import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import express from 'express';
import { createClaudeApi } from '../../src/claude/api.ts';
import { nullLogger } from '../../src/core/logger.ts';
import { Relay } from '../../src/relay/relay.ts';
import { MemoryStore } from '../../src/store/memory.ts';
import { claudeWebhookHandler, type WebhookContext } from '../../src/webhooks/claude.ts';
import { testConfig } from '../helpers/config.ts';
import { FakeClaudeApi, FakeGateway } from '../helpers/fakes.ts';
import { newWebhookSecret, signWebhook, webhookBody } from '../helpers/webhooks.ts';

describe('Claude webhooks', () => {
    const secret = newWebhookSecret();
    let gateway: FakeGateway;
    let store: MemoryStore;
    let fake: FakeClaudeApi;
    let url: string;
    let failDrain = false;
    let server: Server;

    beforeEach(async () => {
        gateway = new FakeGateway();
        store = new MemoryStore();
        fake = new FakeClaudeApi();
        failDrain = false;
        // Real signature verification from the SDK, the rest from the fake.
        const real = createClaudeApi(new Anthropic({ apiKey: 'test' }), secret);
        fake.unwrapWebhook = real.unwrapWebhook;
        const log = nullLogger();
        const relay = new Relay({ api: fake, store, gateway, log, approvalExpiryHours: undefined });
        const drain = relay.drain.bind(relay);
        relay.drain = async (sessionId: string) => {
            if (failDrain) throw new Error('drain failed');
            return drain(sessionId);
        };
        const context: WebhookContext = { api: fake, store, relay, gateway, config: testConfig(), log };
        const app = express();
        app.post(
            '/webhooks/claude',
            express.text({ type: '*/*' }),
            (req, res) => void claudeWebhookHandler(context)(req, res)
        );
        server = app.listen(0);
        await new Promise((resolve) => server.once('listening', resolve));
        const address = server.address();
        assert.ok(address && typeof address === 'object');
        url = `http://127.0.0.1:${address.port}/webhooks/claude`;
        fake.addSession('sesn_1', 'terminated');
    });

    afterEach(() => {
        server.close();
    });

    const deliver = (id: string, body: string, headers = signWebhook(secret, id, body)) =>
        fetch(url, { method: 'POST', headers, body });

    it('rejects deliveries with a bad or missing signature', async () => {
        const body = webhookBody('whe_bad', 'vault_credential.refresh_failed', { vault_id: 'vlt_1' });
        assert.equal((await deliver('whe_bad', body, signWebhook(newWebhookSecret(), 'whe_bad', body))).status, 400);
        assert.equal(
            (await fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json' } })).status,
            400
        );
        const stale = signWebhook(secret, 'whe_bad', body, Math.floor(Date.now() / 1000) - 3600);
        assert.equal((await deliver('whe_bad', body, stale)).status, 400);
        assert.equal(gateway.topLevel.length, 0);
    });

    it('alerts once per event, however often it is delivered', async () => {
        const body = webhookBody('whe_1', 'vault_credential.refresh_failed', { id: 'vcrd_1', vault_id: 'vlt_1' });
        for (let i = 0; i < 3; i++) assert.equal((await deliver('whe_1', body)).status, 204);
        assert.equal(gateway.topLevel.length, 1);
        assert.equal(gateway.topLevel[0]?.channelKey, 'ops');
        assert.match(gateway.topLevel[0]?.content.text ?? '', /vcrd_1 in vault vlt_1/);
    });

    it('alerts on failed deployment runs and terminated sessions, ignores other types', async () => {
        await deliver('whe_2', webhookBody('whe_2', 'deployment_run.failed', { id: 'drun_1' }));
        await deliver('whe_3', webhookBody('whe_3', 'session.status_terminated'));
        await deliver('whe_4', webhookBody('whe_4', 'agent.created', { id: 'agent_1' }));
        const texts = gateway.topLevel.map((t) => t.content.text ?? '');
        assert.equal(texts.length, 2);
        assert.match(texts[0] ?? '', /drun_1 failed: agent_archived_error/);
        assert.match(texts[1] ?? '', /sesn_1 "Test" terminated/);
    });

    it('releases an event whose processing failed, so the retry is processed', async () => {
        await store.putSession({
            sessionId: 'sesn_1',
            channelKey: 'ops',
            rootId: '1',
            watermarkEventId: undefined,
            watermarkAt: undefined,
            pending: false,
            lastSentEventId: undefined,
            workingMessageId: undefined,
            updatedAt: new Date().toISOString(),
        });
        const body = webhookBody('whe_5', 'session.status_idled');
        failDrain = true;
        assert.equal((await deliver('whe_5', body)).status, 500);
        failDrain = false;
        assert.equal((await deliver('whe_5', body)).status, 204);
        assert.equal(await store.claimWebhookEvent('whe_5', new Date().toISOString()), false);
    });
});
