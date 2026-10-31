import type {
    BetaManagedAgentsAgentReference,
    BetaManagedAgentsMultiagent20261001Params,
    BetaManagedAgentsMultiagentCoordinatorParams,
} from '@anthropic-ai/sdk/resources/beta/agents/agents';
import type { Agent, ClaudeApi } from './api.ts';
import type { SessionKind, Templates } from './templates.ts';

/**
 * `upgrade` (concept: "Upgrading a channel's agents"): deployments pin a fixed agent version, and agents pin fixed
 * versions of the agents they use as subagents or in workflows; only skills follow "latest". The upgrade moves a
 * channel's deployments to their agents' newest versions. Where an agent references an outdated version of another
 * agent, it first saves a new version of that agent with the references raised, inside out, and otherwise unchanged.
 * Running sessions keep their version; new sessions use the new one.
 */

/** A deployment of the channel and the role it has there. */
export interface UpgradeTarget {
    deploymentId: string;
    kind: SessionKind;
}

export interface DeploymentUpgrade {
    deploymentId: string;
    deploymentName: string;
    kind: SessionKind;
    agentName: string;
    from: number;
    to: number;
}

/** An agent version saved because the agent referenced outdated versions of other agents. */
export interface AgentVersionSaved {
    agentId: string;
    agentName: string;
    from: number;
    to: number;
}

export type UpgradeResult =
    | { outcome: 'up_to_date' }
    | { outcome: 'upgraded'; deployments: DeploymentUpgrade[]; agents: AgentVersionSaved[] }
    | { outcome: 'refused'; problems: string[]; agents: AgentVersionSaved[] };

type Reference = BetaManagedAgentsAgentReference;
type MultiagentUpdate = BetaManagedAgentsMultiagentCoordinatorParams | BetaManagedAgentsMultiagent20261001Params;

const isReference = (entry: { type: string }): entry is Reference => entry.type === 'agent';

/** The versions of other agents an agent pins: subagents, workflow agents, a coordinator's roster. */
export const referencesOf = (agent: Agent): Reference[] => {
    const multiagent = agent.multiagent;
    if (!multiagent) return [];
    if (multiagent.type === 'coordinator') return multiagent.agents.filter(isReference);
    return [multiagent.subagents, multiagent.workflows].flatMap((member) =>
        member.type === 'enabled' ? member.predefined_agents : []
    );
};

/**
 * The agent's multiagent configuration with its references raised to `newest`, as an update. For
 * `multiagent_20261001` only the lists are sent: the platform merges an update into the stored configuration.
 */
const raisedReferences = (agent: Agent, newest: Map<string, number>): MultiagentUpdate | undefined => {
    const multiagent = agent.multiagent;
    if (!multiagent) return undefined;
    const raise = (reference: Reference): Reference => ({
        type: 'agent',
        id: reference.id,
        version: newest.get(reference.id) ?? reference.version,
    });
    if (multiagent.type === 'coordinator') {
        return {
            type: 'coordinator',
            agents: multiagent.agents.map((entry) => (isReference(entry) ? raise(entry) : entry)),
        };
    }
    const { subagents, workflows } = multiagent;
    return {
        type: multiagent.type,
        ...(subagents.type === 'enabled'
            ? { subagents: { type: 'enabled', predefined_agents: subagents.predefined_agents.map(raise) } }
            : {}),
        ...(workflows.type === 'enabled'
            ? { workflows: { type: 'enabled', predefined_agents: workflows.predefined_agents.map(raise) } }
            : {}),
    };
};

/** One upgrade run for one channel; every agent is looked at once. */
export class Upgrade {
    readonly #api: ClaudeApi;
    readonly #templates: Templates;
    /** Each agent's newest version once its references are current. */
    readonly #newest = new Map<string, number>();
    readonly #saved: AgentVersionSaved[] = [];

    constructor(api: ClaudeApi, templates: Templates) {
        this.#api = api;
        this.#templates = templates;
    }

    async run(targets: UpgradeTarget[]): Promise<UpgradeResult> {
        const plans = [];
        for (const target of targets) {
            const deployment = await this.#api.retrieveDeployment(target.deploymentId);
            const to = await this.#current(deployment.agent.id, new Set());
            plans.push({ target, deployment, to });
        }
        const problems: string[] = [];
        for (const { target, to } of plans) {
            problems.push(
                ...(await this.#templates.check(this.#api.workspaceId, target.deploymentId, target.kind, to))
            );
        }
        if (problems.length > 0) return { outcome: 'refused', problems, agents: this.#saved };
        const deployments: DeploymentUpgrade[] = [];
        const updated = new Set<string>();
        for (const { target, deployment, to } of plans) {
            const from = deployment.agent.version;
            if (from === to || updated.has(deployment.id)) continue;
            await this.#api.updateDeployment(deployment.id, {
                agent: { type: 'agent', id: deployment.agent.id, version: to },
            });
            updated.add(deployment.id);
            await this.#templates.deployment(this.#api.workspaceId, deployment.id, true);
            const agent = await this.#templates.agent(this.#api.workspaceId, deployment.agent.id, to);
            deployments.push({
                deploymentId: deployment.id,
                deploymentName: deployment.name,
                kind: target.kind,
                agentName: agent.name,
                from,
                to,
            });
        }
        if (deployments.length === 0 && this.#saved.length === 0) return { outcome: 'up_to_date' };
        return { outcome: 'upgraded', deployments, agents: this.#saved };
    }

    /**
     * The agent's newest version, after saving a new one if it references outdated versions of other agents.
     * `path` holds the agents being raised further up, so a cycle ends instead of recursing.
     */
    async #current(agentId: string, path: Set<string>): Promise<number> {
        const known = this.#newest.get(agentId);
        if (known !== undefined) return known;
        const agent = await this.#api.retrieveAgent(agentId);
        if (path.has(agentId)) return agent.version;
        const others = referencesOf(agent).filter((reference) => reference.id !== agentId);
        const newest = new Map<string, number>();
        for (const reference of others) {
            newest.set(reference.id, await this.#current(reference.id, new Set([...path, agentId])));
        }
        let version = agent.version;
        const multiagent = raisedReferences(agent, newest);
        if (multiagent && others.some((reference) => newest.get(reference.id) !== reference.version)) {
            const saved = await this.#api.updateAgent(agentId, { version: agent.version, multiagent });
            this.#saved.push({ agentId, agentName: agent.name, from: agent.version, to: saved.version });
            version = saved.version;
        }
        this.#newest.set(agentId, version);
        return version;
    }
}
