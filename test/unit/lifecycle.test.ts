import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import sharp from 'sharp';
import { CHANNEL, eventually, type Harness, startHarness } from '../helpers/harness.ts';
import { newWebhookSecret, signWebhook, webhookBody } from '../helpers/webhooks.ts';

const DAY = 24 * 60 * 60 * 1000;

describe('lifecycle and webhooks', () => {
    let h: Harness;
    let offset = 0;

    before(async () => {
        h = await startHarness({ now: () => new Date(Date.now() + offset) });
        await h.bind();
    });

    after(async () => {
        await h.stop();
    });

    it('archives an inactive conversation quietly; a later reply continues with the log', async () => {
        const sb = h.instances[0]?.sb;
        assert.ok(sb);
        const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#000' } })
            .png()
            .toBuffer();
        h.connector.attachments.set('pic', { type: 'image/png', data: png });
        const root = h.message('Remember this picture', {
            attachments: [
                { contentType: 'image/png', contentUrl: `${h.connector.url}attachments/pic`, name: 'pic.png' },
            ],
        });
        await h.post(root);
        await eventually(() => h.thread(root.id).some((t) => t.startsWith('Echo:')));
        const sessionId = [...h.claude.sessions.keys()].at(-1) ?? '';
        const visibleBefore = h.thread(root.id).length;

        offset = 31 * DAY;
        await sb.lifecycle.run();
        assert.equal((await sb.sessions.get(sessionId))?.state, 'archived');
        assert.ok(h.claude.sessions.get(sessionId)?.session.archived_at, 'archived in Claude');
        assert.equal(h.thread(root.id).length, visibleBefore, 'old threads stay quiet');

        await h.post(h.message('Back again', { rootId: root.id }));
        await eventually(() => h.thread(root.id).some((t) => t === 'Echo: Back again'));
        const content = h.firstContent();
        assert.match(
            content[1]?.text ?? '',
            new RegExp(`^\\[switchboard:continuation\\] previous_session=${sessionId} reason=archived`)
        );
        assert.ok(
            content.some((block) => block.type === 'image'),
            'images of the latest messages come along'
        );
    });

    it('deletes everything after the retention period; a later reply reads the history from Teams', async () => {
        const sb = h.instances[0]?.sb;
        assert.ok(sb);
        const conversations = await sb.entities.conversations.list({ partitionKey: CHANNEL });
        assert.ok(conversations.length > 0);
        const filesBefore = h.claude.files.size;
        assert.ok(filesBefore > 0);

        offset += 91 * DAY;
        await sb.lifecycle.run();
        assert.equal((await sb.entities.conversations.list({ partitionKey: CHANNEL })).length, 0);
        assert.equal((await sb.entities.sessions.list()).length, 0);
        assert.equal((await sb.entities.logs.list()).length, 0);
        assert.ok(h.claude.deletedSessions.length >= 2, 'sessions deleted in Claude');
        assert.equal(h.claude.files.size, 0, 'uploaded files deleted');

        const rootId = conversations[0]?.value.rootId ?? '';
        await h.post(h.message('Hello after a long time', { rootId }));
        await eventually(() => h.thread(rootId).some((t) => t.includes('could not be read')));
        const first = h.firstText();
        assert.match(first, /reason=history_from_teams/);
        assert.ok(first.includes('The earlier messages of this thread could not be read.'));
    });

    it('drops duplicate webhook deliveries and rejects bad signatures', async () => {
        const body = webhookBody('whe_dup', 'session.status_idled', { id: 'sesn_unknown' });
        const send = (headers: Record<string, string>) =>
            fetch(`${h.instances[0]?.base}/webhooks/claude`, { method: 'POST', headers, body });
        assert.equal((await send(signWebhook(h.secret, 'whe_dup', body))).status, 204);
        assert.equal((await send(signWebhook(h.secret, 'whe_dup', body))).status, 204);
        assert.equal((await send(signWebhook(newWebhookSecret(), 'whe_x', body))).status, 400);
    });

    it('posts a note when a vault credential of a channel’s deployment cannot be refreshed', async () => {
        const body = webhookBody('whe_vault', 'vault_credential.refresh_failed', {
            id: 'vcrd_1',
            vault_id: 'vlt_test',
            workspace_id: 'wrkspc_test',
        });
        const response = await fetch(`${h.instances[0]?.base}/webhooks/claude`, {
            method: 'POST',
            headers: signWebhook(h.secret, 'whe_vault', body),
            body,
        });
        assert.equal(response.status, 204);
        await eventually(() =>
            h.connector.created.some((c) => JSON.stringify(c).includes('vault `vlt_test` could not be refreshed'))
        );
    });
});
