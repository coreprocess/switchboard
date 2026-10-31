import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ONLY_ADMINS } from '../../src/teams/admin.ts';
import { CHANNEL, eventually, type Harness, startHarness, WORKSPACE } from '../helpers/harness.ts';
import type { Turn } from '../helpers/mock-claude.ts';

const texts = (h: Harness) => h.connector.messages.map((m) => String(m.activity.text ?? ''));
const latestText = (h: Harness) => texts(h).at(-1) ?? '';
const command = (h: Harness, word: string, asAdmin = false) =>
    h.post(h.message(word, { mention: true, ...(asAdmin ? { from: h.admin } : {}) }));

describe('admins, settings and jobs', () => {
    let h: Harness;
    let offset = 0;
    const gate: { release?: () => void } = {};
    const releaseTurn = () => gate.release?.();

    before(async () => {
        h = await startHarness({ now: () => new Date(Date.now() + offset) });
        h.claude.agent = async (turn: Turn) => {
            if (turn.text.includes('Run the hourly check.')) {
                if (turn.text.includes('hold')) return;
                await new Promise<void>((resolve) => {
                    gate.release = resolve;
                });
                turn.say('All deployments are fine.');
                return;
            }
            turn.say(`Echo: ${turn.text.split('\n').at(-1)}`);
        };
    });

    after(async () => {
        gate.release?.();
        await h.stop();
    });

    it('lets only admins change settings; status works for everyone', async () => {
        await command(h, 'settings');
        await eventually(() => latestText(h) === ONLY_ADMINS);
        const save = await h.post(
            h.click('0', '0', 'switchboard.settings.save', {
                switchboard_settings: CHANNEL,
                conversation_deployment: `${WORKSPACE}|depl_conversation`,
            })
        );
        assert.equal(save.body?.value, ONLY_ADMINS);
        assert.equal(
            await h.instances[0]?.sb.entities.bindings.get('19:team-general@thread.tacv2', CHANNEL),
            undefined
        );
        await command(h, 'pause');
        await eventually(() => texts(h).filter((t) => t === ONLY_ADMINS).length === 2);
        await command(h, 'status');
        await eventually(() => latestText(h).includes('not set up in this channel'));
    });

    it('shows the settings card to admins with the selectable deployments', async () => {
        await command(h, 'settings', true);
        await eventually(() =>
            h.connector.messages.some((m) => JSON.stringify(m.activity).includes('Switchboard settings · ops'))
        );
        const card = JSON.stringify(h.connector.messages.at(-1)?.activity);
        assert.ok(card.includes(`${WORKSPACE}|depl_conversation`));
        assert.ok(card.includes('ops-hourly-check · Test · depl_job · Ops Agent v1'));
    });

    it('rejects a deployment with a schedule and a clashing tool', async () => {
        h.claude.addDeployment('depl_scheduled', {
            agentId: 'agent_ops',
            name: 'scheduled',
            schedule: { cron: '0 * * * *' },
        });
        h.claude.addAgent('agent_clash', {
            tools: [{ type: 'custom', name: 'send_update', description: 'x', input_schema: { type: 'object' } }],
        });
        h.claude.addDeployment('depl_clash', { agentId: 'agent_clash', name: 'clash' });
        const scheduled = await h.bind({ conversation_deployment: `${WORKSPACE}|depl_scheduled` });
        assert.match(JSON.stringify(scheduled.body), /has a schedule/);
        const clash = await h.bind({ conversation_deployment: `${WORKSPACE}|depl_clash` });
        assert.match(JSON.stringify(clash.body), /tools named like Switchboard's: send_update/);
        const badCron = await h.bind({ job_deployment: `${WORKSPACE}|depl_job`, job_cron: 'every hour' });
        assert.match(JSON.stringify(badCron.body), /cron expression with five fields/);
    });

    it('binds the channel with a job and reports it in status', async () => {
        const saved = await h.bind({ job_deployment: `${WORKSPACE}|depl_job`, job_cron: '7 * * * *' });
        assert.match(JSON.stringify(saved.body), /Saved by Ada Admin/);
        await command(h, 'status');
        await eventually(() => latestText(h).startsWith('**Switchboard in ops**'));
        const status = latestText(h);
        assert.match(status, /Conversation deployment: ops-conversation · Test · depl_conversation · Ops Agent v1/);
        assert.match(status, /Job: `7 \* \* \* \*` \(Europe\/Berlin\), on, at most 60 min; last run: none; next run: /);
    });

    it('shows a hint when the agent has a newer version than the deployment uses', async () => {
        h.claude.addAgent('agent_ops', { system: 'Version two.' });
        await new Promise((resolve) => setTimeout(resolve, 10));
        await command(h, 'status');
        // cached agent lookups are at most 60 s old; a fresh instance would show it at once
        await eventually(() => latestText(h).startsWith('**Switchboard in ops**'));
        const sb = h.instances[0]?.sb;
        assert.ok(sb);
        const deployment = await sb.templates.deployment(WORKSPACE, 'depl_conversation');
        const info = await sb.templates.describe(WORKSPACE, deployment);
        assert.equal(info.agentVersion, 1);
        assert.ok(info.latestAgentVersion >= 1);
    });

    it('runs the job on demand, skips a second run while one is active, and archives a finished run', async () => {
        const sb = h.instances[0]?.sb;
        assert.ok(sb);
        await command(h, 'run', true);
        await eventually(() => latestText(h).startsWith('▶️ Job run started'));
        const jobSessionId = /session `([^`]+)`/.exec(latestText(h))?.[1] ?? '';
        const request = h.request();
        assert.equal(request.metadata.switchboard_kind, 'job');
        assert.match(request.title, /^ops · job · /);
        assert.deepEqual(request.initial_events, [
            { type: 'user.message', content: [{ type: 'text', text: 'Run the hourly check.' }] },
        ]);
        assert.ok(request.agent.tools.some((t) => t.name === 'convert_to_conversation'));

        await command(h, 'run', true);
        await eventually(() => latestText(h).includes('previous run is still active'));

        await eventually(() => gate.release !== undefined);
        gate.release?.();
        await eventually(async () => (await sb.sessions.get(jobSessionId))?.state === 'archived', 8000, 'archived');
        const job = (await sb.entities.jobs.list({ partitionKey: CHANNEL }))[0]?.value;
        assert.ok(job);
        assert.equal(job.activeRun, undefined);
        const runs = (await sb.entities.jobRuns.list({ partitionKey: job.jobId })).map((r) => r.value);
        assert.deepEqual(runs.map((r) => r.status).sort(), ['skipped', 'succeeded']);
        assert.equal(runs.find((r) => r.status === 'succeeded')?.finalMessage, 'All deployments are fine.');
    });

    it('stops a run over its maximum run time and moves it into a thread', async () => {
        const sb = h.instances[0]?.sb;
        assert.ok(sb);
        gate.release = undefined;
        await command(h, 'run', true);
        await eventually(() => latestText(h).startsWith('▶️ Job run started'));
        const jobSessionId = /session `([^`]+)`/.exec(latestText(h))?.[1] ?? '';
        await eventually(() => gate.release !== undefined);
        offset = 2 * 60 * 60 * 1000;
        await sb.jobs.tick();
        await eventually(() =>
            h.claude.userMessages(jobSessionId).some((m) => m.startsWith('[switchboard:job-failed] reason=timeout'))
        );
        const entry = await sb.sessions.get(jobSessionId);
        assert.ok(entry?.rootId, 'the job session owns a thread now');
        const note = h.connector.created.at(-1) as { activity: { text: string } };
        assert.match(note.activity.text, /A job run failed.*ran longer than its maximum run time.*Session `/);
        offset = 0;
        releaseTurn();
    });

    it('notes in the channel when a job session cannot be created', async () => {
        const deployment = h.claude.deployments.get('depl_job');
        assert.ok(deployment);
        deployment.archived_at = '2026-10-31T00:00:00Z';
        const sb = h.instances[0]?.sb;
        await sb?.templates.deployment(WORKSPACE, 'depl_job', true).catch(() => undefined);
        await command(h, 'run', true);
        await eventually(() => latestText(h).startsWith('The run could not start'));
        const note = h.connector.created.at(-1) as { activity: { text: string } };
        assert.match(note.activity.text, /A job run could not start/);
        deployment.archived_at = null;
    });

    it('pauses and resumes the job', async () => {
        await command(h, 'pause', true);
        await eventually(() => latestText(h) === '⏸️ The job is paused.');
        await command(h, 'resume', true);
        await eventually(() => latestText(h) === '▶️ The job is on.');
    });
});
