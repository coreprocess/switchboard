import type { Request, Response } from 'express';
import type { ClaudeApi, WebhookEvent } from '../claude/api.ts';
import type { ChannelsConfig } from '../config/channels.ts';
import type { ChannelGateway } from '../core/gateway.ts';
import type { Logger } from '../core/logger.ts';
import { clip } from '../core/text.ts';
import type { Relay } from '../relay/relay.ts';
import type { Store } from '../store/store.ts';

export interface WebhookContext {
    api: ClaudeApi;
    store: Store;
    relay: Relay;
    gateway: ChannelGateway;
    config: ChannelsConfig;
    log: Logger;
}

/** Posts an alert into `alerts_channel`; only logged when none is configured. */
export const postAlert = async (context: Omit<WebhookContext, 'api' | 'relay' | 'store'>, text: string) => {
    const channel = context.config.alerts_channel;
    context.log.warn({ alert: text }, 'alert');
    if (!channel) return;
    await context.gateway.postTopLevel(channel, { text });
};

const consoleLink = (config: ChannelsConfig, sessionId: string) =>
    config.console_workspace
        ? ` — https://platform.claude.com/workspaces/${encodeURIComponent(config.console_workspace)}/sessions/${sessionId}`
        : '';

/** Handles one verified event. Payloads are thin: everything beyond IDs is fetched. */
export const handleWebhookEvent = async (context: WebhookContext, event: WebhookEvent) => {
    const { data } = event;
    switch (data.type) {
        case 'session.status_idled': {
            // Catch-up for idles the relay's stream missed; the drain is a no-op when nothing is new.
            if (await context.store.getSession(data.id)) await context.relay.drain(data.id);
            return;
        }
        case 'session.status_terminated': {
            if (await context.store.getSession(data.id)) await context.relay.drain(data.id);
            const session = await context.api.retrieveSession(data.id).catch(() => undefined);
            const title = session?.title ? ` "${clip(session.title, 120)}"` : '';
            await postAlert(
                context,
                `⚠️ Agent session ${data.id}${title} terminated.${consoleLink(context.config, data.id)}`
            );
            return;
        }
        case 'vault_credential.refresh_failed':
            await postAlert(
                context,
                `⚠️ A vault credential failed to refresh: credential ${data.id} in vault ${data.vault_id}. ` +
                    'Agents using it cannot reach their MCP server until it is reconnected.'
            );
            return;
        case 'deployment_run.failed': {
            const run = await context.api.retrieveDeploymentRun(data.id).catch(() => undefined);
            const reason = run?.error ? `: ${run.error.type}: ${clip(run.error.message, 300)}` : '';
            await postAlert(context, `⚠️ Scheduled deployment run ${data.id} failed${reason}`);
            return;
        }
        default:
            return;
    }
};

const headersOf = (req: Request): Record<string, string> =>
    Object.fromEntries(
        Object.entries(req.headers).flatMap(([name, value]) =>
            value === undefined ? [] : [[name, Array.isArray(value) ? value.join(', ') : value]]
        )
    );

/**
 * `POST /webhooks/claude`: verifies the signature on the raw body, drops duplicate deliveries by event ID and
 * acknowledges with 204. A failure answers 500 and releases the event, so the platform's retry is processed.
 */
export const claudeWebhookHandler = (context: WebhookContext) => async (req: Request, res: Response) => {
    const body = typeof req.body === 'string' ? req.body : '';
    let event: WebhookEvent;
    try {
        event = context.api.unwrapWebhook(body, headersOf(req));
    } catch (error) {
        context.log.warn({ err: error }, 'webhook rejected');
        res.status(400).json({ error: 'invalid signature' });
        return;
    }
    if (!(await context.store.claimWebhookEvent(event.id, new Date().toISOString()))) {
        res.status(204).end();
        return;
    }
    try {
        await handleWebhookEvent(context, event);
    } catch (error) {
        context.log.error({ err: error, eventId: event.id, type: event.data.type }, 'webhook failed');
        await context.store.releaseWebhookEvent(event.id);
        res.status(500).json({ error: 'processing failed' });
        return;
    }
    res.status(204).end();
};
