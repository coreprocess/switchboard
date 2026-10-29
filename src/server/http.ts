import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type AuthConfiguration, authorizeJWT, type CloudAdapter, type TurnContext } from '@microsoft/agents-hosting';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import express from 'express';
import type { McpToken } from '../config/env.ts';
import type { Logger } from '../core/logger.ts';
import { mcpBearerAuth } from '../mcp/auth.ts';
import { createMcpServer, type McpContext } from '../mcp/tools.ts';
import type { Store } from '../store/store.ts';
import { claudeWebhookHandler, type WebhookContext } from '../webhooks/claude.ts';

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
    mcp: McpContext;
    mcpTokens: McpToken[];
    webhooks: WebhookContext;
    store: Store;
    log: Logger;
}

/**
 * One Express app for everything: Bot Framework activities, the MCP endpoint (stateless Streamable HTTP, POST
 * only), Claude webhooks (raw body, for the signature) and probes.
 */
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

    const mcp = toNodeHandler(
        createMcpHandler(() => createMcpServer(deps.mcp), { legacy: 'stateless' }),
        { maxRequestBodySize: MAX_BODY }
    );
    app.post(
        '/mcp',
        mcpBearerAuth(deps.mcpTokens),
        express.json({ limit: MAX_BODY }),
        guarded(deps.log, 'mcp', (req, res) => mcp(req, res, req.body))
    );
    app.all('/mcp', (_req, res) => {
        res.status(405)
            .set('Allow', 'POST')
            .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
    });

    app.post(
        '/webhooks/claude',
        express.text({ type: '*/*', limit: MAX_BODY }),
        guarded(deps.log, 'webhooks', claudeWebhookHandler(deps.webhooks))
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
