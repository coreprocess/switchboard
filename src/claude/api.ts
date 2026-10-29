import type Anthropic from '@anthropic-ai/sdk';
import type { BetaManagedAgentsDeploymentRun } from '@anthropic-ai/sdk/resources/beta/deployment-runs';
import type {
    BetaManagedAgentsSessionEvent,
    BetaManagedAgentsSessionEventType,
    BetaManagedAgentsStreamSessionEvents,
    BetaManagedAgentsUserMessageEventParams,
    BetaManagedAgentsUserToolConfirmationEventParams,
} from '@anthropic-ai/sdk/resources/beta/sessions/events';
import type { BetaManagedAgentsSession, SessionCreateParams } from '@anthropic-ai/sdk/resources/beta/sessions/sessions';
import type { BetaWebhookEvent } from '@anthropic-ai/sdk/resources/beta/webhooks';

export type Session = BetaManagedAgentsSession;
export type SessionEvent = BetaManagedAgentsSessionEvent;
export type StreamEvent = BetaManagedAgentsStreamSessionEvents;
export type WebhookEvent = BetaWebhookEvent;
export type DeploymentRun = BetaManagedAgentsDeploymentRun;
export type OutgoingEvent = BetaManagedAgentsUserMessageEventParams | BetaManagedAgentsUserToolConfirmationEventParams;

export interface ListEventsOptions {
    /** Only events created at or after this time (ISO 8601). */
    createdAtGte?: string;
    types?: BetaManagedAgentsSessionEventType[];
    order?: 'asc' | 'desc';
    /** Stop after this many events. */
    max?: number;
}

/**
 * The part of the Managed Agents API Switchboard uses (beta `managed-agents-2026-04-01`, set by the SDK).
 * A narrow interface so the relay, caller resolution and webhooks can be tested against fakes.
 */
export interface ClaudeApi {
    createSession(params: SessionCreateParams): Promise<Session>;
    retrieveSession(sessionId: string): Promise<Session>;
    /** Sends events and returns the IDs the platform assigned to them, in order. */
    sendEvents(sessionId: string, events: OutgoingEvent[]): Promise<string[]>;
    listEvents(sessionId: string, options?: ListEventsOptions): Promise<SessionEvent[]>;
    /** Opens the live stream; resolves once connected. The stream ends when `signal` aborts. */
    streamEvents(sessionId: string, signal: AbortSignal): Promise<AsyncIterable<StreamEvent>>;
    listRunningSessions(): Promise<Session[]>;
    retrieveDeploymentRun(runId: string): Promise<DeploymentRun>;
    /** Verifies a webhook delivery's signature and freshness and parses it; throws when invalid. */
    unwrapWebhook(body: string, headers: Record<string, string>): WebhookEvent;
}

const PAGE = 100;

export const createClaudeApi = (client: Anthropic, webhookSecret: string): ClaudeApi => ({
    createSession: (params) => client.beta.sessions.create(params),
    retrieveSession: (sessionId) => client.beta.sessions.retrieve(sessionId),
    sendEvents: async (sessionId, events) => {
        const sent = await client.beta.sessions.events.send(sessionId, { events });
        return (sent.data ?? []).map((event) => event.id);
    },
    listEvents: async (sessionId, options = {}) => {
        const events: SessionEvent[] = [];
        const pages = client.beta.sessions.events.list(sessionId, {
            limit: options.max === undefined ? PAGE : Math.min(PAGE, options.max),
            ...(options.createdAtGte ? { 'created_at[gte]': options.createdAtGte } : {}),
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
    listRunningSessions: async () => {
        const sessions: Session[] = [];
        for await (const session of client.beta.sessions.list({ statuses: ['running'], limit: PAGE })) {
            sessions.push(session);
        }
        return sessions;
    },
    retrieveDeploymentRun: (runId) => client.beta.deploymentRuns.retrieve(runId),
    unwrapWebhook: (body, headers) => client.beta.webhooks.unwrap(body, { headers, key: webhookSecret }),
});

/** Text of an `agent.message` event (redacted blocks carry no text). */
export const messageText = (event: SessionEvent): string => {
    if (event.type !== 'agent.message') return '';
    return event.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .filter((text) => text.length > 0)
        .join('\n\n');
};
