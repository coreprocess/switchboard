import { randomUUID } from 'node:crypto';
import { APIError } from '@anthropic-ai/sdk';
import type { IncomingAttachment } from '../attachments/attachments.ts';
import type { ContentBlock, FileResource } from '../claude/templates.ts';
import { ReadAccessError } from '../core/platform.ts';
import {
    clip,
    continuationHeader,
    conversationStartHeader,
    formatHumanMessage,
    neutralise,
    type Person,
    sessionMessageHeader,
} from '../core/text.ts';
import { sleep, timeOfMessageId } from '../core/time.ts';
import { type Binding, type Conversation, conversationKey, type SessionEntry } from '../store/entities.ts';
import type { Switchboard } from '../switchboard.ts';
import { channelOf, titleOf } from './conversations.ts';
import { formatHistory, HISTORY_FILE_PATH, placeHistory } from './history.ts';

/**
 * Delivery: brings a message to the session that owns its thread, and starts one when the thread has none. Two
 * kinds of messages arrive in threads: a person's post, and a message another session sends with
 * `send_to_conversation`. The owning session is created only under a claim on the conversation entry, so
 * concurrent messages on several pods never create two sessions for one thread.
 */

export interface PersonMessage {
    binding: Binding;
    rootId: string;
    messageId: string;
    from: Person;
    at: Date;
    text: string;
    attachments: IncomingAttachment[];
}

export interface SessionMessage {
    binding: Binding;
    /** The target thread. */
    rootId: string;
    from: SessionEntry;
    text: string;
}

/** A message on its way to a session: the Teams message it arrived with, and what the session receives. */
interface Trigger {
    messageId: string;
    at: Date;
    /** Header line and text. */
    text: string;
    images: ContentBlock[];
}

interface FirstMessage {
    content: ContentBlock[];
    files: FileResource[];
}

const textBlock = (text: string): ContentBlock => ({ type: 'text', text });

export class Delivery {
    readonly #sb: Switchboard;

    constructor(sb: Switchboard) {
        this.#sb = sb;
    }

