import { randomBytes, randomUUID } from 'node:crypto';
import { APIError } from '@anthropic-ai/sdk';
import { type IncomingAttachment, imageBlocks } from '../attachments/attachments.ts';
import type { ContentBlock, FileResource } from '../claude/templates.ts';
import {
    clip,
    continuationHeader,
    conversationStartHeader,
    formatHumanMessage,
    neutralise,
    type Person,
} from '../core/text.ts';
import { sleep, timeOfMessageId } from '../core/time.ts';
import type { Binding, Conversation, LogEntry, SessionEntry } from '../store/entities.ts';
import type { Switchboard } from '../switchboard.ts';
import {
    type AttachmentRef,
    formatEntries,
    formatHistory,
    type HistoryMessage,
    LOG_FILE_PATH,
    type LogItem,
    placeLog,
} from './log.ts';

/**
 * Conversations (concept: "Messages from Teams", "Session end and continuation"): one thread, at most one owning
 * session, and the log that lets a new session continue the thread. The owning session is created only under a
 * claim on the conversation entry, so concurrent messages on several pods never create two sessions.
 */

/** Reads a thread's history from the platform when Switchboard has no log for it. */
export interface HistoryReader {
    read(binding: Binding, rootId: string, max: number): Promise<{ messages: HistoryMessage[]; truncated: boolean }>;
}

export interface HumanMessage {
    binding: Binding;
    rootId: string;
    messageId: string;
    /** The thread's opening post (a new thread). */
    isRoot: boolean;
    from: Person;
    at: Date;
    text: string;
    attachments: IncomingAttachment[];
}

export interface NewThread {
    binding: Binding;
    text: string;
    origin: Conversation['origin'];
    owningSession?: string;
    briefing?: string;
    originSession?: string;
}

/** Images of the latest messages in a continuation; older ones appear as lines. */
const CONTINUATION_IMAGE_MESSAGES = 10;
const HISTORY_MAX_MESSAGES = 500;

export const newConversationId = () => `cnv_${randomBytes(12).toString('base64url')}`;

const entryKey = (at: Date) => `${at.toISOString()}-${randomBytes(4).toString('hex')}`;

export class Conversations {
    readonly #sb: Switchboard;

    constructor(sb: Switchboard) {
        this.#sb = sb;
    }

    async get(channelId: string, rootId: string): Promise<Conversation | undefined> {
        return (await this.#sb.entities.conversations.get(channelId, rootId))?.value;
    }

    /**
     * Appends to the conversation's log. People's messages and clicks and the agent's answers, updates and card
     * changes count as activity (archive and retention count from it); Switchboard's own bookkeeping does not.
     */
    async record(channelId: string, rootId: string, item: LogItem) {
        const sb = this.#sb;
        const now = sb.now();
        const activity =
            ['human', 'agent', 'opening', 'card-click', 'confirmation'].includes(item.kind) ||
            (item.kind === 'card' && item.event !== 'closed');
        const conversation = activity
            ? (
                  await sb.entities.conversations.modify(channelId, rootId, (current) => ({
                      ...current,
                      lastActivity: now.toISOString(),
                  }))
              )?.value
            : await this.get(channelId, rootId);
        if (!conversation) return;
        await sb.entities.logs.upsert({
            conversationId: conversation.conversationId,
            entryKey: entryKey(now),
            at: now.toISOString(),
            item: JSON.stringify(item),
        });
    }

    async entries(conversationId: string): Promise<LogEntry[]> {
        const rows = await this.#sb.entities.logs.list({ partitionKey: conversationId });
        return rows.map((row) => row.value).sort((a, b) => a.entryKey.localeCompare(b.entryKey));
    }

    /** The session leaves the thread (if it still owns it). */
    async detach(channelId: string, rootId: string, sessionId: string, reason: string) {
        await this.#sb.entities.conversations.modify(channelId, rootId, (current) =>
            current.owningSession === sessionId
                ? { ...current, owningSession: undefined, previousSession: sessionId, previousReason: reason }
                : undefined
        );
    }

