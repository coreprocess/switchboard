import { clip, neutralise } from '../core/text.ts';
import { conversationKey, type ToolCall, type Versioned } from '../store/entities.ts';
import type { Query } from '../store/store.ts';
import type { Switchboard } from '../switchboard.ts';

/**
 * The `wait` tool (concept: "Waiting"): a session pauses until its deadline, a new message in a conversation it
 * watches, or something for itself. A waiting call is a stored tool call with status `waiting`; the session holds
 * no lease meanwhile. Every pod's timer answers due waits, and the pod that sees a message answers the waits on
 * its conversation. Each wait is answered once: the change from `waiting` to `done` is a conditional write.
 */

export const MAX_WAIT_MINUTES = 5;

/** A message as a waiting session learns about it, in brief. */
export interface SeenMessage {
    from: string;
    at: string;
    text: string;
}

type WaitResult =
    | { reason: 'timeout' }
    | { reason: 'own_message' }
    | { reason: 'conversation_message'; conversation_id: string; message: SeenMessage };

export class Waits {
    readonly #sb: Switchboard;
    #timer: ReturnType<typeof setInterval> | undefined;

    constructor(sb: Switchboard) {
        this.#sb = sb;
    }

    start() {
        this.#timer = setInterval(() => void this.tick(), this.#sb.timing.waitTickMs);
        this.#timer.unref();
    }

    stop() {
        if (this.#timer) clearInterval(this.#timer);
    }

    /** Answers the waits whose deadline has passed. */
    async tick() {
        const sb = this.#sb;
        try {
            const due = await sb.entities.toolCalls.list({
                where: [
                    { field: 'status', op: 'eq', value: 'waiting' },
                    { field: 'waitUntil', op: 'le', value: sb.now().toISOString() },
                ],
            });
            for (const call of due) await this.#answer(call, { reason: 'timeout' });
        } catch (error) {
            sb.log.warn({ err: error }, 'wait tick failed');
        }
    }

    /**
     * A new message in a conversation: the waits watching it end. Best effort: whoever reports the message has
     * posted or delivered it already, and a wait that is not ended here ends at its deadline.
     */
    async conversationMessage(channelId: string, rootId: string, message: SeenMessage) {
        const brief = {
            from: clip(neutralise(message.from), 200),
            at: message.at,
            text: clip(neutralise(message.text), 500),
        };
        await this.#endWaits(
            { where: [{ field: 'waitWatch', op: 'eq', value: conversationKey(channelId, rootId) }] },
            { reason: 'conversation_message', conversation_id: rootId, message: brief }
        );
    }

    /** Something arrives for the session itself (a reply, a click, a session message): its wait ends first. */
    async sessionInput(sessionId: string) {
        await this.#endWaits({ partitionKey: sessionId }, { reason: 'own_message' });
    }

    async #endWaits(query: Query, result: WaitResult) {
        const sb = this.#sb;
        try {
            const waiting = await sb.entities.toolCalls.list({
                ...query,
                where: [...(query.where ?? []), { field: 'status', op: 'eq', value: 'waiting' }],
            });
            for (const call of waiting) await this.#answer(call, result);
        } catch (error) {
            sb.log.warn({ err: error, reason: result.reason }, 'waits not ended');
        }
    }

    async #answer(stored: Versioned<ToolCall>, result: WaitResult) {
        const sb = this.#sb;
        const { sessionId } = stored.value;
        const done = await sb.entities.toolCalls.update(stored, {
            ...stored.value,
            status: 'done',
            result: JSON.stringify(result),
            isError: false,
        });
        // another pod answered it first
        if (!done) return;
        try {
            await sb.tools.deliver(done.value);
        } catch (error) {
            // waiting again, so a later tick answers it; the session's relay is not following it meanwhile
            sb.log.warn({ err: error, sessionId }, 'wait result not sent');
            await sb.entities.toolCalls.update(done, stored.value);
            return;
        }
        sb.log.info({ sessionId, reason: result.reason }, 'wait ended');
        await sb.relay.wake(sessionId);
    }
}
