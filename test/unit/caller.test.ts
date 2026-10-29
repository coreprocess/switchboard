import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CallerResolver, canonicalJson, matchesCall } from '../../src/claude/caller.ts';
import { nullLogger } from '../../src/core/logger.ts';
import { FakeClaudeApi, mcpToolUse } from '../helpers/fakes.ts';

const call = { tool: 'post_message', input: { channel: 'ops', text: 'Incident: queue stuck' }, headers: undefined };

const resolver = (api: FakeClaudeApi) =>
    new CallerResolver({ api, serverName: 'switchboard', log: nullLogger(), attempts: 2, retryDelayMs: 10 });

describe('caller resolution', () => {
    it('compares arguments independent of key order, undefined values and link_thread', () => {
        assert.equal(
            canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } }),
            '{"a":{"d":[1,{"x":1,"y":2}]},"b":1}'
        );
        const event = mcpToolUse('sevt_1', 'post_message', { text: 'Incident: queue stuck', channel: 'ops' });
        assert.equal(
            matchesCall(event, 'switchboard', { tool: 'post_message', input: { ...call.input, link_thread: true } }),
            true
        );
        assert.equal(matchesCall(event, 'other-server', call), false);
        assert.equal(matchesCall(event, 'switchboard', { tool: 'reply', input: call.input }), false);
        assert.equal(
            matchesCall(event, 'switchboard', { tool: 'post_message', input: { channel: 'ops', text: 'x' } }),
            false
        );
    });

    it('ignores session headers: a token holder could set any', async () => {
        const api = new FakeClaudeApi();
        const headers = new Headers({ 'x-anthropic-session-id': 'sesn_victim' });
        assert.equal(await resolver(api).resolve({ ...call, headers }), undefined);
    });

    it('finds the one running session whose recent tool use is this call', async () => {
        const api = new FakeClaudeApi();
        api.addSession('sesn_caller', 'running', [mcpToolUse('sevt_old', 'reply', { thread_id: 'ops/1', text: 'x' })]);
        api.emit(
            'sesn_caller',
            mcpToolUse('sevt_call', 'post_message', {
                channel: 'ops',
                text: 'Incident: queue stuck',
                link_thread: true,
            })
        );
        api.addSession('sesn_other', 'running', [
            mcpToolUse('sevt_x', 'post_message', { channel: 'ops', text: 'Something else' }),
        ]);
        api.addSession('sesn_idle', 'idle', [mcpToolUse('sevt_y', 'post_message', call.input)]);
        const caller = await resolver(api).resolve(call);
        assert.equal(caller?.sessionId, 'sesn_caller');
        assert.equal(caller?.via, 'events');
        assert.equal(caller?.eventId, 'sevt_call');
    });

    it('retries while the tool-use event is not listed yet', async () => {
        const api = new FakeClaudeApi();
        api.addSession('sesn_late', 'running');
        setTimeout(() => api.emit('sesn_late', mcpToolUse('sevt_late', 'post_message', call.input)), 5);
        assert.equal((await resolver(api).resolve(call))?.sessionId, 'sesn_late');
    });

    it('gives up when nothing or more than one session matches', async () => {
        const none = new FakeClaudeApi();
        none.addSession('sesn_a', 'running', [mcpToolUse('sevt_1', 'post_message', { channel: 'ops', text: 'other' })]);
        assert.equal(await resolver(none).resolve(call), undefined);
        const two = new FakeClaudeApi();
        two.addSession('sesn_a', 'running', [mcpToolUse('sevt_1', 'post_message', call.input)]);
        two.addSession('sesn_b', 'running', [mcpToolUse('sevt_2', 'post_message', call.input)]);
        assert.equal(await resolver(two).resolve(call), undefined);
    });
});
