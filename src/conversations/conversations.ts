import { cardText } from '../cards/cards.ts';
import type { ChannelRef, Mention, OutboundContent, ThreadMessage } from '../core/platform.ts';
import { clip } from '../core/text.ts';
import type { Binding, Conversation, PostedKind, Versioned } from '../store/entities.ts';
import type { Switchboard } from '../switchboard.ts';

/**
 * Conversations are Teams threads; this is Switchboard's augmentation of them: which session owns a thread, its
 * description, its briefing, and which session posted which message. An entry is created the first time a thread
 * matters. Every message Switchboard posts goes through here, so it is attributed and counts as activity.
 */

export interface Description {
    title?: string | undefined;
    summary?: string | undefined;
    tags?: string[] | undefined;
}

export interface NewThread {
    binding: Binding;
    text: string;
    /** People the post notifies. */
    mentions?: Mention[];
    origin: Conversation['origin'];
    /** The session the new thread belongs to from the start (`convert_to_conversation`, job failures). */
    owningSession?: string;
    /** The session that opened the thread (`start_new_conversation`, `convert_to_conversation`); else Switchboard. */
    originSession?: string;
    briefing?: string;
    description?: Description;
}

export interface PostOptions {
    kind: PostedKind;
    sessionId?: string;
}

export const channelOf = (entity: { teamId: string; channelId: string }): ChannelRef => ({
    teamId: entity.teamId,
    channelId: entity.channelId,
});

export const parseTags = (tags: string | undefined): string[] => {
    if (!tags) return [];
    try {
        const parsed: unknown = JSON.parse(tags);
        return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : [];
    } catch {
        return [];
    }
};

/** The title people and agents see: the description's, else the post's subject, else its first line. */
export const titleOf = (conversation: Conversation | undefined, root: ThreadMessage | undefined): string => {
    if (conversation?.title) return conversation.title;
    if (root?.subject) return root.subject;
    const line = root?.text.split('\n').find((l) => l.trim().length > 0) ?? '';
    return clip(line.trim(), 100) || 'untitled';
};

export class Conversations {
    readonly #sb: Switchboard;

    constructor(sb: Switchboard) {
        this.#sb = sb;
    }

    async get(channelId: string, rootId: string): Promise<Conversation | undefined> {
        return (await this.#sb.entities.conversations.get(channelId, rootId))?.value;
    }

    /** The thread's entry, created when the thread matters for the first time. */
    async ensure(binding: Binding, rootId: string): Promise<Versioned<Conversation>> {
        const sb = this.#sb;
        const existing = await sb.entities.conversations.get(binding.channelId, rootId);
        if (existing) return existing;
        const now = sb.now().toISOString();
        const inserted = await sb.entities.conversations.insert({
            channelId: binding.channelId,
            rootId,
            teamId: binding.teamId,
            origin: 'thread',
            sessionCount: 0,
            createdAt: now,
            lastActivity: now,
        });
        if (inserted) return inserted;
        const raced = await sb.entities.conversations.get(binding.channelId, rootId);
        if (!raced) throw new Error(`conversation ${rootId} vanished while it was created`);
        return raced;
    }

    /** Something happened in the conversation that counts as activity (archive and retention count from it). */
    async touch(channelId: string, rootId: string) {
        const now = this.#sb.now().toISOString();
        await this.#sb.entities.conversations.modify(channelId, rootId, (current) =>
            current.lastActivity >= now ? undefined : { ...current, lastActivity: now }
        );
    }

