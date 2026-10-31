import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { eventually, type Harness, sleep, startHarness } from '../helpers/harness.ts';
import type { Turn } from '../helpers/mock-claude.ts';
import { signWebhook, webhookBody } from '../helpers/webhooks.ts';

/** Recovery from pods that died, late webhooks and failures that would otherwise leave things stuck. */
describe('recovery', () => {
    let h: Harness;
    const results: Record<string, { text: string; isError: boolean }> = {};

    before(async () => {
        h = await startHarness({ instances: 2, loops: true });
        await h.bind();
        h.claude.agent = async (turn: Turn) => {
            const last = turn.text.split('\n').at(-1) ?? '';
            if (last === 'half-done call') {
                // the call's ID is the next event ID: a pod "claims" it and dies before answering
                const probe = h.claude.emit(turn.sessionId, { type: 'span.probe' });
                const next = `sevt_${Number(String(probe.id).slice(5)) + 1}`;
                await h.instances[0]?.sb.entities.toolCalls.insert({
                    sessionId: turn.sessionId,
                    eventId: next,
                    tool: 'send_update',
                    status: 'started',
                    startedAt: new Date().toISOString(),
                });
                results.halfDone = await turn.callTool('send_update', { text: 'never posted' });
                turn.say('Carried on.');
                return;
            }
            if (last === 'card please') {
                results.show = await turn.callTool('show_card', {
                    card: {
                        type: 'AdaptiveCard',
                        version: '1.5',
                        body: [{ type: 'TextBlock', text: 'Go?' }],
                        actions: [{ type: 'Action.Execute', title: 'Go', verb: 'go' }],
                    },
                });
                return;
            }
            if (last === 'text then tool') {
                turn.say('Let me check…');
                await turn.callTool('send_update', { text: 'checking' });
                return;
            }
            turn.say(`Echo: ${last}`);
        };
    });

    after(async () => {
        await h.stop();
    });

    it('answers a tool call a dead pod left half-done, instead of hanging', async () => {
        const root = h.message('half-done call');
        await h.post(root, 0);
        await eventually(() => h.thread(root.id).includes('Carried on.'), 10_000, 'session goes on');
        assert.equal(results.halfDone?.isError, true);
        assert.match(results.halfDone?.text ?? '', /restarted while carrying out this call/);
        assert.ok(!h.thread(root.id).includes('never posted'));
    });

    it('does not follow an idle session for good after a late webhook', async () => {
        const root = h.message('hello');
        await h.post(root, 0);
        await eventually(() => h.thread(root.id).includes('Echo: hello'));
        const sessionId = [...h.claude.sessions.keys()].at(-1) ?? '';
        await eventually(() => !h.instances.some((i) => i.sb.relay.isFollowing(sessionId)), 5000, 'released');
        const body = webhookBody('whe_late', 'session.status_idled', { id: sessionId });
        const response = await fetch(`${h.instances[1]?.base}/webhooks/claude`, {
            method: 'POST',
            headers: signWebhook(h.secret, 'whe_late', body),
            body,
        });
        assert.equal(response.status, 204);
        await eventually(() => !h.instances.some((i) => i.sb.relay.isFollowing(sessionId)), 5000, 'released again');
        const entry = await h.instances[0]?.sb.sessions.get(sessionId);
        assert.equal(entry?.relayOwner, undefined);
    });

    it('notices a session archived without an event reaching anyone', async () => {
        const root = h.message('to be archived');
        await h.post(root, 0);
        await eventually(() => h.thread(root.id).includes('Echo: to be archived'));
        const sessionId = [...h.claude.sessions.keys()].at(-1) ?? '';
        const session = h.claude.sessions.get(sessionId);
        assert.ok(session);
        session.session.archived_at = new Date().toISOString();
        session.session.status = 'terminated';
        await h.instances[1]?.sb.relay.wake(sessionId);
        await eventually(async () => (await h.instances[0]?.sb.sessions.get(sessionId))?.state === 'ended', 5000);
    });

    it('does not post text from before a tool call as the final answer', async () => {
        const root = h.message('text then tool');
        await h.post(root, 0);
        await eventually(() => h.thread(root.id).includes('checking'));
        await sleep(300);
        assert.ok(!h.thread(root.id).includes('Let me check…'));
    });

    it('unlocks a card when the click cannot reach the agent', async () => {
        const root = h.message('card please');
        await h.post(root, 0);
        await eventually(() => results.show !== undefined);
        const cardId = JSON.parse(results.show?.text ?? '{}').card_id as string;
        const posted = h.connector.messages.find((m) => JSON.stringify(m.activity).includes(cardId));
        assert.ok(posted);
        const sessionId = [...h.claude.sessions.keys()].at(-1) ?? '';
        await eventually(() => h.claude.sessions.get(sessionId)?.session.status === 'idle');
        // the platform refuses events for a terminated session: the click cannot be delivered
        const session = h.claude.sessions.get(sessionId);
        assert.ok(session);
        session.session.status = 'terminated';
        const click = await h.post(h.click(root.id, posted.id, 'go', { switchboard_card: cardId }), 1);
        assert.equal(click.body?.value, 'The agent could not be reached; please try again.');
        const card = await h.instances[0]?.sb.entities.cards.get(cardId);
        assert.equal(card?.value.state, 'open');
    });
});
