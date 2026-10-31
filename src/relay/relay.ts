import { APIError } from '@anthropic-ai/sdk';
import type { SessionEvent } from '../claude/api.ts';
import { messageText } from '../claude/api.ts';
import { KeyedMutex } from '../core/mutex.ts';
import { sleep } from '../core/time.ts';
import type { SessionEntry } from '../store/entities.ts';
import type { Switchboard } from '../switchboard.ts';

/** Events listed again before the watermark's time, as a margin for clock differences. */
const WATERMARK_SLACK_MS = 5 * 60 * 1000;
const STREAM_RETRY_MS = 5_000;

type IdleEvent = Extract<SessionEvent, { type: 'session.status_idle' }>;
type ToolUseEvent = Extract<SessionEvent, { type: 'agent.tool_use' | 'agent.mcp_tool_use' }>;

/** Turn-ending stop reasons other than `end_turn` and `requires_action`, as notices for the thread. */
const STOP_NOTICES: Record<string, string> = {
    retries_exhausted: '⚠️ The agent’s turn failed after several retries. Send a message to try again.',
    refusal: '⚠️ The agent declined to continue this turn.',
};

/** An event that fails this often in a row is skipped. */
const MAX_EVENT_FAILURES = 3;

/** `stopping` reasons that mean "archive once idle". */
const STOP_TO_ARCHIVE = ['disconnected', 'retention', 'inactive', 'claim_lost'];

type Outcome = 'next' | 'pending' | 'ended';

interface TurnState {
    byId: Map<string, SessionEvent>;
    finalText: string;
    waitingForPeople: boolean;
    settled: boolean;
}

interface Follower {
    abort: AbortController;
    renew: ReturnType<typeof setInterval>;
    poll: ReturnType<typeof setInterval>;
}

/**
 * Follows sessions that are working (README: "Operations"). One pod follows a session at a
 * time, holding the session lease in the store (renewed every 20 s, valid for 60 s). The holder drains the
 * session's events from the stored watermark: it answers custom tool calls, posts final answers and handles
 * pauses and ends. A session waiting only for a person or for the end of a `wait` holds no lease.
 *
 * Draining is idempotent: the watermark only advances at stable points (turn end, pause, end), so a pod that
 * takes over repeats the open turn's events, and tool calls are carried out at most once (`Tools`).
 */
export class Relay {
    readonly #sb: Switchboard;
    readonly #followers = new Map<string, Follower>();
    readonly #mutex = new KeyedMutex();
    readonly #rerun = new Set<string>();
    /** Failed attempts per event ID, so a permanently failing event is skipped. */
    readonly #failures = new Map<string, number>();
    #closed = false;

    constructor(sb: Switchboard) {
        this.#sb = sb;
    }

    isFollowing(sessionId: string) {
        return this.#followers.has(sessionId);
    }

    /** Takes the lease if it is free or expired; `true` when this pod holds it now. */
    async acquire(sessionId: string): Promise<boolean> {
        const sb = this.#sb;
        const stored = await sb.entities.sessions.get(sessionId);
        if (!stored || stored.value.state !== 'active') return false;
        const now = sb.now();
        const { relayOwner, relayValidUntil } = stored.value;
        const free = !relayOwner || !relayValidUntil || relayValidUntil <= now.toISOString();
        if (relayOwner !== sb.podId && !free) return false;
        const written = await sb.entities.sessions.update(stored, {
            ...stored.value,
            relayOwner: sb.podId,
            relayValidUntil: new Date(now.getTime() + sb.timing.leaseMs).toISOString(),
        });
        return written !== undefined;
    }

