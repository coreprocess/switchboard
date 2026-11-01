import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ADMIN, CHANNEL, eventually, type Harness, startHarness, TEAM } from '../helpers/harness.ts';
import type { Turn } from '../helpers/mock-claude.ts';

const MINUTE = 60_000;
const START = Date.parse('2026-11-01T08:00:00Z');
const WARNING = '⚠️ **Switchboard cannot read this channel**';
const RESTORED = '✅ Switchboard can read this channel again.';

describe('read access', () => {
    let h: Harness;
    let offset = 0;
    const began = Date.now();
    const results: Record<string, { text: string; isError: boolean }> = {};

    const sb = () => {
        const instance = h.instances[0];
        assert.ok(instance);
        return instance.sb;
    };
    const binding = async () => {
        const stored = (await sb().entities.bindings.get(TEAM, CHANNEL))?.value;
        assert.ok(stored);
        return stored;
    };
    /** Warning threads, oldest first. */
    const warnings = () =>
        h.connector.messages.filter(
            (m) => m.conversationId === `${CHANNEL};messageid=${m.id}` && String(m.activity.text).startsWith(WARNING)
        );
    const notes = () => h.connector.messages.filter((m) => m.activity.text === RESTORED);
    const status = async () => {
        await h.post(h.message('status', { mention: true }));
        return String(h.connector.messages.at(-1)?.activity.text ?? '');
    };

    before(async () => {
        h = await startHarness({ now: () => new Date(START + (Date.now() - began) + offset) });
        h.claude.agent = async (turn: Turn) => {
            if (turn.text.endsWith('list please')) {
                results.list = await turn.callTool('list_conversations', {});
                turn.say('Listed.');
                return;
            }
            turn.say('Hello.');
        };
        await h.bind();
    });

    after(async () => {
        await h.stop();
    });

    it('records that reading works, and status shows it', async () => {
        await sb().access.periodic();
        assert.equal((await sb().access.state(await binding()))?.readable, true);
        assert.match(await status(), /- Read access: ✅ \(checked just now\)/);
        assert.equal(warnings().length, 0);
    });

    it('checks once per interval', async () => {
        offset += 15 * MINUTE;
        const before = h.connector.graphRequests.length;
        await sb().access.periodic();
        await sb().access.periodic();
        assert.equal(h.connector.graphRequests.length - before, 1);
    });

    it('warns in the channel and notifies the admins when reading is refused', async () => {
        h.connector.graphDenied = true;
        offset += 15 * MINUTE;
        await sb().access.periodic();
        assert.equal(warnings().length, 1);
        const warning = warnings()[0]?.activity;
        assert.ok(warning);
        assert.match(String(warning.text), /ChannelMessage\.Read\.Group/);
        assert.match(String(warning.text), /<at>Admin<\/at>$/);
        assert.deepEqual(warning.entities, [
            { type: 'mention', text: '<at>Admin</at>', mentioned: { id: ADMIN, name: 'Admin' } },
        ]);
        const state = await sb().access.state(await binding());
        assert.equal(state?.readable, false);
        assert.equal(state?.warningRootId, warnings()[0]?.id);
        assert.match(
            await status(),
            /⚠️ Read access: denied since .* \(checked just now\); messages without @Switchboard do not reach/
        );
        assert.equal(warnings().length, 1, 'status posts no second warning');
    });

    it('warns at most once a day; agents get a clear error instead', async () => {
        offset += 15 * MINUTE;
        await sb().access.periodic();
        await h.post(h.message('list please'));
        await eventually(() => results.list !== undefined, 8_000, 'list_conversations');
        assert.equal(results.list?.isError, true);
        assert.match(results.list?.text ?? '', /not allowed to read this channel’s messages/);
        assert.match(results.list?.text ?? '', /no need to report it/);
        assert.equal(warnings().length, 1);
    });

    it('repeats the warning the next day, also when an agent hits the refusal first', async () => {
        offset += 24 * 60 * MINUTE;
        delete results.list;
        await h.post(h.message('list please'));
        await eventually(() => warnings().length === 2, 8_000, 'second warning');
        assert.equal((await sb().access.state(await binding()))?.warningRootId, warnings()[1]?.id);
    });

    it('says so once in the latest warning thread when reading works again, at once on status', async () => {
        h.connector.graphDenied = false;
        offset += 5 * MINUTE;
        assert.match(await status(), /- Read access: ✅ \(checked just now\)/);
        assert.equal(notes().length, 1);
        assert.equal(notes()[0]?.conversationId, `${CHANNEL};messageid=${warnings()[1]?.id}`);
        offset += 15 * MINUTE;
        await sb().access.periodic();
        assert.equal(await status().then(() => notes().length), 1);
        const state = await sb().access.state(await binding());
        assert.equal(state?.readable, true);
        assert.equal(state?.deniedSince, undefined);
    });

    it('keeps the last state when the platform cannot tell (an outage)', async () => {
        h.connector.graphDown = true;
        offset += 15 * MINUTE;
        await sb().access.periodic();
        assert.match(await status(), /- Read access: ✅ \(last checked .*; the check failed just now\)/);
        h.connector.graphDown = false;
        assert.equal((await sb().access.state(await binding()))?.readable, true);
        assert.equal(warnings().length, 2);
    });
});
