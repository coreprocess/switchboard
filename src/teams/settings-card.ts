import { z } from 'zod';
import type { DeploymentInfo } from '../claude/templates.ts';
import type { CardJson } from '../core/platform.ts';
import { clip } from '../core/text.ts';
import type { Binding, Job } from '../store/entities.ts';

/** Switchboard's own card for bindings and jobs (README: "Commands"). */

export const SETTINGS_DATA_KEY = 'switchboard_settings';
export const VERB_SAVE = 'switchboard.settings.save';
export const VERB_DISCONNECT = 'switchboard.settings.disconnect';

/** Choice values carry the workspace, since deployments of several workspaces are offered. */
export const choiceValue = (option: Pick<DeploymentInfo, 'workspaceId' | 'deploymentId'>) =>
    `${option.workspaceId}|${option.deploymentId}`;

export const parseChoice = (value: string): { workspaceId: string; deploymentId: string } | undefined => {
    const [workspaceId, deploymentId, ...rest] = value.split('|');
    if (!workspaceId || !deploymentId || rest.length > 0) return undefined;
    return { workspaceId, deploymentId };
};

/** A deployment as people choose it: name, workspace, ID, the agent version it uses and a hint about newer ones. */
export const describeDeployment = (option: DeploymentInfo) => {
    const newer =
        option.latestAgentVersion > option.agentVersion ? ` (agent has newer v${option.latestAgentVersion})` : '';
    return `${option.name} · ${option.workspaceName} · ${option.deploymentId} · ${option.agentName} v${option.agentVersion}${newer}`;
};

export interface SettingsView {
    channelId: string;
    channelName: string;
    binding?: Binding;
    job?: Job;
    options: DeploymentInfo[];
    defaultTimezone: string;
    /** Result of the last action: saved, or what was wrong. */
    status?: string;
    problems?: string[];
}

export const renderSettingsCard = (view: SettingsView): CardJson => {
    const { binding, job } = view;
    const choices = view.options.map((option) => ({
        title: clip(describeDeployment(option), 250),
        value: choiceValue(option),
    }));
    const current = (workspaceId: string | undefined, deploymentId: string | undefined) =>
        workspaceId && deploymentId ? `${workspaceId}|${deploymentId}` : undefined;
    const data = { [SETTINGS_DATA_KEY]: view.channelId };
    return {
        type: 'AdaptiveCard',
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version: '1.5',
        body: [
            {
                type: 'TextBlock',
                text: `Switchboard settings · ${view.channelName}`,
                weight: 'Bolder',
                size: 'Medium',
                wrap: true,
            },
            ...(binding?.channelNote
                ? [{ type: 'TextBlock', text: `⚠️ ${binding.channelNote}`, wrap: true, color: 'Warning' }]
                : []),
            { type: 'TextBlock', text: 'Conversations', weight: 'Bolder', wrap: true, separator: true },
            {
                type: 'Input.ChoiceSet',
                id: 'conversation_deployment',
                label: 'Conversation deployment',
                isRequired: true,
                errorMessage: 'Choose a deployment',
                choices,
                ...(current(binding?.workspaceId, binding?.conversationDeploymentId)
                    ? { value: current(binding?.workspaceId, binding?.conversationDeploymentId) }
                    : {}),
            },
            { type: 'TextBlock', text: 'Job', weight: 'Bolder', wrap: true, separator: true },
            {
                type: 'Input.ChoiceSet',
                id: 'job_deployment',
                label: 'Job deployment',
                choices: [{ title: 'No job', value: '' }, ...choices],
                value: current(binding?.workspaceId, job?.deploymentId) ?? '',
            },
            {
                type: 'Input.Toggle',
                id: 'job_enabled',
                title: 'Job is on',
                value: job && !job.enabled ? 'false' : 'true',
                valueOn: 'true',
                valueOff: 'false',
            },
            {
                type: 'Input.Text',
                id: 'job_cron',
                label: 'Schedule (cron: minute hour day month weekday)',
                placeholder: '7 * * * *',
                value: job?.cron ?? '',
            },
            {
                type: 'Input.Text',
                id: 'job_timezone',
                label: 'Time zone',
                value: job?.timezone ?? view.defaultTimezone,
            },
            ...(view.problems?.length
                ? [
                      {
                          type: 'TextBlock',
                          text: view.problems.map((p) => `- ${p}`).join('\n'),
                          wrap: true,
                          color: 'Attention',
                          separator: true,
                      },
                  ]
                : []),
            ...(view.status
                ? [{ type: 'TextBlock', text: view.status, wrap: true, isSubtle: true, separator: true }]
                : []),
        ],
        actions: [
            { type: 'Action.Execute', title: 'Save', verb: VERB_SAVE, style: 'positive', data },
            ...(binding
                ? [{ type: 'Action.Execute', title: 'Disconnect', verb: VERB_DISCONNECT, style: 'destructive', data }]
                : []),
        ],
    };
};

/** The card's inputs as Teams sends them with a click (untrusted). */
export const SettingsInput = z.looseObject({
    conversation_deployment: z.string().optional(),
    job_deployment: z.string().optional(),
    job_enabled: z.string().optional(),
    job_cron: z.string().optional(),
    job_timezone: z.string().optional(),
});
export type SettingsInput = z.infer<typeof SettingsInput>;
