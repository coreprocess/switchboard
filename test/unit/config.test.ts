import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadSettings } from '../../src/config/env.ts';
import { isValidCron, nextRun } from '../../src/jobs/jobs.ts';

const TENANT = '00000000-0000-0000-0000-000000000001';
const base = {
    SWITCHBOARD_TENANTS: JSON.stringify([TENANT]),
    SWITCHBOARD_WORKSPACES: JSON.stringify([
        {
            id: 'wrkspc_a',
            name: 'A',
            federation: {
                rule_id: 'fdrl_1',
                organization_id: '00000000-0000-0000-0000-000000000002',
                service_account_id: 'svac_1',
            },
        },
    ]),
    ANTHROPIC_IDENTITY_TOKEN_FILE: '/var/run/secrets/anthropic.com/token',
    STORE_TABLES_ENDPOINT: 'https://example.table.core.windows.net',
    SWITCHBOARD_TABLE_PREFIX: 'sbv1',
};

describe('settings', () => {
    it('loads defaults', () => {
        const settings = loadSettings(base);
        assert.equal(settings.port, 8080);
        assert.equal(settings.defaultTimezone, 'Europe/Berlin');
        assert.equal(settings.defaultJobMaxRuntimeMin, 60);
        assert.equal(settings.sessionArchiveAfterDays, 30);
        assert.equal(settings.conversationRetentionDays, 90);
        assert.equal(settings.attachmentMaxBytes, 20 * 1024 * 1024);
        assert.deepEqual(settings.attachmentTypes, ['image']);
        assert.equal(settings.logInlineLimitBytes, 50 * 1024);
        assert.deepEqual(settings.admins, []);
        assert.deepEqual(settings.store, {
            kind: 'azure-tables',
            endpoint: 'https://example.table.core.windows.net',
            connectionString: undefined,
            tablePrefix: 'sbv1',
        });
    });

    it('reads admins, webhook secrets and API-key workspaces', () => {
        const settings = loadSettings({
            ...base,
            SWITCHBOARD_ADMINS: JSON.stringify([
                { tenant: TENANT, object_id: '00000000-0000-0000-0000-000000000003', label: 'Ops lead' },
            ]),
            SWITCHBOARD_WORKSPACES: JSON.stringify([{ id: 'wrkspc_b', name: 'B', api_key_env: 'KEY_B' }]),
            KEY_B: 'sk-test',
            CLAUDE_WEBHOOK_SECRETS: JSON.stringify({ wrkspc_b: 'whsec_x' }),
        });
        assert.deepEqual(settings.admins, [
            { tenant: TENANT, objectId: '00000000-0000-0000-0000-000000000003', label: 'Ops lead' },
        ]);
        assert.deepEqual(settings.webhookSecrets, { wrkspc_b: 'whsec_x' });
    });

    it('rejects incomplete or inconsistent configuration', () => {
        assert.throws(() => loadSettings({ ...base, SWITCHBOARD_TENANTS: '' }), /SWITCHBOARD_TENANTS is required/);
        assert.throws(() => loadSettings({ ...base, SWITCHBOARD_TENANTS: '["x"]' }), /SWITCHBOARD_TENANTS/);
        assert.throws(
            () => loadSettings({ ...base, ANTHROPIC_IDENTITY_TOKEN_FILE: '' }),
            /ANTHROPIC_IDENTITY_TOKEN_FILE/
        );
        assert.throws(
            () => loadSettings({ ...base, CLAUDE_WEBHOOK_SECRETS: '{"wrkspc_other":"x"}' }),
            /not configured/
        );
        assert.throws(() => loadSettings({ ...base, DEFAULT_TIMEZONE: 'Mars/Base' }), /unknown time zone/);
        assert.throws(() => loadSettings({ ...base, SWITCHBOARD_TABLE_PREFIX: '' }), /SWITCHBOARD_TABLE_PREFIX/);
        assert.throws(() => loadSettings({ ...base, NODE_ENV: 'production' }), /CLIENTID/);
        assert.throws(
            () =>
                loadSettings({
                    ...base,
                    NODE_ENV: 'production',
                    STORE_KIND: 'memory',
                    CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTID: 'x',
                }),
            /development only/
        );
        const both = JSON.stringify([
            {
                id: 'wrkspc_a',
                name: 'A',
                api_key_env: 'K',
                federation: JSON.parse(base.SWITCHBOARD_WORKSPACES)[0].federation,
            },
        ]);
        assert.throws(() => loadSettings({ ...base, SWITCHBOARD_WORKSPACES: both, K: 'x' }), /exactly one/);
    });
});

describe('schedules', () => {
    it('accepts five-field cron expressions in a time zone and finds the next run', () => {
        assert.equal(isValidCron('7 * * * *', 'Europe/Berlin'), true);
        assert.equal(isValidCron('0 7 * * * *', 'Europe/Berlin'), false, 'no seconds field');
        assert.equal(isValidCron('every hour', 'Europe/Berlin'), false);
        const next = nextRun({ cron: '0 9 * * *', timezone: 'Europe/Berlin' }, new Date('2026-10-31T10:00:00Z'));
        assert.equal(next?.toISOString(), '2026-11-01T08:00:00.000Z', 'after the switch to winter time');
    });
});