    /** Posts a new thread in the binding's channel and records it as a conversation. */
    async createThread(thread: NewThread): Promise<{ conversation: Conversation; url: string }> {
        const sb = this.#sb;
        const { binding } = thread;
        const channel = { teamId: binding.teamId, channelId: binding.channelId };
        const { rootId, url } = await sb.gateway.postThread(channel, { text: thread.text });
        const now = sb.now().toISOString();
        const conversation: Conversation = {
            channelId: binding.channelId,
            rootId,
            conversationId: newConversationId(),
            teamId: binding.teamId,
            workspaceId: binding.workspaceId,
            origin: thread.origin,
            owningSession: thread.owningSession,
            sessionCount: thread.owningSession ? 1 : 0,
            openingText: thread.origin === 'start_new_conversation' ? thread.text : undefined,
            briefing: thread.briefing,
            originSession: thread.originSession,
            createdAt: now,
            lastActivity: now,
        };
        await sb.entities.conversations.upsert(conversation);
        await this.record(binding.channelId, rootId, {
            kind: 'opening',
            ...(thread.originSession ? { session: thread.originSession } : {}),
            text: thread.text,
        });
        if (thread.owningSession) {
            await this.record(binding.channelId, rootId, {
                kind: 'session',
                event: 'attached',
                session: thread.owningSession,
            });
        }
        return { conversation, url };
    }

    /** A message from a person in a bound channel: a new thread, or a reply to a known or unknown thread. */
    async onHuman(message: HumanMessage) {
        const sb = this.#sb;
        const { binding, rootId } = message;
        let fresh: 'root' | 'unknown' | undefined;
        if (!(await this.get(binding.channelId, rootId))) {
            const now = sb.now().toISOString();
            const inserted = await sb.entities.conversations.insert({
                channelId: binding.channelId,
                rootId,
                conversationId: newConversationId(),
                teamId: binding.teamId,
                workspaceId: binding.workspaceId,
                origin: 'human',
                sessionCount: 0,
                // a reply in a thread Switchboard has not seen: its first session reads the thread from Teams
                ...(message.isRoot ? {} : { historyFromTeams: true }),
                createdAt: now,
                lastActivity: now,
            });
            if (inserted) fresh = message.isRoot ? 'root' : 'unknown';
        }
        const conversation = await this.get(binding.channelId, rootId);
        if (!conversation) return;
        const attachments = await sb.attachments.prepare(
            binding.workspaceId,
            conversation.conversationId,
            message.messageId,
            message.attachments
        );
        await this.record(binding.channelId, rootId, {
            kind: 'human',
            name: message.from.name ?? 'unknown',
            aad: message.from.aadObjectId,
            text: message.text,
            attachments: [...attachments.refs, ...attachments.rejected],
        });
        if (attachments.rejected.length > 0) {
            const names = attachments.rejected.map((a) => `${a.name} (${a.unsupported})`).join(', ');
            await sb.gateway
                .reply({ teamId: binding.teamId, channelId: binding.channelId }, rootId, {
                    text: `ℹ️ Not passed to the agent: ${clip(names, 500)}. Only images are supported so far.`,
                })
                .catch(() => undefined);
        }
        const rejectedLines = attachments.rejected.map(
            (a) => `[attachment not supported] name=${a.name} type=${a.mediaType}`
        );
        const text = [message.text, ...rejectedLines].filter(Boolean).join('\n');
        const human = formatHumanMessage(message.from, message.at, text);
        await this.#deliver(binding, rootId, { human, images: attachments.blocks, fresh });
    }

