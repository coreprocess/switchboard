import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { WorkloadIdentityCredential } from '@azure/identity';
import { loadAuthConfigFromEnv, OutboundHostValidator } from '@microsoft/agents-hosting';
import { createSwitchboard } from './app.ts';
import { parseChannelsConfig } from './config/channels.ts';
import { type Env, loadEnv } from './config/env.ts';
import { createLogger } from './core/logger.ts';
import { VERSION } from './core/version.ts';
import { listen } from './server/http.ts';
import { AzureTableStore } from './store/azure-tables.ts';
import { MemoryStore } from './store/memory.ts';
import type { Store } from './store/store.ts';

const createStore = (settings: Env['store']): Store => {
    if (settings.kind === 'memory') return new MemoryStore();
    return new AzureTableStore({
        endpoint: settings.endpoint,
        connectionString: settings.connectionString,
        // AKS workload identity: AZURE_CLIENT_ID (the managed identity), AZURE_TENANT_ID, AZURE_FEDERATED_TOKEN_FILE.
        credential: settings.connectionString ? undefined : new WorkloadIdentityCredential(),
    });
};

const main = async () => {
    const env = loadEnv(process.env);
    const log = createLogger(env.logLevel);
    // Background work (streams, card updates) logs its own failures; this is the last resort, not a crash.
    process.on('unhandledRejection', (error) => log.error({ err: error }, 'unhandled rejection'));
    const config = parseChannelsConfig(readFileSync(env.configPath, 'utf8'));
    const store = createStore(env.store);
    await store.init();

    const { app, relay, reconciler } = createSwitchboard({
        config,
        store,
        anthropic: new Anthropic({ apiKey: env.anthropicApiKey, baseURL: env.anthropicBaseUrl ?? null }),
        webhookSecret: env.webhookSecret,
        mcpTokens: env.mcpTokens,
        authConfig: loadAuthConfigFromEnv(),
        outboundPolicy: env.production ? new OutboundHostValidator({ enabled: true }) : undefined,
        log,
    });
    const { server, port } = await listen(app, env.host, env.port);
    log.info(
        {
            version: VERSION,
            port,
            publicUrl: env.publicUrl,
            channels: Object.keys(config.channels),
            store: env.store.kind,
            mcpTokens: env.mcpTokens.map((t) => t.name),
        },
        'switchboard started'
    );
    reconciler.start();

    let stopping = false;
    const stop = async (signal: string) => {
        if (stopping) return;
        stopping = true;
        log.info({ signal }, 'stopping');
        await reconciler.stop();
        relay.close();
        server.close();
        server.closeAllConnections();
        log.flush();
    };
    process.on('SIGTERM', () => void stop('SIGTERM'));
    process.on('SIGINT', () => void stop('SIGINT'));
};

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
