import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { Approvals, type CardClick } from '../../src/approvals/approvals.ts';
import { renderApprovalCard, sanitiseAgentCard, VERB_APPROVE, VERB_DENY } from '../../src/approvals/cards.ts';
import type { ChannelBinding } from '../../src/config/channels.ts';
import { nullLogger } from '../../src/core/logger.ts';
import { Relay } from '../../src/relay/relay.ts';
import { MemoryStore } from '../../src/store/memory.ts';
import { testConfig } from '../helpers/config.ts';
import { eventually, FakeClaudeApi, FakeGateway } from '../helpers/fakes.ts';
import { approval } from '../helpers/store-contract.ts';

const MEMBER = 'bbbbbbbb-0000-0000-0000-000000000002';

describe('approvals', () => {
    let store: MemoryStore;
    let api: FakeClaudeApi;
    let gateway: FakeGateway;
    let approvals: Approvals;
    let ops: ChannelBinding;

    const setUp = (expiryHours?: number) => {
        store = new MemoryStore();
        api = new FakeClaudeApi();
        gateway = new FakeGateway();
        const log = nullLogger();
        const relay = new Relay({ api, store, gateway, log, approvalExpiryHours: undefined });
        approvals = new Approvals({ store, gateway, relay, log, expiryHours });
        const binding = testConfig().channels.ops;
        assert.ok(binding);
        ops = binding;
        api.addSession('sesn_1');
    };

    const requestCard = async () => {
        await store.putSession({
            sessionId: 'sesn_1',
            channelKey: 'ops',
            rootId: '100',
            watermarkEventId: undefined,
            watermarkAt: undefined,
            pending: false,
            lastSentEventId: undefined,
            workingMessageId: undefined,
            updatedAt: new Date().toISOString(),
        });
        return approvals.request({
            channelKey: 'ops',
            rootId: '100',
            sessionId: 'sesn_1',
            title: 'Restart the worker',
            summary: 'It is stuck',
            steps: ['Drain', 'Restart'],
        });
    };

    const click = (cardId: string, overrides: Partial<CardClick> = {}): CardClick => ({
        cardId,
        verb: VERB_APPROVE,
        channelKey: 'ops',
        channel: ops,
        rootId: '100',
        messageId: gateway.messages.find((m) => m.content.card)?.messageId,
        aadObjectId: MEMBER,
        name: 'Jane Doe',
        ...overrides,
    });

    const markers = () =>
        api.sent.flatMap((s) =>
            s.events.flatMap((e) =>
                e.type === 'user.message' ? e.content.map((c) => ('text' in c ? c.text : '')) : []
            )
        );

    beforeEach(() => setUp());

    it('posts a card with the steps and Approve / Deny buttons', async () => {
        const record = await requestCard();
        assert.match(record.cardId, /^card_[A-Za-z0-9_-]{22}$/);
        const posted = gateway.messages.find((m) => m.content.card);
        assert.ok(posted);
        const card = JSON.stringify(posted.content.card);
        assert.ok(card.includes('1. Drain\\n2. Restart'));
        assert.ok(card.includes(VERB_APPROVE) && card.includes(VERB_DENY));
        assert.equal((await store.getApproval(record.cardId))?.messageId, posted.messageId);
    });

    it('applies the first click only and tells the session once', async () => {
        const { cardId } = await requestCard();
        const first = await approvals.click(click(cardId));
        assert.ok('card' in first);
        assert.ok(JSON.stringify(first.card).includes('Approved by Jane Doe'));
        assert.ok(!JSON.stringify(first.card).includes(VERB_APPROVE));

        const second = await approvals.click(
            click(cardId, { verb: VERB_DENY, name: 'Max', aadObjectId: 'cccccccc-0000-0000-0000-000000000003' })
        );
        assert.ok('card' in second);
        assert.ok(JSON.stringify(second.card).includes('Approved by Jane Doe'));

        await eventually(() => markers().length > 0);
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(markers().length, 1);
        assert.match(
            markers()[0] ?? '',
            new RegExp(
                `^\\[switchboard:approval\\] card=${cardId} decision=approved by="Jane Doe" aad=${MEMBER} at=\\S+$`
            )
        );
        assert.equal((await store.getApproval(cardId))?.status, 'approved');
        // the card was updated for everyone in the thread
        assert.ok(gateway.updates.some((u) => JSON.stringify(u.content.card).includes('Approved by Jane Doe')));
    });

    it('records a denial', async () => {
        const { cardId } = await requestCard();
        await approvals.click(click(cardId, { verb: VERB_DENY }));
        await eventually(() => markers().length === 1);
        assert.match(markers()[0] ?? '', /decision=denied/);
    });

    it('rejects clicks from another channel, another message, unknown cards and strangers', async () => {
        const { cardId } = await requestCard();
        assert.ok('message' in (await approvals.click(click(cardId, { channelKey: 'restricted' }))));
        assert.ok('message' in (await approvals.click(click(cardId, { messageId: '999999' }))));
        assert.ok('message' in (await approvals.click(click(cardId, { rootId: '200', messageId: undefined }))));
        assert.ok('message' in (await approvals.click(click('card_unknown'))));
        assert.ok('message' in (await approvals.click(click(cardId, { aadObjectId: undefined }))));
        assert.ok('message' in (await approvals.click(click(cardId, { verb: 'switchboard.other' }))));
        const restricted = testConfig().channels.restricted;
        assert.ok(restricted);
        assert.ok('message' in (await approvals.click(click(cardId, { channel: restricted }))));
        assert.equal((await store.getApproval(cardId))?.status, 'pending');
        assert.equal(api.sent.length, 0);
    });

    it('expires cards after the configured time', async () => {
        setUp(1);
        const { cardId } = await requestCard();
        const record = await store.getApproval(cardId);
        assert.ok(record?.expiresAt);
        // move the card's expiry into the past
        await store.createApproval({ ...record, cardId: 'card_old', expiresAt: '2000-01-01T00:00:00.000Z' });
        await store.setApprovalMessageId('card_old', record.messageId ?? '');
        const result = await approvals.click(click('card_old'));
        assert.ok('card' in result);
        assert.ok(JSON.stringify(result.card).includes('Expired'));
        assert.equal((await store.getApproval('card_old'))?.status, 'expired');
        assert.equal(api.sent.length, 0);
    });

    it('sends tool confirmations for tool confirmation cards', async () => {
        await requestCard();
        await store.createApproval(
            approval('tc_sevt_9', { kind: 'tool_confirmation', toolUseId: 'sevt_9', messageId: '42' })
        );
        await approvals.click(click('tc_sevt_9', { messageId: '42', verb: VERB_DENY }));
        await eventually(() => api.sent.length === 1);
        assert.deepEqual(api.sent[0]?.events, [
            {
                type: 'user.tool_confirmation',
                tool_use_id: 'sevt_9',
                result: 'deny',
                deny_message: 'Denied by Jane Doe in Teams.',
            },
        ]);
    });
});

