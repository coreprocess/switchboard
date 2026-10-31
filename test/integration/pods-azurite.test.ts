import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startAzurite } from '../helpers/azurite.ts';
import { CHANNEL, eventually, type Harness, sleep, startHarness, WORKSPACE } from '../helpers/harness.ts';
import type { Turn } from '../helpers/mock-claude.ts';

/** Two Switchboard instances on one Table Storage account (Azurite), against the mock Claude API and connector. */
describe('two pods on Table Storage (Azurite)', () => {
    let azurite: Awaited<ReturnType<typeof startAzurite>>;
    let h: Harness;
    let offset = 0;
    const gate: { release?: () => void } = {};
    const results: Record<string, { text: string; isError: boolean }> = {};

    before(async () => {
        azurite = await startAzurite();
        h = await startHarness({
            instances: 2,
            loops: true,
            store: await azurite.store(),
            now: () => new Date(Date.now() + offset),
        });
        h.claude.agent = async (turn: Turn) => {
            const last = turn.text.split('\n').at(-1) ?? '';
            if (last === 'slow') {
                await new Promise<void>((resolve) => {
                    gate.release = resolve;
                });
                turn.say('Finally done.');
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
            if (turn.text.startsWith('[switchboard:card]')) {
                const cardId = /card=(\S+)/.exec(turn.text)?.[1] ?? '';
                await turn.callTool('update_card', {
                    card_id: cardId,
                    card: { type: 'AdaptiveCard', version: '1.5', body: [{ type: 'TextBlock', text: 'Done' }] },
                });
                return;
            }
            turn.say(`Echo: ${last}`);
        };
        const bound = await h.bind({
            job_deployment: `${WORKSPACE}|depl_job`,
            job_cron: '* * * * *',
            job_enabled: 'false',
        });
        assert.match(JSON.stringify(bound.body), /Saved by/);
    });

    after(async () => {
        gate.release?.();
        await h?.stop();
        await azurite?.stop();
    });

    it('creates one session per thread with messages on both pods', async () => {
        const before = h.claude.createRequests.length;
        const root = h.message('First');
        const second = h.message('Second', { rootId: root.id });
        const third = h.message('Third', { rootId: root.id });
        await Promise.all([h.post(root, 0), h.post(second, 1), h.post(third, 0)]);
        await eventually(() => h.thread(root.id).some((t) => t.startsWith('Echo:')), 15_000);
        await sleep(500);
        assert.equal(h.claude.createRequests.length, before + 1);
        const sessionId = [...h.claude.sessions.keys()].at(-1) ?? '';
        const received = h.claude.userMessages(sessionId).join('\n');
        for (const word of ['First', 'Second', 'Third']) assert.ok(received.includes(word), word);
    });

    it('accepts the first click only, whichever pod receives it', async () => {
        const root = h.message('card please');
        await h.post(root, 1);
        await eventually(() => results.show !== undefined, 15_000);
        const cardId = JSON.parse(results.show?.text ?? '{}').card_id as string;
        const posted = h.connector.messages.find((m) => JSON.stringify(m.activity).includes(cardId));
        assert.ok(posted);
        const sessionId = [...h.claude.sessions.keys()].at(-1) ?? '';
        await Promise.all([
            h.post(h.click(root.id, posted.id, 'go', { switchboard_card: cardId }), 0),
            h.post(h.click(root.id, posted.id, 'go', { switchboard_card: cardId }), 1),
        ]);
        await eventually(() => JSON.stringify(posted.activity).includes('"Done"'), 15_000);
        assert.equal(h.claude.userMessages(sessionId).filter((m) => m.startsWith('[switchboard:card]')).length, 1);
    });

    it('starts each tick once', async () => {
        const [a, b] = h.instances;
        assert.ok(a && b);
        const job = (await a.sb.entities.jobs.list({ partitionKey: CHANNEL }))[0]?.value;
        assert.ok(job);
        await a.sb.entities.jobs.modify(CHANNEL, job.jobId, (current) => ({ ...current, enabled: true }));
        offset += 61_000;
        await Promise.all([a.sb.jobs.tick(), b.sb.jobs.tick()]);
        await a.sb.entities.jobs.modify(CHANNEL, job.jobId, (current) => ({ ...current, enabled: false }));
        const runs = (await a.sb.entities.jobRuns.list({ partitionKey: job.jobId })).map((r) => r.value);
        assert.ok(runs.length >= 1);
        assert.equal(new Set(runs.map((r) => r.runKey)).size, runs.length);
    });

    it('takes over a session whose pod died, and survives a restart of the store connection', async () => {
        const [a] = h.instances;
        assert.ok(a);
        const root = h.message('slow');
        await h.post(root, 0);
        await eventually(() => gate.release !== undefined, 15_000);
        const sessionId = [...h.claude.sessions.keys()].at(-1) ?? '';
        await a.sb.sessions.modify(sessionId, (current) => ({
            ...current,
            relayOwner: 'pod-dead',
            relayValidUntil: new Date(Date.now() + offset + 1_000).toISOString(),
        }));
        gate.release?.();
        await eventually(() => h.thread(root.id).includes('Finally done.'), 20_000, 'answer after takeover');
        // bindings, conversations and cards are in Table Storage: a fresh read sees them
        assert.ok(await a.sb.entities.bindings.get('19:team-general@thread.tacv2', CHANNEL));
        assert.ok((await a.sb.entities.conversations.list({ partitionKey: CHANNEL })).length >= 3);
        assert.ok((await a.sb.entities.cards.list()).length >= 1);
    });

    it('continues a thread after its session ended', async () => {
        const root = h.message('before the end');
        await h.post(root, 0);
        await eventually(() => h.thread(root.id).includes('Echo: before the end'), 15_000);
        const sessionId = [...h.claude.sessions.keys()].at(-1) ?? '';
        h.claude.terminate(sessionId);
        await h.instances[1]?.sb.relay.wake(sessionId);
        await eventually(() => h.thread(root.id).some((t) => t.includes('session ended')), 15_000);
        await h.post(h.message('after the end', { rootId: root.id }), 1);
        await eventually(() => h.thread(root.id).includes('Echo: after the end'), 15_000);
        assert.match(h.firstText(), /^\[switchboard:continuation\] previous_session=/);
    });
});
