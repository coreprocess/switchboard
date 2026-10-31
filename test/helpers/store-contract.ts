import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createEntities } from '../../src/store/entities.ts';
import type { Store } from '../../src/store/store.ts';

/** The behaviour every store must have; run against the in-memory store and Table Storage (Azurite). */
export const storeContract = (makeStore: () => Promise<Store>) => {
    it('inserts once and reads back', async () => {
        const store = await makeStore();
        assert.ok(await store.insert('seen', 'activity', 'a1', { at: '2026-10-31T00:00:00.000Z' }));
        assert.equal(await store.insert('seen', 'activity', 'a1', { at: 'later' }), undefined);
        assert.equal((await store.get('seen', 'activity', 'a1'))?.row.at, '2026-10-31T00:00:00.000Z');
        assert.equal(await store.get('seen', 'activity', 'missing'), undefined);
    });

    it('updates only with the current ETag', async () => {
        const store = await makeStore();
        const first = await store.insert('jobs', 'ch', 'job', { activeRun: '' });
        assert.ok(first);
        const won = await store.update('jobs', first, { activeRun: 'run-1' });
        assert.ok(won);
        assert.equal(await store.update('jobs', first, { activeRun: 'run-2' }), undefined, 'stale ETag loses');
        assert.equal((await store.get('jobs', 'ch', 'job'))?.row.activeRun, 'run-1');
        assert.equal(await store.delete('jobs', 'ch', 'job', first.etag), false);
        assert.equal(await store.delete('jobs', 'ch', 'job', won.etag), true);
        assert.equal(await store.delete('jobs', 'ch', 'job'), false);
    });

    it('filters by partition and conditions; missing properties never match', async () => {
        const store = await makeStore();
        await store.upsert('conversations', 'ch1', 'r1', { lastActivity: '2026-01-01', owningSession: 'sesn_1' });
        await store.upsert('conversations', 'ch1', 'r2', { lastActivity: '2026-06-01' });
        await store.upsert('conversations', 'ch2', 'r3', { lastActivity: '2025-01-01', owningSession: 'sesn_3' });
        const old = await store.list('conversations', {
            where: [{ field: 'lastActivity', op: 'lt', value: '2026-03-01' }],
        });
        assert.deepEqual(old.map((r) => r.rowKey).sort(), ['r1', 'r3']);
        const owned = await store.list('conversations', {
            partitionKey: 'ch1',
            where: [{ field: 'owningSession', op: 'gt', value: '' }],
        });
        assert.deepEqual(
            owned.map((r) => r.rowKey),
            ['r1']
        );
    });

    it('keeps keys with characters Table Storage forbids, and long values', async () => {
        const store = await makeStore();
        const key = '19:abc/def#x?y\\z%@thread.tacv2';
        const long = 'x'.repeat(70_000);
        await store.upsert('cards', key, '', { json: long, n: 3, flag: true });
        const row = await store.get('cards', key, '');
        assert.equal(row?.partitionKey, key);
        assert.ok(row?.row.json === long, 'long value read back whole');
        assert.equal(row?.row.n, 3);
        assert.equal(row?.row.flag, true);
        assert.deepEqual(
            (await store.list('cards', { partitionKey: key })).map((r) => r.partitionKey),
            [key]
        );
    });

    it('validates entities and modifies them with retries', async () => {
        const entities = createEntities(await makeStore());
        await entities.jobs.upsert({
            channelId: 'ch',
            jobId: 'job_1',
            teamId: 'team',
            deploymentId: 'depl_1',
            cron: '7 * * * *',
            timezone: 'Europe/Berlin',
            enabled: true,
            updatedBy: 'admin',
            updatedAt: '2026-10-31T00:00:00.000Z',
        });
        const changed = await entities.jobs.modify('ch', 'job_1', (job) => ({ ...job, enabled: false }));
        assert.equal(changed?.value.enabled, false);
        assert.equal(changed?.value.activeRun, undefined);
        assert.equal(await entities.jobs.modify('ch', 'missing', (job) => job), undefined);
    });
};
