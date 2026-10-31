import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Graph, toThreadMessage } from '../../src/teams/graph.ts';

const GROUP = '00000000-0000-0000-0000-00000000000a';
const graph = new Graph(async () => undefined);
const scope = graph.channelUrl(GROUP, '19:ops-channel@thread.tacv2');
const base = `https://graph.microsoft.com/v1.0/teams/${GROUP}/channels`;

describe('Graph scope', () => {
    it('lets the bot’s token reach the bound channel only', () => {
        const cases: [string, boolean][] = [
            [`${scope}/messages?$top=20&$skiptoken=abc`, true],
            // Graph writes channel IDs unencoded in its own URLs (image sources)
            [`${base}/19:ops-channel@thread.tacv2/messages/1/hostedContents/x/$value`, true],
            [`${scope}`, false],
            [`${base}/19:other@thread.tacv2/messages`, false],
            [`${scope}/../19:other@thread.tacv2/messages`, false],
            [`${scope}/messages/..`, false],
            [`${scope}%2F..%2F19%3Aother%40thread.tacv2/messages`, false],
            [`${scope}/..%2F..%2Fother/messages`, false],
            [`${scope}/%2E%2E/other/messages`, false],
            [
                `https://graph.microsoft.com%2Fv1.0%2Fteams%2F${GROUP}%2Fchannels%2F19%3Aops-channel%40thread.tacv2%2F@evil.example.com/x`,
                false,
            ],
            [
                `https://user:pw@graph.microsoft.com/v1.0/teams/${GROUP}/channels/19%3Aops-channel%40thread.tacv2/messages`,
                false,
            ],
            [`http://graph.microsoft.com/v1.0/teams/${GROUP}/channels/19%3Aops-channel%40thread.tacv2/messages`, false],
            ['not a url', false],
        ];
        for (const [url, expected] of cases) assert.equal(graph.within(scope, url), expected, url);
    });
});

describe('Graph messages', () => {
    it('turns a message into Markdown with image markers, mentions and cards', () => {
        const message = toThreadMessage({
            id: '1793400000000',
            messageType: 'message',
            createdDateTime: '2026-10-31T10:00:00.000Z',
            subject: 'Import',
            from: { user: { id: 'aaaa', displayName: 'Jane Doe' } },
            body: {
                contentType: 'html',
                content:
                    '<p>Hi <at id="0">Otto</at>, see <b>this</b>:</p><img src="https://graph.example/hc/1/$value" alt="error [1].png">',
            },
            attachments: [
                { contentType: 'application/vnd.microsoft.card.adaptive', content: '{"type":"AdaptiveCard"}' },
                { contentType: 'application/vnd.microsoft.card.adaptive', content: 'not json' },
                { contentType: 'reference', name: 'report.xlsx' },
            ],
        });
        assert.equal(message.text, 'Hi @Otto, see **this**:\n\n[image: error [1].png]');
        assert.deepEqual(message.images, [{ ref: 'https://graph.example/hc/1/$value', name: 'error [1].png' }]);
        assert.deepEqual(message.cards, [{ type: 'AdaptiveCard' }]);
        assert.deepEqual(message.files, ['report.xlsx']);
        assert.deepEqual(message.author, { name: 'Jane Doe', aadObjectId: 'aaaa', isApp: false });
        assert.equal(message.subject, 'Import');
    });

    it('marks apps as such', () => {
        const message = toThreadMessage({
            id: '1',
            createdDateTime: '2026-10-31T10:00:00.000Z',
            from: { application: { displayName: 'Switchboard' } },
            body: { contentType: 'text', content: 'Done.' },
        });
        assert.deepEqual(message.author, { name: 'Switchboard', isApp: true });
        assert.equal(message.text, 'Done.');
    });
});
