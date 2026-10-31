import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Response } from 'express';

type Json = Record<string, unknown>;

/** What the mocked agent sees and does during one turn. */
export interface Turn {
    sessionId: string;
    /** Text blocks of the user message(s) that started the turn. */
    text: string;
    /** The first message's full content (text and images). */
    content: Json[];
    say(text: string): void;
    /** Calls a custom tool and waits for Switchboard's result (`requires_action` meanwhile). */
    callTool(name: string, input: Json): Promise<{ text: string; isError: boolean }>;
    /** A built-in tool set to "always ask": waits for the confirmation. */
    askConfirmation(name: string, input: Json): Promise<string>;
    /** Ends the turn with another stop reason (default: `end_turn`). */
    stop(reason: string): void;
    /** Whether the turn was interrupted. */
    readonly interrupted: boolean;
}

interface MockSession {
    session: Json;
    events: Json[];
    streams: Set<Response>;
    queue: Json[][];
    running: boolean;
    turnState?: { interrupted: boolean; stopped: boolean };
    waiting: Map<string, (value: Json) => void>;
}

const error = (res: Response, status: number, message: string) =>
    res.status(status).json({
        type: 'error',
        error: { type: status === 404 ? 'not_found_error' : 'invalid_request_error', message },
    });

/** The platform's merge of a `multiagent_20261001` update into the stored configuration, member by member. */
const mergeMultiagent = (stored: Json | null, update: Json | null): Json | null => {
    if (!update || !stored || stored.type !== update.type || update.type !== 'multiagent_20261001') return update;
    const member = (key: string) =>
        update[key] === undefined ? stored[key] : { ...(stored[key] as Json), ...(update[key] as Json) };
    return { ...stored, advisor: member('advisor'), subagents: member('subagents'), workflows: member('workflows') };
};

const textOf = (content: Json[]) =>
    content
        .filter((block) => block.type === 'text')
        .map((block) => String(block.text))
        .join('\n');

/**
 * A stand-in for the Managed Agents API: deployments, agents (with versions), sessions created with initial
 * events, events (list, send, SSE stream), archive, delete and files. The agent's turns are scripted with `agent`.
 */
export class MockClaude {
    readonly sessions = new Map<string, MockSession>();
    readonly createRequests: Json[] = [];
    readonly deployments = new Map<string, Json>();
    readonly agents = new Map<string, Json[]>();
    readonly files = new Map<string, { name: string; size: number }>();
    readonly deletedFiles: string[] = [];
    readonly deletedSessions: string[] = [];
    /** Agent versions saved and deployments changed through the API (`POST /v1/agents/:id`, `/v1/deployments/:id`). */
    readonly agentUpdates: Json[] = [];
    readonly deploymentUpdates: Json[] = [];
    /** The agent: runs once per turn. The default answers "Echo: <last line>". */
    agent: (turn: Turn) => Promise<void> = async (turn) => {
        turn.say(`Echo: ${turn.text.split('\n').at(-1)}`);
    };
    url = '';
    #server: Server | undefined;
    #next = 1;

    addAgent(id: string, fields: { name?: string; system?: string; tools?: Json[]; multiagent?: Json | null } = {}) {
        const versions = this.agents.get(id) ?? [];
        const previous = versions.at(-1);
        versions.push({
            type: 'agent',
            id,
            version: versions.length + 1,
            name: fields.name ?? previous?.name ?? id,
            system: fields.system ?? previous?.system ?? 'You are the test agent.',
            tools: fields.tools ??
                previous?.tools ?? [{ type: 'agent_toolset_20260401', configs: [], default_config: {} }],
            mcp_servers: [],
            skills: [],
            multiagent: fields.multiagent !== undefined ? fields.multiagent : (previous?.multiagent ?? null),
            model: { id: 'claude-opus-5-5' },
            archived_at: null,
            created_at: '2026-10-31T00:00:00Z',
            description: null,
            metadata: {},
        });
        this.agents.set(id, versions);
    }

    addDeployment(id: string, fields: Json & { agentId: string; version?: number }) {
        const { agentId, version, ...rest } = fields;
        this.deployments.set(id, {
            type: 'deployment',
            id,
            name: id,
            agent: { type: 'agent', id: agentId, version: version ?? this.agents.get(agentId)?.length ?? 1 },
            environment_id: 'env_test',
            vault_ids: ['vlt_test'],
            resources: [],
            initial_events: [],
            schedule: null,
            status: 'active',
            paused_reason: null,
            archived_at: null,
            budget: null,
            created_at: '2026-10-31T00:00:00Z',
            updated_at: '2026-10-31T00:00:00Z',
            description: null,
            metadata: {},
            ...rest,
        });
    }

    /** Appends an event (with ID and time) and pushes it to open streams. */
    emit(sessionId: string, event: Json): Json {
        const session = this.sessions.get(sessionId);
        if (!session) throw new Error(`no session ${sessionId}`);
        const full: Json = { id: `sevt_${this.#next++}`, processed_at: new Date().toISOString(), ...event };
        session.events.push(full);
        if (event.type === 'session.status_running') session.session.status = 'running';
        if (event.type === 'session.status_idle') session.session.status = 'idle';
        if (event.type === 'session.status_terminated') session.session.status = 'terminated';
        for (const stream of session.streams)
            stream.write(`event: ${String(full.type)}\ndata: ${JSON.stringify(full)}\n\n`);
        return full;
    }

