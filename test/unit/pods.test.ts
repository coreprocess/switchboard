import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { CHANNEL, eventually, type Harness, sleep, startHarness, WORKSPACE } from '../helpers/harness.ts';
import type { Turn } from '../helpers/mock-claude.ts';

describe('several pods on one store', () => {
    let h: Harness;
    let offset = 0;
    const gate: { release?: () => void } = {};

    before(async () => {
        h = await startHarness({ instances: 2, loops: true, now: () => new Date(Date.now() + offset) });
        h.claude.agent = async (turn: Turn) => {
            const last = turn.text.split('\n').at(-1) ?? '';
            if (last === 'slow') {
                await new Promise<void>((resolve) => {
                    gate.release = resolve;
                });
                turn.say('Finally done.');
                return;
            }
            turn.say(`Echo: ${last}`);
        };
        await h.bind({ job_deployment: `${WORKSPACE}|depl_job`, job_cron: '* * * * *', job_enabled: 'false' });
    });

    after(async () => {
        gate.release?.();
        await h.stop();
    });

    it('creates one session for a thread even when its messages reach different pods at once', async () => {
        const before = h.claude.createRequests.length;
        const root = h.message('First message');
        const reply = h.message('Quick follow-up', { rootId: root.id });
        await Promise.all([h.post(root, 0), h.post(reply, 1)]);
        await eventually(() => h.thread(root.id).filter((t) => t.startsWith('Echo:')).length >= 1);
        await sleep(300);
        assert.equal(h.claude.createRequests.length, before + 1, 'exactly one session');
        const sessionId = [...h.claude.sessions.keys()].at(-1) ?? '';
        const received = h.claude.userMessages(sessionId).join('\n');
        assert.ok(received.includes('First message') && received.includes('Quick follow-up'));
    });

    it('starts each job tick on exactly one pod', async () => {
        const [a, b] = h.instances;
        assert.ok(a && b);
        const job = (await a.sb.entities.jobs.list({ partitionKey: CHANNEL }))[0]?.value;
        assert.ok(job);
        await a.sb.entities.jobs.modify(CHANNEL, job.jobId, (current) => ({ ...current, enabled: true }));
        const runsBefore = (await a.sb.entities.jobRuns.list({ partitionKey: job.jobId })).length;
        offset += 61_000;
        await Promise.all([a.sb.jobs.tick(), b.sb.jobs.tick()]);
        await a.sb.entities.jobs.modify(CHANNEL, job.jobId, (current) => ({ ...current, enabled: false }));
        const runs = (await a.sb.entities.jobRuns.list({ partitionKey: job.jobId })).map((r) => r.value);
        const started = runs.length - runsBefore;
        assert.ok(started >= 1, 'a tick started a run');
        assert.equal(new Set(runs.map((r) => r.runKey)).size, runs.length, 'one run per tick');
        // the background timers may have claimed some of these ticks: every tick has exactly one run regardless
    });

    it('takes over a session whose pod died during a turn and still relays the answer', async () => {
        const [a, b] = h.instances;
        assert.ok(a && b);
        const root = h.message('slow');
        await h.post(root, 0);
        await eventually(() => gate.release !== undefined, 8000, 'turn started');
        const sessionId = [...h.claude.sessions.keys()].at(-1) ?? '';
        const entry = await a.sb.sessions.get(sessionId);
        assert.equal(entry?.relayOwner, 'pod-0');
        // pod-0 "dies": its lease is handed to a pod that never renews it; pod-0 loses it on the next renewal
        await a.sb.sessions.modify(sessionId, (current) => ({
            ...current,
            relayOwner: 'pod-dead',
            relayValidUntil: new Date(Date.now() + offset + 1_000).toISOString(),
        }));
        await eventually(() => !a.sb.relay.isFollowing(sessionId), 4000, 'pod-0 stops');
        gate.release?.();
        await eventually(() => h.thread(root.id).includes('Finally done.'), 10_000, 'answer relayed by the other pod');
        const after = await a.sb.sessions.get(sessionId);
        assert.notEqual(after?.relayOwner, 'pod-dead');
    });

    it('carries out a tool call once, even if two pods see it', async () => {
        const [a, b] = h.instances;
        assert.ok(a && b);
        const root = h.message('plain question');
        await h.post(root, 0);
        await eventually(() => h.thread(root.id).includes('Echo: plain question'));
        const sessionId = [...h.claude.sessions.keys()].at(-1) ?? '';
        const event = h.claude.emit(sessionId, {
            type: 'agent.custom_tool_use',
            name: 'send_update',
            input: { text: 'Only once' },
        });
        const toolEvent = {
            ...event,
            type: 'agent.custom_tool_use' as const,
            id: String(event.id),
            name: 'send_update',
            input: { text: 'Only once' },
            processed_at: String(event.processed_at),
        };
        await Promise.all([a.sb.tools.handle(sessionId, toolEvent), b.sb.tools.handle(sessionId, toolEvent)]);
        assert.equal(h.thread(root.id).filter((t) => t === 'Only once').length, 1);
        await eventually(() => {
            const results =
                h.claude.sessions.get(sessionId)?.events.filter((e) => e.type === 'user.custom_tool_result') ?? [];
            return results.some((e) => e.custom_tool_use_id === event.id);
        });
    });

    it('accepts card clicks and replies on any pod', async () => {
        const root = h.message('which pod?');
        await h.post(root, 1);
        await eventually(() => h.thread(root.id).includes('Echo: which pod?'));
        await h.post(h.message('reply via the other pod', { rootId: root.id }), 0);
        await eventually(() => h.thread(root.id).includes('Echo: reply via the other pod'));
    });
});
