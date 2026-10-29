import type Anthropic from '@anthropic-ai/sdk';
import { type AuthConfiguration, CloudAdapter, type OutboundUrlPolicy } from '@microsoft/agents-hosting';
import { Approvals } from './approvals/approvals.ts';
import { createClaudeApi } from './claude/api.ts';
import { CallerResolver } from './claude/caller.ts';
import type { ChannelsConfig } from './config/channels.ts';
import type { McpToken } from './config/env.ts';
import type { Logger } from './core/logger.ts';
import { Reconciler } from './relay/reconciler.ts';
import { Relay } from './relay/relay.ts';
import { createHttpApp } from './server/http.ts';
import type { Store } from './store/store.ts';
import { TeamsBot } from './teams/bot.ts';
import { TeamsGateway } from './teams/gateway.ts';

export interface SwitchboardOptions {
    config: ChannelsConfig;
    store: Store;
    anthropic: Anthropic;
    webhookSecret: string;
    mcpTokens: McpToken[];
    /** Agents SDK connection settings (workload identity in production). */
    authConfig: AuthConfiguration;
    /** Restricts the hosts the bot calls; the Microsoft default list in production. */
    outboundPolicy: OutboundUrlPolicy | undefined;
    log: Logger;
    reconcileIntervalMs?: number;
}

/** Wires Switchboard's parts together; `index.ts` starts it, tests build it with fakes. */
export const createSwitchboard = (options: SwitchboardOptions) => {
    const { config, store, log } = options;
    for (const token of options.mcpTokens) {
        const unknown = token.channels.filter((key) => !config.channels[key]);
        if (unknown.length > 0) throw new Error(`MCP token '${token.name}': unknown channels ${unknown.join(', ')}`);
    }

    const api = createClaudeApi(options.anthropic, options.webhookSecret);
    const adapter = new CloudAdapter(options.authConfig, undefined, undefined, undefined, options.outboundPolicy);
    adapter.onTurnError = async (_context, error) => {
        log.error({ err: error }, 'turn failed');
    };
    const gateway = new TeamsGateway({ adapter, store, config, botAppId: options.authConfig.clientId ?? '' });
    const relay = new Relay({ api, store, gateway, log, approvalExpiryHours: config.approval_expiry_hours });
    const approvals = new Approvals({ store, gateway, relay, log, expiryHours: config.approval_expiry_hours });
    const resolver = new CallerResolver({ api, serverName: config.mcp_server_name, log });
    const bot = new TeamsBot({ config, store, api, relay, approvals, log });
    const reconciler = new Reconciler({
        api,
        store,
        relay,
        log,
        ...(options.reconcileIntervalMs ? { intervalMs: options.reconcileIntervalMs } : {}),
    });
    const app = createHttpApp({
        adapter,
        authConfig: options.authConfig,
        onTurn: (context) => bot.handle(context),
        mcp: { config, store, gateway, relay, approvals, resolver, log },
        mcpTokens: options.mcpTokens,
        webhooks: { api, store, relay, gateway, config, log },
        store,
        log,
    });
    return { app, relay, reconciler, gateway, api };
};
