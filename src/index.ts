import { WorkloadIdentityCredential } from '@azure/identity';
import { loadAuthConfigFromEnv, OutboundHostValidator } from '@microsoft/agents-hosting';
import { createApp } from './app.ts';
import { ClaudeWorkspaces, createAnthropicClient, createClaudeApi } from './claude/api.ts';
import { loadSettings, type StoreSettings } from './config/env.ts';
import { createLogger } from './core/logger.ts';
import { VERSION } from './core/version.ts';
import { listen } from './server/http.ts';
import { AzureTableStore } from './store/azure-tables.ts';
import { MemoryStore } from './store/memory.ts';
import type { Store } from './store/store.ts';

const createStore = (settings: StoreSettings): Store => {
    if (settings.kind === 'memory') return new MemoryStore();
    return new AzureTableStore({
        endpoint: settings.endpoint,
        connectionString: settings.connectionString,
        tablePrefix: settings.tablePrefix,
        // AKS workload identity: AZURE_CLIENT_ID (the managed identity), AZURE_TENANT_ID, AZURE_FEDERATED_TOKEN_FILE.
        credential: settings.connectionString ? undefined : new WorkloadIdentityCredential(),
    });
};

const main = async () => {
    const settings = loadSettings(process.env);
    const log = createLogger(settings.logLevel);
    // Background work (streams, card updates) logs its own failures; this is the last resort, not a crash.
    process.on('unhandledRejection', (error) => log.error({ err: error }, 'unhandled rejection'));
    const store = createStore(settings.store);
    await store.init();
    const workspaces = new ClaudeWorkspaces(
        settings.workspaces.map((workspace) =>
            createClaudeApi(
                createAnthropicClient(workspace, settings, process.env),
                workspace,
                settings.webhookSecrets[workspace.id]
            )
        )
    );
    const { app, sb } = createApp({
        settings,
        store,
        workspaces,
        authConfig: loadAuthConfigFromEnv(),
        outboundPolicy: settings.production ? new OutboundHostValidator({ enabled: true }) : undefined,
        log,
    });
    const { server, port } = await listen(app, settings.host, settings.port);
    sb.start();
    log.info(
        {
            version: VERSION,
            port,
            pod: sb.podId,
            publicUrl: settings.publicUrl,
            store: settings.store.kind,
            tenants: settings.tenants.length,
            admins: settings.admins.length,
            workspaces: settings.workspaces.map((w) => w.id),
        },
        'switchboard started'
    );

    let stopping = false;
    const stop = async (signal: string) => {
        if (stopping) return;
        stopping = true;
        log.info({ signal }, 'stopping');
        // stop taking requests, finish the ones in flight, then hand the session leases over
        server.close();
        await sb.stop();
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