    /** A person posted in a bound channel: a new thread or a reply. */
    async fromPerson(message: PersonMessage) {
        const sb = this.#sb;
        const { binding, rootId } = message;
        await sb.waits.conversationMessage(binding.channelId, rootId, {
            from: message.from.name ?? 'unknown',
            at: message.at.toISOString(),
            text: message.text,
        });
        await sb.conversations.ensure(binding, rootId);
        await sb.conversations.touch(binding.channelId, rootId);
        const attachments = await sb.attachments.prepare(
            binding.workspaceId,
            conversationKey(binding.channelId, rootId),
            message.attachments
        );
        if (attachments.rejected.length > 0) {
            const names = attachments.rejected.map((a) => `${a.name} (${a.unsupported})`).join(', ');
            await this.#note(binding, rootId, `ℹ️ Not passed to the agent: ${clip(names, 500)}.`);
        }
        const rejected = attachments.rejected.map(
            (a) => `[attachment not supported] name=${a.name} type=${a.mediaType}`
        );
        const text = [message.text, ...rejected].filter(Boolean).join('\n');
        await this.#deliver(binding, rootId, {
            messageId: message.messageId,
            at: message.at,
            text: formatHumanMessage(message.from, message.at, text),
            images: attachments.blocks,
        });
    }

    /**
     * A session sends a message into another thread of its channel: it appears there as a visible note and
     * reaches the thread's session. Fire and forget: nothing comes back to the sender. Once the note is posted,
     * a failed delivery is reported (`delivered: false`) rather than thrown, so the sender does not post it twice.
     */
    async fromSession(message: SessionMessage): Promise<{ messageId: string; url: string; delivered: boolean }> {
        const sb = this.#sb;
        const { binding, rootId, from } = message;
        const channel = channelOf(binding);
        await sb.conversations.ensure(binding, rootId);
        const note = `🔁 **From ${await this.#senderName(from)}:**\n\n${message.text}`;
        const { messageId } = await sb.conversations.post(
            channel,
            rootId,
            { text: note },
            { kind: 'session-message', sessionId: from.sessionId }
        );
        const at = sb.now();
        const header = sessionMessageHeader(from.sessionId, from.kind, from.rootId ?? 'none', at);
        const url = await sb.platform.messageUrl(channel, rootId, messageId);
        try {
            await this.#deliver(binding, rootId, {
                messageId,
                at,
                text: `${header}\n${neutralise(message.text)}`,
                images: [],
            });
        } catch (error) {
            sb.log.warn({ err: error, channelId: binding.channelId, rootId }, 'session message not delivered');
            const reason = error instanceof Error ? clip(error.message, 300) : 'unknown error';
            await this.#note(binding, rootId, `⚠️ The message above could not be passed to the agent: ${reason}.`);
            return { messageId, url, delivered: false };
        }
        return { messageId, url, delivered: true };
    }

    /** The sender as people in the target thread see it: its conversation's title, or its job. */
    async #senderName(from: SessionEntry): Promise<string> {
        const sb = this.#sb;
        if (!from.rootId) return 'a job of this channel';
        const conversation = await sb.conversations.get(from.channelId, from.rootId);
        if (conversation?.title) return clip(conversation.title, 200);
        const thread = await sb.platform.thread(channelOf(from), from.rootId).catch(() => undefined);
        return clip(titleOf(conversation, thread?.root), 200);
    }

    /** Gets a message to the thread's owning session, creating one (under a claim) when there is none. */
    async #deliver(binding: Binding, rootId: string, trigger: Trigger) {
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
                if (owner?.state === 'active' && (await this.#sendTo(owner, trigger))) return;
                await sb.conversations.detach(
                    binding.channelId,
                    rootId,
                    conversation.owningSession,
                    owner?.endReason ?? 'ended'
                );
                continue;
            }
            const now = sb.now();
            const claimedByOther =
                conversation.claimedBy &&
                conversation.claimedBy !== claim &&
                (conversation.claimedUntil ?? '') > now.toISOString();
            if (claimedByOther) {
                if (Date.now() > deadline) {
                    await this.#note(binding, rootId, '⚠️ A message could not be passed on yet; please send it again.');
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
            if (await this.#startSession(binding, claimed.value, claim, trigger)) return;
        }
    }

    /** Sends to an active owner; `false` when the session turned out to have ended (then a new one starts). */
    async #sendTo(owner: SessionEntry, trigger: Trigger): Promise<boolean> {
        const sb = this.#sb;
        try {
            await sb.sessions.send(owner, [textBlock(trigger.text), ...trigger.images]);
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

    /** Creates the thread's session; `false` when the claim was lost meanwhile (then the delivery starts over). */
    async #startSession(
        binding: Binding,
        conversation: Conversation,
        claim: string,
        trigger: Trigger
    ): Promise<boolean> {
        const sb = this.#sb;
        const { channelId, rootId } = conversation;
        try {
            const first = await this.#firstMessage(binding, conversation, trigger);
            const entry = await sb.sessions.create({
                binding,
                kind: 'conversation',
                deploymentId: binding.conversationDeploymentId,
                rootId,
                seq: conversation.sessionCount + 1,
                titleTime: timeOfMessageId(rootId) ?? new Date(conversation.createdAt),
                firstContent: first.content,
                files: first.files,
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
                      }
                    : undefined;
            });
            if (attached) return true;
            sb.log.warn({ sessionId: entry.sessionId, channelId }, 'claim lost while creating a session');
            // the extra session leaves the thread at once (nothing of it is posted) and is archived when idle
            const detached = await sb.sessions.modify(entry.sessionId, (current) => ({
                ...current,
                rootId: undefined,
            }));
            await sb.sessions.archive(detached?.value ?? entry, 'claim_lost').catch(() => false);
            return false;
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
            return true;
        }
    }

    /**
     * The first message of a new session. A new root post arrives on its own; in every other case the thread has
     * content already, which comes first, read from Teams (README: "Message formats").
     */
    async #firstMessage(binding: Binding, conversation: Conversation, trigger: Trigger): Promise<FirstMessage> {
        const sb = this.#sb;
        if (trigger.messageId === conversation.rootId) {
            return { content: [textBlock(trigger.text), ...trigger.images], files: [] };
        }
        const now = sb.now();
        const header =
            conversation.origin === 'start_new_conversation' && conversation.sessionCount === 0
                ? conversationStartHeader(conversation.originSession ?? 'none', new Date(conversation.createdAt))
                : continuationHeader(
                      conversation.previousSession ?? 'none',
                      conversation.previousReason ?? 'first_session',
                      now
                  );
        const history = await this.#history(binding, conversation, trigger);
        const placed = placeHistory(history.lines, sb.settings.historyInlineLimitBytes);
        const files: FileResource[] = [];
        if (!placed.inline) {
            const fileId = await sb.workspaces
                .get(binding.workspaceId)
                .uploadFile('conversation-history.md', 'text/markdown', Buffer.from(placed.file));
            await sb.entities.files.upsert({
                owner: conversationKey(binding.channelId, conversation.rootId),
                fileId,
                workspaceId: binding.workspaceId,
                kind: 'history',
                mediaType: 'text/markdown',
                name: 'conversation-history.md',
                size: Buffer.byteLength(placed.file),
                createdAt: now.toISOString(),
            });
            files.push({ type: 'file', file_id: fileId, mount_path: HISTORY_FILE_PATH });
        }
        return {
            content: [textBlock([header, placed.text, trigger.text].join('\n')), ...history.images, ...trigger.images],
            files,
        };
    }

    /**
     * The thread up to the message being delivered (which follows with its own header), and the images of its
     * latest messages. When Teams cannot be read, the session starts without it and the thread gets a note.
     */
    async #history(
        binding: Binding,
        conversation: Conversation,
        trigger: Trigger
    ): Promise<{ lines: string[]; images: ContentBlock[] }> {
        const sb = this.#sb;
        try {
            const history = await sb.history.read(channelOf(binding), conversation.rootId);
            const until = trigger.at.toISOString();
            const entries = history.entries.filter(
                (entry) => entry.messageId !== trigger.messageId && entry.at <= until
            );
            return {
                lines: formatHistory({ entries, truncated: history.truncated }),
                images: await sb.history.images(binding, conversation.rootId, entries),
            };
        } catch (error) {
            sb.log.warn({ err: error, channelId: binding.channelId }, 'thread history not read');
            const why = error instanceof ReadAccessError ? ' (Switchboard is not allowed to read this channel)' : '';
            await this.#note(
                binding,
                conversation.rootId,
                `ℹ️ The earlier messages of this thread could not be read${why}; the agent starts without them.`
            );
            const briefing = conversation.briefing
                ? [`Briefing (not shown in Teams):\n${neutralise(conversation.briefing)}`]
                : [];
            return { lines: ['The earlier messages of this thread could not be read.', ...briefing], images: [] };
        }
    }

    async #note(binding: Binding, rootId: string, text: string) {
        await this.#sb.conversations
            .post(channelOf(binding), rootId, { text }, { kind: 'note' })
            .catch((error: unknown) => {
                this.#sb.log.warn({ err: error, channelId: binding.channelId }, 'note not posted');
            });
    }
}
