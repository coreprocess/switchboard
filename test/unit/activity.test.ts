import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Activity } from '@microsoft/agents-activity';
import { commandOf, messageText, splitConversationId, teamsOriginOf } from '../../src/teams/activity.ts';

const BOT = '28:bot';
const message = (text: string, mention = true, overrides: Record<string, unknown> = {}) =>
    Activity.fromObject({
        type: 'message',
        id: '1793400000001',
        text: mention ? `<at>Switchboard</at> ${text}` : text,
        recipient: { id: BOT, name: 'Switchboard' },
        from: { id: '29:u', name: 'Jane', aadObjectId: 'a1' },
        conversation: { id: '19:ch@thread.tacv2;messageid=1793400000000', conversationType: 'channel', tenantId: 'T' },
        channelData: {
            tenant: { id: 'TENANT' },
            team: { id: '19:team@thread.tacv2', aadGroupId: 'g1' },
            channel: { id: '19:ch@thread.tacv2' },
        },
        entities: mention
            ? [{ type: 'mention', mentioned: { id: BOT, name: 'Switchboard' }, text: '<at>Switchboard</at>' }]
            : [],
        ...overrides,
    });

describe('Teams activities', () => {
    it('recognises commands: a mention and only the command word', () => {
        assert.equal(commandOf(message('settings')), 'settings');
        assert.equal(commandOf(message('  Status. ')), 'status');
        assert.equal(commandOf(message('run')), 'run');
        assert.equal(commandOf(message('settings please')), undefined);
        assert.equal(commandOf(message('status', false)), undefined);
    });

    it('reads origin, thread and text', () => {
        const activity = message('Hello <at>Bob</at>, see <b>this</b>');
        const origin = teamsOriginOf(activity);
        assert.equal(origin.tenantId, 'tenant');
        assert.equal(origin.teamId, '19:team@thread.tacv2');
        assert.equal(origin.aadGroupId, 'g1');
        assert.equal(origin.rootId, '1793400000000');
        assert.equal(messageText(activity), 'Hello @Bob, see **this**');
        assert.deepEqual(splitConversationId('19:x@thread.tacv2'), {
            channelConversationId: '19:x@thread.tacv2',
            rootId: undefined,
        });
    });
});