    /** Starts following a session whose lease this pod holds. */
    follow(sessionId: string) {
        if (this.#closed || this.#followers.has(sessionId)) {
            this.#schedule(sessionId);
            return;
        }
        const sb = this.#sb;
        const abort = new AbortController();
        const follower: Follower = {
            abort,
            renew: setInterval(() => void this.#renew(sessionId), sb.timing.renewMs),
            poll: setInterval(() => this.#schedule(sessionId), sb.timing.drainIntervalMs),
        };
        follower.renew.unref();
        follower.poll.unref();
        this.#followers.set(sessionId, follower);
        this.#schedule(sessionId);
        void this.#stream(sessionId, abort.signal);
    }

    /** Something happened to the session (a message was sent, a webhook, the reconciler): follow it if possible. */
    async wake(sessionId: string) {
        if (this.#closed) return;
        if (this.#followers.has(sessionId)) {
            this.#schedule(sessionId);
            return;
        }
        if (await this.acquire(sessionId)) this.follow(sessionId);
    }

    /** Stops following everything and releases the leases, so other pods take over at once. */
    async close() {
        this.#closed = true;
        const sessions = [...this.#followers.keys()];
        for (const sessionId of sessions) this.#stop(sessionId);
        await Promise.all(sessions.map((sessionId) => this.#release(sessionId).catch(() => undefined)));
    }

    #stop(sessionId: string) {
        const follower = this.#followers.get(sessionId);
        if (!follower) return;
        follower.abort.abort();
        clearInterval(follower.renew);
        clearInterval(follower.poll);
        this.#followers.delete(sessionId);
    }

    /**
     * Extends the lease. Other writes to the session entry (messages, the drain) make an ETag update fail now and
     * then, so it retries; it gives up only when the lease belongs to someone else or the session ended.
     */
    async #renew(sessionId: string) {
        const sb = this.#sb;
        try {
            for (let attempt = 0; attempt < 8; attempt++) {
                const stored = await sb.entities.sessions.get(sessionId);
                const ours = stored?.value.relayOwner === sb.podId && stored.value.state === 'active';
                if (!stored || !ours) break;
                const renewed = await sb.entities.sessions.update(stored, {
                    ...stored.value,
                    relayValidUntil: new Date(sb.now().getTime() + sb.timing.leaseMs).toISOString(),
                });
                if (renewed) return;
            }
            // lost the lease (or the session ended): stop at once, another pod may follow it now
            this.#stop(sessionId);
            sb.log.info({ sessionId }, 'session lease lost');
        } catch (error) {
            sb.log.warn({ err: error, sessionId }, 'session lease not renewed');
        }
    }

    async #release(sessionId: string) {
        const sb = this.#sb;
        await sb.entities.sessions.modify(sessionId, '', (current) =>
            current.relayOwner === sb.podId
                ? { ...current, relayOwner: undefined, relayValidUntil: undefined }
                : undefined
        );
    }

    /** Runs a drain for the session; one at a time, with one more run if something arrived meanwhile. */
    #schedule(sessionId: string) {
        if (this.#rerun.has(sessionId)) return;
        this.#rerun.add(sessionId);
        void this.#mutex
            .run(sessionId, async () => {
                this.#rerun.delete(sessionId);
                if (!this.#followers.has(sessionId)) return;
                await this.#drain(sessionId);
            })
            .catch((error: unknown) => {
                this.#sb.log.warn({ err: error, sessionId }, 'session events not relayed');
            });
    }

    /** The live stream only signals that something happened; draining reads the events themselves. */
    async #stream(sessionId: string, signal: AbortSignal) {
        const sb = this.#sb;
        while (!signal.aborted) {
            try {
                const entry = await sb.sessions.get(sessionId);
                if (!entry) return;
                const stream = await sb.workspaces.get(entry.workspaceId).streamEvents(sessionId, signal);
                this.#schedule(sessionId);
                for await (const _event of stream) this.#schedule(sessionId);
            } catch (error) {
                if (signal.aborted) return;
                sb.log.debug({ err: error, sessionId }, 'session stream interrupted');
            }
            if (!signal.aborted) await sleep(STREAM_RETRY_MS);
        }
    }

    async #eventsAfterWatermark(entry: SessionEntry): Promise<SessionEvent[]> {
        const api = this.#sb.workspaces.get(entry.workspaceId);
        const mark = entry.watermarkEventId;
        if (!mark) return api.listEvents(entry.sessionId);
        const since = entry.watermarkAt
            ? new Date(Date.parse(entry.watermarkAt) - WATERMARK_SLACK_MS).toISOString()
            : undefined;
        let events = await api.listEvents(entry.sessionId, since ? { processedAtGte: since } : {});
        let index = events.findIndex((event) => event.id === mark);
        if (index < 0) {
            events = await api.listEvents(entry.sessionId);
            index = events.findIndex((event) => event.id === mark);
        }
        if (index < 0) {
            this.#sb.log.warn({ sessionId: entry.sessionId }, 'watermark not found; continuing after the latest event');
            const last = events.at(-1);
            if (last) await this.#advance(entry.sessionId, last);
            return [];
        }
        return events.slice(index + 1);
    }

    async #advance(sessionId: string, event: SessionEvent) {
        const sb = this.#sb;
        await sb.sessions.modify(sessionId, (current) =>
            current.relayOwner === sb.podId
                ? { ...current, watermarkEventId: event.id, watermarkAt: event.processed_at ?? current.watermarkAt }
                : undefined
        );
    }

    async #drain(sessionId: string) {
        const sb = this.#sb;
        const entry = await sb.sessions.get(sessionId);
        if (!entry || entry.relayOwner !== sb.podId) {
            this.#stop(sessionId);
            return;
        }
        if (entry.state !== 'active') {
            this.#stop(sessionId);
            await this.#release(sessionId);
            return;
        }
        const events = await this.#eventsAfterWatermark(entry);
        const turn: TurnState = {
            byId: new Map(events.map((e) => [e.id, e])),
            finalText: '',
            waitingForPeople: false,
            settled: false,
        };
        for (const event of events) {
            let outcome: Outcome;
            try {
                outcome = await this.#process(sessionId, event, turn);
                this.#failures.delete(event.id);
            } catch (error) {
                // a failure is retried with the next drain; one that keeps failing is skipped, so it cannot block
                // the session for good (for example a thread deleted in Teams)
                const failures = (this.#failures.get(event.id) ?? 0) + 1;
                this.#failures.set(event.id, failures);
                if (failures < MAX_EVENT_FAILURES) throw error;
                this.#failures.delete(event.id);
                sb.log.warn({ err: error, sessionId, eventId: event.id, type: event.type }, 'session event skipped');
                if (event.type === 'session.status_idle') await this.#advance(sessionId, event);
                continue;
            }
            if (outcome === 'ended') {
                this.#stop(sessionId);
                return;
            }
            // a tool call that cannot be answered yet: keep the watermark before it and look again later
            if (outcome === 'pending') return;
        }
        if (turn.settled) {
            await this.#maybeRelease(sessionId, turn.waitingForPeople);
            return;
        }
        if (events.length === 0) await this.#checkQuiet(entry);
    }

    async #process(sessionId: string, event: SessionEvent, turn: TurnState): Promise<Outcome> {
        const sb = this.#sb;
        switch (event.type) {
            case 'agent.message': {
                const text = messageText(event);
                if (text) turn.finalText = text;
                return 'next';
            }
            case 'agent.custom_tool_use':
                // text before a tool call is not the turn's final answer
                turn.finalText = '';
                await sb.tools.handle(sessionId, event);
                return 'next';
            case 'agent.tool_use':
            case 'agent.mcp_tool_use':
                turn.finalText = '';
                return 'next';
            case 'session.status_running':
                turn.settled = false;
                return 'next';
            case 'session.status_idle': {
                const entry = await sb.sessions.get(sessionId);
                if (!entry) return 'ended';
                const result = await this.#idle(entry, event, turn);
                if (result === 'pending') return 'pending';
                turn.finalText = '';
                turn.settled = true;
                turn.waitingForPeople = result === 'people';
                await this.#advance(sessionId, event);
                if (entry.stopping && STOP_TO_ARCHIVE.includes(entry.stopping) && result !== 'agent') {
                    // disconnected (or expired) while it was running: archive it now that it is idle
                    await sb.sessions.archive(entry, entry.stopping);
                    return 'ended';
                }
                return 'next';
            }
            case 'session.status_terminated':
            case 'session.deleted':
                await this.#advance(sessionId, event);
                await sb.sessions.end(sessionId, event.type === 'session.deleted' ? 'deleted' : 'terminated');
                return 'ended';
            case 'session.error':
                sb.log.info(
                    { sessionId, error: event.error.type, retry: event.error.retry_status.type },
                    'session error'
                );
                return 'next';
            default:
                return 'next';
        }
    }