    /**
     * Gets a message to the thread's owning session, creating one (under a claim) when there is none. The first
     * message of a new session depends on how the thread came about (concept: "Message formats").
     */
    async #deliver(
        binding: Binding,
        rootId: string,
        message: { human: string; images: ContentBlock[]; fresh: 'root' | 'unknown' | undefined }
    ) {
        const sb = this.#sb;
        const deadline = Date.now() + sb.timing.claimWaitMs;
        // one claim per delivery, not per pod: two messages of a thread on the same pod must not both create a session
        const claim = `${sb.podId}:${randomUUID()}`;
        for (;;) {
            const current = await sb.entities.conversations.get(binding.channelId, rootId);
            if (!current) return;
            const conversation = current.value;
            if (conversation.owningSession) {
                const owner = await sb.sessions.get(conversation.owningSession);
                if (owner?.state === 'active' && (await this.#sendTo(owner, message))) return;
                await this.detach(binding.channelId, rootId, conversation.owningSession, owner?.endReason ?? 'ended');
                continue;
            }
            const now = sb.now();
            const claimedByOther =
                conversation.claimedBy &&
                conversation.claimedBy !== claim &&
                (conversation.claimedUntil ?? '') > now.toISOString();
            if (claimedByOther) {
                if (Date.now() > deadline) {
                    await this.#note(
                        binding,
                        rootId,
                        '⚠️ Your message could not be passed on yet; please send it again.'
                    );
                    return;
                }
                await sleep(500);
                continue;
            }
            const claimed = await sb.entities.conversations.update(current, {
                ...conversation,
                claimedBy: claim,
                claimedUntil: new Date(now.getTime() + sb.timing.claimMs).toISOString(),
            });
            if (!claimed) continue;
            // the claim expired while the session was created and another delivery won: send it there instead
            if (await this.#startSession(binding, claimed.value, claim, message)) return;
        }
    }

    /** Sends to an active owner; `false` when the session turned out to have ended (then a new one starts). */
    async #sendTo(owner: SessionEntry, message: { human: string; images: ContentBlock[] }): Promise<boolean> {
        const sb = this.#sb;
        try {
            await sb.sessions.send(owner, [{ type: 'text', text: message.human }, ...message.images]);
            return true;
        } catch (error) {
            if (!(error instanceof APIError) || error.status >= 500) throw error;
            const session = await sb.workspaces
                .get(owner.workspaceId)
                .retrieveSession(owner.sessionId)
                .catch(() => undefined);
            if (session && session.status !== 'terminated' && session.archived_at === null) throw error;
            await sb.sessions.end(owner.sessionId, session?.archived_at ? 'archived' : 'terminated');
            return false;
        }
    }

    async #startSession(
        binding: Binding,
        conversation: Conversation,
        claim: string,
        message: { human: string; images: ContentBlock[]; fresh: 'root' | 'unknown' | undefined }
    ): Promise<boolean> {
        const sb = this.#sb;
        const { channelId, rootId } = conversation;
        try {
            const first = await this.#firstMessage(binding, conversation, message);
            const entry = await sb.sessions.create({
                binding,
                kind: 'conversation',
                deploymentId: binding.conversationDeploymentId,
                rootId,
                conversationId: conversation.conversationId,
                seq: conversation.sessionCount + 1,
                titleTime: timeOfMessageId(rootId) ?? new Date(conversation.createdAt),
                firstContent: first.content,
                ...(first.files.length > 0 ? { files: first.files } : {}),
            });
            let attached = false;
            await sb.entities.conversations.modify(channelId, rootId, (current) => {
                // only while this delivery's claim holds and nobody else attached a session meanwhile
                attached = current.claimedBy === claim && !current.owningSession;
                return attached
                    ? {
                          ...current,
                          owningSession: entry.sessionId,
                          sessionCount: current.sessionCount + 1,
                          claimedBy: undefined,
                          claimedUntil: undefined,
                          historyFromTeams: undefined,
                      }
                    : undefined;
            });
            if (!attached) {
                sb.log.warn({ sessionId: entry.sessionId, channelId }, 'claim lost while creating a session');
                // the extra session leaves the thread at once (nothing of it is posted) and is archived when idle
                const detached = await sb.sessions.modify(entry.sessionId, (current) => ({
                    ...current,
                    rootId: undefined,
                }));
                await sb.sessions.archive(detached?.value ?? entry, 'claim_lost').catch(() => false);
                return false;
            }
            await this.record(channelId, rootId, { kind: 'session', event: 'attached', session: entry.sessionId });
        } catch (error) {
            sb.log.warn({ err: error, channelId, rootId }, 'conversation session not created');
            await sb.entities.conversations.modify(channelId, rootId, (current) =>
                current.claimedBy === claim ? { ...current, claimedBy: undefined, claimedUntil: undefined } : undefined
            );
            const reason = error instanceof Error ? clip(error.message, 300) : 'unknown error';
            await this.#note(
                binding,
                rootId,
                `⚠️ Could not start an agent session: ${reason}. Send another message to try again.`
            );
        }
        return true;
    }

    async #note(binding: Binding, rootId: string, text: string) {
        await this.#sb.gateway
            .reply({ teamId: binding.teamId, channelId: binding.channelId }, rootId, { text })
            .catch(() => undefined);
    }

    /** Switchboard's part of a new session's first message, and files to mount. */
    async #firstMessage(
        binding: Binding,
        conversation: Conversation,
        message: { human: string; images: ContentBlock[]; fresh: 'root' | 'unknown' | undefined }
    ): Promise<{ content: ContentBlock[]; files: FileResource[] }> {
        const sb = this.#sb;
        const now = sb.now();
        const text = (value: string): ContentBlock => ({ type: 'text', text: value });
        if (conversation.sessionCount === 0 && message.fresh === 'root') {
            return { content: [text(message.human), ...message.images], files: [] };
        }
        if (conversation.sessionCount === 0 && conversation.origin === 'start_new_conversation') {
            const parts = [
                conversationStartHeader(conversation.originSession ?? 'none', new Date(conversation.createdAt)),
                neutralise(conversation.openingText ?? ''),
                ...(conversation.briefing ? ['--- briefing ---', neutralise(conversation.briefing)] : []),
                message.human,
            ];
            return { content: [text(parts.join('\n')), ...message.images], files: [] };
        }
        const fromTeams =
            message.fresh === 'unknown' || (conversation.sessionCount === 0 && conversation.historyFromTeams);
        const entries = fromTeams ? [] : await this.entries(conversation.conversationId);
        // the latest entry is the message being delivered: it follows the history with its own header
        const history = entries.slice(0, -1);
        let lines: string[];
        let note: string | undefined;
        let header: string;
        let images: ContentBlock[] = [];
        if (history.length > 0) {
            lines = formatEntries(history);
            header = continuationHeader(
                conversation.previousSession ?? 'none',
                conversation.previousReason ?? 'ended',
                now
            );
            const recentHuman = history
                .map((entry) => JSON.parse(entry.item) as LogItem)
                .filter((item): item is Extract<LogItem, { kind: 'human' }> => item.kind === 'human')
                .slice(-CONTINUATION_IMAGE_MESSAGES);
            images = imageBlocks(recentHuman.flatMap((item) => item.attachments ?? []));
        } else {
            header = continuationHeader('none', 'history_from_teams', now);
            ({ lines, note } = await this.#history(binding, conversation));
        }
        const placed = placeLog(lines, sb.settings.logInlineLimitBytes, note);
        const files: FileResource[] = [];
        if (!placed.inline) {
            const api = sb.workspaces.get(binding.workspaceId);
            const fileId = await api.uploadFile('conversation-log.md', 'text/markdown', Buffer.from(placed.file));
            await sb.entities.files.upsert({
                owner: conversation.conversationId,
                fileId,
                workspaceId: binding.workspaceId,
                kind: 'log',
                mediaType: 'text/markdown',
                name: 'conversation-log.md',
                size: Buffer.byteLength(placed.file),
                createdAt: now.toISOString(),
            });
            files.push({ type: 'file', file_id: fileId, mount_path: LOG_FILE_PATH });
        }
        return {
            content: [text([header, placed.text, message.human].join('\n')), ...images, ...message.images],
            files,
        };
    }

    /** The thread's history read from the platform, for threads Switchboard has no log of. */
    async #history(binding: Binding, conversation: Conversation): Promise<{ lines: string[]; note?: string }> {
        const sb = this.#sb;
        try {
            const { messages, truncated } = await sb.history.read(binding, conversation.rootId, HISTORY_MAX_MESSAGES);
            // the newest message is the one being delivered; it follows with its own header
            const earlier = messages.slice(0, -1);
            return {
                lines: formatHistory(earlier),
                ...(truncated
                    ? { note: `Only the latest ${HISTORY_MAX_MESSAGES} messages of the thread were read.` }
                    : {}),
            };
        } catch (error) {
            sb.log.warn({ err: error, channelId: binding.channelId }, 'thread history not read');
            await this.#note(
                binding,
                conversation.rootId,
                'ℹ️ The earlier messages of this thread could not be read; the agent starts without them.'
            );
            return { lines: [], note: 'The earlier messages of this thread could not be read.' };
        }
    }
}

export type { AttachmentRef };
