import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

type Json = Record<string, unknown>;

export interface ConnectorMessage {
    conversationId: string;
    id: string;
    activity: Json;
    deleted: boolean;
}

/** A stand-in for the Bot Framework connector API a Teams bot posts to. */
export class MockConnector {
    readonly messages: ConnectorMessage[] = [];
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
            this.messages.push({ conversationId, id, activity: params.activity ?? {}, deleted: false });
            res.json({ id: conversationId, activityId: id });
        });
        const send = (req: express.Request, res: express.Response) => {
            const id = String(this.#next++);
            this.messages.push({
                conversationId: String(req.params.conversationId),
                id,
                activity: req.body as Json,
                deleted: false,
            });
            res.json({ id });
        };
        app.post('/v3/conversations/:conversationId/activities', send);
        app.post('/v3/conversations/:conversationId/activities/:replyTo', send);
        app.put('/v3/conversations/:conversationId/activities/:id', (req, res) => {
            const message = this.messages.find((m) => m.id === req.params.id);
            if (!message) return void res.status(404).end();
            message.activity = req.body as Json;
            res.json({ id: message.id });
        });
        app.delete('/v3/conversations/:conversationId/activities/:id', (req, res) => {
            const message = this.messages.find((m) => m.id === req.params.id);
            if (message) message.deleted = true;
            res.status(200).end();
        });
        await new Promise<void>((resolve) => {
            this.#server = app.listen(0, '127.0.0.1', () => resolve());
        });
        const address = this.#server?.address() as AddressInfo | undefined;
        this.url = `http://127.0.0.1:${address?.port}/`;
    }

    async stop() {
        this.#server?.closeAllConnections();
        await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
    }
}
