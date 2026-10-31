import { type AuthConfiguration, CloudAdapter, type OutboundUrlPolicy } from '@microsoft/agents-hosting';
import type { ClaudeWorkspaces } from './claude/api.ts';
import { loadAppendix, Templates } from './claude/templates.ts';
import type { Settings } from './config/env.ts';
import type { HistoryReader } from './conversations/conversations.ts';
import type { Logger } from './core/logger.ts';
import { createHttpApp } from './server/http.ts';
import { createEntities } from './store/entities.ts';
import type { Store } from './store/store.ts';
import { type Core, Switchboard, type Timing } from './switchboard.ts';
import { TeamsBot } from './teams/bot.ts';
import { TeamsGateway } from './teams/gateway.ts';
import { GraphHistory } from './teams/history.ts';
import { claudeWebhookHandler } from './webhooks/claude.ts';

export interface AppOptions {
    settings: Settings;
    store: Store;
    workspaces: ClaudeWorkspaces;
    /** Agents SDK connection settings (workload identity in production). */
    authConfig: AuthConfiguration;
    /** Restricts the hosts the bot calls; the Microsoft default list in production. */
    outboundPolicy: OutboundUrlPolicy | undefined;
    log: Logger;
    /** Tests: a history reader instead of Microsoft Graph, attachment hosts, timings, clock, pod ID. */
    history?: HistoryReader;
    attachmentHosts?: RegExp[];
    timing?: Partial<Timing>;
    now?: () => Date;
    podId?: string;
}

/** Wires one Switchboard instance; `index.ts` starts it, tests build several against shared fakes. */
export const createApp = (options: AppOptions) => {
    const { settings, log } = options;
    const adapter = new CloudAdapter(options.authConfig, undefined, undefined, undefined, options.outboundPolicy);
    adapter.onTurnError = async (_context, error) => {
        log.error({ err: error }, 'turn failed');
    };
    const entities = createEntities(options.store);
    const teams = new TeamsGateway({
        adapter,
        entities,
        botAppId: options.authConfig.clientId ?? '',
        ...(options.attachmentHosts ? { attachmentHosts: options.attachmentHosts } : {}),
    });
    const core: Core = {
        settings,
        entities,
        workspaces: options.workspaces,
        templates: new Templates(options.workspaces, loadAppendix()),
        gateway: teams,
        history: options.history ?? new GraphHistory((scope) => teams.token(scope)),
        log,
        ...(options.podId ? { podId: options.podId } : {}),
        ...(options.now ? { now: options.now } : {}),
        ...(options.timing ? { timing: options.timing } : {}),
    };
    const sb = new Switchboard(core);
    const bot = new TeamsBot(sb, teams);
    const app = createHttpApp({
        adapter,
        authConfig: options.authConfig,
        onTurn: (context) => bot.handle(context),
        onWebhook: claudeWebhookHandler(sb),
        store: options.store,
        log,
    });
    return { app, sb, teams };
};
