import { cardText } from '../cards/cards.ts';
import type { ContentBlock } from '../claude/templates.ts';
import type { ChannelRef, ImageRef, ThreadMessage } from '../core/platform.ts';
import { clip, neutralise, quoted } from '../core/text.ts';
import { type Binding, type Card, type Conversation, conversationKey, type PostedMessage } from '../store/entities.ts';
import type { Switchboard } from '../switchboard.ts';
import { channelOf } from './conversations.ts';

/**
 * A conversation's history: the Teams thread as people see it (the truth), annotated with what only Switchboard
 * knows: which session posted Switchboard's messages, card states and clicks, briefings, and when sessions
 * started and ended. Continuations get it as text; `read_conversation` as entries.
 */

export type EntryKind =
    | 'message'
    | 'opening'
    | 'answer'
    | 'update'
    | 'card'
    | 'note'
    | 'session-message'
    | 'app'
    | 'session-change';

export interface CardAnnotation {
    cardId: string;
    state: Card['state'];
    lastClick?: { verb: string; by: string; aad: string; at: string; data: string };
}

export interface HistoryEntry {
    /** The Teams message; absent for session changes. */
    messageId?: string;
    at: string;
    kind: EntryKind;
    /** Who wrote it, as people would say it. */
    from: string;
    aad?: string;
    session?: string;
    text: string;
    card?: CardAnnotation;
    briefing?: string;
    images: ImageRef[];
    files: string[];
}

export interface History {
    entries: HistoryEntry[];
    /** The thread is longer than what was read. */
    truncated: boolean;
}

/** At most this many messages of a thread are read for a continuation. */
export const HISTORY_MESSAGES = 500;
/** A continuation brings the images of this many of the latest messages. */
export const HISTORY_IMAGE_MESSAGES = 10;

const KIND_FROM_POSTED: Record<PostedMessage['kind'], EntryKind> = {
    opening: 'opening',
    answer: 'answer',
    update: 'update',
    card: 'card',
    note: 'note',
    'session-message': 'session-message',
};

const annotation = (card: Card): CardAnnotation => ({
    cardId: card.cardId,
    state: card.state,
    ...(card.lastClickVerb && card.lastClickAt
        ? {
              lastClick: {
                  verb: card.lastClickVerb,
                  by: card.lastClickBy ?? 'unknown',
                  aad: card.lastClickAad ?? '',
                  at: card.lastClickAt,
                  data: card.lastClickData ?? '{}',
              },
          }
        : {}),
});

export class HistoryReader {
    readonly #sb: Switchboard;

    constructor(sb: Switchboard) {
        this.#sb = sb;
    }

    /** The thread's history, oldest first, at most the latest `limit` messages plus session changes. */
    async read(channel: ChannelRef, rootId: string, limit = HISTORY_MESSAGES): Promise<History> {
        const sb = this.#sb;
        const { messages, truncated } = await sb.platform.readThread(channel, rootId, limit);
        const where = [{ field: 'rootId', op: 'eq' as const, value: rootId }];
        const posted = new Map(
            (await sb.entities.posted.list({ partitionKey: channel.channelId, where })).map((p) => [
                p.value.messageId,
                p.value,
            ])
        );
        const cards = new Map(
            (
                await sb.entities.cards.list({
                    where: [{ field: 'channelId', op: 'eq', value: channel.channelId }, ...where],
                })
            )
                .filter((c) => c.value.activityId)
                .map((c) => [c.value.activityId ?? '', c.value])
        );
        const conversation = await sb.conversations.get(channel.channelId, rootId);
        const entries = messages.map((message) =>
            this.#entry(message, posted.get(message.messageId), cards, conversation)
        );
        const sessions = await sb.entities.sessions.list({
            where: [{ field: 'channelId', op: 'eq', value: channel.channelId }, ...where],
        });
        const first = entries[0]?.at ?? '';
        for (const { value: session } of sessions) {
            const changes: [string, string][] = [
                [session.createdAt, `session ${session.sessionId} started (#${session.seq})`],
            ];
            if (session.endedAt) {
                changes.push([session.endedAt, `session ${session.sessionId} ended: ${session.endReason ?? 'ended'}`]);
            }
            for (const [at, text] of changes) {
                if (at < first) continue;
                entries.push({
                    at,
                    kind: 'session-change',
                    from: 'Switchboard',
                    session: session.sessionId,
                    text,
                    images: [],
                    files: [],
                });
            }
        }
        entries.sort((a, b) => a.at.localeCompare(b.at));
        return { entries, truncated };
    }

