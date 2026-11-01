import type { z } from 'zod';
import { type Description, parseTags, titleOf } from '../conversations/conversations.ts';
import type { HistoryEntry } from '../conversations/history.ts';
import { type ChannelRef, CursorError, type ThreadSummary } from '../core/platform.ts';
import { clip, neutralise } from '../core/text.ts';
import {
    type Binding,
    type Conversation,
    conversationKey,
    forgetSeen,
    markSeen,
    type SessionEntry,
} from '../store/entities.ts';
import type { Switchboard } from '../switchboard.ts';
import { type ToolInput, ToolInputs, type ToolName } from './definitions.ts';
import { MAX_WAIT_MINUTES } from './waits.ts';

/** A failure the agent can act on; its message becomes the tool result. */
export class ToolFailure extends Error {}

/** A `wait` call: until when at the latest, and the conversation it watches (`conversationKey`). */
export interface WaitRequest {
    until: string;
    watch?: string;
}

/** What a tool call comes to: a result now, or a wait that is answered later (`Waits`). */
export type ToolReply = { value: Record<string, unknown> } | { wait: WaitRequest };

/** The calling session and its channel. */
export interface ToolContext {
    entry: SessionEntry;
    binding: Binding;
    channel: ChannelRef;
}

/** Threads per `list_conversations` result, and Teams pages read at most to fill one. */
const LIST_SIZE = 20;
const LIST_PAGES = 5;
/** Entries per `read_conversation` result. */
const READ_SIZE = 30;
const OPENING_CHARS = 500;
const ENTRY_CHARS = 4_000;

const value = (result: Record<string, unknown>): ToolReply => ({ value: result });

