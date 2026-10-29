import { setTimeout as sleep } from 'node:timers/promises';
import { postApprovalCard } from '../approvals/post.ts';
import { type ClaudeApi, messageText, type OutgoingEvent, type SessionEvent, type StreamEvent } from '../claude/api.ts';
import type { ChannelGateway } from '../core/gateway.ts';
import type { Logger } from '../core/logger.ts';
import { KeyedMutex } from '../core/mutex.ts';
import { clip, splitMessage } from '../core/text.ts';
import type { SessionRecord, Store } from '../store/store.ts';

export const WORKING_TEXT = '⏳ Working…';
export const TERMINATED_NOTICE = 'This agent session has ended. Mention me in a new post to start a new one.';

/** Stream events after which the event list has something to relay. */
const DRAIN_TRIGGERS = new Set<StreamEvent['type']>([
    'session.status_idle',
    'session.status_terminated',
    'session.error',
]);

/** Listings start this long before the watermark's time, so clock skew cannot hide the watermark event. */
const WATERMARK_SLACK_MS = 5 * 60_000;

export interface Thread {
    channelKey: string;
    rootId: string;
}

export interface RelayOptions {
    api: ClaudeApi;
    store: Store;
    gateway: ChannelGateway;
    log: Logger;
    approvalExpiryHours: number | undefined;
    reconnectDelayMs?: number;
    /** A drain triggered by an event retries the listing until the event shows up. */
    listAttempts?: number;
    listRetryDelayMs?: number;
}

type IdleEvent = Extract<SessionEvent, { type: 'session.status_idle' }>;
type ErrorEvent = Extract<SessionEvent, { type: 'session.error' }>;
type ToolUseEvent = Extract<SessionEvent, { type: 'agent.tool_use' | 'agent.mcp_tool_use' }>;

const idleNotice = (stopReason: IdleEvent['stop_reason']): string | undefined => {
    switch (stopReason.type) {
        case 'budget_reached':
            return '⚠️ The session reached its budget and paused. Raise or remove the budget in the Claude Console to continue.';
        case 'retries_exhausted':
            return '⚠️ The agent stopped after repeated errors.';
        case 'refusal':
            return '⚠️ The agent declined to continue.';
        default:
            return undefined;
    }
};

const errorNotice = (event: ErrorEvent) => `⚠️ Agent error (${event.error.type}): ${clip(event.error.message, 500)}`;

const isToolUse = (event: SessionEvent): event is ToolUseEvent =>
    event.type === 'agent.tool_use' || event.type === 'agent.mcp_tool_use';

/**
 * Moves agent output into Teams threads.
 *
 * Switchboard opens a session's live stream whenever it sends something into the session and uses the stream only
 * as a wake-up signal. What gets relayed always comes from the session's event list after the session's watermark,
 * so the stream, webhooks and the reconciler run the same idempotent pass (`drain`), and a dropped stream or a
 * restart loses nothing.
 *
 * Only turns Switchboard started (`pending`) have their `agent.message` text relayed; output of turns it did not
 * start, such as the rest of a scheduled run after `post_message`, is skipped. Tool confirmations, errors and the
 * session's end are posted either way.
 */
export class Relay {
    readonly #api: ClaudeApi;
    readonly #store: Store;
    readonly #gateway: ChannelGateway;
    readonly #log: Logger;
    readonly #expiryHours: number | undefined;
    readonly #reconnectDelayMs: number;
    readonly #listAttempts: number;
    readonly #listRetryDelayMs: number;
    readonly #mutex = new KeyedMutex();
    readonly #streams = new Map<string, AbortController>();
    #closed = false;

    constructor(options: RelayOptions) {
        this.#api = options.api;
        this.#store = options.store;
        this.#gateway = options.gateway;
        this.#log = options.log;
        this.#expiryHours = options.approvalExpiryHours;
        this.#reconnectDelayMs = options.reconnectDelayMs ?? 2000;
        this.#listAttempts = options.listAttempts ?? 4;
        this.#listRetryDelayMs = options.listRetryDelayMs ?? 500;
    }

