import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { budgetOf, parseChannelsConfig } from '../../src/config/channels.ts';
import { digestToken, loadEnv, parseMcpTokens } from '../../src/config/env.ts';
import { CONFIG_YAML, TENANT } from '../helpers/config.ts';

const TOKEN = 'a'.repeat(40);

describe('channels file', () => {
    it('parses a full channel and applies defaults', () => {
        const config = parseChannelsConfig(CONFIG_YAML);
        assert.equal(config.tenant_id, TENANT);
        assert.equal(config.mcp_server_name, 'switchboard');
        const ops = config.channels.ops;
        assert.ok(ops);
        assert.deepEqual(ops.agent, { id: 'agent_ops', version: 3 });
        assert.deepEqual(ops.resources, [
            { type: 'memory_store', memory_store_id: 'memstore_ops', access: 'read_write' },
        ]);
        assert.equal(ops.access, 'team_members');
        const restricted = config.channels.restricted;
        assert.ok(restricted);
        assert.deepEqual(restricted.vault_ids, []);
        assert.equal(restricted.session_title_prefix, 'Teams');
        assert.equal(restricted.access, 'allowlist');
    });

    it('converts the budget to USD minor units', () => {
        const config = parseChannelsConfig(CONFIG_YAML);
        assert.deepEqual(config.channels.ops && budgetOf(config.channels.ops), {
            type: 'limit',
            max_list_cost: { amount: '1000', currency: 'USD' },
        });
        assert.equal(config.channels.restricted && budgetOf(config.channels.restricted), undefined);
    });

    const minimal = (channel: string, extra = '') => `
tenant_id: ${TENANT}
${extra}
channels:
  ops:
${channel}
`;
    const base = `    team_id: "19:t@thread.tacv2"
    channel_id: "19:c@thread.tacv2"
    agent: { id: agent_x }
    environment_id: env_x`;

    it('rejects unknown keys, missing team, bad keys and duplicates', () => {
        assert.throws(() => parseChannelsConfig(minimal(`${base}\n    surprise: true`)));
        assert.throws(() =>
            parseChannelsConfig(
                minimal(`    channel_id: "19:c@thread.tacv2"\n    agent: { id: a }\n    environment_id: e`)
            )
        );
        assert.throws(() => parseChannelsConfig(minimal(base).replace('  ops:', '  Ops Channel:')));
        assert.throws(() => parseChannelsConfig(minimal(base, 'alerts_channel: missing')), /alerts_channel/);
        assert.throws(() => parseChannelsConfig(minimal(`${base}\n    access: allowlist`)), /allowlist/);
        const duplicate = `${minimal(base)}  second:\n${base}\n`;
        assert.throws(() => parseChannelsConfig(duplicate), /already bound/);
        assert.throws(() => parseChannelsConfig(`tenant_id: not-a-guid\nchannels: {}`));
        assert.throws(() => parseChannelsConfig(`tenant_id: ${TENANT}\nchannels: {}`), /at least one/);
    });

    it('accepts a team matched by its group ID', () => {
        const config = parseChannelsConfig(
            minimal(
                `    team_aad_group_id: 00000000-0000-0000-0000-000000000000\n    channel_id: "19:c@thread.tacv2"\n    agent: { id: a }\n    environment_id: e`
            )
        );
        assert.equal(config.channels.ops?.team_aad_group_id, '00000000-0000-0000-0000-000000000000');
    });
});

describe('MCP tokens', () => {
    it('accepts arrays and named entries and keeps only digests', () => {
        const tokens = parseMcpTokens(
            JSON.stringify({ [TOKEN]: ['ops'], ['b'.repeat(40)]: { name: 'ops-agent', channels: ['ops', 'x'] } })
        );
        assert.equal(tokens.length, 2);
        assert.deepEqual(tokens[0]?.channels, ['ops']);
        assert.equal(tokens[0]?.name, 'token-1');
        assert.equal(tokens[1]?.name, 'ops-agent');
        assert.deepEqual(tokens[0]?.digest, digestToken(TOKEN));
        assert.ok(!JSON.stringify(tokens).includes(TOKEN));
    });

    it('rejects short tokens and malformed entries', () => {
        assert.throws(() => parseMcpTokens(JSON.stringify({ short: ['ops'] })), /shorter/);
        assert.throws(() => parseMcpTokens(JSON.stringify({ [TOKEN]: 'ops' })));
        assert.throws(() => parseMcpTokens('not json'));
    });
});

describe('environment', () => {
    const env = {
        ANTHROPIC_API_KEY: 'sk-test',
        CLAUDE_WEBHOOK_SECRET: 'whsec_test',
        SWITCHBOARD_CONFIG: '/etc/switchboard/channels.yaml',
        STORE_TABLES_ENDPOINT: 'https://example.table.core.windows.net',
    };

    it('loads defaults', () => {
        const loaded = loadEnv(env);
        assert.equal(loaded.port, 8080);
        assert.equal(loaded.logLevel, 'info');
        assert.deepEqual(loaded.store, {
            kind: 'azure-tables',
            endpoint: 'https://example.table.core.windows.net',
            connectionString: undefined,
        });
        assert.deepEqual(loaded.mcpTokens, []);
    });

    it('signs in with Workload Identity Federation when no API key is set', () => {
        const federation = {
            ...env,
            ANTHROPIC_API_KEY: undefined,
            ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_test',
            ANTHROPIC_ORGANIZATION_ID: '00000000-0000-0000-0000-000000000000',
            ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac_test',
            ANTHROPIC_IDENTITY_TOKEN_FILE: '/var/run/secrets/anthropic.com/token',
        };
        assert.equal(loadEnv(env).anthropicAuth, 'api-key');
        assert.equal(loadEnv(federation).anthropicAuth, 'federation');
        assert.equal(loadEnv(federation).anthropicApiKey, undefined);
        assert.throws(
            () => loadEnv({ ...federation, ANTHROPIC_IDENTITY_TOKEN_FILE: undefined }),
            /ANTHROPIC_API_KEY is required, or Workload Identity Federation: ANTHROPIC_IDENTITY_TOKEN_FILE/
        );
        assert.throws(
            () => loadEnv({ ...federation, ANTHROPIC_FEDERATION_RULE_ID: '' }),
            /ANTHROPIC_FEDERATION_RULE_ID/
        );
    });

    it('requires secrets, a store and the bot ID in production', () => {
        assert.throws(() => loadEnv({ ...env, ANTHROPIC_API_KEY: '' }), /ANTHROPIC_API_KEY/);
        assert.throws(() => loadEnv({ ...env, STORE_TABLES_ENDPOINT: undefined }), /STORE_TABLES_ENDPOINT/);
        assert.throws(() => loadEnv({ ...env, STORE_KIND: 'sqlite' }), /unknown store/);
        assert.throws(() => loadEnv({ ...env, NODE_ENV: 'production' }), /CLIENTID/);
        assert.throws(
            () =>
                loadEnv({
                    ...env,
                    NODE_ENV: 'production',
                    STORE_KIND: 'memory',
                    CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTID: 'app',
                }),
            /development only/
        );
        const production = loadEnv({
            ...env,
            NODE_ENV: 'production',
            CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTID: 'app',
        });
        assert.equal(production.botClientId, 'app');
    });
});