    /**
     * A turn ended or paused: `people` when the session now waits for people (or nothing), `agent` when it goes
     * on by itself (tool results answered), `pending` when a tool call cannot be answered yet.
     */
    async #idle(entry: SessionEntry, event: IdleEvent, turn: TurnState): Promise<'people' | 'agent' | 'pending'> {
        const sb = this.#sb;
        const stop = event.stop_reason;
        switch (stop.type) {
            case 'end_turn':
                if (entry.rootId) await sb.sessions.post(entry, turn.finalText, false);
                if (entry.jobId && entry.runKey) await sb.jobs.turnEnded(entry, turn.finalText);
                return 'people';
            case 'requires_action':
                return this.#requiresAction(entry, stop.event_ids, turn.byId);
            case 'budget_reached':
                if (entry.rootId && turn.finalText) await sb.sessions.post(entry, turn.finalText, false);
                await sb.sessions.end(entry.sessionId, 'budget_reached');
                return 'people';
            default: {
                if (entry.rootId) {
                    await sb.sessions.post(entry, turn.finalText, false);
                    await sb.sessions.notice(
                        entry,
                        STOP_NOTICES[stop.type] ?? `⚠️ The agent’s turn ended (${stop.type}).`
                    );
                }
                if (entry.jobId && entry.runKey) await sb.jobs.turnFailed(entry, stop.type);
                return 'people';
            }
        }
    }

    /**
     * The session waits for tool results (Switchboard answers its own), for confirmations (people answer) or for
     * the end of a `wait`. While anything stays open the session waits for the outside world (`people`): its
     * lease is released, and whoever answers wakes it.
     */
    async #requiresAction(
        entry: SessionEntry,
        eventIds: string[],
        byId: Map<string, SessionEvent>
    ): Promise<'people' | 'agent' | 'pending'> {
        const sb = this.#sb;
        const missing = eventIds.filter((id) => !byId.has(id));
        if (missing.length > 0) {
            const recent = await sb.workspaces.get(entry.workspaceId).listEvents(entry.sessionId, {
                order: 'desc',
                max: 200,
            });
            for (const event of recent) if (!byId.has(event.id)) byId.set(event.id, event);
        }
        const confirmations: ToolUseEvent[] = [];
        let pending = false;
        let waiting = false;
        for (const id of eventIds) {
            const event = byId.get(id);
            if (event?.type === 'agent.custom_tool_use') {
                const state = await sb.tools.handle(entry.sessionId, event);
                if (state === 'pending') pending = true;
                if (state === 'waiting') waiting = true;
            } else if (event?.type === 'agent.tool_use' || event?.type === 'agent.mcp_tool_use') {
                confirmations.push(event);
            }
        }
        if (pending) return 'pending';
        if (confirmations.length > 0) {
            let current = entry;
            if (!current.rootId) current = (await sb.jobs.moveToThread(current, 'needs_confirmation')) ?? current;
            for (const event of confirmations) await sb.cards.askConfirmation(current, event);
        }
        return waiting || confirmations.length > 0 ? 'people' : 'agent';
    }

    /** After a turn ended: release the lease when the session is really idle, else keep following. */
    async #maybeRelease(sessionId: string, waitingForPeople: boolean) {
        const sb = this.#sb;
        if (!waitingForPeople) return;
        const entry = await sb.sessions.get(sessionId);
        if (!entry || entry.state !== 'active') {
            this.#stop(sessionId);
            return;
        }
        const session = await sb.workspaces.get(entry.workspaceId).retrieveSession(sessionId);
        if (session.status !== 'idle') return;
        this.#stop(sessionId);
        await this.#release(sessionId);
        // a message may have arrived between the check and the release: look once more
        const again = await sb.workspaces.get(entry.workspaceId).retrieveSession(sessionId);
        if (again.status === 'running') await this.wake(sessionId);
    }

    /**
     * Nothing new after the watermark (the session was woken late, by a webhook or the reconciler): release an
     * idle session, end one that was archived or deleted without an event.
     */
    async #checkQuiet(entry: SessionEntry) {
        const sb = this.#sb;
        let session: Awaited<ReturnType<ReturnType<typeof sb.workspaces.get>['retrieveSession']>>;
        try {
            session = await sb.workspaces.get(entry.workspaceId).retrieveSession(entry.sessionId);
        } catch (error) {
            if (error instanceof APIError && error.status === 404) {
                await sb.sessions.end(entry.sessionId, 'deleted');
                this.#stop(entry.sessionId);
                return;
            }
            throw error;
        }
        if (session.status === 'terminated' || session.archived_at !== null) {
            await sb.sessions.end(entry.sessionId, entry.stopping ? 'archived' : 'terminated');
            this.#stop(entry.sessionId);
            return;
        }
        if (session.status === 'idle') await this.#maybeRelease(entry.sessionId, true);
    }
}
