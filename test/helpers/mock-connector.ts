import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

type Json = Record<string, unknown>;

export interface ConnectorMessage {
    conversationId: string;
    id: string;
    activity: Json;
    deleted: boolean;
    /** When it was posted (Graph's `createdDateTime`). */
    at: string;
    /** People's posts: who wrote it; absent for Switchboard's own. */
    from?: { name: string; aadObjectId: string };
    subject?: string;
    /** The body as Graph returns it, when it differs from the activity's text (inline images). */
    html?: string;
}

const ADAPTIVE_CARD = 'application/vnd.microsoft.card.adaptive';
const GRAPH_PAGE = 20;

/**
 * A stand-in for Teams as the bot sees it: the Bot Framework connector API it posts to, and Microsoft Graph, which
 * shows the channel's threads with both Switchboard's posts and people's (registered with `human`).
 */
export class MockConnector {
    /** What Switchboard posted. */
    readonly messages: ConnectorMessage[] = [];
    /** What people posted. */
    readonly posts: ConnectorMessage[] = [];
    /** Images in messages, served as Graph hosted contents (`<img src="{graphBase}/…/hostedContents/<id>/$value">`). */
    readonly hostedContents = new Map<string, { type: string; data: Buffer }>();
    /** Graph answers 503 while set. */
    graphDown = false;
    /** Graph answers 403 while set, as when the team's consent for the app is missing. */
    graphDenied = false;
    /** Graph requests, as paths. */
    readonly graphRequests: string[] = [];
    now: () => Date = () => new Date();
    /** `POST /v3/conversations` requests: new top-level channel posts. */
    readonly created: Json[] = [];
    /** Teams the connector knows: details and channels (`v3/teams/…`). */
    readonly teams = new Map<
        string,
        { name: string; aadGroupId: string; channels: { id: string; name: string | null }[] }
    >();
    /** Attachment content served at `/attachments/<id>`. */
    readonly attachments = new Map<string, { type: string; data: Buffer }>();
    url = '';
    #server: Server | undefined;
    #next = 5000;

    /** Messages visible in a conversation (thread), as text, `[card] …` for cards. */
    visible(conversationId: string): string[] {
        return this.messages
            .filter((m) => m.conversationId === conversationId && !m.deleted)
            .map((m) => {
                const attachments = m.activity.attachments as { content: unknown }[] | undefined;
                return attachments?.length
                    ? `[card] ${JSON.stringify(attachments[0]?.content)}`
                    : String(m.activity.text);
            });
    }

