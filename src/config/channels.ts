import { parse } from 'yaml';
import { z } from 'zod';

/** Channel keys appear in thread IDs, store keys and tool calls, so they stay short and URL-safe. */
export const CHANNEL_KEY = /^[a-z0-9][a-z0-9_-]{0,62}$/;

const MemoryStoreResource = z
    .object({
        type: z.literal('memory_store'),
        memory_store_id: z.string().min(1),
        access: z.enum(['read_write', 'read_only']).optional(),
        instructions: z.string().optional(),
    })
    .strict();

const Channel = z
    .object({
        description: z.string().default(''),
        /** Teams team ID (`19:…@thread.tacv2`, the ID of the team's General channel). */
        team_id: z.string().min(1).optional(),
        /** Alternatively the team's Microsoft 365 group (Entra object ID). */
        team_aad_group_id: z.guid().optional(),
        channel_id: z.string().min(1),
        agent: z
            .object({
                id: z.string().min(1),
                version: z.number().int().positive().optional(),
            })
            .strict(),
        environment_id: z.string().min(1),
        vault_ids: z.array(z.string().min(1)).default([]),
        resources: z.array(MemoryStoreResource).default([]),
        budget_usd: z.number().positive().optional(),
        session_title_prefix: z.string().default('Teams'),
        /** v1 lets every member of the bound team talk to the agent and approve; `allowlist` narrows that. */
        access: z.enum(['team_members', 'allowlist']).default('team_members'),
        allowlist: z.array(z.guid()).optional(),
    })
    .strict()
    .refine((c) => c.team_id !== undefined || c.team_aad_group_id !== undefined, {
        message: 'set team_id or team_aad_group_id',
    })
    .refine((c) => c.access !== 'allowlist' || (c.allowlist?.length ?? 0) > 0, {
        message: 'access: allowlist needs a non-empty allowlist of Entra object IDs',
    });

const ChannelsFile = z
    .object({
        tenant_id: z.guid(),
        alerts_channel: z.string().regex(CHANNEL_KEY).optional(),
        /** Bot Framework service URL used before the first activity from a channel has been seen. */
        service_url: z.url().optional(),
        /** The name agents give this server in `mcp_servers`; caller resolution matches tool-use events on it. */
        mcp_server_name: z.string().min(1).default('switchboard'),
        /** Approval cards expire after this many hours; unset means they never expire. */
        approval_expiry_hours: z.number().positive().optional(),
        /** Claude Console workspace ID for session links in alerts (`default` for the Default workspace). */
        console_workspace: z.string().min(1).optional(),
        channels: z.record(z.string().regex(CHANNEL_KEY), Channel),
    })
    .strict();

export type ChannelBinding = z.infer<typeof Channel>;
export type ChannelsConfig = z.infer<typeof ChannelsFile>;

export const parseChannelsConfig = (source: string): ChannelsConfig => {
    const config = ChannelsFile.parse(parse(source));
    const keys = Object.keys(config.channels);
    if (keys.length === 0) throw new Error('channels: configure at least one channel');
    if (config.alerts_channel && !config.channels[config.alerts_channel]) {
        throw new Error(`alerts_channel: unknown channel '${config.alerts_channel}'`);
    }
    const seen = new Map<string, string>();
    for (const [key, channel] of Object.entries(config.channels)) {
        const other = seen.get(channel.channel_id);
        if (other) throw new Error(`channels.${key}: channel_id is already bound by '${other}'`);
        seen.set(channel.channel_id, key);
    }
    return config;
};

/** Session budget in the API's form: USD minor units as an integer string. */
export const budgetOf = (channel: ChannelBinding) =>
    channel.budget_usd === undefined
        ? undefined
        : {
              type: 'limit' as const,
              max_list_cost: {
                  amount: String(Math.max(1, Math.round(channel.budget_usd * 100))),
                  currency: 'USD' as const,
              },
          };
