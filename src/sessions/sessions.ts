import type { OutgoingEvent } from '../claude/api.ts';
import type { ContentBlock, FileResource, SessionKind } from '../claude/templates.ts';
import { channelOf } from '../conversations/conversations.ts';
import { clip, splitMessage } from '../core/text.ts';
import { formatLocal } from '../core/time.ts';
import type { Binding, SessionEntry } from '../store/entities.ts';
import type { Switchboard } from '../switchboard.ts';

/** Shown in the thread while a turn runs; replaced by the answer. */
export const WORKING_TEXT = '⏳ Working…';

/** Why a session ended, as people read it. */
const END_REASONS: Record<string, string> = {
    terminated: 'it was terminated',
    deleted: 'it was deleted',
    error: 'it stopped with an error',
    budget_reached: 'it reached its budget',
    archived: 'it was archived',
};

export const endNotice = (reason: string) =>
    `ℹ️ The agent's session ended because ${END_REASONS[reason] ?? reason}. The next message starts a new session.`;

export interface CreateSessionInput {
    binding: Binding;
    kind: SessionKind;
    deploymentId: string;
    /** Conversations: the thread's root message. */
    rootId?: string;
    /** Jobs: the job and run. */
    jobId?: string;
    runKey?: string;
    /** Sequence number of the session in its thread. */
    seq: number;
    /** The thread's opening time (conversations) or the run's start (jobs). */
    titleTime: Date;
    firstContent?: ContentBlock[];
    files?: FileResource[];
}

/** Creating, messaging and ending sessions, and posting their answers into their threads. */
export class Sessions {
    readonly #sb: Switchboard;

    constructor(sb: Switchboard) {
        this.#sb = sb;
    }