    async start() {
        const app = express();
        app.use(express.json({ limit: '5mb' }));
        app.get('/v3/teams/:teamId', (req, res) => {
            const team = this.teams.get(req.params.teamId);
            if (!team) return void res.status(404).end();
            res.json({ id: req.params.teamId, name: team.name, aadGroupId: team.aadGroupId });
        });
        app.get('/v3/teams/:teamId/conversations', (req, res) => {
            const team = this.teams.get(req.params.teamId);
            if (!team) return void res.status(404).end();
            res.json({ conversations: team.channels });
        });
        app.get('/attachments/:id', (req, res) => {
            const attachment = this.attachments.get(req.params.id);
            if (!attachment) return void res.status(404).end();
            res.type(attachment.type).send(attachment.data);
        });
        app.post('/v3/conversations', (req, res) => {
            const params = req.body as { channelData?: { channel?: { id?: string } }; activity?: Json };
            const id = String(this.#next++);
            const conversationId = `${params.channelData?.channel?.id};messageid=${id}`;
            this.created.push(req.body as Json);
            this.messages.push({ conversationId, id, activity: params.activity ?? {}, deleted: false, at: this.#at() });
            res.json({ id: conversationId, activityId: id });
        });
        const send = (req: express.Request, res: express.Response) => {
            const id = String(this.#next++);
            this.messages.push({
                conversationId: String(req.params.conversationId),
                id,
                activity: req.body as Json,
                deleted: false,
                at: this.#at(),
            });
            res.json({ id });
        };
        app.post('/v3/conversations/:conversationId/activities', send);
        app.post('/v3/conversations/:conversationId/activities/:replyTo', send);
        app.put('/v3/conversations/:conversationId/activities/:id', (req, res) => {
            const message = this.messages.find((m) => m.id === req.params.id);
            if (!message) return void res.status(404).end();
            if (message.deleted) {
                return void res.status(403).json({
                    error: { code: 'ActivityDeletedInConversation', message: 'Message has been deleted.' },
                });
            }
            message.activity = req.body as Json;
            res.json({ id: message.id });
        });
        app.delete('/v3/conversations/:conversationId/activities/:id', (req, res) => {
            const message = this.messages.find((m) => m.id === req.params.id);
            if (message) message.deleted = true;
            res.status(200).end();
        });
        app.use('/graph/v1.0', (req, res) => this.#graph(req, res));
        await new Promise<void>((resolve) => {
            this.#server = app.listen(0, '127.0.0.1', () => resolve());
        });
        const address = this.#server?.address() as AddressInfo | undefined;
        this.url = `http://127.0.0.1:${address?.port}/`;
    }

    get graphBase() {
        return `${this.url}graph/v1.0`;
    }

    /**
     * A person's post as Teams has it before the bot hears of it (`message` activities in channel threads). Each
     * post is registered once, so a test can register one with a subject or a body of its own before posting it.
     */
    human(activity: Json, options: { subject?: string; html?: string } = {}) {
        const conversationId = String((activity.conversation as Json | undefined)?.id ?? '');
        const from = activity.from as { name?: string; aadObjectId?: string } | undefined;
        if (activity.type !== 'message' || !conversationId.includes(';messageid=')) return;
        if (this.posts.some((post) => post.id === String(activity.id))) return;
        this.posts.push({
            conversationId,
            id: String(activity.id),
            activity,
            deleted: false,
            at: String(activity.timestamp ?? this.#at()),
            from: { name: from?.name ?? 'unknown', aadObjectId: from?.aadObjectId ?? '' },
            ...options,
        });
    }

    /** Deletes a thread as a person would in Teams: its root post and every reply. */
    deleteThread(channelId: string, rootId: string) {
        const conversationId = `${channelId};messageid=${rootId}`;
        for (const message of [...this.posts, ...this.messages]) {
            if (message.conversationId === conversationId) message.deleted = true;
        }
    }

    #at() {
        return this.now().toISOString();
    }

    #thread(channelId: string, rootId: string) {
        const conversationId = `${channelId};messageid=${rootId}`;
        return [...this.posts, ...this.messages]
            .filter((m) => m.conversationId === conversationId)
            .sort((a, b) => a.at.localeCompare(b.at));
    }

    #graphMessage(m: ConnectorMessage, replies?: Json[]): Json {
        const attachments = (m.activity.attachments as { contentType?: string; content?: unknown }[] | undefined) ?? [];
        const card = attachments.find((a) => a.contentType === ADAPTIVE_CARD);
        const text = String(m.activity.text ?? '');
        return {
            id: m.id,
            messageType: 'message',
            createdDateTime: m.at,
            deletedDateTime: m.deleted ? m.at : null,
            subject: m.subject ?? null,
            from: m.from
                ? { user: { id: m.from.aadObjectId, displayName: m.from.name }, application: null }
                : { user: null, application: { displayName: 'Switchboard' } },
            body: m.from
                ? { contentType: 'html', content: m.html ?? text }
                : { contentType: 'text', content: card ? '' : text },
            attachments: card ? [{ contentType: ADAPTIVE_CARD, content: JSON.stringify(card.content) }] : [],
            ...(replies ? { replies } : {}),
        };
    }

    /** Microsoft Graph's channel messages: list (latest activity first), one thread, replies, hosted contents. */
    #graph(req: express.Request, res: express.Response) {
        this.graphRequests.push(req.path);
        if (this.graphDown) return void res.status(503).json({ error: { code: 'ServiceUnavailable' } });
        if (this.graphDenied) {
            return void res.status(403).json({
                error: { code: 'Forbidden', message: 'Missing role permissions on the request.' },
            });
        }
        const parts = req.path.split('/').filter(Boolean).map(decodeURIComponent);
        const [teams, group, channels, channelId, messages, rootId, ...rest] = parts;
        const team = [...this.teams.values()].find((t) => t.aadGroupId === group);
        if (teams !== 'teams' || channels !== 'channels' || messages !== 'messages' || !team || !channelId) {
            return void res.status(404).json({ error: { code: 'NotFound' } });
        }
        const skip = Number(req.query.$skiptoken ?? 0);
        const page = (items: Json[], size: number) => ({
            value: items.slice(skip, skip + size),
            ...(skip + size < items.length
                ? { '@odata.nextLink': `${this.graphBase}${req.path}?$top=${size}&$skiptoken=${skip + size}` }
                : {}),
        });
        if (!rootId) {
            const roots = [...this.posts, ...this.messages]
                .filter((m) => m.conversationId === `${channelId};messageid=${m.id}`)
                .map((root) => {
                    const thread = this.#thread(channelId, root.id);
                    const replies = thread.filter((m) => m.id !== root.id).map((m) => this.#graphMessage(m));
                    return { latest: thread.at(-1)?.at ?? root.at, message: this.#graphMessage(root, replies) };
                })
                .sort((a, b) => b.latest.localeCompare(a.latest))
                .map((root) => root.message);
            return void res.json(page(roots, Number(req.query.$top ?? GRAPH_PAGE)));
        }
        const thread = this.#thread(channelId, rootId);
        const root = thread.find((m) => m.id === rootId);
        if (!root) return void res.status(404).json({ error: { code: 'NotFound' } });
        const replies = thread.filter((m) => m.id !== rootId).map((m) => this.#graphMessage(m));
        if (rest.length === 0) {
            // like Graph: replies are expanded only when listing threads
            if (req.query.$expand) {
                return void res.status(400).json({
                    error: { code: 'BadRequest', message: "Expand query parameter 'replies' is not supported" },
                });
            }
            return void res.json(this.#graphMessage(root));
        }
        // like Graph: a thread's replies come newest first
        if (rest[0] === 'replies') {
            return void res.json(page([...replies].reverse(), Number(req.query.$top ?? GRAPH_PAGE)));
        }
        const hosted = rest[0] === 'hostedContents' ? this.hostedContents.get(rest[1] ?? '') : undefined;
        if (!hosted) return void res.status(404).json({ error: { code: 'NotFound' } });
        res.type(hosted.type).send(hosted.data);
    }

    async stop() {
        this.#server?.closeAllConnections();
        await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
    }
}
