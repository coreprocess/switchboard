import { readFileSync } from 'node:fs';
import type { BetaManagedAgentsCustomToolParams } from '@anthropic-ai/sdk/resources/beta/agents/agents';
import type {
    BetaManagedAgentsDocumentBlock,
    BetaManagedAgentsImageBlock,
    BetaManagedAgentsTextBlock,
} from '@anthropic-ai/sdk/resources/beta/sessions/events';
import type { BetaManagedAgentsFileResourceParams } from '@anthropic-ai/sdk/resources/beta/sessions/sessions';
import { TOOL_NAMES, toolsFor } from '../tools/definitions.ts';
import type { Agent, ClaudeWorkspaces, CreateSessionParams, Deployment } from './api.ts';

/**
 * Deployments as templates (concept: "Creating sessions from the deployment template"). Switchboard reads a
 * deployment and its agent in the version the deployment pins, and creates every session itself, with its own
 * system prompt appendix and tools added. It never runs a deployment.
 */

export type ContentBlock = BetaManagedAgentsTextBlock | BetaManagedAgentsImageBlock | BetaManagedAgentsDocumentBlock;
export type FileResource = BetaManagedAgentsFileResourceParams;
export type SessionKind = 'conversation' | 'job';

/** The appendix, read once; the same relative path works from `src/` and from `dist/`. */
export const loadAppendix = (): string =>
    readFileSync(new URL('../../prompt/switchboard-appendix.md', import.meta.url), 'utf8').trim();

export const APPENDIX_HEADING = '# Switchboard';

export const combineSystemPrompt = (agentSystem: string | null, appendix: string) =>
    [agentSystem?.trim(), `${APPENDIX_HEADING}\n\n${appendix}`].filter(Boolean).join('\n\n');

/** Names of the agent's own tools that would clash with Switchboard's. */
export const clashingTools = (agent: Agent): string[] => {
    const names = agent.tools.flatMap((tool) => {
        if (tool.type === 'custom') return [tool.name];
        if (tool.type === 'agent_toolset_20260401') return tool.configs.map((config) => config.name);
        return [];
    });
    return names.filter((name) => (TOOL_NAMES as readonly string[]).includes(name));
};

export interface DeploymentInfo {
    workspaceId: string;
    workspaceName: string;
    deploymentId: string;
    name: string;
    agentId: string;
    agentName: string;
    agentVersion: number;
    latestAgentVersion: number;
    scheduled: boolean;
    archived: boolean;
}

export interface BuildInput {
    workspaceId: string;
    deploymentId: string;
    kind: SessionKind;
    title: string;
    metadata: Record<string, string>;
    /** Conversations: Switchboard's part of the first message, after the deployment's text. */
    firstContent?: ContentBlock[];
    /** Files to mount, for example a long conversation history. */
    files?: FileResource[];
}

export interface Built {
    params: CreateSessionParams;
    deployment: Deployment;
    agentId: string;
    agentVersion: number;
}

interface Cached<T> {
    value: T;
    until: number;
}

export class Templates {
    readonly #workspaces: ClaudeWorkspaces;
    readonly #appendix: string;
    readonly #cacheMs: number;
    readonly #deployments = new Map<string, Cached<Deployment>>();
    readonly #agents = new Map<string, Cached<Agent>>();

    constructor(workspaces: ClaudeWorkspaces, appendix: string, cacheMs = 60_000) {
        this.#workspaces = workspaces;
        this.#appendix = appendix;
        this.#cacheMs = cacheMs;
    }

