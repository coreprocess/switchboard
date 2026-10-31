import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ONLY_ADMINS } from '../../src/teams/admin.ts';
import { eventually, type Harness, startHarness, WORKSPACE } from '../helpers/harness.ts';

const latestText = (h: Harness) => String(h.connector.messages.at(-1)?.activity.text ?? '');
const pinned = (h: Harness, deploymentId: string) =>
    (h.claude.deployments.get(deploymentId)?.agent as { version: number } | undefined)?.version;

/** `multiagent_20261001` with the given subagents, as the platform stores it. */
const withSubagents = (agents: { id: string; version: number }[]) => ({
    type: 'multiagent_20261001',
    advisor: { type: 'disabled' },
    subagents: {
        type: 'enabled',
        inline_agents: { type: 'disabled' },
        predefined_agents: agents.map((agent) => ({ type: 'agent', ...agent })),
    },
    workflows: { type: 'disabled' },
});

describe('upgrade', () => {
    let h: Harness;
    const upgrade = async (asAdmin = true) => {
        const before = h.connector.messages.length;
        await h.post(h.message('upgrade', { mention: true, ...(asAdmin ? { from: h.admin } : {}) }));
        await eventually(() => h.connector.messages.length > before, 8000, 'answer');
        return latestText(h);
    };

    before(async () => {
        h = await startHarness();
        // a deployment of another channel that uses the same agent
        h.claude.addDeployment('depl_other', { agentId: 'agent_ops', name: 'other-channel' });
        await h.bind({ job_deployment: `${WORKSPACE}|depl_job`, job_cron: '0 3 * * *', job_enabled: 'false' });
    });

    after(async () => {
        await h.stop();
    });

    it('reports that everything is up to date and changes nothing', async () => {
        assert.equal(await upgrade(), '✅ Everything is up to date.');
        assert.equal(h.claude.agentUpdates.length + h.claude.deploymentUpdates.length, 0);
    });

    it('lets only admins upgrade', async () => {
        h.claude.addAgent('agent_ops', { system: 'Version two.' });
        assert.equal(await upgrade(false), ONLY_ADMINS);
        assert.equal(h.claude.deploymentUpdates.length, 0);
    });

    it('moves both deployments to the newest agent version; other channels keep theirs', async () => {
        const before = h.connector.messages.length;
        await h.post(h.message('status', { mention: true }));
        await eventually(() => h.connector.messages.length > before);
        assert.match(
            latestText(h),
            /Newer agent versions exist: an admin moves the deployments to them with `@Switchboard upgrade`/
        );

        const answer = await upgrade();
        assert.match(answer, /Conversation deployment ops-conversation: Ops Agent v1 → v2/);
        assert.match(
            answer,
            /Job deployment ops-hourly-check: Ops Agent v1 → v2\n\nRunning sessions keep their version/
        );
        assert.equal(pinned(h, 'depl_conversation'), 2);
        assert.equal(pinned(h, 'depl_job'), 2);
        assert.equal(pinned(h, 'depl_other'), 1, 'another channel’s deployment is unchanged');
        assert.equal(h.claude.agentUpdates.length, 0);

        const root = h.message('Which version are you?');
        await h.post(root);
        await eventually(() => h.thread(root.id).some((t) => t.startsWith('Echo:')));
        assert.equal(h.request().agent.version, 2, 'new sessions run on the new version');
        assert.match(h.request().agent.system, /Version two\./);
    });

    it('saves a new agent version when a subagent has a newer version, otherwise identical', async () => {
        h.claude.addAgent('agent_reviewer', { name: 'Reviewer' });
        h.claude.addAgent('agent_ops', { multiagent: withSubagents([{ id: 'agent_reviewer', version: 1 }]) });
        assert.match(await upgrade(), /Ops Agent v2 → v3/);
        h.claude.addAgent('agent_reviewer', { system: 'Review more strictly.' });

        const answer = await upgrade();
        assert.match(answer, /New version of agent Ops Agent: v3 → v4 \(references raised\)/);
        assert.match(answer, /Conversation deployment ops-conversation: Ops Agent v3 → v4/);
        const versions = h.claude.agents.get('agent_ops') ?? [];
        const [previous, saved] = versions.slice(-2);
        assert.ok(previous && saved);
        const multiagent = saved.multiagent as ReturnType<typeof withSubagents>;
        assert.deepEqual(multiagent.subagents.predefined_agents, [{ type: 'agent', id: 'agent_reviewer', version: 2 }]);
        assert.deepEqual(
            multiagent.subagents.inline_agents,
            { type: 'disabled' },
            'the rest of the configuration is kept'
        );
        assert.deepEqual({ ...saved, version: 0, multiagent: null }, { ...previous, version: 0, multiagent: null });
        assert.deepEqual(h.claude.agentUpdates.at(-1), {
            id: 'agent_ops',
            version: 3,
            multiagent: {
                type: 'multiagent_20261001',
                subagents: {
                    type: 'enabled',
                    predefined_agents: [{ type: 'agent', id: 'agent_reviewer', version: 2 }],
                },
            },
        });
        assert.equal(pinned(h, 'depl_conversation'), 4);
        assert.equal(await upgrade(), '✅ Everything is up to date.');
    });

    it('changes no deployment when a check fails', async () => {
        h.claude.addAgent('agent_ops', {
            tools: [{ type: 'custom', name: 'send_update', description: 'x', input_schema: { type: 'object' } }],
        });
        const answer = await upgrade();
        assert.match(answer, /^⚠️ No deployment was changed:/);
        assert.match(answer, /tools named like Switchboard's: send_update/);
        assert.equal(pinned(h, 'depl_conversation'), 4);
        assert.equal(pinned(h, 'depl_job'), 4);
    });
});