/** Tool inputs come from agents, which are untrusted: validated before anything is carried out. */
const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
    const parsed = schema.safeParse(input);
    if (parsed.success) return parsed.data;
    throw new ToolFailure(`invalid input: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
};

/** Agents write descriptions too: every string an agent reads back is neutralised like people's text. */
const safe = (text: string | undefined) => (text === undefined ? undefined : neutralise(text));

/** Orders `read_conversation` entries and pages through them stably, also when new messages arrive. */
const entryKey = (entry: HistoryEntry) => `${entry.at}|${entry.messageId ?? `${entry.kind}:${entry.session ?? ''}`}`;
const encodeCursor = (key: string) => Buffer.from(key).toString('base64url');
const decodeCursor = (cursor: string) => Buffer.from(cursor, 'base64url').toString('utf8');

const hasTags = (conversation: Conversation | undefined, wanted: string[]) => {
    const tags = parseTags(conversation?.tags).map((tag) => tag.toLowerCase());
    return wanted.every((tag) => tags.includes(tag.toLowerCase()));
};

const describeEntry = (entry: HistoryEntry) => ({
    ...(entry.messageId ? { message_id: entry.messageId } : {}),
    at: entry.at,
    kind: entry.kind,
    from: neutralise(entry.from),
    ...(entry.aad ? { aad: entry.aad } : {}),
    ...(entry.session ? { session: entry.session } : {}),
    text: clip(neutralise(entry.text), ENTRY_CHARS),
    ...(entry.card
        ? {
              card: {
                  card_id: entry.card.cardId,
                  state: entry.card.state,
                  ...(entry.card.lastClick
                      ? {
                            last_click: {
                                verb: neutralise(entry.card.lastClick.verb),
                                by: neutralise(entry.card.lastClick.by),
                                aad: entry.card.lastClick.aad,
                                at: entry.card.lastClick.at,
                                data: neutralise(entry.card.lastClick.data),
                            },
                        }
                      : {}),
              },
          }
        : {}),
    ...(entry.briefing ? { briefing: neutralise(entry.briefing) } : {}),
    ...(entry.images.length > 0 ? { images: entry.images.map((image) => neutralise(image.name)) } : {}),
    ...(entry.files.length > 0 ? { files: entry.files.map((name) => neutralise(name)) } : {}),
});

/** Carries out each of Switchboard's tools for a session; `Tools` makes sure each call runs at most once. */
export class ToolHandlers {
    readonly #sb: Switchboard;

    constructor(sb: Switchboard) {
        this.#sb = sb;
    }

    readonly #handlers: Record<ToolName, (context: ToolContext, input: unknown) => Promise<ToolReply>> = {
        send_update: (context, input) => this.#sendUpdate(context, parse(ToolInputs.send_update, input)),
        show_card: (context, input) => this.#showCard(context, parse(ToolInputs.show_card, input)),
        update_card: (context, input) => this.#updateCard(context, parse(ToolInputs.update_card, input)),
        describe_conversation: (context, input) =>
            this.#describeConversation(context, parse(ToolInputs.describe_conversation, input)),
        list_conversations: (context, input) =>
            this.#listConversations(context, parse(ToolInputs.list_conversations, input)),
        read_conversation: (context, input) =>
            this.#readConversation(context, parse(ToolInputs.read_conversation, input)),
        send_to_conversation: (context, input) =>
            this.#sendToConversation(context, parse(ToolInputs.send_to_conversation, input)),
        start_new_conversation: (context, input) =>
            this.#startNewConversation(context, parse(ToolInputs.start_new_conversation, input)),
        convert_to_conversation: (context, input) =>
            this.#convertToConversation(context, parse(ToolInputs.convert_to_conversation, input)),
        wait: (context, input) => this.#wait(context, parse(ToolInputs.wait, input)),
        notify_admins: (context, input) => this.#notifyAdmins(context, parse(ToolInputs.notify_admins, input)),
    };

    /** Carries a call out with its input validated. */
    run(name: ToolName, context: ToolContext, input: unknown): Promise<ToolReply> {
        return this.#handlers[name](context, input);
    }

    async #sendUpdate({ entry }: ToolContext, input: ToolInput<'send_update'>) {
        if (!entry.rootId) {
            throw new ToolFailure(
                'this session has no conversation yet; use convert_to_conversation or start_new_conversation'
            );
        }
        const messageId = await this.#sb.sessions.post(entry, input.text, true);
        return value({ message_id: messageId ?? null });
    }

    async #showCard({ entry }: ToolContext, input: ToolInput<'show_card'>) {
        return value({ card_id: await this.#sb.cards.show(entry, input.card) });
    }

    async #updateCard({ entry }: ToolContext, input: ToolInput<'update_card'>) {
        await this.#sb.cards.update(entry, input.card_id, input.card);
        return value({ ok: true });
    }

    async #describeConversation({ entry }: ToolContext, input: ToolInput<'describe_conversation'>) {
        if (!entry.rootId) throw new ToolFailure('this session has no conversation to describe');
        if (input.title === undefined && input.summary === undefined && input.tags === undefined) {
            throw new ToolFailure('give a title, a summary or tags');
        }
        const described = await this.#sb.conversations.describe(entry.channelId, entry.rootId, input);
        if (!described) throw new ToolFailure('your conversation is not known any more');
        return value({
            conversation_id: described.rootId,
            title: described.title ?? null,
            summary: described.summary ?? null,
            tags: parseTags(described.tags),
        });
    }

    async #listConversations({ entry, channel }: ToolContext, input: ToolInput<'list_conversations'>) {
        const sb = this.#sb;
        const since = input.activity_since ? new Date(input.activity_since).toISOString() : undefined;
        const items: Record<string, unknown>[] = [];
        let cursor = input.cursor;
        for (let pages = 0; pages < LIST_PAGES && items.length < LIST_SIZE; pages++) {
            const page = await sb.platform.listThreads(channel, cursor).catch((error: unknown) => {
                throw error instanceof CursorError ? new ToolFailure(error.message) : error;
            });
            // Teams lists threads by latest activity: once one is older, all that follow are
            const fresh = since ? page.items.filter((thread) => thread.lastActivity >= since) : page.items;
            const conversations = await Promise.all(
                fresh.map((thread) => sb.conversations.get(channel.channelId, thread.rootId))
            );
            for (const [index, thread] of fresh.entries()) {
                const conversation = conversations[index];
                if (input.active_only && !conversation?.owningSession) continue;
                if (input.tags && !hasTags(conversation, input.tags)) continue;
                items.push(this.#summary(thread, conversation, entry));
            }
            cursor = fresh.length < page.items.length ? undefined : page.cursor;
            if (!cursor) break;
        }
        return value({ conversations: items, ...(cursor ? { cursor } : {}) });
    }

    #summary(thread: ThreadSummary, conversation: Conversation | undefined, entry: SessionEntry) {
        return {
            conversation_id: thread.rootId,
            url: thread.url,
            title: neutralise(titleOf(conversation, thread.root)),
            summary: safe(conversation?.summary) ?? null,
            tags: parseTags(conversation?.tags).map((tag) => neutralise(tag)),
            opening_post: clip(neutralise(thread.root.text), OPENING_CHARS),
            created: thread.root.at,
            last_activity: thread.lastActivity,
            replies: thread.replyCount,
            has_active_session: Boolean(conversation?.owningSession),
            ...(thread.rootId === entry.rootId ? { own: true } : {}),
        };
    }

    async #readConversation({ channel }: ToolContext, input: ToolInput<'read_conversation'>) {
        const sb = this.#sb;
        const thread = await this.#thread(channel, input.conversation_id);
        const history = await sb.history.read(channel, thread.rootId);
        const before = input.cursor ? decodeCursor(input.cursor) : undefined;
        const newestFirst = history.entries
            .map((entry) => ({ key: entryKey(entry), entry }))
            .sort((a, b) => b.key.localeCompare(a.key))
            .filter(({ key }) => before === undefined || key < before);
        const page = newestFirst.slice(0, READ_SIZE);
        const more = newestFirst.length > page.length;
        const last = page.at(-1);
        return value({
            conversation_id: thread.rootId,
            url: thread.url,
            entries: page.map(({ entry }) => describeEntry(entry)),
            ...(more && last ? { cursor: encodeCursor(last.key) } : {}),
            ...(!more && history.truncated ? { older_messages_not_read: true } : {}),
        });
    }

    async #sendToConversation({ entry, binding, channel }: ToolContext, input: ToolInput<'send_to_conversation'>) {
        if (input.conversation_id === entry.rootId) {
            throw new ToolFailure('this is your own conversation; answer in it directly');
        }
        const thread = await this.#thread(channel, input.conversation_id);
        const { url, delivered } = await this.#sb.delivery.fromSession({
            binding,
            rootId: thread.rootId,
            from: entry,
            text: input.message,
        });
        return value({ conversation_id: thread.rootId, url, delivered });
    }

    async #startNewConversation({ entry, binding }: ToolContext, input: ToolInput<'start_new_conversation'>) {
        const { conversation, url } = await this.#sb.conversations.open({
            binding,
            text: input.message,
            origin: 'start_new_conversation',
            originSession: entry.sessionId,
            ...(input.briefing ? { briefing: input.briefing } : {}),
            description: this.#description(input),
        });
        return value({ conversation_id: conversation.rootId, url });
    }

    async #convertToConversation({ entry, binding }: ToolContext, input: ToolInput<'convert_to_conversation'>) {
        const sb = this.#sb;
        if (entry.rootId) throw new ToolFailure('this session already owns a conversation');
        if (entry.kind !== 'job') throw new ToolFailure('only job sessions can be converted');
        const { conversation, url } = await sb.conversations.open({
            binding,
            text: input.message,
            origin: 'convert_to_conversation',
            owningSession: entry.sessionId,
            originSession: entry.sessionId,
            description: this.#description(input),
        });
        const converted = await sb.sessions.modify(entry.sessionId, (current) => ({
            ...current,
            rootId: conversation.rootId,
        }));
        if (entry.jobId && entry.runKey) await sb.jobs.markConverted(entry.jobId, entry.runKey);
        if (converted) await sb.sessions.ensureWorking(converted.value);
        return value({ conversation_id: conversation.rootId, url });
    }

    async #wait({ entry, channel }: ToolContext, input: ToolInput<'wait'>): Promise<ToolReply> {
        const sb = this.#sb;
        let watch: string | undefined;
        if (input.conversation_id !== undefined) {
            if (input.conversation_id === entry.rootId) {
                throw new ToolFailure('messages in your own conversation end a wait anyway; leave out conversation_id');
            }
            const thread = await this.#thread(channel, input.conversation_id);
            watch = conversationKey(channel.channelId, thread.rootId);
        }
        const minutes = Math.min(input.minutes, MAX_WAIT_MINUTES);
        const until = new Date(sb.now().getTime() + minutes * 60_000).toISOString();
        return { wait: { until, ...(watch ? { watch } : {}) } };
    }

    /**
     * A message to the admins as a thread of its own, with an @mention of each. Once per channel and (UTC) day,
     * claimed by inserting the day's entry; later calls that day get the link to the earlier message.
     */
    async #notifyAdmins({ entry, binding, channel }: ToolContext, input: ToolInput<'notify_admins'>) {
        const sb = this.#sb;
        const day = sb.now().toISOString().slice(0, 10);
        const key = `${binding.channelId}|${day}`;
        if (!(await markSeen(sb.entities, 'admin-notice', key))) {
            const [earlier] = await sb.entities.conversations.list({
                partitionKey: binding.channelId,
                where: [
                    { field: 'origin', op: 'eq', value: 'admin_notice' },
                    { field: 'createdAt', op: 'ge', value: day },
                ],
            });
            const rootId = earlier?.value.rootId;
            return value({
                posted: false,
                reason: 'the admins of this channel were already notified today; nothing was posted',
                ...(rootId
                    ? { conversation_id: rootId, url: await sb.platform.messageUrl(channel, rootId, rootId) }
                    : {}),
            });
        }
        const mentions = sb.conversations.adminMentions(binding);
        try {
            const { conversation, url } = await sb.conversations.open({
                binding,
                text: `📣 **Message for the Switchboard admins**\n\n${input.message}`,
                mentions,
                origin: 'admin_notice',
                originSession: entry.sessionId,
            });
            sb.log.info(
                { channelId: binding.channelId, sessionId: entry.sessionId, admins: mentions.length },
                'admins notified'
            );
            return value({ posted: true, conversation_id: conversation.rootId, url, admins_notified: mentions.length });
        } catch (error) {
            // not posted: a later call may try again today
            await forgetSeen(sb.entities, 'admin-notice', key);
            throw error;
        }
    }

    /** A thread of the session's channel; anything else (other channels, unknown IDs) is rejected. */
    async #thread(channel: ChannelRef, rootId: string): Promise<ThreadSummary> {
        const thread = await this.#sb.platform.thread(channel, rootId);
        if (!thread) throw new ToolFailure(`'${clip(rootId, 60)}' is not a conversation of your channel`);
        return thread;
    }

    #description(input: Description): Description {
        return { title: input.title, summary: input.summary, tags: input.tags };
    }
}
