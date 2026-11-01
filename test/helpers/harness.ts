import type { Server } from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { loadAuthConfigFromEnv } from '@microsoft/agents-hosting';
import { z } from 'zod';
import { createApp } from '../../src/app.ts';
import { ClaudeWorkspaces, createClaudeApi } from '../../src/claude/api.ts';
import { loadSettings, type Settings } from '../../src/config/env.ts';
import { createLogger, nullLogger } from '../../src/core/logger.ts';
import { listen } from '../../src/server/http.ts';
import { MemoryStore } from '../../src/store/memory.ts';
import type { Store } from '../../src/store/store.ts';
import type { Switchboard, Timing } from '../../src/switchboard.ts';
import { MockClaude } from './mock-claude.ts';
import { MockConnector } from './mock-connector.ts';
import { newWebhookSecret } from './webhooks.ts';

export const TENANT = '11111111-2222-3333-4444-555555555555';
export const ADMIN = 'aaaaaaaa-0000-0000-0000-000000000001';
export const USER = 'bbbbbbbb-0000-0000-0000-000000000002';
export const TEAM = '19:team-general@thread.tacv2';
export const TEAM_GROUP = '00000000-0000-0000-0000-00000000000a';
export const CHANNEL = '19:ops-channel@thread.tacv2';
export const OTHER_CHANNEL = '19:other-channel@thread.tacv2';
export const WORKSPACE = 'wrkspc_test';
export const BOT = '28:switchboard-bot';

export const FAST: Partial<Timing> = {
    leaseMs: 1_500,
    renewMs: 300,
    drainIntervalMs: 250,
    reconcileMs: 400,
    schedulerMs: 150,
    claimMs: 4_000,
    claimWaitMs: 8_000,
    waitTickMs: 100,
};

