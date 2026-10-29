import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { ApprovalRecord, SessionRecord, Store } from '../../src/store/store.ts';

export const approval = (cardId: string, overrides: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
    cardId,
    kind: 'approval',
    sessionId: 'sesn_1',
    channelKey: 'ops',
    rootId: '100',
    messageId: undefined,
    title: 'Restart the worker',
    summary: 'Restarts the stuck worker',
    steps: ['Drain the queue', 'Restart'],
    toolUseId: undefined,
    status: 'pending',
    decidedBy: undefined,
    decidedByAad: undefined,
    decidedAt: undefined,
    createdAt: '2026-10-29T10:00:00.000Z',
    expiresAt: undefined,
    ...overrides,
});

const session = (sessionId: string, updatedAt: string): SessionRecord => ({
    sessionId,
    channelKey: 'ops',
    rootId: '100',
    watermarkEventId: 'sevt_1',
    watermarkAt: '2026-10-29T10:00:00.000Z',
    pending: true,
    lastSentEventId: undefined,
    workingMessageId: '555',
    updatedAt,
});

/** The behaviour every Store implementation must have; run against each implementation. */
export const storeContract = (create: () => Promise<Store>) => {
    it('stores and reads threads', async () => {
        const store = await create();
        assert.equal(await store.getThread('ops', '100'), undefined);
        await store.putThread({
            channelKey: 'ops',
            rootId: '100',
            sessionId: 'sesn_1',
            createdAt: 't',
            createdBy: 'user',
        });
        assert.deepEqual(await store.getThread('ops', '100'), {
            channelKey: 'ops',
            rootId: '100',
            sessionId: 'sesn_1',
            createdAt: 't',
            createdBy: 'user',
        });
        assert.equal(await store.getThread('other', '100'), undefined);
    });

    it('replaces session records and clears removed fields', async () => {
        const store = await create();
        await store.putSession(session('sesn_a', '2026-10-29T10:00:00.000Z'));
        assert.deepEqual(await store.getSession('sesn_a'), session('sesn_a', '2026-10-29T10:00:00.000Z'));
        await store.putSession({
            ...session('sesn_a', '2026-10-29T11:00:00.000Z'),
            pending: false,
            lastSentEventId: undefined,
            workingMessageId: undefined,
        });
        const updated = await store.getSession('sesn_a');
        assert.equal(updated?.pending, false);
        assert.equal(updated?.workingMessageId, undefined);
    });

    it('lists sessions updated since a time', async () => {
        const store = await create();
        await store.putSession(session('sesn_old', '2026-10-27T10:00:00.000Z'));
        await store.putSession(session('sesn_new', '2026-10-29T10:00:00.000Z'));
        const recent = await store.listSessionsUpdatedSince('2026-10-28T10:00:00.000Z');
        assert.deepEqual(
            recent.map((s) => s.sessionId).filter((id) => id === 'sesn_old' || id === 'sesn_new'),
            ['sesn_new']
        );
    });

    it('creates approvals once and decides them once', async () => {
        const store = await create();
        assert.equal(await store.createApproval(approval('card_contract')), true);
        assert.equal(await store.createApproval(approval('card_contract')), false);
        await store.setApprovalMessageId('card_contract', '777');
        const stored = await store.getApproval('card_contract');
        assert.equal(stored?.messageId, '777');
        assert.deepEqual(stored?.steps, ['Drain the queue', 'Restart']);

        const decision = { status: 'approved' as const, decidedBy: 'Jane', decidedByAad: 'aad-1', decidedAt: 't1' };
        const first = await store.decideApproval('card_contract', decision);
        assert.equal(first?.applied, true);
        assert.equal(first?.record.status, 'approved');
        const second = await store.decideApproval('card_contract', { ...decision, status: 'denied', decidedBy: 'Max' });
        assert.equal(second?.applied, false);
        assert.equal(second?.record.status, 'approved');
        assert.equal(second?.record.decidedBy, 'Jane');
        assert.equal(await store.decideApproval('card_unknown', decision), undefined);
    });

    it('lets only one of concurrent decisions win', async () => {
        const store = await create();
        await store.createApproval(approval('card_race'));
        const results = await Promise.all(
            ['a', 'b', 'c', 'd'].map((who) =>
                store.decideApproval('card_race', {
                    status: 'approved',
                    decidedBy: who,
                    decidedByAad: who,
                    decidedAt: 't',
                })
            )
        );
        assert.equal(results.filter((r) => r?.applied).length, 1);
        const winner = results.find((r) => r?.applied)?.record.decidedBy;
        assert.equal((await store.getApproval('card_race'))?.decidedBy, winner);
    });

    it('stores conversation references', async () => {
        const store = await create();
        const record = {
            channelKey: 'ops',
            serviceUrl: 'https://smba.example.com/',
            tenantId: 'tenant',
            channelId: '19:c@thread.tacv2',
            teamId: undefined,
            aadGroupId: 'group',
            botId: '28:bot',
            updatedAt: 't',
        };
        await store.putConversation(record);
        assert.deepEqual(await store.getConversation('ops'), record);
    });

    it('claims webhook events once, releases and purges them', async () => {
        const store = await create();
        assert.equal(await store.claimWebhookEvent('whe_1', '2026-10-01T00:00:00.000Z'), true);
        assert.equal(await store.claimWebhookEvent('whe_1', '2026-10-01T00:00:00.000Z'), false);
        await store.releaseWebhookEvent('whe_1');
        assert.equal(await store.claimWebhookEvent('whe_1', '2026-10-01T00:00:00.000Z'), true);
        await store.claimWebhookEvent('whe_2', '2026-10-29T00:00:00.000Z');
        assert.equal(await store.purgeWebhookEvents('2026-10-22T00:00:00.000Z'), 1);
        assert.equal(await store.claimWebhookEvent('whe_1', '2026-10-29T00:00:00.000Z'), true);
        assert.equal(await store.claimWebhookEvent('whe_2', '2026-10-29T00:00:00.000Z'), false);
    });
};
