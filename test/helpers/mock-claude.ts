import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Response } from 'express';

type Json = Record<string, unknown>;

interface MockSession {
    session: Json;
    events: Json[];
    streams: Set<Response>;
}

const queryList = (query: Record<string, unknown>, name: string): string[] => {
    const value = query[name] ?? query[`${name}[]`];
    if (value === undefined) return [];
    return (Array.isArray(value) ? value : [value]).map(String);
};

/**
 * A small stand-in for the Managed Agents API: sessions, events (list, send, SSE stream). By default every
 * `user.message` gets an echo turn: running, `agent.message`, idle with `end_turn`.
 */
export class MockClaude {
    readonly sessions = new Map<string, MockSession>();
    readonly createRequests: Json[] = [];
    /** Replaces the default echo turn; return `true` when handled. */
    onUserMessage: ((sessionId: string, text: string) => boolean) | undefined;
    url = '';
    #server: Server | undefined;
    #next = 1;

    addSession(id: string, status: string, events: Json[] = []) {
        this.sessions.set(id, {
            session: { id, type: 'session', status, title: id, metadata: {} },
            events: [],
            streams: new Set(),
        });
        for (const event of events) this.emit(id, event);
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

    /** Text of the user messages a session received. */
    userMessages(sessionId: string): string[] {
        return (this.sessions.get(sessionId)?.events ?? [])
            .filter((e) => e.type === 'user.message')
            .map((e) => ((e.content as { text: string }[])[0]?.text ?? '').toString());
    }

    echo(sessionId: string, text: string) {
        setTimeout(() => {
            this.emit(sessionId, { type: 'session.status_running' });
            this.emit(sessionId, { type: 'agent.message', content: [{ type: 'text', text }] });
            this.emit(sessionId, {
                type: 'session.status_idle',
                stop_reason: { type: 'end_turn' },
                stop_details: null,
            });
        }, 30);
    }

    async start() {
        const app = express();
        app.use(express.json());
        const session = (id: string) => this.sessions.get(id);

        app.post('/v1/sessions', (req, res) => {
            const id = `sesn_mock${this.#next++}`;
            this.createRequests.push(req.body as Json);
            this.addSession(id, 'idle');
            res.json(this.sessions.get(id)?.session);
        });
        app.get('/v1/sessions', (req, res) => {
            const statuses = queryList(req.query, 'statuses');
            const data = [...this.sessions.values()]
                .map((s) => s.session)
                .filter((s) => statuses.length === 0 || statuses.includes(String(s.status)));
            res.json({ data, next_page: null, prev_page: null });
        });
        app.get('/v1/sessions/:id', (req, res) => {
            const found = session(req.params.id);
            if (!found)
                return void res
                    .status(404)
                    .json({ type: 'error', error: { type: 'not_found_error', message: 'not found' } });
            res.json(found.session);
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
            const types = queryList(req.query, 'types');
            let data = found.events.filter((e) => types.length === 0 || types.includes(String(e.type)));
            if (req.query.order === 'desc') data = [...data].reverse();
            res.json({ data, next_page: null });
        });
        app.post('/v1/sessions/:id/events', (req, res) => {
            const id = req.params.id;
            const found = session(id);
            if (!found) return void res.status(404).end();
            if (found.session.status === 'terminated') {
                return void res
                    .status(400)
                    .json({ type: 'error', error: { type: 'invalid_request_error', message: 'session terminated' } });
            }
            const sent = ((req.body as { events: Json[] }).events ?? []).map((event) =>
                this.emit(id, { ...event, processed_at: null })
            );
            res.json({ data: sent });
            for (const event of sent) {
                if (event.type !== 'user.message') continue;
                const text = (event.content as { text: string }[])[0]?.text ?? '';
                if (this.onUserMessage?.(id, text)) continue;
                this.echo(id, `Echo: ${text.split('\n').at(-1)}`);
            }
        });

        await new Promise<void>((resolve) => {
            this.#server = app.listen(0, '127.0.0.1', () => resolve());
        });
        const address = this.#server?.address() as AddressInfo | undefined;
        this.url = `http://127.0.0.1:${address?.port}`;
    }

    async stop() {
        for (const s of this.sessions.values()) for (const stream of s.streams) stream.end();
        await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
    }
}
