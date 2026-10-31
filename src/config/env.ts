import { z } from 'zod';

/**
 * Switchboard's configuration: only what must not be changeable from Teams. Bindings and jobs live in the store
 * and are managed with the settings card.
 */

const Guid = z.guid();

export const AdminSchema = z
    .object({ tenant: Guid, object_id: Guid, label: z.string().min(1).optional() })
    .strict()
    .transform((admin) => ({ tenant: admin.tenant, objectId: admin.object_id, label: admin.label }));
export type Admin = z.output<typeof AdminSchema>;

const FederationSchema = z
    .object({
        rule_id: z.string().startsWith('fdrl_'),
        organization_id: Guid,
        service_account_id: z.string().startsWith('svac_'),
    })
    .strict();

export const WorkspaceSchema = z
    .object({
        id: z.string().startsWith('wrkspc_'),
        name: z.string().min(1),
        /** Workload identity federation (recommended): exchanges the pod's identity token per workspace. */
        federation: FederationSchema.optional(),
        /** Alternatively the name of an environment variable holding an API key for this workspace. */
        api_key_env: z
            .string()
            .regex(/^[A-Z][A-Z0-9_]*$/)
            .optional(),
    })
    .strict()
    .refine((w) => (w.federation === undefined) !== (w.api_key_env === undefined), {
        message: 'set exactly one of federation and api_key_env',
    });
export type WorkspaceConfig = z.output<typeof WorkspaceSchema>;

export type StoreSettings =
    | { kind: 'memory' }
    | {
          kind: 'azure-tables';
          endpoint: string | undefined;
          connectionString: string | undefined;
          tablePrefix: string;
      };

export interface Settings {
    host: string;
    port: number;
    publicUrl: string | undefined;
    logLevel: string;
    production: boolean;
    tenants: string[];
    admins: Admin[];
    workspaces: WorkspaceConfig[];
    /** Webhook signing secret per workspace ID. */
    webhookSecrets: Record<string, string>;
    /** The pod's identity token for workload identity federation (projected service-account token). */
    identityTokenFile: string | undefined;
    anthropicBaseUrl: string | undefined;
    store: StoreSettings;
    defaultTimezone: string;
    defaultJobMaxRuntimeMin: number;
    sessionArchiveAfterDays: number;
    conversationRetentionDays: number;
    attachmentMaxBytes: number;
    attachmentTypes: string[];
    logInlineLimitBytes: number;
    botClientId: string | undefined;
}

const json = <T extends z.ZodType>(env: NodeJS.ProcessEnv, name: string, schema: T, fallback?: string): z.output<T> => {
    const raw = env[name]?.trim() || fallback;
    if (raw === undefined) throw new Error(`${name} is required`);
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(`${name} is not valid JSON`);
    }
    const result = schema.safeParse(parsed);
    if (!result.success) throw new Error(`${name}: ${z.prettifyError(result.error)}`);
    return result.data;
};

const integer = (env: NodeJS.ProcessEnv, name: string, fallback: number, min = 1): number => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min) throw new Error(`${name} must be an integer of at least ${min}`);
    return value;
};

const required = (env: NodeJS.ProcessEnv, name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
};

export const isTimeZone = (zone: string): boolean => {
    try {
        new Intl.DateTimeFormat('en', { timeZone: zone });
        return true;
    } catch {
        return false;
    }
};

/** The bot's app ID from the Agents SDK connection settings (`CONNECTIONS__<name>__SETTINGS__CLIENTID`). */
const botClientIdOf = (env: NodeJS.ProcessEnv): string | undefined =>
    Object.entries(env).find(([key, value]) => /^connections__[^_].*__settings__clientid$/i.test(key) && value)?.[1];

