import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from '../core/logger.ts';
import type { ClaudeApi, SessionEvent } from './api.ts';

/** How many recent MCP tool-use events of each running session are compared. */
const RECENT_TOOL_USES = 10;

export interface ToolCall {
    tool: string;
    /** The tool arguments; keys listed in `ignore` are left out of the comparison. */
    input: Record<string, unknown>;
    headers: Headers | undefined;
}

export interface ResolvedCaller {
    sessionId: string;
    via: 'events';
    /** The matched `agent.mcp_tool_use` event (when resolved through events). */
    eventId: string | undefined;
    eventAt: string | undefined;
}

export interface CallerResolverOptions {
    api: ClaudeApi;
    /** The `name` agents give this server in `mcp_servers`. */
    serverName: string;
    log: Logger;
    attempts?: number;
    retryDelayMs?: number;
}

/** Arguments with defaults filled in by the schema; left out so an omitted and a defaulted value compare equal. */
const IGNORED_KEYS = new Set(['link_thread']);

/** Deterministic JSON: object keys sorted at every level. */
export const canonicalJson = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        const entries = Object.entries(value)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    return JSON.stringify(value);
};

const comparable = (input: Record<string, unknown>) =>
    canonicalJson(Object.fromEntries(Object.entries(input).filter(([key]) => !IGNORED_KEYS.has(key))));

/** Whether a tool-use event is this call: same server name, tool name and arguments. */
export const matchesCall = (event: SessionEvent, serverName: string, call: Pick<ToolCall, 'tool' | 'input'>) =>
    event.type === 'agent.mcp_tool_use' &&
    event.mcp_server_name === serverName &&
    event.name === call.tool &&
    comparable(event.input) === comparable(call.input);

/**
 * Finds the agent session that made an MCP tool call, so a thread it posts can be linked to it: the one `running`
 * session whose recent `agent.mcp_tool_use` events contain this call (server name, tool, arguments). Returns
 * `undefined` when none or several match.
 *
 * The Managed Agents beta sends no header naming the calling session (MCP calls come from an Anthropic-side proxy),
 * and a header could not be trusted anyway: whoever holds an MCP token can call the endpoint directly and set any
 * header. The header names of the first request are logged, to notice when the platform adds one.
 */
export class CallerResolver {
    readonly #api: ClaudeApi;
    readonly #serverName: string;
    readonly #log: Logger;
    readonly #attempts: number;
    readonly #retryDelayMs: number;
    #headersLogged = false;

    constructor(options: CallerResolverOptions) {
        this.#api = options.api;
        this.#serverName = options.serverName;
        this.#log = options.log;
        this.#attempts = options.attempts ?? 3;
        this.#retryDelayMs = options.retryDelayMs ?? 1000;
    }

    async resolve(call: ToolCall): Promise<ResolvedCaller | undefined> {
        if (call.headers && !this.#headersLogged) {
            // Names only, never values: shows during rollout which headers the platform's MCP proxy sends.
            this.#headersLogged = true;
            this.#log.info({ headers: [...call.headers.keys()].sort() }, 'mcp request header names');
        }
        for (let attempt = 1; attempt <= this.#attempts; attempt++) {
            const matches = await this.#matchRunningSessions(call);
            if (matches.length === 1) {
                const [match] = matches;
                if (match)
                    return {
                        sessionId: match.sessionId,
                        via: 'events',
                        eventId: match.eventId,
                        eventAt: match.eventAt,
                    };
            }
            if (matches.length > 1) {
                this.#log.warn({ tool: call.tool, sessions: matches.map((m) => m.sessionId) }, 'ambiguous mcp caller');
                return undefined;
            }
            // The tool-use event may not be listable yet when the call arrives.
            if (attempt < this.#attempts) await sleep(this.#retryDelayMs);
        }
        return undefined;
    }

    async #matchRunningSessions(call: ToolCall) {
        const sessions = await this.#api.listRunningSessions();
        const matches = await Promise.all(
            sessions.map(async (session) => {
                const events = await this.#api.listEvents(session.id, {
                    types: ['agent.mcp_tool_use'],
                    order: 'desc',
                    max: RECENT_TOOL_USES,
                });
                const event = events.find((e) => matchesCall(e, this.#serverName, call));
                return event
                    ? { sessionId: session.id, eventId: event.id, eventAt: event.processed_at ?? undefined }
                    : undefined;
            })
        );
        return matches.filter((m) => m !== undefined);
    }
}
