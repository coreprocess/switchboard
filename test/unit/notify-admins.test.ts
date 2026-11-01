import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ADMIN, CHANNEL, eventually, type Harness, startHarness } from '../helpers/harness.ts';
import type { Turn } from '../helpers/mock-claude.ts';

const START = Date.parse('2026-11-02T08:00:00Z');
const HEADING = '📣 **Message for the Switchboard admins**';

type Result = { text: string; isError: boolean };

describe('notify_admins', () => {
    let h: Harness;
    let offset = 0;
    const began = Date.now();
    const results: Result[] = [];

    /** Messages to the admins in the channel: thread roots that start with the heading. */
    const notices = () =>
        h.connector.messages.filter(
            (m) => m.conversationId === `${CHANNEL};messageid=${m.id}` && String(m.activity.text).startsWith(HEADING)
        );
    /** A new thread whose agent calls `notify_admins` with the given message. */
    const notify = async (message: string) => {
        const count = results.length;
        await h.post(h.message(`notify ${message}`));
        await eventually(() => results.length > count, 8_000, 'notify_admins result');
        return JSON.parse(results.at(-1)?.text ?? '{}') as Record<string, unknown>;
    };

    before(async () => {
        h = await startHarness({ now: () => new Date(START + (Date.now() - began) + offset) });
        h.claude.agent = async (turn: Turn) => {
            const match = /notify (.+)$/.exec(turn.text);
            if (!match) return turn.say('Hello.');
            results.push(await turn.callTool('notify_admins', { message: match[1] }));
            turn.say('Done.');
        };
        await h.bind();
    });

    after(async () => {
        await h.stop();
    });

    it('posts the message as a thread of its own and @mentions the admins', async () => {
        const result = await notify('The GitHub token has expired.');
        assert.equal(result.posted, true);
        assert.equal(result.admins_notified, 1);
        assert.equal(notices().length, 1);
        const notice = notices()[0];
        assert.equal(result.conversation_id, notice?.id);
        assert.equal(String(notice?.activity.text), `${HEADING}\n\nThe GitHub token has expired.\n\n<at>Admin</at>`);
        assert.deepEqual(notice?.activity.entities, [
            { type: 'mention', text: '<at>Admin</at>', mentioned: { id: ADMIN, name: 'Admin' } },
        ]);
    });

    it('posts nothing more that day, whichever session calls, and links the earlier message', async () => {
        offset += 6 * 60 * 60_000;
        const result = await notify('Another problem.');
        assert.equal(result.posted, false);
        assert.match(String(result.reason), /already notified today/);
        assert.equal(result.conversation_id, notices()[0]?.id);
        assert.match(String(result.url), /^https:\/\/teams\.microsoft\.com\/l\/message\//);
        assert.equal(notices().length, 1);
    });

    it('notifies again the next day', async () => {
        offset += 24 * 60 * 60_000;
        const result = await notify('Still expired.');
        assert.equal(result.posted, true);
        assert.equal(notices().length, 2);
    });

    it('refuses an overly long message', async () => {
        await h.post(h.message(`notify ${'x'.repeat(2_001)}`));
        await eventually(() => results.at(-1)?.isError === true, 8_000, 'error result');
        assert.match(results.at(-1)?.text ?? '', /invalid input/);
        assert.equal(notices().length, 2);
    });
});