const storeOf = (env: NodeJS.ProcessEnv, production: boolean): StoreSettings => {
    const kind = env.STORE_KIND?.trim() || 'azure-tables';
    if (kind === 'memory') {
        if (production) throw new Error('STORE_KIND=memory is for development only');
        return { kind };
    }
    if (kind !== 'azure-tables') throw new Error(`STORE_KIND: unknown store '${kind}' (azure-tables, memory)`);
    const endpoint = env.STORE_TABLES_ENDPOINT?.trim() || undefined;
    const connectionString = env.STORE_TABLES_CONNECTION_STRING?.trim() || undefined;
    if (!endpoint && !connectionString) {
        throw new Error('STORE_TABLES_ENDPOINT (or STORE_TABLES_CONNECTION_STRING for development) is required');
    }
    return { kind, endpoint, connectionString, tablePrefix: required(env, 'SWITCHBOARD_TABLE_PREFIX') };
};

export const loadSettings = (env: NodeJS.ProcessEnv): Settings => {
    const production = env.NODE_ENV === 'production';
    const botClientId = botClientIdOf(env);
    if (production && !botClientId) {
        throw new Error('CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTID is required in production');
    }
    const workspaces = json(env, 'SWITCHBOARD_WORKSPACES', z.array(WorkspaceSchema).min(1));
    const ids = workspaces.map((w) => w.id);
    if (new Set(ids).size !== ids.length) throw new Error('SWITCHBOARD_WORKSPACES: duplicate workspace IDs');
    const identityTokenFile = env.ANTHROPIC_IDENTITY_TOKEN_FILE?.trim() || undefined;
    for (const workspace of workspaces) {
        if (workspace.federation && !identityTokenFile) {
            throw new Error(`workspace ${workspace.id} uses federation: ANTHROPIC_IDENTITY_TOKEN_FILE is required`);
        }
        if (workspace.api_key_env && !env[workspace.api_key_env]?.trim()) {
            throw new Error(`workspace ${workspace.id}: ${workspace.api_key_env} is not set`);
        }
    }
    const webhookSecrets = json(
        env,
        'CLAUDE_WEBHOOK_SECRETS',
        z.record(z.string().startsWith('wrkspc_'), z.string().min(1)),
        '{}'
    );
    for (const id of Object.keys(webhookSecrets)) {
        if (!ids.includes(id)) throw new Error(`CLAUDE_WEBHOOK_SECRETS: workspace ${id} is not configured`);
    }
    const defaultTimezone = env.DEFAULT_TIMEZONE?.trim() || 'Europe/Berlin';
    if (!isTimeZone(defaultTimezone)) throw new Error(`DEFAULT_TIMEZONE: unknown time zone '${defaultTimezone}'`);
    return {
        host: env.HOST?.trim() || '0.0.0.0',
        port: integer(env, 'PORT', 8080, 0),
        publicUrl: env.SWITCHBOARD_PUBLIC_URL?.trim() || undefined,
        logLevel: env.LOG_LEVEL?.trim() || 'info',
        production,
        tenants: json(env, 'SWITCHBOARD_TENANTS', z.array(Guid).min(1)).map((t) => t.toLowerCase()),
        admins: json(env, 'SWITCHBOARD_ADMINS', z.array(AdminSchema), '[]'),
        workspaces,
        webhookSecrets,
        identityTokenFile,
        anthropicBaseUrl: env.ANTHROPIC_BASE_URL?.trim() || undefined,
        store: storeOf(env, production),
        defaultTimezone,
        defaultJobMaxRuntimeMin: integer(env, 'DEFAULT_JOB_MAX_RUNTIME_MIN', 60),
        sessionArchiveAfterDays: integer(env, 'SESSION_ARCHIVE_AFTER_DAYS', 30),
        conversationRetentionDays: integer(env, 'CONVERSATION_RETENTION_DAYS', 90),
        attachmentMaxBytes: integer(env, 'ATTACHMENT_MAX_MB', 20) * 1024 * 1024,
        attachmentTypes: (env.ATTACHMENT_TYPES?.trim() || 'image')
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
        logInlineLimitBytes: integer(env, 'LOG_INLINE_LIMIT_KB', 50) * 1024,
        botClientId,
    };
};
