import { APIError } from '@anthropic-ai/sdk';
import { CardError } from '../cards/cards.ts';
import type { SessionEvent } from '../claude/api.ts';
import { channelOf } from '../conversations/conversations.ts';
import { ReadAccessError } from '../core/platform.ts';
import { clip } from '../core/text.ts';
import type { ToolCall } from '../store/entities.ts';
import type { Switchboard } from '../switchboard.ts';
import { isToolName } from './definitions.ts';
import { ToolFailure, ToolHandlers, type WaitRequest } from './handlers.ts';

const READ_ACCESS_DENIED =
    'Switchboard is currently not allowed to read this channel’s messages. Switchboard has warned the channel ' +
    'and notified its admins, so there is no need to report it. Posting (your answers, send_update, ' +
    'start_new_conversation) still works.';

/** A tool's answer: text for the agent, with the error flag on failure. */
interface ToolResult {
    text: string;
    isError: boolean;
}

/**
 * `answered`: the result was sent. `waiting`: a `wait` call, answered later by `Waits`. `pending`: another pod
 * started the call moments ago and its result is not stored yet; the caller looks again later.
 */
export type CallState = 'answered' | 'waiting' | 'pending';

/**
 * Carries out Switchboard's custom tools (README: "Tools for agents"). Each call is carried out at most once:
 * its event ID is inserted before it runs and its result is stored, so a pod that takes over a session answers
 * pending calls from the stored result instead of repeating them.
 */
export class Tools {
    readonly #sb: Switchboard;
    readonly #handlers: ToolHandlers;

    constructor(sb: Switchboard) {
        this.#sb = sb;
        this.#handlers = new ToolHandlers(sb);
    }

    /** Answers a call, carrying it out the first time. */
    async handle(
        sessionId: string,
        event: Extract<SessionEvent, { type: 'agent.custom_tool_use' }>
    ): Promise<CallState> {
        const sb = this.#sb;
        const inserted = await sb.entities.toolCalls.insert({
            sessionId,
            eventId: event.id,
            tool: event.name,
            status: 'started',
            startedAt: sb.now().toISOString(),
        });
        if (!inserted) return this.#answerKnown(sessionId, event.id);
        const reply = await this.#run(sessionId, event.name, event.input);
        if ('wait' in reply) {
            await sb.entities.toolCalls.upsert({
                ...inserted.value,
                status: 'waiting',
                waitUntil: reply.wait.until,
                waitWatch: reply.wait.watch,
            });
            sb.log.info({ sessionId, until: reply.wait.until, watching: Boolean(reply.wait.watch) }, 'wait started');
            await this.#inputBeforeWait(sessionId, event.processed_at);
            return 'waiting';
        }
        const done: ToolCall = { ...inserted.value, status: 'done', result: reply.text, isError: reply.isError };
        await sb.entities.toolCalls.upsert(done);
        await this.deliver(done);
        sb.log.info({ sessionId, tool: event.name, error: reply.isError }, 'tool call answered');
        return 'answered';
    }

    /**
     * Input that reached the session after it called `wait` but before the wait was stored found no wait to end:
     * the wait ends now. Sessions record input (`lastInputAt`) before they look for waits, so one of the two sides
     * always sees the other.
     */
    async #inputBeforeWait(sessionId: string, calledAt: string | null) {
        const entry = await this.#sb.sessions.get(sessionId);
        if (calledAt && (entry?.lastInputAt ?? '') > calledAt) await this.#sb.waits.sessionInput(sessionId);
    }

    /** A call seen before: its result is sent unless it reached the session already. */
    async #answerKnown(sessionId: string, eventId: string): Promise<CallState> {
        const sb = this.#sb;
        const stored = await sb.entities.toolCalls.get(sessionId, eventId);
        if (!stored) return 'pending';
        if (stored.value.status === 'waiting') return 'waiting';
        if (stored.value.status === 'done') {
            await this.deliver(stored.value);
            return 'answered';
        }
        // only the lease holder carries out calls; a started call without result for longer than a lease was cut
        // off (its pod died): answer it as interrupted rather than carrying it out twice
        const age = sb.now().getTime() - Date.parse(stored.value.startedAt);
        if (age < sb.timing.leaseMs) return 'pending';
        const interrupted = await sb.entities.toolCalls.update(stored, {
            ...stored.value,
            status: 'done',
            isError: true,
            result: 'Switchboard was restarted while carrying out this call; it may or may not have taken effect. Check before repeating it.',
        });
        if (!interrupted) return 'pending';
        await this.deliver(interrupted.value);
        return 'answered';
    }

    /**
     * Sends a finished call's result to its session, once: the platform ignores repeats, but every repeat is an
     * event that wakes the relay again. A session that ended meanwhile no longer needs the result.
     */
    async deliver(call: ToolCall) {
        const sb = this.#sb;
        if (call.answeredAt) return;
        const entry = await sb.sessions.get(call.sessionId);
        if (!entry) return;
        try {
            await sb.workspaces.get(entry.workspaceId).sendEvents(call.sessionId, [
                {
                    type: 'user.custom_tool_result',
                    custom_tool_use_id: call.eventId,
                    content: [{ type: 'text', text: call.result ?? '' }],
                    is_error: call.isError ?? false,
                },
            ]);
        } catch (error) {
            if (!(error instanceof APIError) || (error.status !== 400 && error.status !== 404)) throw error;
            sb.log.info({ sessionId: call.sessionId, status: error.status }, 'tool result not accepted');
            // a session that is gone needs no result; one that refused it gets it again on its next pause
            if (error.status === 400) return;
        }
        await sb.entities.toolCalls.modify(call.sessionId, call.eventId, (current) =>
            current.answeredAt ? undefined : { ...current, answeredAt: sb.now().toISOString() }
        );
    }

    /** Runs a call; failures become error results the agent can act on. */
    async #run(sessionId: string, name: string, input: unknown): Promise<ToolResult | { wait: WaitRequest }> {
        const sb = this.#sb;
        try {
            if (!isToolName(name)) throw new ToolFailure(`unknown tool '${name}'`);
            const entry = await sb.sessions.get(sessionId);
            if (!entry || entry.state !== 'active') throw new ToolFailure('this session has ended');
            // after a disconnect nothing reaches the channel any more, also not from sessions still running
            const binding = (await sb.entities.bindings.get(entry.teamId, entry.channelId))?.value;
            if (!binding) throw new ToolFailure('the channel is no longer connected to Switchboard');
            const reply = await this.#handlers.run(name, { entry, binding, channel: channelOf(binding) }, input);
            return 'value' in reply ? { text: JSON.stringify(reply.value), isError: false } : reply;
        } catch (error) {
            if (error instanceof ToolFailure || error instanceof CardError) {
                return { text: `${name}: ${error.message}`, isError: true };
            }
            if (error instanceof ReadAccessError) {
                sb.log.info({ sessionId, tool: name }, 'tool call refused: no read access');
                return { text: `${name} failed: ${READ_ACCESS_DENIED}`, isError: true };
            }
            sb.log.warn({ err: error, sessionId, tool: name }, 'tool call failed');
            const message = error instanceof Error ? clip(error.message, 300) : 'unknown error';
            return { text: `${name} failed: ${message}`, isError: true };
        }
    }
}
