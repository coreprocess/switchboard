import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type AuthConfiguration, authorizeJWT, type CloudAdapter, type TurnContext } from '@microsoft/agents-hosting';
import express from 'express';
import type { Logger } from '../core/logger.ts';
import type { Store } from '../store/store.ts';

const MAX_BODY = 1024 * 1024;

/** Runs an async handler; a failure is logged and answered with 500 instead of becoming an unhandled rejection. */
const guarded =
    (log: Logger, name: string, handler: (req: express.Request, res: express.Response) => Promise<unknown>) =>
    (req: express.Request, res: express.Response) => {
        handler(req, res).catch((error: unknown) => {
            log.error({ err: error, route: name }, 'request failed');
            if (!res.headersSent) res.status(500).json({ error: 'internal error' });
        });
    };

export interface HttpDeps {
    adapter: CloudAdapter;
    authConfig: AuthConfiguration;
    onTurn: (context: TurnContext) => Promise<void>;
    onWebhook: (req: express.Request, res: express.Response) => Promise<void>;
    store: Store;
    log: Logger;
}

/** One Express app for everything: Bot Framework activities, Claude webhooks (raw body, for the signature), probes. */
export const createHttpApp = (deps: HttpDeps) => {
    const app = express();
    app.disable('x-powered-by');
    app.set('etag', false);
    app.set('trust proxy', true);

    app.get('/healthz', (_req, res) => {
        res.json({ status: 'ok' });
    });
    app.get('/readyz', async (_req, res) => {
        try {
            await deps.store.ping();
            res.json({ status: 'ready' });
        } catch (error) {
            deps.log.warn({ err: error }, 'not ready');
            res.status(503).json({ status: 'store unavailable' });
        }
    });

    app.post(
        '/api/messages',
        express.json({ limit: MAX_BODY }),
        authorizeJWT(deps.authConfig),
        guarded(deps.log, 'messages', (req, res) => deps.adapter.process(req, res, deps.onTurn))
    );

    app.post(
        '/webhooks/claude',
        express.text({ type: '*/*', limit: MAX_BODY }),
        guarded(deps.log, 'webhooks', deps.onWebhook)
    );

    app.use((_req, res) => {
        res.status(404).json({ error: 'not found' });
    });
    return app;
};

export const listen = (app: express.Express, host: string, port: number): Promise<{ server: Server; port: number }> =>
    new Promise((resolve, reject) => {
        const server = app.listen(port, host, (error?: Error) => {
            if (error) reject(error);
            else resolve({ server, port: (server.address() as AddressInfo).port });
        });
        server.keepAliveTimeout = 10_000;
        server.headersTimeout = 15_000;
        server.requestTimeout = 0;
    });
