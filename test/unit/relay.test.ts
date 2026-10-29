import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { nullLogger } from '../../src/core/logger.ts';
import { Reconciler } from '../../src/relay/reconciler.ts';
import { Relay, TERMINATED_NOTICE, WORKING_TEXT } from '../../src/relay/relay.ts';
import { MemoryStore } from '../../src/store/memory.ts';
import {
    agentMessage,
    eventually,
    FakeClaudeApi,
    FakeGateway,
    idle,
    mcpToolUse,
    running,
    sessionError,
    terminated,
} from '../helpers/fakes.ts';

const thread = { channelKey: 'ops', rootId: '100' };

describe('relay', () => {
    let api: FakeClaudeApi;
    let store: MemoryStore;
    let gateway: FakeGateway;
    let relay: Relay;

    const newRelay = () =>
        new Relay({
            api,
            store,
            gateway,
            log: nullLogger(),
            approvalExpiryHours: undefined,
            reconnectDelayMs: 10,
            listAttempts: 3,
            listRetryDelayMs: 10,
        });

    beforeEach(async () => {
        api = new FakeClaudeApi();
        store = new MemoryStore();
        gateway = new FakeGateway();
        relay = newRelay();
        api.addSession('sesn_1', 'idle', [idle('sevt_before')]);
        await relay.link(thread, 'sesn_1', 'user');
    });

    it('opens the stream before sending and shows a working message', async () => {
        await relay.sendUserMessage('sesn_1', thread, 'hello');
        assert.deepEqual(api.streamsOpened, ['sesn_1']);
        assert.deepEqual(gateway.visible('100'), [WORKING_TEXT]);
        const record = await store.getSession('sesn_1');
        assert.equal(record?.pending, true);
        assert.equal(record?.watermarkEventId, api.sessions.get('sesn_1')?.events.at(-1)?.id);
        assert.equal(relay.isStreaming('sesn_1'), true);
    });

    it('replaces the working message with the turn text when the turn ends', async () => {
        await relay.sendUserMessage('sesn_1', thread, 'hello');
        api.emit('sesn_1', running('sevt_r'));
        api.emit('sesn_1', agentMessage('sevt_m1', 'First part.'));
        api.emit('sesn_1', mcpToolUse('sevt_t', 'reply', {}));
        api.emit('sesn_1', agentMessage('sevt_m2', 'Second part.'));
        api.emit('sesn_1', idle('sevt_idle'));
        await eventually(() => gateway.visible('100')[0] === 'First part.\n\nSecond part.');
        assert.equal(gateway.visible('100').length, 1);
        const record = await store.getSession('sesn_1');
        assert.equal(record?.pending, false);
        assert.equal(record?.watermarkEventId, 'sevt_idle');
        assert.equal(record?.workingMessageId, undefined);
        await eventually(() => !relay.isStreaming('sesn_1'));
    });

    it('relays each event once, however often it drains', async () => {
        await relay.sendUserMessage('sesn_1', thread, 'hello');
        api.emit('sesn_1', agentMessage('sevt_m', 'Answer'));
        api.emit('sesn_1', idle('sevt_idle'));
        await Promise.all([relay.drain('sesn_1'), relay.drain('sesn_1'), relay.drain('sesn_1', 'sevt_idle')]);
        await relay.drain('sesn_1');
        assert.deepEqual(gateway.visible('100'), ['Answer']);
    });

    it('keeps text of a running turn until it ends and survives a restart', async () => {
        await relay.sendUserMessage('sesn_1', thread, 'hello');
        api.emit('sesn_1', agentMessage('sevt_m', 'Answer'));
        relay.close();
        // a new process: nothing in memory, only the store
        relay = newRelay();
        await relay.drain('sesn_1');
        assert.deepEqual(gateway.visible('100'), [WORKING_TEXT]);
        api.emit('sesn_1', idle('sevt_idle'));
        await new Reconciler({ api, store, relay, log: nullLogger() }).tick();
        assert.deepEqual(gateway.visible('100'), ['Answer']);
    });

    it('reopens the stream of a running pending session on reconcile', async () => {
        await relay.sendUserMessage('sesn_1', thread, 'hello');
        relay.close();
        relay = newRelay();
        const session = api.sessions.get('sesn_1');
        assert.ok(session);
        session.status = 'running';
        await new Reconciler({ api, store, relay, log: nullLogger() }).tick();
        assert.equal(relay.isStreaming('sesn_1'), true);
        api.emit('sesn_1', agentMessage('sevt_m', 'Done'));
        api.emit('sesn_1', idle('sevt_idle'));
        await eventually(() => gateway.visible('100')[0] === 'Done');
    });

    it('does not relay text of turns Switchboard did not start, but advances past them', async () => {
        api.emit('sesn_1', agentMessage('sevt_auto', 'Autonomous summary'));
        api.emit('sesn_1', idle('sevt_auto_idle'));
        await relay.drain('sesn_1');
        assert.deepEqual(gateway.visible('100'), []);
        assert.equal((await store.getSession('sesn_1'))?.watermarkEventId, 'sevt_auto_idle');
    });

    it('relays only what follows the message that started the turn', async () => {
        await relay.drain('sesn_1');
        api.emit('sesn_1', agentMessage('sevt_auto', 'Autonomous text without idle yet'));
        await relay.sendUserMessage('sesn_1', thread, 'question');
        api.emit('sesn_1', agentMessage('sevt_answer', 'Answer'));
        api.emit('sesn_1', idle('sevt_idle'));
        await relay.drain('sesn_1');
        assert.deepEqual(gateway.visible('100'), ['Answer']);
    });

    it('keeps the watermark of a running turn when more messages arrive', async () => {
        await relay.sendUserMessage('sesn_1', thread, 'first');
        api.emit('sesn_1', agentMessage('sevt_a', 'Reply to first'));
        await relay.sendUserMessage('sesn_1', thread, 'second');
        api.emit('sesn_1', agentMessage('sevt_b', 'Reply to second'));
        api.emit('sesn_1', idle('sevt_idle'));
        await relay.drain('sesn_1');
        assert.deepEqual(gateway.visible('100'), ['Reply to first\n\nReply to second']);
    });

    it('splits long replies', async () => {
        await relay.sendUserMessage('sesn_1', thread, 'hello');
        const paragraph = `${'x'.repeat(7000)}`;
        api.emit('sesn_1', agentMessage('sevt_m', `${paragraph}\n\n${paragraph}`));
        api.emit('sesn_1', idle('sevt_idle'));
        await relay.drain('sesn_1');
        assert.deepEqual(gateway.visible('100'), [paragraph, paragraph]);
    });

    it('removes the working message when the turn produced no text', async () => {
        await relay.sendUserMessage('sesn_1', thread, 'hello');
        api.emit('sesn_1', idle('sevt_idle'));
        await relay.drain('sesn_1');
        assert.deepEqual(gateway.visible('100'), []);
    });

    it('posts a confirmation card once for a tool call that waits for approval', async () => {
        await relay.sendUserMessage('sesn_1', thread, 'hello');
        api.emit('sesn_1', mcpToolUse('sevt_ask', 'delete_records', { table: 'x' }, 'db', 'ask'));
        api.emit('sesn_1', idle('sevt_idle', { type: 'requires_action', event_ids: ['sevt_ask'] }));
        await relay.drain('sesn_1');
        // a repeated pass from an older watermark (crash before saving) must not post it again
        const record = await store.getSession('sesn_1');
        assert.ok(record);
        await store.putSession({ ...record, watermarkEventId: 'sevt_before', watermarkAt: undefined });
        await relay.drain('sesn_1');
        const cards = gateway.messages.filter((m) => m.content.card);
        assert.equal(cards.length, 1);
        assert.ok(JSON.stringify(cards[0]?.content.card).includes('db / delete_records'));
        const approval = await store.getApproval('tc_sevt_ask');
        assert.equal(approval?.toolUseId, 'sevt_ask');
        assert.equal(approval?.messageId, cards[0]?.messageId);
    });

    it('posts notices for budget pauses, errors and the end of the session', async () => {
        await relay.sendUserMessage('sesn_1', thread, 'hello');
        api.emit('sesn_1', sessionError('sevt_retry', true));
        api.emit('sesn_1', sessionError('sevt_fatal', false));
        api.emit('sesn_1', idle('sevt_budget', { type: 'budget_reached' }));
        api.emit('sesn_1', terminated('sevt_end'));
        await relay.drain('sesn_1');
        const visible = gateway.visible('100');
        assert.equal(visible.length, 3);
        assert.match(visible[0] ?? '', /Agent error \(unknown_error\): boom/);
        assert.match(visible[1] ?? '', /budget/);
        assert.equal(visible[2], TERMINATED_NOTICE);
    });

    it('undoes the pending state when sending fails', async () => {
        api.failSend = new Error('400 session is waiting for confirmation');
        await assert.rejects(relay.sendUserMessage('sesn_1', thread, 'hello'), /waiting/);
        const record = await store.getSession('sesn_1');
        assert.equal(record?.pending, false);
        assert.deepEqual(gateway.visible('100'), []);
        assert.equal(relay.isStreaming('sesn_1'), false);
    });

    it('skips to the latest event when the watermark event is gone', async () => {
        const record = await store.getSession('sesn_1');
        assert.ok(record);
        await store.putSession({ ...record, pending: true, watermarkEventId: 'sevt_missing', watermarkAt: undefined });
        api.emit('sesn_1', agentMessage('sevt_m', 'Unknown position'));
        await relay.drain('sesn_1');
        assert.deepEqual(gateway.visible('100'), []);
        assert.equal((await store.getSession('sesn_1'))?.watermarkEventId, 'sevt_m');
    });

    it('relays a turn whose message was sent after an idle that was not drained yet', async () => {
        await relay.sendUserMessage('sesn_1', thread, 'q1');
        relay.closeStream('sesn_1'); // stream dropped: the first idle is not drained before q2
        const session = api.sessions.get('sesn_1');
        assert.ok(session);
        session.events.push(running('r1'), agentMessage('m1', 'A1'), idle('i1'));
        await relay.sendUserMessage('sesn_1', thread, 'q2');
        await relay.drain('sesn_1');
        assert.equal((await store.getSession('sesn_1'))?.pending, true, 'still waiting for the turn of q2');
        session.events.push(running('r2'), agentMessage('m2', 'A2'), idle('i2'));
        await relay.drain('sesn_1');
        assert.deepEqual(gateway.visible('100'), ['A1', 'A2']);
        assert.equal((await store.getSession('sesn_1'))?.pending, false);
    });

    it('keeps the stream of a new turn open while a drain runs', async () => {
        await relay.sendUserMessage('sesn_1', thread, 'q1');
        const session = api.sessions.get('sesn_1');
        assert.ok(session);
        session.events.push(running('r1'), agentMessage('m1', 'A1'), idle('i1'));
        await Promise.all([relay.drain('sesn_1'), relay.sendUserMessage('sesn_1', thread, 'q2')]);
        assert.equal(relay.isStreaming('sesn_1'), true);
    });

    it('posts a tool confirmation card again when the first post failed', async () => {
        const session = api.sessions.get('sesn_1');
        assert.ok(session);
        session.events.push(
            mcpToolUse('tu1', 'deploy', {}, 'other', 'ask'),
            idle('i1', { type: 'requires_action', event_ids: ['tu1'] })
        );
        const reply = gateway.reply.bind(gateway);
        let fail = true;
        gateway.reply = async (...args) => {
            if (!fail) return reply(...args);
            fail = false;
            throw new Error('429 Too Many Requests');
        };
        await assert.rejects(relay.drain('sesn_1'), /429/);
        await relay.drain('sesn_1');
        await relay.drain('sesn_1');
        assert.deepEqual(gateway.visible('100'), ['[card]']);
        assert.ok((await store.getApproval('tc_tu1'))?.messageId);
    });

    it('relays into the thread a turn started in', async () => {
        await relay.link({ channelKey: 'ops', rootId: '200' }, 'sesn_1', 'agent');
        await relay.sendUserMessage('sesn_1', { channelKey: 'ops', rootId: '200' }, 'from the second thread');
        api.emit('sesn_1', agentMessage('sevt_m', 'Here'));
        api.emit('sesn_1', idle('sevt_idle'));
        await relay.drain('sesn_1');
        assert.deepEqual(gateway.visible('200'), ['Here']);
        assert.deepEqual(gateway.visible('100'), []);
    });
});