    /**
     * Links a thread to a session. A session can be linked to several threads; its relay state follows the thread
     * a turn started in. `watermark` is the event after which relaying starts (for threads an agent posted).
     */
    async link(
        thread: Thread,
        sessionId: string,
        createdBy: string,
        watermark?: { eventId: string | undefined; at: string | undefined }
    ): Promise<void> {
        await this.#mutex.run(sessionId, async () => {
            const now = new Date().toISOString();
            await this.#store.putThread({ ...thread, sessionId, createdAt: now, createdBy });
            const existing = await this.#store.getSession(sessionId);
            if (existing?.pending) return;
            await this.#save({
                sessionId,
                channelKey: thread.channelKey,
                rootId: thread.rootId,
                watermarkEventId: watermark?.eventId ?? existing?.watermarkEventId,
                watermarkAt: watermark?.at ?? existing?.watermarkAt,
                pending: false,
                lastSentEventId: existing?.lastSentEventId,
                workingMessageId: undefined,
                updatedAt: now,
            });
        });
    }

    sendUserMessage(sessionId: string, thread: Thread, text: string): Promise<void> {
        return this.#send(sessionId, thread, [{ type: 'user.message', content: [{ type: 'text', text }] }]);
    }

    sendToolConfirmation(sessionId: string, thread: Thread, toolUseId: string, allow: boolean, by: string) {
        return this.#send(sessionId, thread, [
            {
                type: 'user.tool_confirmation',
                tool_use_id: toolUseId,
                result: allow ? 'allow' : 'deny',
                ...(allow ? {} : { deny_message: `Denied by ${by} in Teams.` }),
            },
        ]);
    }

    /**
     * Sends events into a session: opens the stream first, shows the "working…" message, marks the turn as
     * pending and moves the watermark to the sent events when this starts a new turn.
     */
    async #send(sessionId: string, thread: Thread, events: OutgoingEvent[]): Promise<void> {
        await this.#mutex.run(sessionId, async () => {
            const record = await this.#store.getSession(sessionId);
            if (!record) throw new Error(`session ${sessionId} is not linked to a thread`);
            const startsTurn = !record.pending;
            if (startsTurn) {
                record.channelKey = thread.channelKey;
                record.rootId = thread.rootId;
            }
            if (!record.workingMessageId) {
                const { messageId } = await this.#gateway.reply(record.channelKey, record.rootId, {
                    text: WORKING_TEXT,
                });
                record.workingMessageId = messageId;
            }
            record.pending = true;
            await this.#save(record);
            // Stream first, inside the lock: a drain running concurrently would otherwise close it again.
            await this.ensureStream(sessionId);
            let ids: string[];
            try {
                ids = await this.#api.sendEvents(sessionId, events);
            } catch (error) {
                if (startsTurn) {
                    record.pending = false;
                    await this.#removeWorking(record);
                    await this.#save(record);
                    this.closeStream(sessionId);
                }
                throw error;
            }
            const last = ids.at(-1);
            if (last) {
                record.lastSentEventId = last;
                if (startsTurn) {
                    record.watermarkEventId = last;
                    record.watermarkAt = new Date().toISOString();
                }
                await this.#save(record);
            }
        });
    }

    /** Opens the session's live stream unless it is open; failures are logged, the reconciler catches up. */
    async ensureStream(sessionId: string): Promise<void> {
        if (this.#closed || this.#streams.has(sessionId)) return;
        const controller = new AbortController();
        this.#streams.set(sessionId, controller);
        let stream: AsyncIterable<StreamEvent>;
        try {
            stream = await this.#api.streamEvents(sessionId, controller.signal);
        } catch (error) {
            this.#streams.delete(sessionId);
            this.#log.warn({ err: error, sessionId }, 'could not open session stream');
            return;
        }
        void this.#consume(sessionId, controller, stream);
    }

    isStreaming(sessionId: string): boolean {
        return this.#streams.has(sessionId);
    }

    closeStream(sessionId: string): void {
        this.#streams.get(sessionId)?.abort();
        this.#streams.delete(sessionId);
    }

    /** Closes all streams; used on shutdown. */
    close(): void {
        this.#closed = true;
        for (const controller of this.#streams.values()) controller.abort();
        this.#streams.clear();
    }

    async #consume(sessionId: string, controller: AbortController, stream: AsyncIterable<StreamEvent>) {
        try {
            for await (const event of stream) {
                if (!DRAIN_TRIGGERS.has(event.type) || !('id' in event)) continue;
                this.drain(sessionId, event.id).catch((error: unknown) =>
                    this.#log.error({ err: error, sessionId }, 'relay failed')
                );
            }
        } catch (error) {
            if (!controller.signal.aborted) this.#log.warn({ err: error, sessionId }, 'session stream failed');
        } finally {
            if (this.#streams.get(sessionId) === controller) this.#streams.delete(sessionId);
        }
        if (controller.signal.aborted || this.#closed) return;
        // The stream ended on its own: catch up, then reconnect while the turn still runs.
        try {
            await sleep(this.#reconnectDelayMs);
            await this.drain(sessionId);
            if ((await this.#store.getSession(sessionId))?.pending) await this.ensureStream(sessionId);
        } catch (error) {
            this.#log.error({ err: error, sessionId }, 'stream reconnect failed');
        }
    }

    /**
     * Relays everything after the session's watermark that is complete: a turn's text once the session goes idle,
     * tool confirmation cards, notices for errors, budget pauses and the session's end. Safe to call any time.
     */
    drain(sessionId: string, expectEventId?: string): Promise<void> {
        return this.#mutex.run(sessionId, () => this.#drain(sessionId, expectEventId));
    }

    async #drain(sessionId: string, expectEventId: string | undefined) {
        const record = await this.#store.getSession(sessionId);
        if (!record) return;
        let events = await this.#eventsAfterWatermark(record);
        if (events === undefined) return;
        for (
            let attempt = 1;
            expectEventId &&
            expectEventId !== record.watermarkEventId &&
            !events.some((e) => e.id === expectEventId) &&
            attempt < this.#listAttempts;
            attempt++
        ) {
            await sleep(this.#listRetryDelayMs);
            events = (await this.#eventsAfterWatermark(record)) ?? [];
        }

        const text: string[] = [];
        // The turn Switchboard waits for ends at an idle after the last event it sent; an idle before that ends
        // an earlier turn while the latest message is still queued.
        let sentSeen = !record.lastSentEventId || !events.some((e) => e.id === record.lastSentEventId);
        for (const event of events) {
            if (event.id === record.lastSentEventId) sentSeen = true;
            switch (event.type) {
                case 'agent.message': {
                    const message = messageText(event);
                    if (record.pending && message) text.push(message);
                    break;
                }
                case 'session.status_idle':
                    await this.#flush(record, text, idleNotice(event.stop_reason));
                    if (event.stop_reason.type === 'requires_action') {
                        await this.#requestConfirmations(record, event.stop_reason.event_ids, events);
                    }
                    if (sentSeen || event.stop_reason.type !== 'end_turn') record.pending = false;
                    await this.#advance(record, event);
                    break;
                case 'session.error':
                    if (event.error.retry_status.type === 'retrying') break;
                    await this.#flush(record, text, errorNotice(event));
                    await this.#advance(record, event);
                    break;
                case 'session.status_terminated':
                    await this.#flush(record, text, TERMINATED_NOTICE);
                    record.pending = false;
                    await this.#advance(record, event);
                    break;
                default:
                    break;
            }
        }
        if (!record.pending) this.closeStream(sessionId);
    }

    /** Events after the watermark; `undefined` when the watermark was lost and has been reset (nothing relayed). */
    async #eventsAfterWatermark(record: SessionRecord): Promise<SessionEvent[] | undefined> {
        const mark = record.watermarkEventId;
        if (!mark) return this.#api.listEvents(record.sessionId);
        const since = record.watermarkAt
            ? new Date(Date.parse(record.watermarkAt) - WATERMARK_SLACK_MS).toISOString()
            : undefined;
        let events = await this.#api.listEvents(record.sessionId, since ? { createdAtGte: since } : {});
        let index = events.findIndex((e) => e.id === mark);
        if (index < 0 && since) {
            events = await this.#api.listEvents(record.sessionId);
            index = events.findIndex((e) => e.id === mark);
        }
        if (index >= 0) return events.slice(index + 1);
        const last = events.at(-1);
        this.#log.warn(
            { sessionId: record.sessionId, mark },
            'watermark event not found, skipping to the latest event'
        );
        if (last) await this.#advance(record, last);
        return undefined;
    }

    /** Posts collected text and a notice into the thread, replacing the "working…" message with the first part. */
    async #flush(record: SessionRecord, text: string[], notice: string | undefined) {
        const parts = text.splice(0);
        if (notice) parts.push(notice);
        const chunks = parts.length > 0 ? splitMessage(parts.join('\n\n')) : [];
        const [first, ...rest] = chunks;
        if (first === undefined) {
            await this.#removeWorking(record);
            return;
        }
        const working = record.workingMessageId;
        record.workingMessageId = undefined;
        if (working) {
            try {
                await this.#gateway.update(record.channelKey, record.rootId, working, { text: first });
            } catch (error) {
                this.#log.warn({ err: error, sessionId: record.sessionId }, 'could not update working message');
                await this.#gateway.reply(record.channelKey, record.rootId, { text: first });
            }
        } else {
            await this.#gateway.reply(record.channelKey, record.rootId, { text: first });
        }
        for (const chunk of rest) await this.#gateway.reply(record.channelKey, record.rootId, { text: chunk });
    }

    async #removeWorking(record: SessionRecord) {
        const working = record.workingMessageId;
        if (!working) return;
        record.workingMessageId = undefined;
        try {
            await this.#gateway.delete(record.channelKey, record.rootId, working);
        } catch (error) {
            this.#log.warn({ err: error, sessionId: record.sessionId }, 'could not delete working message');
        }
    }

    /** Posts a confirmation card for each tool call the session waits on. */
    async #requestConfirmations(record: SessionRecord, eventIds: string[], events: SessionEvent[]) {
        for (const eventId of eventIds) {
            const event = events.find((e): e is ToolUseEvent => e.id === eventId && isToolUse(e));
            if (!event || event.evaluated_permission !== 'ask') continue;
            const tool = event.type === 'agent.mcp_tool_use' ? `${event.mcp_server_name} / ${event.name}` : event.name;
            await postApprovalCard(
                this.#store,
                this.#gateway,
                {
                    // Deterministic, so a repeated pass does not post the card twice.
                    cardId: `tc_${event.id}`,
                    kind: 'tool_confirmation',
                    sessionId: record.sessionId,
                    channelKey: record.channelKey,
                    rootId: record.rootId,
                    title: `Allow tool call: ${tool}?`,
                    summary: 'The agent is waiting for confirmation before it runs this tool.',
                    steps: [clip(JSON.stringify(event.input, null, 2), 1500)],
                    toolUseId: event.id,
                },
                this.#expiryHours
            );
        }
    }

    async #advance(record: SessionRecord, event: SessionEvent) {
        record.watermarkEventId = event.id;
        record.watermarkAt = ('processed_at' in event ? event.processed_at : undefined) ?? new Date().toISOString();
        await this.#save(record);
    }

    async #save(record: SessionRecord) {
        record.updatedAt = new Date().toISOString();
        await this.#store.putSession(record);
    }
}
