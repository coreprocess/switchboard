import { randomBytes } from 'node:crypto';
import type { DeploymentInfo } from '../claude/templates.ts';
import { isTimeZone } from '../config/env.ts';
import type { CardJson, ChannelRef } from '../core/gateway.ts';
import { clip } from '../core/text.ts';
import { formatLocal } from '../core/time.ts';
import { isValidCron, nextRun } from '../jobs/jobs.ts';
import type { Binding, Job } from '../store/entities.ts';
import type { Switchboard } from '../switchboard.ts';
import type { Command } from './activity.ts';
import type { TeamsGateway } from './gateway.ts';
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
    aadGroupId: string | undefined;
    teamName: string | undefined;
}

const PRIVATE_CHANNEL_NOTE =
    'This channel is not in the team’s list of standard channels (private or shared?). Teams may not deliver ' +
    'messages without an @mention from such channels to apps yet; mention Switchboard to be sure.';

/** Bindings, jobs and the commands (concept: "Admins and access", "Commands and the settings card"). */
export class ChannelAdmin {
    readonly #sb: Switchboard;
    readonly #teams: TeamsGateway;

    constructor(sb: Switchboard, teams: TeamsGateway) {
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
            defaultMaxRuntimeMin: sb.settings.defaultJobMaxRuntimeMin,
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
        const maxRuntimeMin = Number(input.job_max_runtime ?? sb.settings.defaultJobMaxRuntimeMin);
        if (jobChoice) {
            if (!isTimeZone(timezone)) problems.push(`Unknown time zone "${clip(timezone, 60)}".`);
            else if (!isValidCron(cron, timezone))
                problems.push('The schedule must be a cron expression with five fields.');
            if (!Number.isInteger(maxRuntimeMin) || maxRuntimeMin < 1)
                problems.push('The maximum run time must be at least 1 minute.');
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
        let aadGroupId = existing?.aadGroupId ?? channel.aadGroupId;
        if (!aadGroupId)
            aadGroupId = (await this.#teams.teamDetails(channel.teamId).catch(() => undefined))?.aadGroupId;
        const binding: Binding = {
            teamId: channel.teamId,
            channelId: channel.channelId,
            tenantId: channel.tenantId,
            workspaceId: conversation.workspaceId,
            conversationDeploymentId: conversation.deploymentId,
            aadGroupId,
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
                maxRuntimeMin,
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
     * interrupted first and archived by the reconciler once idle), their cards close. Logs stay until retention.
     */
    async disconnect(binding: Binding, actor: Actor) {
        const sb = this.#sb;
        await sb.jobs.remove(binding.channelId);
        await sb.entities.bindings.delete(binding.teamId, binding.channelId);
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
        await sb.gateway
            .postThread(binding, {
                text: '🔌 Switchboard was disconnected from this channel. Messages here no longer reach an agent.',
            })
            .catch(() => undefined);
    }

    async #describe(workspaceId: string, deploymentId: string): Promise<string> {
        const sb = this.#sb;
        try {
            const deployment = await sb.templates.deployment(workspaceId, deploymentId);
            const info: DeploymentInfo = await sb.templates.describe(workspaceId, deployment);
            return describeDeployment(info);
        } catch {
            return `${deploymentId} (could not be read)`;
        }
    }

    /** `status`: binding, deployments, job, active conversations, known limitations. */
    async status(channel: ChannelContext): Promise<string> {
        const sb = this.#sb;
        const binding = await this.binding(channel);
        if (!binding) return NOT_SET_UP;
        const zone = sb.settings.defaultTimezone;
        const lines = [`**Switchboard in ${binding.channelName}**`];
        lines.push(
            `- Conversation deployment: ${await this.#describe(binding.workspaceId, binding.conversationDeploymentId)}`
        );
        const job = await this.job(binding.channelId);
        if (job) {
            const last = await sb.jobs.latestRun(job.jobId);
            const next = job.enabled ? nextRun(job, sb.now()) : undefined;
            lines.push(`- Job deployment: ${await this.#describe(binding.workspaceId, job.deploymentId)}`);
            lines.push(
                `- Job: \`${job.cron}\` (${job.timezone}), ${job.enabled ? 'on' : 'paused'}, at most ${job.maxRuntimeMin} min` +
                    `; last run: ${last ? `${last.status}${last.reason ? ` (${clip(last.reason, 120)})` : ''} at ${formatLocal(new Date(last.startedAt), zone)}` : 'none'}` +
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
        if (binding.channelNote) lines.push(`- Limitation: ${binding.channelNote}`);
        return lines.join('\n');
    }
}