    async describe(channelId: string, rootId: string, description: Description): Promise<Conversation | undefined> {
        const written = await this.#sb.entities.conversations.modify(channelId, rootId, (current) => ({
            ...current,
            ...(description.title !== undefined ? { title: clip(description.title, 200) } : {}),
            ...(description.summary !== undefined ? { summary: clip(description.summary, 2_000) } : {}),
            ...(description.tags !== undefined ? { tags: JSON.stringify(description.tags) } : {}),
        }));
        return written?.value;
    }

    /** The session leaves the thread (if it still owns it). */
    async detach(channelId: string, rootId: string, sessionId: string, reason: string) {
        await this.#sb.entities.conversations.modify(channelId, rootId, (current) =>
            current.owningSession === sessionId
                ? { ...current, owningSession: undefined, previousSession: sessionId, previousReason: reason }
                : undefined
        );
    }

    /**
     * Posts a new message into a thread for a session or for Switchboard itself: attributed, counted as activity
     * (except Switchboard's notes), and seen by sessions waiting for a message in this conversation.
     */
    async post(channel: ChannelRef, rootId: string, content: OutboundContent, options: PostOptions) {
        const { messageId } = await this.#sb.platform.reply(channel, rootId, content);
        await this.#arrived(channel, rootId, messageId, content, options);
        return { messageId };
    }

    /** Turns a message Switchboard showed before (the "working…" message) into a new message, like `post`. */
    async publish(
        channel: ChannelRef,
        rootId: string,
        messageId: string,
        content: OutboundContent,
        options: PostOptions
    ) {
        await this.#sb.platform.update(channel, rootId, messageId, content);
        await this.#arrived(channel, rootId, messageId, content, options);
    }

    /** Changes one of Switchboard's messages in place (cards); `activity` when it counts as activity. */
    async edit(
        channel: ChannelRef,
        rootId: string,
        messageId: string,
        content: OutboundContent,
        options: PostOptions & { activity: boolean }
    ) {
        await this.#sb.platform.update(channel, rootId, messageId, content);
        await this.#record(channel, rootId, messageId, options);
        if (options.activity) await this.touch(channel.channelId, rootId);
    }

    async #arrived(
        channel: ChannelRef,
        rootId: string,
        messageId: string,
        content: OutboundContent,
        options: PostOptions
    ) {
        const sb = this.#sb;
        await this.#record(channel, rootId, messageId, options);
        if (options.kind !== 'note') await this.touch(channel.channelId, rootId);
        await sb.waits.conversationMessage(channel.channelId, rootId, {
            from: options.sessionId ? `agent (session ${options.sessionId})` : 'Switchboard',
            at: sb.now().toISOString(),
            text: content.text ?? cardText(content.card),
        });
    }

    async #record(channel: ChannelRef, rootId: string, messageId: string, options: PostOptions) {
        await this.#sb.entities.posted.upsert({
            channelId: channel.channelId,
            messageId,
            rootId,
            kind: options.kind,
            sessionId: options.sessionId,
            at: this.#sb.now().toISOString(),
        });
    }

    /** Opens a new thread in the binding's channel and records it as a conversation. */
    async open(thread: NewThread): Promise<{ conversation: Conversation; url: string }> {
        const sb = this.#sb;
        const { binding } = thread;
        const channel = channelOf(binding);
        const { rootId, url } = await sb.platform.postThread(channel, {
            text: thread.text,
            ...(thread.mentions ? { mentions: thread.mentions } : {}),
        });
        await this.#record(channel, rootId, rootId, {
            kind: 'opening',
            ...(thread.originSession ? { sessionId: thread.originSession } : {}),
        });
        const now = sb.now().toISOString();
        const tags = thread.description?.tags;
        const conversation: Conversation = {
            channelId: binding.channelId,
            rootId,
            teamId: binding.teamId,
            origin: thread.origin,
            owningSession: thread.owningSession,
            sessionCount: thread.owningSession ? 1 : 0,
            title: thread.description?.title,
            summary: thread.description?.summary,
            tags: tags ? JSON.stringify(tags) : undefined,
            briefing: thread.briefing,
            originSession: thread.originSession,
            createdAt: now,
            lastActivity: now,
        };
        await sb.entities.conversations.upsert(conversation);
        return { conversation, url };
    }

    /** The admins of the binding's tenant (`SWITCHBOARD_ADMINS`), as people a post notifies. */
    adminMentions(binding: Binding): Mention[] {
        const tenant = binding.tenantId.toLowerCase();
        return this.#sb.settings.admins
            .filter((admin) => admin.tenant.toLowerCase() === tenant)
            .map((admin) => ({ id: admin.objectId, name: admin.label ?? 'Switchboard admin' }));
    }

    /** A notice from Switchboard to the whole channel, as a thread of its own (a reply there reaches an agent). */
    async notice(binding: Binding, text: string) {
        await this.open({ binding, text, origin: 'notice' }).catch((error: unknown) => {
            this.#sb.log.warn({ err: error, channelId: binding.channelId }, 'notice not posted');
        });
    }
}
