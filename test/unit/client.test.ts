import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import { createAnthropicClient } from '../../src/claude/client.ts';

const FEDERATION_ENV = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_FEDERATION_RULE_ID',
    'ANTHROPIC_ORGANIZATION_ID',
    'ANTHROPIC_SERVICE_ACCOUNT_ID',
    'ANTHROPIC_WORKSPACE_ID',
    'ANTHROPIC_IDENTITY_TOKEN_FILE',
    'ANTHROPIC_CONFIG_DIR',
];

describe('Claude API client', () => {
    const exchanges: Record<string, unknown>[] = [];
    const authorizations: (string | undefined)[] = [];
    let server: Server;
    let baseUrl: string;
    const saved = Object.fromEntries(FEDERATION_ENV.map((name) => [name, process.env[name]]));

    before(async () => {
        const app = express();
        app.post('/v1/oauth/token', express.json(), (req, res) => {
            exchanges.push(req.body);
            res.json({ access_token: 'sk-ant-oat01-test', token_type: 'Bearer', expires_in: 600 });
        });
        app.get('/v1/sessions', (req, res) => {
            authorizations.push(req.headers.authorization ?? (req.headers['x-api-key'] as string | undefined));
            res.json({ data: [], has_more: false, first_id: null, last_id: null });
        });
        server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(() => {
        server.close();
        for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });

    it('exchanges the identity token when no API key is set', async () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'switchboard-wif-'));
        const tokenFile = path.join(dir, 'token');
        writeFileSync(tokenFile, 'header.payload.signature');
        delete process.env.ANTHROPIC_API_KEY;
        Object.assign(process.env, {
            ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_test',
            ANTHROPIC_ORGANIZATION_ID: '00000000-0000-0000-0000-000000000000',
            ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac_test',
            ANTHROPIC_WORKSPACE_ID: 'wrkspc_test',
            ANTHROPIC_IDENTITY_TOKEN_FILE: tokenFile,
            ANTHROPIC_CONFIG_DIR: dir,
        });

        const client = createAnthropicClient({ anthropicApiKey: undefined, anthropicBaseUrl: baseUrl });
        await client.beta.sessions.list({ limit: 1 });

        assert.equal(exchanges.length, 1);
        assert.deepEqual(exchanges[0], {
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: 'header.payload.signature',
            federation_rule_id: 'fdrl_test',
            organization_id: '00000000-0000-0000-0000-000000000000',
            service_account_id: 'svac_test',
            workspace_id: 'wrkspc_test',
        });
        assert.equal(authorizations.at(-1), 'Bearer sk-ant-oat01-test');
    });

    it('uses the API key when one is set', async () => {
        const client = createAnthropicClient({ anthropicApiKey: 'sk-ant-api-test', anthropicBaseUrl: baseUrl });
        await client.beta.sessions.list({ limit: 1 });
        assert.match(String(authorizations.at(-1)), /sk-ant-api-test/);
        assert.equal(exchanges.length, 1);
    });
});
