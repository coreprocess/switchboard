import { APIError } from '@anthropic-ai/sdk';
import { CardError } from '../cards/cards.ts';
import type { SessionEvent } from '../claude/api.ts';
import { clip } from '../core/text.ts';
import type { SessionEntry, ToolCall } from '../store/entities.ts';
import type { Switchboard } from '../switchboard.ts';
import { isToolName, ToolInputs, type ToolName } from './definitions.ts';

/** A tool's answer: text for the agent, with the error flag on failure. */
interface ToolResult {
    text: string;
    isError: boolean;
}

/** A failure the agent can act on; its message becomes the tool result. */
export class ToolFailure extends Error {}

const ok = (value: Record<string, unknown>): ToolResult => ({ text: JSON.stringify(value), isError: false });

/**
 * Carries out Switchboard's custom tools (concept: "Tools for agents"). Each call is carried out at most once:
 * its event ID is inserted before it runs and its result is stored, so a pod that takes over a session answers
 * pending calls from the stored result instead of repeating them.
 */
export class Tools {
    readonly #sb: Switchboard;

    constructor(sb: Switchboard) {
        this.#sb = sb;
    }

    /**
     * Answers a call (carrying it out the first time); `pending` when another pod started it moments ago and its
     * result is not stored yet: the caller looks again later.
     */
    async handle(
        sessionId: string,
        event: Extract<SessionEvent, { type: 'agent.custom_tool_use' }>
    ): Promise<'answered' | 'pending'> {
        const sb = this.#sb;
        const startedAt = sb.now().toISOString();
        const inserted = await sb.entities.toolCalls.insert({
            sessionId,
            eventId: event.id,
            tool: event.name,
            status: 'started',
            startedAt,
        });
        if (!inserted) return this.#answerKnown(sessionId, event.id);
        const result = await this.#run(sessionId, event.name, event.input);
        await sb.entities.toolCalls.upsert({
            ...inserted.value,
            status: 'done',
            result: result.text,
            isError: result.isError,
        });
        await this.#send(sessionId, event.id, result);
        sb.log.info({ sessionId, tool: event.name, error: result.isError }, 'tool call answered');
        return 'answered';
    }

    /** A call seen before: send its stored result again (the platform ignores duplicates). */
    async #answerKnown(sessionId: string, eventId: string): Promise<'answered' | 'pending'> {
        const sb = this.#sb;
        const stored = await sb.entities.toolCalls.get(sessionId, eventId);
        if (!stored) return 'pending';
        let call: ToolCall = stored.value;
        if (call.status === 'started') {
            // only the lease holder carries out calls; a started call without result for longer than a lease was
            // cut off (its pod died): answer it as interrupted rather than carrying it out twice
            const age = sb.now().getTime() - Date.parse(call.startedAt);
            if (age < sb.timing.leaseMs) return 'pending';
            call = {
                ...call,
                status: 'done',
                isError: true,
                result: 'Switchboard was restarted while carrying out this call; it may or may not have taken effect. Check before repeating it.',
            };
            const written = await sb.entities.toolCalls.update(stored, call);
            if (!written) return 'pending';
        }
        await this.#send(sessionId, eventId, { text: call.result ?? '', isError: call.isError ?? false });
        return 'answered';
    }

    async #send(sessionId: string, eventId: string, result: ToolResult) {
        const sb = this.#sb;
        const entry = await sb.sessions.get(sessionId);
        if (!entry) return;
        try {
            await sb.workspaces.get(entry.workspaceId).sendEvents(sessionId, [
                {
                    type: 'user.custom_tool_result',
                    custom_tool_use_id: eventId,
                    content: [{ type: 'text', text: result.text }],
                    is_error: result.isError,
                },
            ]);
        } catch (error) {
            // the session ended in the meantime: nobody waits for the result any more
            if (error instanceof APIError && (error.status === 400 || error.status === 404)) {
                sb.log.info({ sessionId, eventId, status: error.status }, 'tool result not accepted');
                return;
            }
            throw error;
        }
    }

    async #run(sessionId: string, name: string, input: unknown): Promise<ToolResult> {
        try {
            if (!isToolName(name)) throw new ToolFailure(`unknown tool '${name}'`);
            const entry = await this.#sb.sessions.get(sessionId);
            if (!entry || entry.state !== 'active') throw new ToolFailure('this session has ended');
            return await this.#call(entry, name, input);
        } catch (error) {
            if (error instanceof ToolFailure || error instanceof CardError) {
                return { text: `${name}: ${error.message}`, isError: true };
            }
            this.#sb.log.warn({ err: error, sessionId, tool: name }, 'tool call failed');
            const message = error instanceof Error ? clip(error.message, 300) : 'unknown error';
            return { text: `${name} failed: ${message}`, isError: true };
        }
    }

    async #call(entry: SessionEntry, name: ToolName, input: unknown): Promise<ToolResult> {
        const sb = this.#sb;
        const parsed = ToolInputs[name].safeParse(input);
        if (!parsed.success)
            throw new ToolFailure(`invalid input: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
        // after a disconnect nothing reaches the channel any more, also not from sessions still running
        const binding = await this.#binding(entry);
        switch (name) {
            case 'start_new_conversation': {
                const args = ToolInputs.start_new_conversation.parse(input);
                const { conversation, url } = await sb.conversations.createThread({
                    binding,
                    text: args.message,
                    origin: 'start_new_conversation',
                    originSession: entry.sessionId,
                    ...(args.briefing ? { briefing: args.briefing } : {}),
                });
                return ok({ conversation_id: conversation.conversationId, url });
            }
            case 'convert_to_conversation': {
                const args = ToolInputs.convert_to_conversation.parse(input);
                if (entry.rootId) throw new ToolFailure('this session already owns a conversation');
                if (entry.kind !== 'job') throw new ToolFailure('only job sessions can be converted');
                const { conversation, url } = await sb.conversations.createThread({
                    binding,
                    text: args.message,
                    origin: 'convert_to_conversation',
                    owningSession: entry.sessionId,
                    originSession: entry.sessionId,
                });
                const converted = await sb.sessions.modify(entry.sessionId, (current) => ({
                    ...current,
                    rootId: conversation.rootId,
                }));
                if (entry.jobId && entry.runKey) await sb.jobs.markConverted(entry.jobId, entry.runKey);
                if (converted) await sb.sessions.ensureWorking(converted.value);
                return ok({ conversation_id: conversation.conversationId, url });
            }
            case 'send_update': {
                const args = ToolInputs.send_update.parse(input);
                if (!entry.rootId) {
                    throw new ToolFailure(
                        'this session has no conversation yet; use convert_to_conversation or start_new_conversation'
                    );
                }
                const messageId = await sb.sessions.post(entry, args.text, true);
                return ok({ message_id: messageId ?? null });
            }
            case 'show_card': {
                const args = ToolInputs.show_card.parse(input);
                return ok({ card_id: await sb.cards.show(entry, args.card) });
            }
            case 'update_card': {
                const args = ToolInputs.update_card.parse(input);
                await sb.cards.update(entry, args.card_id, args.card);
                return ok({ ok: true });
            }
        }
    }

    async #binding(entry: SessionEntry) {
        const binding = (await this.#sb.entities.bindings.get(entry.teamId, entry.channelId))?.value;
        if (!binding) throw new ToolFailure('the channel is no longer connected to Switchboard');
        return binding;
    }
}
