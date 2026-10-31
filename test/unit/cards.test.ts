import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    buttonTitle,
    CardError,
    confirmationCard,
    lockedStatus,
    MAX_CARD_BYTES,
    prepareAgentCard,
    withoutButtons,
} from '../../src/cards/cards.ts';

const card = (extra: Record<string, unknown> = {}) => ({
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
        { type: 'TextBlock', text: 'Deploy?' },
        { type: 'Container', selectAction: { type: 'Action.Execute', verb: 'open' }, items: [] },
        { type: 'ActionSet', actions: [{ type: 'Action.Execute', title: 'Inner', verb: 'inner' }] },
    ],
    actions: [
        { type: 'Action.Execute', title: 'Approve', verb: 'approve', data: { step: 2 } },
        { type: 'Action.OpenUrl', title: 'Docs', url: 'https://example.com' },
        {
            type: 'Action.ShowCard',
            title: 'More',
            card: { type: 'AdaptiveCard', actions: [{ type: 'Action.Execute', verb: 'deep' }] },
        },
    ],
    ...extra,
});

describe('agent cards', () => {
    it('adds the card ID to every Action.Execute, at any depth, and leaves the rest alone', () => {
        const prepared = JSON.stringify(prepareAgentCard(card(), 'card_1'));
        assert.equal(prepared.match(/"switchboard_card":"card_1"/g)?.length, 4);
        assert.ok(prepared.includes('"step":2'));
        assert.ok(prepared.includes('Action.OpenUrl') && prepared.includes('Action.ShowCard'));
    });

    it('rejects Action.Submit anywhere, unsupported versions, non-cards, non-object data and oversized cards', () => {
        const submit = card({ actions: [{ type: 'Action.ShowCard', card: { actions: [{ type: 'Action.Submit' }] } }] });
        assert.throws(() => prepareAgentCard(submit, 'c'), /Action.Submit is not supported, use Action.Execute/);
        assert.throws(() => prepareAgentCard({ ...card(), version: '1.6' }, 'c'), CardError);
        assert.throws(() => prepareAgentCard({ type: 'Thing' }, 'c'), CardError);
        assert.throws(
            () => prepareAgentCard(card({ actions: [{ type: 'Action.Execute', data: 'x' }] }), 'c'),
            /must be an object/
        );
        const big = card({ body: [{ type: 'TextBlock', text: 'x'.repeat(MAX_CARD_BYTES) }] });
        assert.throws(() => prepareAgentCard(big, 'c'), /Teams allows at most/);
    });

    it('renders the locked state without buttons and with the waiting line', () => {
        const prepared = prepareAgentCard(card(), 'card_1');
        assert.equal(buttonTitle(prepared, 'approve'), 'Approve');
        assert.equal(buttonTitle(prepared, 'unknown'), 'unknown');
        const locked = withoutButtons(prepared, lockedStatus('Jane Doe', 'Approve'));
        const json = JSON.stringify(locked);
        assert.ok(!json.includes('Action.Execute'));
        assert.ok(json.includes('Action.OpenUrl'), 'other actions stay');
        assert.ok(!json.includes('"ActionSet"'), 'empty action sets disappear');
        assert.ok(json.includes('⏳ Jane Doe chose \\"Approve\\" – waiting for the agent'));
    });

    it('renders confirmations open and decided', () => {
        const open = JSON.stringify(confirmationCard('conf_1', { toolName: 'bash', input: '{"command":"ls"}' }));
        assert.ok(open.includes('"switchboard_confirmation":"conf_1"') && open.includes('switchboard.allow'));
        const decided = JSON.stringify(
            confirmationCard('conf_1', { toolName: 'bash', input: '{}', decision: 'deny', by: 'Jane' })
        );
        assert.ok(decided.includes('❌ Denied by Jane') && !decided.includes('Action.Execute'));
    });
});
