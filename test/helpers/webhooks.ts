import { createHmac, randomBytes } from 'node:crypto';

export const newWebhookSecret = () => `whsec_${randomBytes(32).toString('base64')}`;

/** Signs a delivery the way the platform does (Standard Webhooks: HMAC-SHA256 over `id.timestamp.body`). */
export const signWebhook = (secret: string, id: string, body: string, timestamp = Math.floor(Date.now() / 1000)) => {
    const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
    return {
        'content-type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': String(timestamp),
        'webhook-signature': `v1,${signature}`,
    };
};

export const webhookBody = (id: string, type: string, data: Record<string, unknown> = {}) =>
    JSON.stringify({
        type: 'event',
        id,
        created_at: new Date().toISOString(),
        data: { type, id: 'sesn_1', organization_id: 'org', workspace_id: 'wrkspc', ...data },
    });
