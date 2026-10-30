import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CHANNEL_KEY } from './channels.ts';

/** An MCP bearer token, kept only as its SHA-256 digest, with the channels it may post to. */
export interface McpToken {
    name: string;
    digest: Buffer;
    channels: string[];
}

export type StoreSettings =
    | { kind: 'memory' }
    | { kind: 'azure-tables'; endpoint: string | undefined; connectionString: string | undefined };

export interface Env {
    host: string;
    port: number;
    publicUrl: string | undefined;
    logLevel: string;
    production: boolean;
    /** Unset with Workload Identity Federation: the SDK then signs in with the `ANTHROPIC_FEDERATION_*` settings. */
    anthropicApiKey: string | undefined;
    anthropicAuth: 'api-key' | 'federation';
    anthropicBaseUrl: string | undefined;
    webhookSecret: string;
    mcpTokens: McpToken[];
    configPath: string;
    store: StoreSettings;
    botClientId: string | undefined;
}

const MIN_TOKEN_LENGTH = 32;

const TokenEntry = z.union([
    z.array(z.string().regex(CHANNEL_KEY)),
    z.object({ name: z.string().min(1).optional(), channels: z.array(z.string().regex(CHANNEL_KEY)) }).strict(),
]);

export const digestToken = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

/**
 * `SWITCHBOARD_MCP_TOKENS`: a JSON object mapping each token to the channel keys it may post to, either as an
 * array or as `{ "name": "…", "channels": [ … ] }`. The name only appears in logs.
 */
export const parseMcpTokens = (json: string): McpToken[] => {
    const parsed = z.record(z.string(), TokenEntry).parse(JSON.parse(json));
    return Object.entries(parsed).map(([token, entry], index) => {
        if (token.length < MIN_TOKEN_LENGTH) {
            throw new Error(
                `SWITCHBOARD_MCP_TOKENS: token #${index + 1} is shorter than ${MIN_TOKEN_LENGTH} characters`
            );
        }
        const channels = Array.isArray(entry) ? entry : entry.channels;
        const name = (Array.isArray(entry) ? undefined : entry.name) ?? `token-${index + 1}`;
        return { name, digest: digestToken(token), channels };
    });
};

const required = (env: NodeJS.ProcessEnv, name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
};

const FEDERATION_SETTINGS = [
    'ANTHROPIC_FEDERATION_RULE_ID',
    'ANTHROPIC_ORGANIZATION_ID',
    'ANTHROPIC_SERVICE_ACCOUNT_ID',
];

/**
 * How Switchboard signs in to the Claude API: `ANTHROPIC_API_KEY`, or Workload Identity Federation, which the SDK
 * resolves itself from `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_SERVICE_ACCOUNT_ID`,
 * `ANTHROPIC_WORKSPACE_ID` and the identity token (`ANTHROPIC_IDENTITY_TOKEN_FILE`). A key wins over federation.
 */
const anthropicAuthOf = (env: NodeJS.ProcessEnv): Env['anthropicAuth'] => {
    if (env.ANTHROPIC_API_KEY?.trim()) return 'api-key';
    const missing = FEDERATION_SETTINGS.filter((name) => !env[name]?.trim());
    if (!env.ANTHROPIC_IDENTITY_TOKEN_FILE?.trim() && !env.ANTHROPIC_IDENTITY_TOKEN?.trim()) {
        missing.push('ANTHROPIC_IDENTITY_TOKEN_FILE');
    }
    if (missing.length === 0) return 'federation';
    throw new Error(`ANTHROPIC_API_KEY is required, or Workload Identity Federation: ${missing.join(', ')}`);
};

/** The bot's app ID from the Agents SDK connection settings (`CONNECTIONS__<name>__SETTINGS__CLIENTID`). */
const botClientIdOf = (env: NodeJS.ProcessEnv): string | undefined =>
    Object.entries(env).find(([key, value]) => /^connections__[^_].*__settings__clientid$/i.test(key) && value)?.[1];

export const loadEnv = (env: NodeJS.ProcessEnv): Env => {
    const production = env.NODE_ENV === 'production';
    const botClientId = botClientIdOf(env);
    if (production && !botClientId) {
        throw new Error('CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTID is required in production');
    }
    const kind = env.STORE_KIND?.trim() || 'azure-tables';
    let store: StoreSettings;
    if (kind === 'memory') {
        if (production) throw new Error('STORE_KIND=memory is for development only');
        store = { kind };
    } else if (kind === 'azure-tables') {
        const endpoint = env.STORE_TABLES_ENDPOINT?.trim() || undefined;
        const connectionString = env.STORE_TABLES_CONNECTION_STRING?.trim() || undefined;
        if (!endpoint && !connectionString) {
            throw new Error('STORE_TABLES_ENDPOINT (or STORE_TABLES_CONNECTION_STRING for development) is required');
        }
        store = { kind, endpoint, connectionString };
    } else {
        throw new Error(`STORE_KIND: unknown store '${kind}' (azure-tables, memory)`);
    }
    return {
        host: env.HOST?.trim() || '0.0.0.0',
        port: Number(env.PORT ?? 8080),
        publicUrl: env.SWITCHBOARD_PUBLIC_URL?.trim() || undefined,
        logLevel: env.LOG_LEVEL?.trim() || 'info',
        production,
        anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || undefined,
        anthropicAuth: anthropicAuthOf(env),
        anthropicBaseUrl: env.ANTHROPIC_BASE_URL?.trim() || undefined,
        webhookSecret: required(env, 'CLAUDE_WEBHOOK_SECRET'),
        mcpTokens: parseMcpTokens(env.SWITCHBOARD_MCP_TOKENS?.trim() || '{}'),
        configPath: required(env, 'SWITCHBOARD_CONFIG'),
        store,
        botClientId,
    };
};
