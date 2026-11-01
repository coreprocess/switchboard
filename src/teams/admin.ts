import { randomBytes } from 'node:crypto';
import type { DeploymentInfo } from '../claude/templates.ts';
import { Upgrade, type UpgradeResult } from '../claude/upgrade.ts';
import { isTimeZone } from '../config/env.ts';
import { channelOf } from '../conversations/conversations.ts';
import type { CardJson, ChannelRef } from '../core/platform.ts';
import { clip } from '../core/text.ts';
import { formatLocal } from '../core/time.ts';
import { isValidCron, nextRun } from '../jobs/jobs.ts';
import type { Binding, Job } from '../store/entities.ts';
import type { Switchboard } from '../switchboard.ts';
import type { Command } from './activity.ts';
import type { TeamsPlatform } from './platform.ts';
import { describeDeployment, parseChoice, renderSettingsCard, type SettingsInput } from './settings-card.ts';

export const ONLY_ADMINS = 'Only Switchboard admins can change this.';
export const NOT_SET_UP =
    'Switchboard is not set up in this channel. An admin can set it up with `@Switchboard settings`.';

/** Who acts, as verified by the Bot Framework. */
export interface Actor {
    tenantId: string;
    aadObjectId: string | undefined;
    name: string | undefined;
}

export interface ChannelContext extends ChannelRef {
    tenantId: string;
    teamName: string | undefined;
}

const PRIVATE_CHANNEL_NOTE =
    'This channel is not in the team’s list of standard channels (private or shared?). Teams may not deliver ' +
    'messages without an @mention from such channels to apps yet; mention Switchboard to be sure.';

/** Bindings, jobs and the commands (README: "Commands", "Commands and the settings card"). */
export class ChannelAdmin {
    readonly #sb: Switchboard;
    readonly #teams: TeamsPlatform;

    constructor(sb: Switchboard, teams: TeamsPlatform) {
        this.#sb = sb;
        this.#teams = teams;
    }

