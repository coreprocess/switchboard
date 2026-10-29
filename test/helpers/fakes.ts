import type {
    ClaudeApi,
    DeploymentRun,
    ListEventsOptions,
    OutgoingEvent,
    Session,
    SessionEvent,
    StreamEvent,
    WebhookEvent,
} from '../../src/claude/api.ts';
import type { ChannelGateway, OutboundContent } from '../../src/core/gateway.ts';

const now = () => new Date().toISOString();

export const agentMessage = (id: string, text: string): SessionEvent => ({
    id,
    type: 'agent.message',
    content: [{ type: 'text', text }],
    processed_at: now(),
});

export const idle = (
    id: string,
    stopReason: Extract<SessionEvent, { type: 'session.status_idle' }>['stop_reason'] = { type: 'end_turn' }
): SessionEvent => ({
    id,
    type: 'session.status_idle',
    processed_at: now(),
    stop_details: null,
    stop_reason: stopReason,
});

export const running = (id: string): SessionEvent => ({ id, type: 'session.status_running', processed_at: now() });

export const terminated = (id: string): SessionEvent => ({
    id,
    type: 'session.status_terminated',
    processed_at: now(),
});

export const mcpToolUse = (
    id: string,
    name: string,
    input: Record<string, unknown>,
    serverName = 'switchboard',
    evaluatedPermission: 'allow' | 'ask' | 'deny' = 'allow'
): SessionEvent => ({
    id,
    type: 'agent.mcp_tool_use',
    name,
    input,
    mcp_server_name: serverName,
    evaluated_permission: evaluatedPermission,
    processed_at: now(),
});

export const sessionError = (id: string, retrying: boolean): SessionEvent => ({
    id,
    type: 'session.error',
    processed_at: now(),
    error: {
        type: 'unknown_error',
        message: 'boom',
        retry_status: retrying ? { type: 'retrying' } : { type: 'terminal' },
    },
});

interface FakeSession {
    status: Session['status'];
    params: unknown;
    events: SessionEvent[];
    listeners: Set<(event: StreamEvent) => void>;
}

/** An in-memory Managed Agents API: sessions with event lists and live streams. */
export class FakeClaudeApi implements ClaudeApi {
    readonly sessions = new Map<string, FakeSession>();
    readonly sent: { sessionId: string; events: OutgoingEvent[] }[] = [];
    readonly streamsOpened: string[] = [];
    failSend: Error | undefined;
    #next = 1;

    addSession(id: string, status: Session['status'] = 'idle', events: SessionEvent[] = []) {
        this.sessions.set(id, { status, params: undefined, events: [...events], listeners: new Set() });
    }

    /** Appends an event to the session's history and pushes it to open streams. */
    emit(sessionId: string, event: SessionEvent) {
        const session = this.#session(sessionId);
        session.events.push(event);
        for (const listener of session.listeners) listener(event);
    }

    #session(id: string): FakeSession {
        const session = this.sessions.get(id);
        if (!session) throw new Error(`no session ${id}`);
        return session;
    }

    async createSession(params: unknown) {
        const id = `sesn_fake${this.#next++}`;
        this.sessions.set(id, { status: 'idle', params, events: [], listeners: new Set() });
        return { id, status: 'idle' } as Session;
    }

    async retrieveSession(sessionId: string) {
        return { id: sessionId, status: this.#session(sessionId).status, title: 'Test' } as Session;
    }

    async sendEvents(sessionId: string, events: OutgoingEvent[]) {
        if (this.failSend) throw this.failSend;
        const session = this.#session(sessionId);
        this.sent.push({ sessionId, events });
        return events.map((event) => {
            const id = `sevt_user${this.#next++}`;
            session.events.push({ ...event, id, processed_at: null } as SessionEvent);
            return id;
        });
    }

    async listEvents(sessionId: string, options: ListEventsOptions = {}) {
        let events = [...this.#session(sessionId).events];
        if (options.types) events = events.filter((e) => options.types?.some((type) => type === e.type));
        if (options.order === 'desc') events.reverse();
        return options.max === undefined ? events : events.slice(0, options.max);
    }

    async streamEvents(sessionId: string, signal: AbortSignal): Promise<AsyncIterable<StreamEvent>> {
        const session = this.#session(sessionId);
        this.streamsOpened.push(sessionId);
        const queue: StreamEvent[] = [];
        let wake: (() => void) | undefined;
        const listener = (event: StreamEvent) => {
            queue.push(event);
            wake?.();
        };
        session.listeners.add(listener);
        signal.addEventListener('abort', () => wake?.());
        return {
            async *[Symbol.asyncIterator]() {
                try {
                    while (!signal.aborted) {
                        const event = queue.shift();
                        if (event) {
                            yield event;
                            continue;
                        }
                        await new Promise<void>((resolve) => {
                            wake = resolve;
                        });
                    }
                } finally {
                    session.listeners.delete(listener);
                }
            },
        };
    }

    async listRunningSessions() {
        return [...this.sessions.entries()]
            .filter(([, s]) => s.status === 'running')
            .map(([id]) => ({ id, status: 'running' }) as Session);
    }

    async retrieveDeploymentRun(runId: string) {
        return { id: runId, error: { type: 'agent_archived_error', message: 'agent archived' } } as DeploymentRun;
    }

    unwrapWebhook(body: string, _headers: Record<string, string>): WebhookEvent {
        return JSON.parse(body) as WebhookEvent;
    }
}

export interface PostedMessage {
    channelKey: string;
    rootId: string;
    messageId: string;
    content: OutboundContent;
    deleted: boolean;
}

/** Records everything posted, like a channel would show it. */
export class FakeGateway implements ChannelGateway {
    readonly topLevel: { channelKey: string; rootId: string; content: OutboundContent }[] = [];
    readonly messages: PostedMessage[] = [];
    readonly updates: { messageId: string; content: OutboundContent }[] = [];
    #next = 1000;

    async postTopLevel(channelKey: string, content: OutboundContent) {
        const rootId = String(this.#next++);
        this.topLevel.push({ channelKey, rootId, content });
        return { rootId, url: `https://teams.example.com/${rootId}` };
    }

    async reply(channelKey: string, rootId: string, content: OutboundContent) {
        const messageId = String(this.#next++);
        this.messages.push({ channelKey, rootId, messageId, content, deleted: false });
        return { messageId };
    }

    async update(_channelKey: string, _rootId: string, messageId: string, content: OutboundContent) {
        const message = this.messages.find((m) => m.messageId === messageId);
        if (!message) throw new Error(`no message ${messageId}`);
        message.content = content;
        this.updates.push({ messageId, content });
    }

    async delete(_channelKey: string, _rootId: string, messageId: string) {
        const message = this.messages.find((m) => m.messageId === messageId);
        if (message) message.deleted = true;
    }

    /** Visible messages in a thread, as text (cards as `[card]`). */
    visible(rootId: string): string[] {
        return this.messages.filter((m) => m.rootId === rootId && !m.deleted).map((m) => m.content.text ?? '[card]');
    }
}

/** Waits until `check` holds, polling. */
export const eventually = async (check: () => boolean | Promise<boolean>, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error('condition not met in time');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};