describe('cards', () => {
    it('removes Switchboard actions from agent cards', () => {
        const card = sanitiseAgentCard({
            type: 'AdaptiveCard',
            body: [
                { type: 'TextBlock', text: 'hi' },
                {
                    type: 'ActionSet',
                    actions: [
                        { type: 'Action.Execute', verb: 'switchboard.approve', data: { card_id: 'card_x' } },
                        { type: 'Action.Submit', data: { card_id: 'card_x' } },
                        { type: 'Action.OpenUrl', url: 'https://example.com' },
                    ],
                },
            ],
            actions: [{ type: 'Action.Execute', verb: 'SWITCHBOARD.deny' }],
        });
        const text = JSON.stringify(card);
        assert.ok(!text.toLowerCase().includes('switchboard.') && !text.includes('card_id'));
        assert.ok(text.includes('Action.OpenUrl'));
        assert.throws(() => sanitiseAgentCard({ type: 'Other' }));
        assert.throws(() => sanitiseAgentCard([]));
    });

    it('removes reserved actions outside arrays and card refresh', () => {
        const reserved = { type: 'Action.Execute', verb: 'switchboard.approve', data: { card_id: 'card_x' } };
        const card = sanitiseAgentCard({
            type: 'AdaptiveCard',
            refresh: { action: reserved, userIds: ['29:someone'] },
            selectAction: reserved,
            body: [
                { type: 'Container', selectAction: reserved, items: [{ type: 'TextBlock', text: 'hi' }] },
                {
                    type: 'ActionSet',
                    actions: [{ type: 'Action.OpenUrl', url: 'https://example.com', fallback: reserved }],
                },
            ],
        });
        const text = JSON.stringify(card);
        assert.ok(!text.includes('switchboard.') && !text.includes('card_id') && !text.includes('refresh'), text);
        assert.ok(text.includes('Action.OpenUrl') && text.includes('hi'));
    });

    it('renders tool confirmations with Allow', () => {
        const card = renderApprovalCard(approval('tc_1', { kind: 'tool_confirmation' }));
        assert.ok(JSON.stringify(card).includes('"Allow"'));
    });
});
