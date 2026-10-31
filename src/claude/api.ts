import Anthropic, { APIError } from '@anthropic-ai/sdk';
import { identityTokenFromFile } from '@anthropic-ai/sdk/lib/credentials/identity-token';
import { oidcFederationProvider } from '@anthropic-ai/sdk/lib/credentials/oidc-federation';
import type { AgentUpdateParams, BetaManagedAgentsAgent } from '@anthropic-ai/sdk/resources/beta/agents/agents';
import type { BetaManagedAgentsDeployment, DeploymentUpdateParams } from '@anthropic-ai/sdk/resources/beta/deployments';
import type {
    BetaManagedAgentsSessionEvent,
    BetaManagedAgentsSessionEventType,
    BetaManagedAgentsStreamSessionEvents,
    BetaManagedAgentsUserCustomToolResultEventParams,
    BetaManagedAgentsUserInterruptEventParams,
    BetaManagedAgentsUserMessageEventParams,
    BetaManagedAgentsUserToolConfirmationEventParams,
} from '@anthropic-ai/sdk/resources/beta/sessions/events';
import type { BetaManagedAgentsSession, SessionCreateParams } from '@anthropic-ai/sdk/resources/beta/sessions/sessions';
import type { BetaWebhookEvent } from '@anthropic-ai/sdk/resources/beta/webhooks';
import type { Settings, WorkspaceConfig } from '../config/env.ts';

export type Agent = BetaManagedAgentsAgent;
export type Deployment = BetaManagedAgentsDeployment;
export type AgentUpdate = AgentUpdateParams;
export type DeploymentUpdate = DeploymentUpdateParams;
export type Session = BetaManagedAgentsSession;
export type SessionEvent = BetaManagedAgentsSessionEvent;
export type StreamEvent = BetaManagedAgentsStreamSessionEvents;
export type WebhookEvent = BetaWebhookEvent;
export type CreateSessionParams = SessionCreateParams;
export type UserMessageEvent = BetaManagedAgentsUserMessageEventParams;
export type OutgoingEvent =
    | BetaManagedAgentsUserMessageEventParams
    | BetaManagedAgentsUserToolConfirmationEventParams
    | BetaManagedAgentsUserCustomToolResultEventParams
    | BetaManagedAgentsUserInterruptEventParams;

export interface ListEventsOptions {
    /** Only events processed at or after this time (ISO 8601). */
    processedAtGte?: string;
    types?: BetaManagedAgentsSessionEventType[];
    order?: 'asc' | 'desc';
    /** Stop after this many events. */
    max?: number;
}

/**
 * The part of the Managed Agents API Switchboard uses, for one Claude workspace (beta `managed-agents-2026-04-01`,
 * set by the SDK). A narrow interface, so everything above it can be tested against a fake.
 */
export interface ClaudeApi {
    readonly workspaceId: string;
    readonly workspaceName: string;
    retrieveDeployment(deploymentId: string): Promise<Deployment>;
    /** Deployments that are not archived. */
    listDeployments(): Promise<Deployment[]>;
    /** The agent in the given version, or its latest version. */
    retrieveAgent(agentId: string, version?: number): Promise<Agent>;
    /** Saves a new version of the agent; with `version`, only if that is still its newest version. */
    updateAgent(agentId: string, update: AgentUpdate): Promise<Agent>;
    /** Changes the given fields of the deployment. */
    updateDeployment(deploymentId: string, update: DeploymentUpdate): Promise<Deployment>;
    createSession(params: CreateSessionParams): Promise<Session>;
    retrieveSession(sessionId: string): Promise<Session>;
    archiveSession(sessionId: string): Promise<void>;
    /** Deletes the session; a session that is gone already counts as deleted. */
    deleteSession(sessionId: string): Promise<void>;
    /** Sends events and returns the IDs the platform assigned to them, in order. */
    sendEvents(sessionId: string, events: OutgoingEvent[]): Promise<string[]>;
    listEvents(sessionId: string, options?: ListEventsOptions): Promise<SessionEvent[]>;
    /** Opens the live stream; resolves once connected. The stream ends when `signal` aborts. */
    streamEvents(sessionId: string, signal: AbortSignal): Promise<AsyncIterable<StreamEvent>>;
    uploadFile(name: string, mediaType: string, data: Uint8Array): Promise<string>;
    /** Deletes the file; a file that is gone already counts as deleted. */
    deleteFile(fileId: string): Promise<void>;
    /** Verifies a webhook delivery with this workspace's secret and parses it; throws when invalid. */
    unwrapWebhook(body: string, headers: Record<string, string>): WebhookEvent;
}

const PAGE = 100;

