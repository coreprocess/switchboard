import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Activity } from '@microsoft/agents-activity';
import {
    bindingOf,
    hasFileAttachments,
    isBotMentioned,
    splitConversationId,
    textWithoutBotMention,
    userAllowed,
} from '../../src/teams/access.ts';
import { CHANNEL, groupBoundConfig, OTHER_CHANNEL, TEAM, TEAM_GROUP, TENANT, testConfig } from '../helpers/config.ts';

const BOT = '28:bot-app-id';
const ALLOWED = 'aaaaaaaa-0000-0000-0000-000000000001';

const channelMessage = (overrides: Record<string, unknown> = {}) =>
    Activity.fromObject({
        type: 'message',
        id: '1730000000001',
        text: '<at>Switchboard</at> deploy please',
        from: { id: '29:user', name: 'Jane Doe', aadObjectId: ALLOWED },
        recipient: { id: BOT, name: 'Switchboard' },
        conversation: { id: `${CHANNEL};messageid=1730000000001`, conversationType: 'channel', tenantId: TENANT },
        channelData: { tenant: { id: TENANT }, team: { id: TEAM }, channel: { id: CHANNEL } },
        entities: [{ type: 'mention', mentioned: { id: BOT, name: 'Switchboard' }, text: '<at>Switchboard</at>' }],
        ...overrides,
    });

describe('channel binding', () => {
    const config = testConfig();

    it('binds messages from a configured channel in the configured tenant', () => {
        const binding = bindingOf(config, channelMessage());
        assert.ok(binding.bound);
        assert.equal(binding.channelKey, 'ops');
        assert.equal(binding.origin.rootId, '1730000000001');
    });

    it('rejects other tenants, chats, unknown channels and other teams', () => {
        const otherTenant = channelMessage({
            channelData: {
                tenant: { id: '99999999-0000-0000-0000-000000000000' },
                team: { id: TEAM },
                channel: { id: CHANNEL },
            },
        });
        assert.deepEqual(reason(bindingOf(config, otherTenant)), 'tenant');
        const personal = channelMessage({
            conversation: { id: 'a:personal', conversationType: 'personal', tenantId: TENANT },
            channelData: { tenant: { id: TENANT } },
        });
        assert.deepEqual(reason(bindingOf(config, personal)), 'not_a_channel');
        const group = channelMessage({
            conversation: { id: '19:chat@thread.v2', conversationType: 'groupChat', tenantId: TENANT },
            channelData: { tenant: { id: TENANT } },
        });
        assert.deepEqual(reason(bindingOf(config, group)), 'not_a_channel');
        const unknownChannel = channelMessage({
            channelData: { tenant: { id: TENANT }, team: { id: TEAM }, channel: { id: '19:elsewhere@thread.tacv2' } },
        });
        assert.deepEqual(reason(bindingOf(config, unknownChannel)), 'not_bound');
        const otherTeam = channelMessage({
            channelData: {
                tenant: { id: TENANT },
                team: { id: '19:other-team@thread.tacv2' },
                channel: { id: CHANNEL },
            },
        });
        assert.deepEqual(reason(bindingOf(config, otherTeam)), 'not_bound');
    });

    it('binds card clicks without the group ID to a channel bound by group ID', () => {
        const groupBound = groupBoundConfig();
        const message = channelMessage({
            channelData: {
                tenant: { id: TENANT },
                team: { id: TEAM, aadGroupId: TEAM_GROUP },
                channel: { id: CHANNEL },
            },
        });
        assert.equal(bindingOf(groupBound, message).bound, true);
        // Teams sends card clicks with the team's thread ID only
        const click = channelMessage({
            type: 'invoke',
            name: 'adaptiveCard/action',
            channelData: { tenant: { id: TENANT }, team: { id: TEAM }, channel: { id: CHANNEL } },
        });
        assert.equal(bindingOf(groupBound, click).bound, true);
        const otherGroup = channelMessage({
            channelData: {
                tenant: { id: TENANT },
                team: { id: TEAM, aadGroupId: '00000000-0000-0000-0000-00000000000b' },
                channel: { id: CHANNEL },
            },
        });
        assert.deepEqual(reason(bindingOf(groupBound, otherGroup)), 'not_bound');
    });

    it('ignores channelData it cannot parse', () => {
        assert.deepEqual(reason(bindingOf(config, channelMessage({ channelData: 'garbage' }))), 'not_a_channel');
    });

    it('lets team members talk by default and narrows to the allowlist', () => {
        const ops = config.channels.ops;
        const restricted = config.channels.restricted;
        assert.ok(ops && restricted);
        assert.equal(userAllowed(ops, 'bbbbbbbb-0000-0000-0000-000000000002'), true);
        assert.equal(userAllowed(ops, undefined), false);
        assert.equal(userAllowed(restricted, ALLOWED.toUpperCase()), true);
        assert.equal(userAllowed(restricted, 'bbbbbbbb-0000-0000-0000-000000000002'), false);
        const binding = bindingOf(
            config,
            channelMessage({
                channelData: { tenant: { id: TENANT }, team: { id: TEAM }, channel: { id: OTHER_CHANNEL } },
            })
        );
        assert.ok(binding.bound);
        assert.equal(binding.channelKey, 'restricted');
    });
});

describe('message parsing', () => {
    it('detects and strips the bot mention, keeping mentions of people', () => {
        const activity = channelMessage({ text: '<at>Switchboard</at> ask <at>Max</at> about it' });
        assert.equal(isBotMentioned(activity), true);
        assert.equal(textWithoutBotMention(activity), 'ask @Max about it');
        const plain = channelMessage({ text: 'just a reply', entities: [] });
        assert.equal(isBotMentioned(plain), false);
        assert.equal(textWithoutBotMention(plain), 'just a reply');
        const otherMention = channelMessage({
            entities: [{ type: 'mention', mentioned: { id: '29:someone' }, text: '<at>Someone</at>' }],
        });
        assert.equal(isBotMentioned(otherMention), false);
    });

    it('splits thread conversation IDs', () => {
        assert.deepEqual(splitConversationId(`${CHANNEL};messageid=42`), {
            channelConversationId: CHANNEL,
            rootId: '42',
        });
        assert.deepEqual(splitConversationId(CHANNEL), { channelConversationId: CHANNEL, rootId: undefined });
    });

    it('treats only non-HTML attachments as files', () => {
        assert.equal(
            hasFileAttachments(channelMessage({ attachments: [{ contentType: 'text/html', content: '<p>x</p>' }] })),
            false
        );
        assert.equal(
            hasFileAttachments(
                channelMessage({ attachments: [{ contentType: 'image/png', contentUrl: 'https://x' }] })
            ),
            true
        );
    });
});

const reason = (binding: ReturnType<typeof bindingOf>) => (binding.bound ? 'bound' : binding.reason);