    /** Text of the user messages a session received, in order. */
    userMessages(sessionId: string): string[] {
        return (this.sessions.get(sessionId)?.events ?? [])
            .filter((e) => e.type === 'user.message')
            .map((e) => textOf(e.content as Json[]));
    }

    /** Ends a session from outside (as an operator would in the Console). */
    terminate(sessionId: string) {
        this.emit(sessionId, { type: 'session.status_terminated' });
    }

    #enqueue(id: string, content: Json[]) {
        const session = this.sessions.get(id);
        if (!session) return;
        session.queue.push(content);
        if (!session.running) void this.#runTurns(id);
    }

    async #runTurns(id: string) {
        const session = this.sessions.get(id);
        if (!session || session.running) return;
        session.running = true;
        while (session.queue.length > 0 && session.session.status !== 'terminated') {
            const batch = session.queue.splice(0, session.queue.length);
            const state = { interrupted: false, stopped: false };
            session.turnState = state;
            this.emit(id, { type: 'session.status_running' });
            const idle = (stop: Json) => {
                if (state.stopped) return;
                state.stopped = true;
                this.emit(id, { type: 'session.status_idle', stop_reason: stop, stop_details: null });
            };
            const wait = (eventId: string) =>
                new Promise<Json>((resolve) => {
                    session.waiting.set(eventId, (value) => {
                        session.waiting.delete(eventId);
                        if (!state.interrupted) this.emit(id, { type: 'session.status_running' });
                        resolve(value);
                    });
                });
            const turn: Turn = {
                sessionId: id,
                text: batch.map(textOf).join('\n'),
                content: batch[0] ?? [],
                say: (text) => {
                    if (!state.interrupted) this.emit(id, { type: 'agent.message', content: [{ type: 'text', text }] });
                },
                callTool: async (name, input) => {
                    const event = this.emit(id, { type: 'agent.custom_tool_use', name, input });
                    this.emit(id, {
                        type: 'session.status_idle',
                        stop_reason: { type: 'requires_action', event_ids: [event.id] },
                        stop_details: null,
                    });
                    const result = await wait(String(event.id));
                    return { text: textOf((result.content as Json[]) ?? []), isError: result.is_error === true };
                },
                askConfirmation: async (name, input) => {
                    const event = this.emit(id, { type: 'agent.tool_use', name, input, evaluated_permission: 'ask' });
                    this.emit(id, {
                        type: 'session.status_idle',
                        stop_reason: { type: 'requires_action', event_ids: [event.id] },
                        stop_details: null,
                    });
                    return String((await wait(String(event.id))).result);
                },
                stop: (reason) => idle({ type: reason }),
                get interrupted() {
                    return state.interrupted;
                },
            };
            try {
                await this.agent(turn);
            } catch {
                // a failing script ends the turn
            }
            idle({ type: 'end_turn' });
        }
        session.running = false;
    }

    async start() {
        const app = express();
        app.use(express.json({ limit: '10mb' }));
        const session = (id: string) => this.sessions.get(id);

        app.get('/v1/deployments', (_req, res) => {
            res.json({ data: [...this.deployments.values()].filter((d) => d.archived_at === null), next_page: null });
        });
        app.get('/v1/deployments/:id', (req, res) => {
            const deployment = this.deployments.get(req.params.id);
            if (!deployment) return void error(res, 404, 'deployment not found');
            res.json(deployment);
        });
        app.get('/v1/agents/:id', (req, res) => {
            const versions = this.agents.get(req.params.id);
            if (!versions) return void error(res, 404, 'agent not found');
            const version = req.query.version ? Number(req.query.version) : versions.length;
            const agent = versions[version - 1];
            if (!agent) return void error(res, 404, 'version not found');
            res.json(agent);
        });

        app.post('/v1/agents/:id', (req, res) => {
            const versions = this.agents.get(req.params.id);
            const latest = versions?.at(-1);
            if (!versions || !latest) return void error(res, 404, 'agent not found');
            const body = req.body as Json;
            if (body.version !== undefined && body.version !== latest.version) {
                return void error(res, 409, 'version is not the current version');
            }
            const { version: _version, multiagent, ...fields } = body;
            const next: Json = { ...latest, ...fields, version: versions.length + 1 };
            if (multiagent !== undefined)
                next.multiagent = mergeMultiagent(latest.multiagent as Json | null, multiagent as Json | null);
            versions.push(next);
            this.agentUpdates.push({ id: req.params.id, ...body });
            res.json(next);
        });
        app.post('/v1/deployments/:id', (req, res) => {
            const deployment = this.deployments.get(req.params.id);
            if (!deployment) return void error(res, 404, 'deployment not found');
            const { agent, ...fields } = req.body as Json;
            Object.assign(deployment, fields);
            if (agent && typeof agent === 'object') {
                const { id, version } = agent as Json;
                deployment.agent = { type: 'agent', id, version };
            }
            this.deploymentUpdates.push({ id: req.params.id, ...(req.body as Json) });
            res.json(deployment);
        });

        app.post('/v1/sessions', (req, res) => {
            const body = req.body as Json;
            const id = `sesn_mock${this.#next++}`;
            this.createRequests.push(body);
            this.sessions.set(id, {
                session: {
                    type: 'session',
                    id,
                    status: 'idle',
                    title: body.title,
                    metadata: body.metadata ?? {},
                    archived_at: null,
                },
                events: [],
                streams: new Set(),
                queue: [],
                running: false,
                waiting: new Map(),
            });
            const initial = (body.initial_events as Json[] | undefined) ?? [];
            for (const event of initial) this.emit(id, { ...event });
            const messages = initial.filter((e) => e.type === 'user.message');
            if (messages.length > 0) {
                const created = this.sessions.get(id);
                if (created) created.session.status = 'running';
                this.#enqueue(
                    id,
                    messages.flatMap((e) => e.content as Json[])
                );
            }
            res.json(this.sessions.get(id)?.session);
        });
        app.get('/v1/sessions/:id', (req, res) => {
            const found = session(req.params.id);
            if (!found) return void error(res, 404, 'session not found');
            res.json(found.session);
        });
        app.post('/v1/sessions/:id/archive', (req, res) => {
            const found = session(req.params.id);
            if (!found) return void error(res, 404, 'session not found');
            if (found.session.status === 'running') return void error(res, 400, 'session is running');
            found.session.archived_at = new Date().toISOString();
            this.emit(req.params.id, { type: 'session.status_terminated' });
            res.json(found.session);
        });
        app.delete('/v1/sessions/:id', (req, res) => {
            if (!this.sessions.delete(req.params.id)) return void error(res, 404, 'session not found');
            this.deletedSessions.push(req.params.id);
            res.json({ id: req.params.id, type: 'session_deleted' });
        });
        app.get('/v1/sessions/:id/events/stream', (req, res) => {
            const found = session(req.params.id);
            if (!found) return void res.status(404).end();
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
            res.write(': connected\n\n');
            found.streams.add(res);
            req.on('close', () => found.streams.delete(res));
        });
        app.get('/v1/sessions/:id/events', (req, res) => {
            const found = session(req.params.id);
            if (!found) return void res.status(404).end();
            let data = [...found.events];
            if (req.query.order === 'desc') data = data.reverse();
            const limit = req.query.limit ? Number(req.query.limit) : data.length;
            res.json({ data: data.slice(0, Math.max(limit, data.length)), next_page: null });
        });
        app.post('/v1/sessions/:id/events', (req, res) => {
            const id = req.params.id;
            const found = session(id);
            if (!found) return void error(res, 404, 'session not found');
            if (found.session.status === 'terminated') return void error(res, 400, 'session is terminated');
            const sent = ((req.body as { events: Json[] }).events ?? []).map((event) => this.emit(id, { ...event }));
            res.json({ data: sent });
            for (const event of sent) {
                if (event.type === 'user.message') this.#enqueue(id, event.content as Json[]);
                if (event.type === 'user.custom_tool_result')
                    found.waiting.get(String(event.custom_tool_use_id))?.(event);
                if (event.type === 'user.tool_confirmation') found.waiting.get(String(event.tool_use_id))?.(event);
                if (event.type === 'user.interrupt' && found.turnState && !found.turnState.stopped) {
                    found.turnState.interrupted = true;
                    found.turnState.stopped = true;
                    this.emit(id, {
                        type: 'session.status_idle',
                        stop_reason: { type: 'end_turn' },
                        stop_details: null,
                    });
                    for (const resolve of [...found.waiting.values()])
                        resolve({ content: [], is_error: true, result: 'deny' });
                }
            }
        });

        app.post('/v1/files', express.raw({ type: () => true, limit: '20mb' }), (req, res) => {
            const id = `file_mock${this.#next++}`;
            const name = /filename="([^"]+)"/.exec(String(req.body))?.[1] ?? 'file';
            this.files.set(id, { name, size: Buffer.isBuffer(req.body) ? req.body.byteLength : 0 });
            res.json({
                id,
                type: 'file',
                filename: name,
                mime_type: 'application/octet-stream',
                size_bytes: 0,
                created_at: new Date().toISOString(),
            });
        });
        app.delete('/v1/files/:id', (req, res) => {
            this.files.delete(req.params.id);
            this.deletedFiles.push(req.params.id);
            res.json({ id: req.params.id, type: 'file_deleted' });
        });

        await new Promise<void>((resolve) => {
            this.#server = app.listen(0, '127.0.0.1', () => resolve());
        });
        const address = this.#server?.address() as AddressInfo | undefined;
        this.url = `http://127.0.0.1:${address?.port}`;
    }

    async stop() {
        for (const s of this.sessions.values()) for (const stream of s.streams) stream.end();
        this.#server?.closeAllConnections();
        await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
    }
}
