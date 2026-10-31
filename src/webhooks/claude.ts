import type express from 'express';
import type { WebhookEvent } from '../claude/api.ts';
import { forgetSeen, markSeen } from '../store/entities.ts';
import type { Switchboard } from '../switchboard.ts';

/** Webhook event types that mean "something happened to this session". */
const SESSION_EVENTS = new Set([
    'session.status_run_started',
    'session.status_idled',
    'session.status_rescheduled',
    'session.status_terminated',
    'session.budget_reached',
    // also listed by the API reference
    'session.running',
    'session.idled',
    'session.requires_action',
    'session.archived',
]);

/** Verifies a delivery with the secret of the workspace it came from (each endpoint belongs to one workspace). */
const unwrap = (sb: Switchboard, body: string, headers: Record<string, string>): WebhookEvent | undefined => {
    for (const api of sb.workspaces.all()) {
        if (!sb.settings.webhookSecrets[api.workspaceId]) continue;
        try {
            return api.unwrapWebhook(body, headers);
        } catch {
            // try the next workspace's secret
        }
    }
    return undefined;
};

/** Payloads are thin and may arrive late, twice or not at all: they only wake the relay, which reads the state. */
export const handleWebhookEvent = async (sb: Switchboard, event: WebhookEvent) => {
    const data = event.data;
    if (data.type === 'session.deleted') {
        if (await sb.sessions.get(data.id)) await sb.sessions.end(data.id, 'deleted');
        return;
    }
    if (SESSION_EVENTS.has(data.type)) {
        if (await sb.sessions.get(data.id)) await sb.relay.wake(data.id);
        return;
    }
    if (data.type === 'vault_credential.refresh_failed') await vaultRefreshFailed(sb, data.workspace_id, data.vault_id);
};

/** A note in every channel whose conversation or job deployment uses the vault. */
const vaultRefreshFailed = async (sb: Switchboard, workspaceId: string, vaultId: string) => {
    for (const { value: binding } of await sb.entities.bindings.list()) {
        if (binding.workspaceId !== workspaceId) continue;
        const jobs = await sb.entities.jobs.list({ partitionKey: binding.channelId });
        const deploymentIds = [binding.conversationDeploymentId, ...jobs.map((j) => j.value.deploymentId)];
        let uses = false;
        for (const deploymentId of new Set(deploymentIds)) {
            const deployment = await sb.templates.deployment(workspaceId, deploymentId).catch(() => undefined);
            if (deployment?.vault_ids.includes(vaultId)) uses = true;
        }
        if (!uses) continue;
        await sb.gateway
            .postThread(
                { teamId: binding.teamId, channelId: binding.channelId },
                {
                    text:
                        `⚠️ A credential in vault \`${vaultId}\` could not be refreshed. Agent sessions of this channel ` +
                        'may fail to reach the service it signs in to until the credential is renewed in the Claude Console.',
                }
            )
            .catch((error: unknown) =>
                sb.log.warn({ err: error, channelId: binding.channelId }, 'vault note not posted')
            );
    }
};

/** `POST /webhooks/claude`: verify (raw body), deduplicate by event ID across pods, handle. */
export const claudeWebhookHandler = (sb: Switchboard) => async (req: express.Request, res: express.Response) => {
    const body = typeof req.body === 'string' ? req.body : '';
    const headers = Object.fromEntries(
        Object.entries(req.headers).flatMap(([name, value]) => (typeof value === 'string' ? [[name, value]] : []))
    );
    const event = unwrap(sb, body, headers);
    if (!event) {
        sb.log.warn('webhook rejected: signature not valid for any workspace');
        res.status(400).json({ error: 'invalid signature' });
        return;
    }
    if (!(await markSeen(sb.entities, 'webhook', event.id))) {
        res.status(204).end();
        return;
    }
    try {
        await handleWebhookEvent(sb, event);
        res.status(204).end();
    } catch (error) {
        sb.log.error({ err: error, type: event.data.type }, 'webhook not handled');
        await forgetSeen(sb.entities, 'webhook', event.id).catch(() => undefined);
        res.status(500).json({ error: 'not handled' });
    }
};