/** Polls until `check` holds (or fails after `timeoutMs`). */
export const eventually = async (check: () => boolean | Promise<boolean>, timeoutMs = 8_000, what = 'condition') => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for ${what}`);
};

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const Block = z.looseObject({
    type: z.string(),
    text: z.string().optional(),
    source: z.looseObject({ type: z.string(), file_id: z.string().optional() }).optional(),
});

/** The parts of a recorded `POST /v1/sessions` the tests look at. */
export const CreateRequest = z.looseObject({
    agent: z.looseObject({
        type: z.string(),
        version: z.number(),
        system: z.string(),
        tools: z.array(z.looseObject({ type: z.string(), name: z.string().optional() })),
    }),
    environment_id: z.string(),
    vault_ids: z.array(z.string()).optional(),
    resources: z
        .array(z.looseObject({ type: z.string(), file_id: z.string().optional(), mount_path: z.string().nullish() }))
        .optional(),
    title: z.string(),
    metadata: z.record(z.string(), z.string()),
    initial_events: z.array(z.looseObject({ type: z.string(), content: z.array(Block).optional() })),
});
export type CreateRequest = z.infer<typeof CreateRequest>;

export interface Instance {
    sb: Switchboard;
    base: string;
    server: Server;
}

export interface HarnessOptions {
    instances?: number;
    store?: Store;
    env?: Record<string, string>;
    /** Start the background loops (reconciler, scheduler). */
    loops?: boolean;
    timing?: Partial<Timing>;
    /** The instances' clock. */
    now?: () => Date;
}

/** Mock Claude API and Bot Framework connector, and Switchboard instances sharing one store. */
export const startHarness = async (options: HarnessOptions = {}) => {
    const claude = new MockClaude();
    const connector = new MockConnector();
    await claude.start();
    await connector.start();
    if (options.now) connector.now = options.now;
    connector.teams.set(TEAM, {
        name: 'Dev Agents',
        aadGroupId: TEAM_GROUP,
        channels: [
            { id: TEAM, name: null },
            { id: CHANNEL, name: 'ops' },
        ],
    });
    claude.addAgent('agent_ops', { name: 'Ops Agent', system: 'You watch the deployments.' });
    claude.addDeployment('depl_conversation', {
        agentId: 'agent_ops',
        name: 'ops-conversation',
        initial_events: [{ type: 'user.message', content: [{ type: 'text', text: 'This is a conversation in ops.' }] }],
        budget: { type: 'limit', max_list_cost: { amount: '1000', currency: 'USD' } },
    });
    claude.addDeployment('depl_job', {
        agentId: 'agent_ops',
        name: 'ops-hourly-check',
        initial_events: [{ type: 'user.message', content: [{ type: 'text', text: 'Run the hourly check.' }] }],
    });

    const secret = newWebhookSecret();
    const env: Record<string, string> = {
        SWITCHBOARD_TENANTS: JSON.stringify([TENANT]),
        SWITCHBOARD_ADMINS: JSON.stringify([{ tenant: TENANT, object_id: ADMIN, label: 'Admin' }]),
        SWITCHBOARD_WORKSPACES: JSON.stringify([{ id: WORKSPACE, name: 'Test', api_key_env: 'TEST_API_KEY' }]),
        TEST_API_KEY: 'test',
        CLAUDE_WEBHOOK_SECRETS: JSON.stringify({ [WORKSPACE]: secret }),
        STORE_KIND: 'memory',
        ...options.env,
    };
    const settings: Settings = loadSettings(env);
    const store = options.store ?? new MemoryStore();
    const log = process.env.TEST_LOG ? createLogger(process.env.TEST_LOG) : nullLogger();
    const instances: Instance[] = [];
    for (let index = 0; index < (options.instances ?? 1); index++) {
        const workspaces = new ClaudeWorkspaces([
            createClaudeApi(
                new Anthropic({ apiKey: 'test', baseURL: claude.url, maxRetries: 0 }),
                { id: WORKSPACE, name: 'Test' },
                secret
            ),
        ]);
        const { app, sb } = createApp({
            settings,
            store,
            workspaces,
            authConfig: loadAuthConfigFromEnv(),
            outboundPolicy: undefined,
            log: log.child({ pod: index }),
            graphBase: connector.graphBase,
            graphRetryDelayMs: 5,
            attachmentHosts: [/^127\.0\.0\.1$/],
            timing: { ...FAST, ...options.timing },
            podId: `pod-${index}`,
            ...(options.now ? { now: options.now } : {}),
        });
        const { server, port } = await listen(app, '127.0.0.1', 0);
        if (options.loops) sb.start();
        instances.push({ sb, server, base: `http://127.0.0.1:${port}` });
    }

    let nextId = 1793400000000;
    const nextMessageId = () => String(nextId++);

    const activity = (overrides: Record<string, unknown>) => ({
        type: 'message',
        id: nextMessageId(),
        timestamp: (options.now?.() ?? new Date()).toISOString(),
        channelId: 'msteams',
        serviceUrl: connector.url,
        from: { id: '29:user', name: 'Jane Doe', aadObjectId: USER },
        recipient: { id: BOT, name: 'Switchboard' },
        channelData: {
            tenant: { id: TENANT },
            team: { id: TEAM, aadGroupId: TEAM_GROUP, name: 'Dev Agents' },
            channel: { id: CHANNEL },
        },
        ...overrides,
    });

    const mention = { type: 'mention', mentioned: { id: BOT, name: 'Switchboard' }, text: '<at>Switchboard</at>' };

    /** A message in a channel: a root post (no `rootId`) or a reply. */
    const message = (
        text: string,
        opts: {
            rootId?: string;
            mention?: boolean;
            from?: { id: string; name: string; aadObjectId: string };
            channel?: string;
            attachments?: unknown[];
        } = {}
    ) => {
        const id = nextMessageId();
        const channel = opts.channel ?? CHANNEL;
        return activity({
            id,
            conversation: {
                id: `${channel};messageid=${opts.rootId ?? id}`,
                conversationType: 'channel',
                tenantId: TENANT,
                isGroup: true,
            },
            channelData: {
                tenant: { id: TENANT },
                team: { id: TEAM, aadGroupId: TEAM_GROUP, name: 'Dev Agents' },
                channel: { id: channel },
            },
            text: opts.mention ? `<at>Switchboard</at> ${text}` : text,
            entities: opts.mention ? [mention] : [],
            ...(opts.from ? { from: opts.from } : {}),
            ...(opts.attachments ? { attachments: opts.attachments } : {}),
        });
    };

    /** A card click as Teams sends it: the team's thread ID, no group ID. */
    const click = (
        rootId: string,
        messageId: string,
        verb: string,
        data: Record<string, unknown>,
        from = { id: '29:user', name: 'Jane Doe', aadObjectId: USER }
    ) =>
        activity({
            type: 'invoke',
            name: 'adaptiveCard/action',
            replyToId: messageId,
            from,
            conversation: {
                id: `${CHANNEL};messageid=${rootId}`,
                conversationType: 'channel',
                tenantId: TENANT,
                isGroup: true,
            },
            channelData: { tenant: { id: TENANT }, team: { id: TEAM }, channel: { id: CHANNEL } },
            value: { action: { type: 'Action.Execute', verb, data } },
        });

    const admin = { id: '29:admin', name: 'Ada Admin', aadObjectId: ADMIN };

    /** Delivers an activity to an instance; a post in a channel shows in Teams (Graph) before the bot hears of it. */
    const post = async (body: Record<string, unknown>, instance = 0) => {
        const target = instances[instance];
        if (!target) throw new Error(`no instance ${instance}`);
        connector.human(body);
        const response = await fetch(`${target.base}/api/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        const text = await response.text();
        return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined };
    };

    /** Binds the ops channel through the settings card, as the admin. */
    const bind = async (inputs: Record<string, string> = {}) => {
        const result = await post(
            click(
                '0',
                '0',
                'switchboard.settings.save',
                {
                    switchboard_settings: CHANNEL,
                    conversation_deployment: `${WORKSPACE}|depl_conversation`,
                    job_deployment: '',
                    job_enabled: 'true',
                    job_cron: '',
                    job_timezone: 'Europe/Berlin',
                    ...inputs,
                },
                admin
            )
        );
        return result;
    };

    /** Threads in the channel as the connector saw them: root message IDs of posts Switchboard created. */
    const thread = (rootId: string) => connector.visible(`${CHANNEL};messageid=${rootId}`);

    const stop = async () => {
        for (const instance of instances) {
            await instance.sb.stop();
            instance.server.closeAllConnections();
            instance.server.close();
        }
        await claude.stop();
        await connector.stop();
    };

    /** A recorded session-create request (the latest by default). */
    const request = (index = -1): CreateRequest => CreateRequest.parse(claude.createRequests.at(index));
    /** The first message's content blocks of a recorded request, and the text of Switchboard's part. */
    const firstContent = (index = -1) => request(index).initial_events[0]?.content ?? [];
    const firstText = (index = -1) => firstContent(index)[1]?.text ?? '';

    return {
        request,
        firstContent,
        firstText,
        claude,
        connector,
        instances,
        settings,
        store,
        secret,
        post,
        message,
        click,
        bind,
        admin,
        thread,
        nextMessageId,
        stop,
    };
};

export type Harness = Awaited<ReturnType<typeof startHarness>>;
