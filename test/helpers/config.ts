import { type ChannelsConfig, parseChannelsConfig } from '../../src/config/channels.ts';

export const TENANT = '11111111-2222-3333-4444-555555555555';
export const TEAM = '19:team-general@thread.tacv2';
export const TEAM_GROUP = '00000000-0000-0000-0000-00000000000a';
export const CHANNEL = '19:ops-channel@thread.tacv2';
export const OTHER_CHANNEL = '19:other-channel@thread.tacv2';

const configYaml = (opsTeam: string) => `
tenant_id: ${TENANT}
alerts_channel: ops
mcp_server_name: switchboard
channels:
  ops:
    description: Operations agent for the example product
    ${opsTeam}
    channel_id: "${CHANNEL}"
    agent: { id: agent_ops, version: 3 }
    environment_id: env_ops
    vault_ids: [vlt_ops]
    resources:
      - { type: memory_store, memory_store_id: memstore_ops, access: read_write }
    budget_usd: 10
    session_title_prefix: Teams
  restricted:
    team_id: "${TEAM}"
    channel_id: "${OTHER_CHANNEL}"
    agent: { id: agent_other }
    environment_id: env_other
    access: allowlist
    allowlist: [aaaaaaaa-0000-0000-0000-000000000001]
`;

export const CONFIG_YAML = configYaml(`team_id: "${TEAM}"`);

export const testConfig = (): ChannelsConfig => parseChannelsConfig(CONFIG_YAML);

/** `ops` bound by the team's group ID only, which Teams sends with messages but not with card clicks. */
export const groupBoundConfig = (): ChannelsConfig =>
    parseChannelsConfig(configYaml(`team_aad_group_id: ${TEAM_GROUP}`));