    async get(sessionId: string): Promise<SessionEntry | undefined> {
        return (await this.#sb.entities.sessions.get(sessionId))?.value;
    }

    /** Read-modify-write of a session entry; `change` returns `undefined` to leave it unchanged. */
    modify(sessionId: string, change: (entry: SessionEntry) => SessionEntry | undefined) {
        return this.#sb.entities.sessions.modify(sessionId, '', change);
    }

    title(binding: Binding, kind: SessionKind, time: Date, seq: number) {
        const base = `${binding.channelName} · ${kind} · ${formatLocal(time, this.#sb.settings.defaultTimezone)}`;
        return seq > 1 ? `${base} · #${seq}` : base;
    }

    /**
     * Creates the session from the deployment template in one call (it starts running at once), records it and
     * starts following it: the creating pod holds its lease.
     */
    async create(input: CreateSessionInput): Promise<SessionEntry> {
        const sb = this.#sb;
        const { binding } = input;
        const built = await sb.templates.build({
            workspaceId: binding.workspaceId,
            deploymentId: input.deploymentId,
            kind: input.kind,
            title: this.title(binding, input.kind, input.titleTime, input.seq),
            metadata: {
                switchboard_binding: clip(binding.channelId, 500),
                switchboard_kind: input.kind,
                ...(input.rootId ? { switchboard_conversation: clip(input.rootId, 500) } : {}),
                ...(input.jobId && input.runKey
                    ? { switchboard_job_run: clip(`${input.jobId}/${input.runKey}`, 500) }
                    : {}),
            },
            ...(input.firstContent ? { firstContent: input.firstContent } : {}),
            ...(input.files ? { files: input.files } : {}),
        });
        const session = await sb.workspaces.get(binding.workspaceId).createSession(built.params);
        const now = sb.now();
        const entry: SessionEntry = {
            sessionId: session.id,
            workspaceId: binding.workspaceId,
            teamId: binding.teamId,
            channelId: binding.channelId,
            kind: input.kind,
            rootId: input.rootId,
            jobId: input.jobId,
            runKey: input.runKey,
            deploymentId: input.deploymentId,
            agentId: built.agentId,
            agentVersion: built.agentVersion,
            seq: input.seq,
            state: 'active',
            relayOwner: sb.podId,
            relayValidUntil: new Date(now.getTime() + sb.timing.leaseMs).toISOString(),
            createdAt: now.toISOString(),
            lastActivity: now.toISOString(),
        };
        await sb.entities.sessions.upsert(entry);
        sb.log.info(
            { sessionId: session.id, kind: input.kind, channelId: binding.channelId, agentVersion: built.agentVersion },
            'session created'
        );
        if (entry.rootId) await this.ensureWorking(entry);
        sb.relay.follow(session.id);
        return entry;
    }

    /** Sends a message to a session (also while it works: it queues behind earlier events) and follows it. */
    async send(entry: SessionEntry, content: ContentBlock[]) {
        await this.sendEvents(entry, [{ type: 'user.message', content }]);
    }

    /**
     * Sends events (messages, confirmations), records the activity and follows the session. Input for the session
     * ends its wait first, so it handles the input at once.
     */
    async sendEvents(entry: SessionEntry, events: OutgoingEvent[]) {
        const sb = this.#sb;
        // recorded before the waits are looked at, so a wait stored meanwhile sees the input (`Tools`)
        const now = sb.now().toISOString();
        const touched = await this.modify(entry.sessionId, (current) => ({
            ...current,
            lastActivity: now,
            lastInputAt: now,
        }));
        await sb.waits.sessionInput(entry.sessionId);
        await sb.workspaces.get(entry.workspaceId).sendEvents(entry.sessionId, events);
        if (touched?.value.rootId) await this.ensureWorking(touched.value);
        await sb.relay.wake(entry.sessionId);
    }

    /**
     * Posts the "working…" message in the session's thread unless one is shown already. It is a status, not a
     * message of the conversation: it is not attributed and becomes one only when the answer replaces it.
     */
    async ensureWorking(entry: SessionEntry) {
        const sb = this.#sb;
        if (!entry.rootId || entry.workingMessageId) return;
        const channel = channelOf(entry);
        let posted: string;
        try {
            posted = (await sb.platform.reply(channel, entry.rootId, { text: WORKING_TEXT })).messageId;
        } catch (error) {
            sb.log.warn({ err: error, sessionId: entry.sessionId }, 'working message not posted');
            return;
        }
        const written = await this.modify(entry.sessionId, (current) =>
            current.workingMessageId || current.state !== 'active'
                ? undefined
                : { ...current, workingMessageId: posted }
        );
        if (written?.value.workingMessageId !== posted) {
            await sb.platform.delete(channel, entry.rootId, posted).catch(() => undefined);
        }
    }

    /** Takes the "working…" message away; returns its ID so the caller can reuse it for the answer. */
    async takeWorking(sessionId: string): Promise<string | undefined> {
        let taken: string | undefined;
        await this.modify(sessionId, (current) => {
            taken = current.workingMessageId;
            return taken ? { ...current, workingMessageId: undefined } : undefined;
        });
        return taken;
    }

    /**
     * Posts text from the session into its thread: the final answer of a turn (replacing the "working…" message)
     * or an update. Empty final text removes the "working…" message and posts nothing.
     */
    async post(entry: SessionEntry, text: string, update: boolean): Promise<string | undefined> {
        const sb = this.#sb;
        if (!entry.rootId) return undefined;
        const channel = channelOf(entry);
        const options = { kind: update ? 'update' : 'answer', sessionId: entry.sessionId } as const;
        // the final answer replaces the "working…" message; an update moves it below itself, so the answer ends up
        // after the updates
        const working = await this.takeWorking(entry.sessionId);
        const chunks = splitMessage(text);
        if (working && (update || chunks.length === 0)) {
            await sb.platform.delete(channel, entry.rootId, working).catch(() => undefined);
        }
        let first: string | undefined;
        for (const [index, chunk] of chunks.entries()) {
            if (index === 0 && working && !update) {
                await sb.conversations.publish(channel, entry.rootId, working, { text: chunk }, options);
                first = working;
                continue;
            }
            const { messageId } = await sb.conversations.post(channel, entry.rootId, { text: chunk }, options);
            first ??= messageId;
        }
        if (update && working) await this.ensureWorking({ ...entry, workingMessageId: undefined });
        return first;
    }

    /** A notice from Switchboard in the session's thread. */
    async notice(entry: SessionEntry, text: string) {
        if (!entry.rootId) return;
        await this.#sb.conversations
            .post(channelOf(entry), entry.rootId, { text }, { kind: 'note' })
            .catch((error: unknown) => {
                this.#sb.log.warn({ err: error, sessionId: entry.sessionId }, 'notice not posted');
            });
    }

    /**
     * A session ended (terminated, deleted, budget, error, or archived by Switchboard). It leaves its thread, its
     * cards close for good, and the thread gets a notice, except after an archive for inactivity.
     */
    async end(sessionId: string, reason: string) {
        const sb = this.#sb;
        let ended: SessionEntry | undefined;
        await this.modify(sessionId, (current) => {
            if (current.state !== 'active') return undefined;
            ended = {
                ...current,
                state: reason === 'archived' ? 'archived' : 'ended',
                endReason: reason,
                endedAt: sb.now().toISOString(),
                relayOwner: undefined,
                relayValidUntil: undefined,
            };
            return ended;
        });
        if (!ended) return;
        sb.log.info({ sessionId, reason }, 'session ended');
        await this.leaveThread(ended, reason, reason !== 'archived' && !ended.stopping);
        if (ended.jobId && ended.runKey) await sb.jobs.sessionEnded(ended, reason);
    }

    /** Detaches the session from its thread and closes its cards; optionally posts the end notice. */
    async leaveThread(entry: SessionEntry, reason: string, notify: boolean) {
        const sb = this.#sb;
        if (!entry.rootId) return;
        const working = await this.takeWorking(entry.sessionId);
        if (working) await sb.platform.delete(channelOf(entry), entry.rootId, working).catch(() => undefined);
        await sb.conversations.detach(entry.channelId, entry.rootId, entry.sessionId, reason);
        await sb.cards.closeAll(entry.sessionId);
        if (notify) await this.notice(entry, endNotice(reason));
    }

    /** Interrupts the session's current turn (timeout, disconnect); `stopping` records why. */
    async interrupt(entry: SessionEntry, why: string) {
        const sb = this.#sb;
        await this.modify(entry.sessionId, (current) => ({ ...current, stopping: why }));
        await sb.workspaces.get(entry.workspaceId).sendEvents(entry.sessionId, [{ type: 'user.interrupt' }]);
        await sb.relay.wake(entry.sessionId);
    }

    /**
     * Archives an idle session through the API and treats it as ended without a notice. A running session is
     * interrupted instead and archived on a later attempt; returns whether it was archived.
     */
    async archive(entry: SessionEntry, why: string): Promise<boolean> {
        const sb = this.#sb;
        const api = sb.workspaces.get(entry.workspaceId);
        const session = await api.retrieveSession(entry.sessionId);
        if (session.status === 'running' || session.status === 'rescheduling') {
            await this.interrupt(entry, why);
            return false;
        }
        await this.modify(entry.sessionId, (current) => ({ ...current, stopping: why }));
        if (session.status !== 'terminated' && session.archived_at === null) await api.archiveSession(entry.sessionId);
        await this.end(entry.sessionId, 'archived');
        return true;
    }
}