    isAdmin(actor: Actor): boolean {
        if (!actor.aadObjectId) return false;
        const id = actor.aadObjectId.toLowerCase();
        const tenant = actor.tenantId.toLowerCase();
        return this.#sb.settings.admins.some(
            (a) => a.tenant.toLowerCase() === tenant && a.objectId.toLowerCase() === id
        );
    }

    async binding(channel: ChannelRef): Promise<Binding | undefined> {
        return (await this.#sb.entities.bindings.get(channel.teamId, channel.channelId))?.value;
    }

    async job(channelId: string): Promise<Job | undefined> {
        return (await this.#sb.entities.jobs.list({ partitionKey: channelId }))[0]?.value;
    }

    /** Handles a command; returns the answer (text or the settings card). */
    async command(
        command: Command,
        channel: ChannelContext,
        actor: Actor
    ): Promise<{ text: string } | { card: CardJson }> {
        if (command === 'status') return { text: await this.status(channel) };
        if (!this.isAdmin(actor)) return { text: ONLY_ADMINS };
        if (command === 'settings') return { card: await this.settingsCard(channel) };
        const binding = await this.binding(channel);
        if (!binding) return { text: NOT_SET_UP };
        const job = await this.job(channel.channelId);
        switch (command) {
            case 'pause':
            case 'resume': {
                if (!job) return { text: 'This channel has no job.' };
                const enabled = command === 'resume';
                await this.#sb.entities.jobs.modify(job.channelId, job.jobId, (current) => ({
                    ...current,
                    enabled,
                    updatedBy: actor.aadObjectId ?? 'unknown',
                    updatedAt: this.#sb.now().toISOString(),
                }));
                return { text: enabled ? '▶️ The job is on.' : '⏸️ The job is paused.' };
            }
            case 'run': {
                if (!job) return { text: 'This channel has no job.' };
                const run = await this.#sb.jobs.runNow(job);
                if (!run) return { text: 'A run was started just now.' };
                if (run.status === 'skipped') return { text: 'The previous run is still active; nothing was started.' };
                if (run.status === 'failed')
                    return { text: `The run could not start: ${run.reason ?? 'unknown error'}` };
                return { text: `▶️ Job run started (session \`${run.sessionId ?? 'pending'}\`).` };
            }
            case 'upgrade':
                return { text: await this.upgrade(binding, job) };
            case 'disconnect':
                await this.disconnect(binding, actor);
                return { text: '🔌 Switchboard is disconnected from this channel.' };
        }
    }

    async settingsCard(channel: ChannelContext, status?: string, problems?: string[]): Promise<CardJson> {
        const sb = this.#sb;
        const binding = await this.binding(channel);
        const job = await this.job(channel.channelId);
        const options = await sb.templates.selectable();
        return renderSettingsCard({
            channelId: channel.channelId,
            channelName: binding?.channelName ?? (await this.#channelInfo(channel)).name,
            ...(binding ? { binding } : {}),
            ...(job ? { job } : {}),
            options,
            defaultTimezone: sb.settings.defaultTimezone,
            ...(status ? { status } : {}),
            ...(problems ? { problems } : {}),
        });
    }

    async #channelInfo(channel: ChannelContext): Promise<{ name: string; listed: boolean }> {
        try {
            const info = await this.#teams.channelInfo(channel.teamId, channel.channelId);
            return { name: info.name ?? 'channel', listed: info.listed };
        } catch (error) {
            this.#sb.log.warn({ err: error, channelId: channel.channelId }, 'channel details not read');
            return { name: 'channel', listed: true };
        }
    }

    /** Save on the settings card: checks both deployments, the schedule, then stores binding and job. */
    async save(channel: ChannelContext, actor: Actor, input: SettingsInput): Promise<CardJson | { message: string }> {
        const sb = this.#sb;
        if (!this.isAdmin(actor)) return { message: ONLY_ADMINS };
        const problems: string[] = [];
        const conversation = parseChoice(input.conversation_deployment ?? '');
        const jobChoice = input.job_deployment ? parseChoice(input.job_deployment) : undefined;
        if (!conversation) problems.push('Choose a conversation deployment.');
        if (input.job_deployment && !jobChoice) problems.push('The job deployment is not valid.');
        const workspaceId = conversation?.workspaceId;
        if (workspaceId && !sb.workspaces.has(workspaceId))
            problems.push(`Workspace ${workspaceId} is not configured.`);
        if (jobChoice && workspaceId && jobChoice.workspaceId !== workspaceId) {
            problems.push('Both deployments must be in the same Claude workspace.');
        }
        const cron = (input.job_cron ?? '').trim();
        const timezone = (input.job_timezone ?? '').trim() || sb.settings.defaultTimezone;
        if (jobChoice) {
            if (!isTimeZone(timezone)) problems.push(`Unknown time zone "${clip(timezone, 60)}".`);
            else if (!isValidCron(cron, timezone))
                problems.push('The schedule must be a cron expression with five fields.');
        }
        if (problems.length === 0 && conversation) {
            problems.push(
                ...(await sb.templates.check(conversation.workspaceId, conversation.deploymentId, 'conversation'))
            );
            if (jobChoice)
                problems.push(...(await sb.templates.check(jobChoice.workspaceId, jobChoice.deploymentId, 'job')));
        }
        if (problems.length > 0 || !conversation) return this.settingsCard(channel, undefined, problems);

        const now = sb.now().toISOString();
        const by = actor.aadObjectId ?? 'unknown';
        const existing = await this.binding(channel);
        const info = await this.#channelInfo(channel);
        const binding: Binding = {
            teamId: channel.teamId,
            channelId: channel.channelId,
            tenantId: channel.tenantId,
            workspaceId: conversation.workspaceId,
            conversationDeploymentId: conversation.deploymentId,
            teamName: channel.teamName ?? existing?.teamName,
            channelName: existing?.channelName && info.name === 'channel' ? existing.channelName : info.name,
            channelNote: info.listed ? undefined : PRIVATE_CHANNEL_NOTE,
            createdBy: existing?.createdBy ?? by,
            createdAt: existing?.createdAt ?? now,
            updatedBy: by,
            updatedAt: now,
        };
        await sb.entities.bindings.upsert(binding);
        const job = await this.job(channel.channelId);
        if (jobChoice) {
            await sb.entities.jobs.upsert({
                channelId: channel.channelId,
                jobId: job?.jobId ?? `job_${randomBytes(9).toString('base64url')}`,
                teamId: channel.teamId,
                deploymentId: jobChoice.deploymentId,
                cron,
                timezone,
                enabled: input.job_enabled !== 'false',
                activeRun: job?.activeRun,
                updatedBy: by,
                updatedAt: now,
            });
        } else if (job) {
            await sb.jobs.remove(channel.channelId);
        }
        sb.log.info({ channelId: channel.channelId, by, job: Boolean(jobChoice) }, 'binding saved');
        return this.settingsCard(
            channel,
            `✅ Saved by ${clip(actor.name ?? 'an admin', 80)} at ${formatLocal(sb.now(), sb.settings.defaultTimezone)}.`
        );
    }

    /**
     * Removes the binding: the job is cancelled and deleted, owning sessions are archived (running ones are
     * interrupted first and archived by the reconciler once idle), their cards close. The augmentation of the
     * channel's threads stays until retention.
     */
    async disconnect(binding: Binding, actor: Actor) {
        const sb = this.#sb;
        await sb.jobs.remove(binding.channelId);
        await sb.entities.bindings.delete(binding.teamId, binding.channelId);
        await sb.access.forget(binding);
        const sessions = await sb.entities.sessions.list({
            where: [
                { field: 'channelId', op: 'eq', value: binding.channelId },
                { field: 'state', op: 'eq', value: 'active' },
            ],
        });
        for (const { value: entry } of sessions) {
            await sb.sessions.archive(entry, 'disconnected').catch((error: unknown) => {
                sb.log.warn({ err: error, sessionId: entry.sessionId }, 'session not archived on disconnect');
            });
        }
        sb.log.info({ channelId: binding.channelId, by: actor.aadObjectId }, 'binding removed');
        await sb.platform
            .postThread(channelOf(binding), {
                text: '🔌 Switchboard was disconnected from this channel. Messages here no longer reach an agent.',
            })
            .catch(() => undefined);
    }

    /** `upgrade`: moves the channel's deployments to the newest agent versions (README: "Upgrading a channel's agents"). */
    async upgrade(binding: Binding, job: Job | undefined): Promise<string> {
        const sb = this.#sb;
        const targets = [
            { deploymentId: binding.conversationDeploymentId, kind: 'conversation' as const },
            ...(job ? [{ deploymentId: job.deploymentId, kind: 'job' as const }] : []),
        ];
        const result = await new Upgrade(sb.workspaces.get(binding.workspaceId), sb.templates).run(targets);
        sb.log.info({ channelId: binding.channelId, outcome: result.outcome }, 'upgrade');
        return upgradeAnswer(result);
    }

    /** A deployment as `status` shows it, and whether its agent has a newer version. */
    async #describe(workspaceId: string, deploymentId: string): Promise<{ text: string; outdated: boolean }> {
        const sb = this.#sb;
        try {
            const deployment = await sb.templates.deployment(workspaceId, deploymentId, true);
            const info: DeploymentInfo = await sb.templates.describe(workspaceId, deployment, true);
            return { text: describeDeployment(info), outdated: info.latestAgentVersion > info.agentVersion };
        } catch {
            return { text: `${deploymentId} (could not be read)`, outdated: false };
        }
    }

    /**
     * The channel's read access (README: "Read access"), checked on the spot like the regular check: a restored
     * access gets its note at once. When the check fails, the last known state shows.
     */
    async #readAccess(binding: Binding): Promise<string> {
        const sb = this.#sb;
        const zone = sb.settings.defaultTimezone;
        const outcome = await sb.access.check(binding);
        const access = await sb.access.state(binding);
        if (!access) return 'Read access: unknown (the check failed just now)';
        const checked =
            outcome === 'unknown'
                ? `last checked ${formatLocal(new Date(access.checkedAt), zone)}; the check failed just now`
                : 'checked just now';
        if (access.readable) return `Read access: ✅ (${checked})`;
        const since = access.deniedSince ? ` since ${formatLocal(new Date(access.deniedSince), zone)}` : '';
        return `⚠️ Read access: denied${since} (${checked}); messages without @Switchboard do not reach the agents`;
    }

    /** `status`: binding, deployments, job, active conversations, read access, known limitations. */
    async status(channel: ChannelContext): Promise<string> {
        const sb = this.#sb;
        const binding = await this.binding(channel);
        if (!binding) return NOT_SET_UP;
        const zone = sb.settings.defaultTimezone;
        const lines = [`**Switchboard in ${binding.channelName}**`];
        const conversationDeployment = await this.#describe(binding.workspaceId, binding.conversationDeploymentId);
        lines.push(`- Conversation deployment: ${conversationDeployment.text}`);
        const job = await this.job(binding.channelId);
        const jobDeployment = job ? await this.#describe(binding.workspaceId, job.deploymentId) : undefined;
        if (job && jobDeployment) {
            const last = await sb.jobs.latestRun(job.jobId);
            const next = job.enabled ? nextRun(job, sb.now()) : undefined;
            lines.push(`- Job deployment: ${jobDeployment.text}`);
            const lastRun = last
                ? `${last.status === 'running' ? 'running since' : `${last.status}${last.reason ? ` (${clip(last.reason, 120)})` : ''}, started`} ` +
                  formatLocal(new Date(last.startedAt), zone)
                : 'none';
            lines.push(
                `- Job: \`${job.cron}\` (${job.timezone}), ${job.enabled ? 'on' : 'paused'}; last run: ${lastRun}` +
                    `; next run: ${next ? formatLocal(next, zone) : '–'}`
            );
        } else {
            lines.push('- Job: none');
        }
        const owned = await sb.entities.conversations.list({
            partitionKey: binding.channelId,
            where: [{ field: 'owningSession', op: 'gt', value: '' }],
        });
        lines.push(`- Conversations with an active session: ${owned.length}`);
        lines.push(`- ${await this.#readAccess(binding)}`);
        if (conversationDeployment.outdated || jobDeployment?.outdated) {
            lines.push(
                '- Newer agent versions exist: an admin moves the deployments to them with `@Switchboard upgrade`.'
            );
        }
        if (binding.channelNote) lines.push(`- Limitation: ${binding.channelNote}`);
        return lines.join('\n');
    }
}

const ROLES = { conversation: 'Conversation deployment', job: 'Job deployment' } as const;

/** What `upgrade` did, as the admin reads it. */
export const upgradeAnswer = (result: UpgradeResult): string => {
    if (result.outcome === 'up_to_date') return '✅ Everything is up to date.';
    const saved = result.agents.map(
        (agent) => `- New version of agent ${agent.agentName}: v${agent.from} → v${agent.to} (references raised)`
    );
    if (result.outcome === 'refused') {
        return [
            '⚠️ No deployment was changed:',
            ...result.problems.map((problem) => `- ${problem}`),
            ...(saved.length > 0 ? ['', 'Agent versions saved before the check:', ...saved] : []),
        ].join('\n');
    }
    return [
        '⬆️ Upgraded:',
        ...result.deployments.map(
            (d) => `- ${ROLES[d.kind]} ${d.deploymentName}: ${d.agentName} v${d.from} → v${d.to}`
        ),
        ...saved,
        // a blank line ends the list; otherwise Markdown joins the sentence to the last item
        '',
        'Running sessions keep their version; new sessions use the new one.',
    ].join('\n');
};