    #entry(
        message: ThreadMessage,
        posted: PostedMessage | undefined,
        cards: Map<string, Card>,
        conversation: Conversation | undefined
    ): HistoryEntry {
        const card = cards.get(message.messageId);
        const visibleCards = message.cards.map(cardText).filter(Boolean);
        const text = [message.text, ...visibleCards].filter(Boolean).join('\n');
        const base = {
            messageId: message.messageId,
            at: message.at,
            text,
            images: message.images,
            files: message.files,
            ...(card ? { card: annotation(card) } : {}),
        };
        if (posted) {
            const kind = KIND_FROM_POSTED[posted.kind];
            const briefing = kind === 'opening' && conversation?.briefing ? { briefing: conversation.briefing } : {};
            return {
                ...base,
                kind,
                from: posted.sessionId ? 'agent' : 'Switchboard',
                ...(posted.sessionId ? { session: posted.sessionId } : {}),
                ...briefing,
            };
        }
        if (message.author.isApp) return { ...base, kind: 'app', from: message.author.name };
        return {
            ...base,
            kind: 'message',
            from: message.author.name,
            ...(message.author.aadObjectId ? { aad: message.author.aadObjectId } : {}),
        };
    }

    /**
     * The images of the latest messages as content blocks: fetched from the platform, uploaded to the binding's
     * workspace (recorded with the conversation, deleted with it). Images that cannot be fetched are skipped.
     */
    async images(binding: Binding, rootId: string, entries: HistoryEntry[]): Promise<ContentBlock[]> {
        const sb = this.#sb;
        const blocks: ContentBlock[] = [];
        const recent = entries.filter((entry) => entry.messageId).slice(-HISTORY_IMAGE_MESSAGES);
        for (const entry of recent) {
            for (const image of entry.images) {
                try {
                    const { data, mediaType } = await sb.platform.fetchImage(channelOf(binding), image);
                    const fileId = await sb.attachments.uploadImage(
                        binding.workspaceId,
                        conversationKey(binding.channelId, rootId),
                        image.name,
                        data,
                        mediaType
                    );
                    if (fileId) blocks.push({ type: 'image', source: { type: 'file', file_id: fileId } });
                } catch (error) {
                    sb.log.warn({ err: error, rootId }, 'history image not passed on');
                }
            }
        }
        return blocks;
    }
}

const indent = (text: string) =>
    neutralise(text)
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n');

const who = (entry: HistoryEntry) => {
    switch (entry.kind) {
        case 'message':
            return `person ${quoted(entry.from)}${entry.aad ? ` (aad ${entry.aad})` : ''} wrote`;
        case 'opening':
            return entry.session ? `opening post by agent (session ${entry.session})` : 'opening post by Switchboard';
        case 'answer':
            return `agent (session ${entry.session ?? 'unknown'}) answered`;
        case 'update':
            return `agent (session ${entry.session ?? 'unknown'}) posted an update`;
        case 'card':
            return `card by agent (session ${entry.session ?? 'unknown'})`;
        case 'note':
            return 'note from Switchboard';
        case 'session-message':
            return `message from another session (${entry.session ?? 'unknown'})`;
        case 'app':
            return `app ${quoted(entry.from)} wrote`;
        case 'session-change':
            return 'Switchboard';
    }
};

const cardLine = (card: CardAnnotation) => {
    const click = card.lastClick
        ? `; last click verb=${quoted(card.lastClick.verb)} by ${quoted(card.lastClick.by)} at ${card.lastClick.at}: ${clip(card.lastClick.data, 500)}`
        : '';
    return `[card ${card.cardId}: ${card.state}${click}]`;
};

/** One entry as Markdown; every line of content is indented, so no line of a history can look like a header. */
export const formatEntry = (entry: HistoryEntry): string => {
    if (entry.kind === 'session-change') return `- ${entry.at} · ${entry.text}`;
    const lines = [
        entry.text,
        ...(entry.card ? [cardLine(entry.card)] : []),
        ...(entry.briefing ? [`[briefing, not shown in Teams] ${entry.briefing}`] : []),
        ...entry.files.map((name) => `[file not passed on] name=${name}`),
    ].filter(Boolean);
    return `- ${entry.at} · ${who(entry)}:\n${indent(lines.join('\n'))}`;
};

/** The history as text lines for a first message; `note` (if any) comes first. */
export const formatHistory = (history: History, note?: string): string[] => [
    ...(note ? [note] : []),
    ...(history.truncated ? [`Only the latest ${HISTORY_MESSAGES} messages of the thread were read.`] : []),
    ...history.entries.map(formatEntry),
];

export const HISTORY_FILE_PATH = '/mnt/session/uploads/switchboard/conversation-history.md';
/** In the message when the history is a file: the latest entries. */
export const RECENT_ENTRIES = 20;

export type HistoryPlacement = { inline: true; text: string } | { inline: false; file: string; text: string };

/**
 * Where a history goes in a first message: inline up to the limit; above it the whole history goes into a file
 * (mounted at `HISTORY_FILE_PATH`) and the message carries the latest entries and the path.
 */
export const placeHistory = (lines: string[], limitBytes: number): HistoryPlacement => {
    const full = lines.join('\n');
    if (Buffer.byteLength(full) <= limitBytes) return { inline: true, text: full };
    const recent = lines.slice(-RECENT_ENTRIES);
    return {
        inline: false,
        file: `# Conversation history\n\n${full}\n`,
        text: [
            `The full history (${lines.length} entries) is in the file ${HISTORY_FILE_PATH}. The latest ${recent.length}:`,
            ...recent,
        ].join('\n'),
    };
};