const ignoreNotFound = async (call: () => Promise<unknown>) => {
    try {
        await call();
    } catch (error) {
        if (error instanceof APIError && error.status === 404) return;
        throw error;
    }
};

export const createClaudeApi = (
    client: Anthropic,
    workspace: Pick<WorkspaceConfig, 'id' | 'name'>,
    webhookSecret: string | undefined
): ClaudeApi => ({
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    retrieveDeployment: (deploymentId) => client.beta.deployments.retrieve(deploymentId),
    listDeployments: async () => {
        const deployments: Deployment[] = [];
        for await (const deployment of client.beta.deployments.list({ limit: PAGE })) deployments.push(deployment);
        return deployments;
    },
    retrieveAgent: (agentId, version) => client.beta.agents.retrieve(agentId, version === undefined ? {} : { version }),
    updateAgent: (agentId, update) => client.beta.agents.update(agentId, update),
    updateDeployment: (deploymentId, update) => client.beta.deployments.update(deploymentId, update),
    createSession: (params) => client.beta.sessions.create(params),
    retrieveSession: (sessionId) => client.beta.sessions.retrieve(sessionId),
    archiveSession: async (sessionId) => {
        await client.beta.sessions.archive(sessionId);
    },
    deleteSession: (sessionId) => ignoreNotFound(() => client.beta.sessions.delete(sessionId)),
    sendEvents: async (sessionId, events) => {
        const sent = await client.beta.sessions.events.send(sessionId, { events });
        return (sent.data ?? []).map((event) => event.id);
    },
    listEvents: async (sessionId, options = {}) => {
        const events: SessionEvent[] = [];
        const pages = client.beta.sessions.events.list(sessionId, {
            limit: options.max === undefined ? PAGE : Math.min(PAGE, options.max),
            ...(options.processedAtGte ? { 'created_at[gte]': options.processedAtGte } : {}),
            ...(options.types ? { types: options.types } : {}),
            order: options.order ?? 'asc',
        });
        for await (const event of pages) {
            events.push(event);
            if (options.max !== undefined && events.length >= options.max) break;
        }
        return events;
    },
    streamEvents: async (sessionId, signal) => client.beta.sessions.events.stream(sessionId, {}, { signal }),
    uploadFile: async (name, mediaType, data) => {
        const file = await client.beta.files.upload({ file: new File([data], name, { type: mediaType }) });
        return file.id;
    },
    deleteFile: (fileId) => ignoreNotFound(() => client.beta.files.delete(fileId)),
    unwrapWebhook: (body, headers) => {
        if (!webhookSecret) throw new Error(`no webhook secret for workspace ${workspace.id}`);
        return client.beta.webhooks.unwrap(body, { headers, key: webhookSecret });
    },
});

/** A Claude API client for one workspace: workload identity federation, or an API key for local development. */
export const createAnthropicClient = (workspace: WorkspaceConfig, settings: Settings, env: NodeJS.ProcessEnv) => {
    const baseURL = settings.anthropicBaseUrl ?? 'https://api.anthropic.com';
    if (workspace.api_key_env) return new Anthropic({ apiKey: env[workspace.api_key_env] ?? '', baseURL });
    const federation = workspace.federation;
    if (!federation || !settings.identityTokenFile) throw new Error(`workspace ${workspace.id}: no sign-in`);
    return new Anthropic({
        baseURL,
        // one token exchange per workspace: federated tokens are scoped to the workspace they were minted for
        credentials: oidcFederationProvider({
            identityTokenProvider: identityTokenFromFile(settings.identityTokenFile),
            federationRuleId: federation.rule_id,
            organizationId: federation.organization_id,
            serviceAccountId: federation.service_account_id,
            workspaceId: workspace.id,
            baseURL,
            fetch: globalThis.fetch,
        }),
    });
};

/** The configured workspaces' APIs. */
export class ClaudeWorkspaces {
    readonly #apis: Map<string, ClaudeApi>;

    constructor(apis: ClaudeApi[]) {
        this.#apis = new Map(apis.map((api) => [api.workspaceId, api]));
    }

    get(workspaceId: string): ClaudeApi {
        const api = this.#apis.get(workspaceId);
        if (!api) throw new Error(`workspace ${workspaceId} is not configured`);
        return api;
    }

    has(workspaceId: string) {
        return this.#apis.has(workspaceId);
    }

    all(): ClaudeApi[] {
        return [...this.#apis.values()];
    }
}

/** Text of an `agent.message` event (redacted blocks carry no text). */
export const messageText = (event: SessionEvent): string => {
    if (event.type !== 'agent.message') return '';
    return event.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .filter((text) => text.length > 0)
        .join('\n\n');
};