    async #cached<T>(cache: Map<string, Cached<T>>, key: string, ttl: number, load: () => Promise<T>) {
        const hit = cache.get(key);
        if (hit && hit.until > Date.now()) return hit.value;
        const value = await load();
        cache.set(key, { value, until: Date.now() + ttl });
        return value;
    }

    deployment(workspaceId: string, deploymentId: string, fresh = false): Promise<Deployment> {
        const key = `${workspaceId}/${deploymentId}`;
        if (fresh) this.#deployments.delete(key);
        return this.#cached(this.#deployments, key, this.#cacheMs, () =>
            this.#workspaces.get(workspaceId).retrieveDeployment(deploymentId)
        );
    }

    /** An agent version never changes, so pinned versions are cached longer than "latest" (`fresh` skips it). */
    agent(workspaceId: string, agentId: string, version?: number, fresh = false): Promise<Agent> {
        const key = `${workspaceId}/${agentId}/${version ?? 'latest'}`;
        if (fresh) this.#agents.delete(key);
        const ttl = version === undefined ? this.#cacheMs : 60 * this.#cacheMs;
        return this.#cached(this.#agents, key, ttl, () =>
            this.#workspaces.get(workspaceId).retrieveAgent(agentId, version)
        );
    }

    /** The deployment as people choose it; `fresh` reads the agent's newest version instead of the cached one. */
    async describe(workspaceId: string, deployment: Deployment, fresh = false): Promise<DeploymentInfo> {
        const latest = await this.agent(workspaceId, deployment.agent.id, undefined, fresh);
        return {
            workspaceId,
            workspaceName: this.#workspaces.get(workspaceId).workspaceName,
            deploymentId: deployment.id,
            name: deployment.name,
            agentId: deployment.agent.id,
            agentName: latest.name,
            agentVersion: deployment.agent.version,
            latestAgentVersion: latest.version,
            scheduled: deployment.schedule !== null,
            archived: deployment.archived_at !== null,
        };
    }

    /** Deployments an admin can choose: in a configured workspace, active, not archived, without a schedule. */
    async selectable(): Promise<DeploymentInfo[]> {
        const options: DeploymentInfo[] = [];
        for (const api of this.#workspaces.all()) {
            for (const deployment of await api.listDeployments()) {
                if (deployment.archived_at !== null || deployment.schedule !== null) continue;
                if (deployment.status !== 'active') continue;
                options.push(await this.describe(api.workspaceId, deployment));
            }
        }
        return options.sort((a, b) => a.name.localeCompare(b.name));
    }

    /**
     * Problems that stop a deployment from serving in this role, with the agent version it pins or the one given
     * (`upgrade` checks the version it is about to pin); empty when it can serve.
     */
    async check(
        workspaceId: string,
        deploymentId: string,
        kind: SessionKind,
        agentVersion?: number
    ): Promise<string[]> {
        let deployment: Deployment;
        try {
            deployment = await this.deployment(workspaceId, deploymentId, true);
        } catch {
            return [`deployment ${deploymentId} was not found in workspace ${workspaceId}`];
        }
        const name = `deployment "${deployment.name}"`;
        const problems: string[] = [];
        if (deployment.archived_at !== null) problems.push(`${name} is archived`);
        if (deployment.schedule !== null) {
            problems.push(`${name} has a schedule; Switchboard runs jobs itself, remove the schedule`);
        }
        const allowed = kind === 'conversation' ? ['user.message'] : ['user.message', 'user.define_outcome'];
        const rejected = deployment.initial_events.filter((event) => !allowed.includes(event.type));
        if (rejected.length > 0) {
            problems.push(
                `${name} starts with ${[...new Set(rejected.map((e) => e.type))].join(', ')}; a ${kind} deployment ` +
                    `may only start with ${allowed.join(' or ')}`
            );
        }
        try {
            const agent = await this.agent(workspaceId, deployment.agent.id, agentVersion ?? deployment.agent.version);
            if (agent.archived_at !== null) problems.push(`the agent of ${name} is archived`);
            const clashes = clashingTools(agent);
            if (clashes.length > 0) {
                problems.push(`the agent of ${name} has tools named like Switchboard's: ${clashes.join(', ')}`);
            }
        } catch {
            problems.push(`the agent of ${name} could not be read`);
        }
        return problems;
    }

    /** The one create call for a new session: deployment settings, agent with appendix and tools, first events. */
    async build(input: BuildInput): Promise<Built> {
        const deployment = await this.deployment(input.workspaceId, input.deploymentId);
        if (deployment.archived_at !== null) throw new Error(`deployment "${deployment.name}" is archived`);
        const { id: agentId, version: agentVersion } = deployment.agent;
        const agent = await this.agent(input.workspaceId, agentId, agentVersion);
        const clashes = clashingTools(agent);
        if (clashes.length > 0) throw new Error(`the agent has tools named like Switchboard's: ${clashes.join(', ')}`);
        const tools: (Agent['tools'][number] | BetaManagedAgentsCustomToolParams)[] = [
            ...agent.tools,
            ...toolsFor(input.kind),
        ];
        const initialEvents: NonNullable<CreateSessionParams['initial_events']> = [];
        if (input.kind === 'conversation') {
            // one user.message: the deployment's context first, then Switchboard's part, so the agent answers once
            const context = deployment.initial_events.flatMap((event) =>
                event.type === 'user.message'
                    ? event.content.filter((block): block is ContentBlock => block.type !== 'redacted')
                    : []
            );
            initialEvents.push({ type: 'user.message', content: [...context, ...(input.firstContent ?? [])] });
        } else {
            for (const event of deployment.initial_events) {
                if (event.type === 'user.message') {
                    const content = event.content.filter((block): block is ContentBlock => block.type !== 'redacted');
                    initialEvents.push({ type: 'user.message', content });
                } else if (event.type === 'user.define_outcome') {
                    initialEvents.push(event);
                }
            }
        }
        return {
            deployment,
            agentId,
            agentVersion,
            params: {
                agent: {
                    type: 'agent_with_overrides',
                    id: agentId,
                    version: agentVersion,
                    system: combineSystemPrompt(agent.system, this.#appendix),
                    tools,
                },
                environment_id: deployment.environment_id,
                ...(deployment.vault_ids.length > 0 ? { vault_ids: deployment.vault_ids } : {}),
                ...(deployment.resources.length > 0 || input.files?.length
                    ? { resources: [...deployment.resources, ...(input.files ?? [])] }
                    : {}),
                ...(deployment.budget ? { budget: deployment.budget } : {}),
                title: input.title.slice(0, 500),
                metadata: input.metadata,
                ...(initialEvents.length > 0 ? { initial_events: initialEvents } : {}),
            },
        };
    }
}
