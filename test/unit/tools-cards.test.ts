import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { HISTORY_FILE_PATH } from '../../src/conversations/history.ts';
import { neutralise } from '../../src/core/text.ts';
import { endNotice } from '../../src/sessions/sessions.ts';
import { CHANNEL, eventually, type Harness, startHarness, USER } from '../helpers/harness.ts';
import type { Turn } from '../helpers/mock-claude.ts';
import { signWebhook, webhookBody } from '../helpers/webhooks.ts';

const card = (title: string, buttons: Record<string, unknown>[] = []) => ({
    type: 'AdaptiveCard',
    version: '1.5',
    body: [{ type: 'TextBlock', text: title }],
    actions: buttons,
});

const latestSession = (h: Harness) => [...h.claude.sessions.keys()].at(-1) ?? '';

describe('tools and cards', () => {
    let h: Harness;
    const results: Record<string, { text: string; isError: boolean }> = {};

    before(async () => {
        h = await startHarness({ env: { HISTORY_INLINE_LIMIT_KB: '2' } });
        await h.bind();
        h.claude.agent = async (turn: Turn) => {
            const last = turn.text.split('\n').at(-1) ?? '';
            if (last === 'show a card') {
                results.show = await turn.callTool('show_card', {
                    card: card('Restart the worker?', [
                        { type: 'Action.Execute', title: 'Approve', verb: 'approve', data: { step: 1 } },
                        { type: 'Action.Execute', title: 'Deny', verb: 'deny' },
                    ]),
                });
                turn.say('Waiting for your decision.');
                return;
            }
            if (turn.text.startsWith('[switchboard:card]')) {
                const cardId = /card=(\S+)/.exec(turn.text)?.[1] ?? '';
                results.update = await turn.callTool('update_card', {
                    card_id: cardId,
                    card: card('✅ Approved, restarting.'),
                });
                return;
            }
            if (last === 'submit card') {
                results.submit = await turn.callTool('show_card', {
                    card: card('Old style', [{ type: 'Action.Submit', title: 'Go' }]),
                });
                return;
            }
            if (last === 'progress please') {
                results.update1 = await turn.callTool('send_update', { text: 'Step 1 of 2 done.' });
                turn.say('All done.');
                return;
            }
            if (last === 'hand over') {
                results.handover = await turn.callTool('start_new_conversation', {
                    message: 'Separate topic: disk usage is growing.',
                    briefing: 'Volume /data grew 20 % in a day.',
                    title: 'Disk usage on /data',
                    tags: ['disk'],
                });
                turn.say('Opened a separate thread.');
                return;
            }
            turn.say(`Echo: ${last}`);
        };
    });

    after(async () => {
        await h.stop();
    });

    it('shows a card, locks it on the first click and unlocks it with update_card', async () => {
        const root = h.message('show a card');
        await h.post(root);
        await eventually(() => h.thread(root.id).includes('Waiting for your decision.'));
        assert.equal(results.show?.isError, false);
        const cardId = JSON.parse(results.show?.text ?? '{}').card_id as string;
        const posted = h.connector.messages.find((m) => JSON.stringify(m.activity).includes(cardId));
        assert.ok(posted, 'card posted');
        assert.match(JSON.stringify(posted.activity), /"switchboard_card":"card_/);

        const sessionId = latestSession(h);
        const clicks = await Promise.all([
            h.post(h.click(root.id, posted.id, 'approve', { step: 1, switchboard_card: cardId, comment: 'go' })),
            h.post(h.click(root.id, posted.id, 'deny', { switchboard_card: cardId })),
        ]);
        for (const click of clicks) {
            assert.equal(click.status, 200);
            assert.equal(click.body?.type, 'application/vnd.microsoft.card.adaptive');
            assert.match(JSON.stringify(click.body?.value), /chose \\"(Approve|Deny)\\" – waiting for the agent/);
            assert.ok(!JSON.stringify(click.body?.value).includes('Action.Execute'), 'buttons removed while locked');
        }
        await eventually(() => results.update !== undefined, 8000, 'update_card');
        const cardMessages = h.claude.userMessages(sessionId).filter((m) => m.startsWith('[switchboard:card]'));
        assert.equal(cardMessages.length, 1, 'exactly one click reaches the session');
        assert.match(
            cardMessages[0] ?? '',
            new RegExp(`card=${cardId} verb=(approve|deny) by="Jane Doe" aad=${USER} at=`)
        );
        assert.equal(results.update?.isError, false);
        await eventually(() => JSON.stringify(posted.activity).includes('Approved, restarting.'));
    });

    it('rejects Action.Submit', async () => {
        const root = h.message('submit card');
        await h.post(root);
        await eventually(() => results.submit !== undefined);
        assert.equal(results.submit?.isError, true);
        assert.match(results.submit?.text ?? '', /Action.Submit is not supported, use Action.Execute/);
    });

    it('posts updates at once and the final answer at the end', async () => {
        const root = h.message('progress please');
        await h.post(root);
        await eventually(() => h.thread(root.id).includes('All done.'));
        assert.deepEqual(h.thread(root.id), ['Step 1 of 2 done.', 'All done.']);
    });

    it('opens a new thread with start_new_conversation; the first reply starts its session with the briefing', async () => {
        const root = h.message('hand over');
        await h.post(root);
        await eventually(() => h.thread(root.id).includes('Opened a separate thread.'));
        const callerSession = latestSession(h);
        const created = h.claude.createRequests.length;
        const handover = JSON.parse(results.handover?.text ?? '{}');
        const newRoot = h.connector.messages.find((m) => m.activity.text === 'Separate topic: disk usage is growing.');
        assert.ok(newRoot);
        assert.equal(handover.conversation_id, newRoot.id, 'the conversation ID is the root message ID');
        assert.match(handover.url, /^https:\/\/teams\.microsoft\.com\/l\/message\//);
        assert.equal(h.claude.createRequests.length, created, 'no session before a reply');
        const entry = await h.instances[0]?.sb.conversations.get(CHANNEL, newRoot.id);
        assert.equal(entry?.title, 'Disk usage on /data');
        assert.equal(entry?.tags, '["disk"]');

        await h.post(h.message('What do you suggest?', { rootId: newRoot.id }));
        await eventually(() => h.claude.createRequests.length === created + 1);
        const first = h.firstText();
        assert.match(
            first,
            new RegExp(`^\\[switchboard:conversation-start\\] from_session=${callerSession} posted_at=`)
        );
        assert.match(
            first,
            new RegExp(
                `opening post by agent \\(session ${callerSession}\\):\\n {4}Separate topic: disk usage is growing\\.`
            )
        );
        assert.ok(first.includes('    [briefing, not shown in Teams] Volume /data grew 20 % in a day.'));
        assert.match(first, /\[teams\] from="Jane Doe".*\nWhat do you suggest\?$/);
        const newSession = latestSession(h);
        await h.post(h.message('Thanks', { rootId: newRoot.id }));
        await eventually(() => h.claude.userMessages(newSession).some((m) => m.endsWith('Thanks')));
        assert.ok(!h.claude.userMessages(callerSession).some((m) => m.endsWith('Thanks')));
    });

    it('closes cards when the session ends and continues with the thread in a new session', async () => {
        const root = h.message('show a card');
        await h.post(root);
        await eventually(() => h.thread(root.id).includes('Waiting for your decision.'));
        const sessionId = latestSession(h);
        const cardId = JSON.parse(results.show?.text ?? '{}').card_id as string;
        const cardMessage = h.connector.messages.find((m) => JSON.stringify(m.activity).includes(cardId));
        assert.ok(cardMessage);
        h.claude.terminate(sessionId);
        // the platform's webhook wakes Switchboard (the session had no follower: it was idle)
        const body = webhookBody('whe_terminated', 'session.status_terminated', { id: sessionId });
        const delivery = await fetch(`${h.instances[0]?.base}/webhooks/claude`, {
            method: 'POST',
            headers: signWebhook(h.secret, 'whe_terminated', body),
            body,
        });
        assert.equal(delivery.status, 204);
        await eventually(() => h.thread(root.id).includes(endNotice('terminated')), 8000, 'end notice');
        assert.match(JSON.stringify(cardMessage.activity), /Closed – the session ended/);

        const created = h.claude.createRequests.length;
        await h.post(h.message('Are you still there?', { rootId: root.id }));
        await eventually(() => h.claude.createRequests.length === created + 1);
        const request = h.request();
        const first = h.firstText();
        assert.match(
            first,
            new RegExp(`^\\[switchboard:continuation\\] previous_session=${sessionId} reason=terminated at=`)
        );
        assert.match(request.title, / · #2$/);
        // the thread as Teams shows it, annotated: the card as it shows now, its state and the session change
        assert.ok(!first.includes(HISTORY_FILE_PATH));
        assert.match(first, new RegExp(`card by agent \\(session ${sessionId}\\):\\n {4}Restart the worker\\?`));
        assert.ok(first.includes('Closed – the session ended'));
        assert.ok(first.includes(`[card ${cardId}: closed]`));
        assert.ok(first.includes(`session ${sessionId} ended: terminated`));
        assert.ok(first.includes(`note from Switchboard:\n    ${neutralise(endNotice('terminated'))}`));
        assert.match(first, /\[teams\] from="Jane Doe".*\nAre you still there\?$/);
        const history = first.split('\n').slice(1, -2).join('\n');
        assert.ok(!/^\[(teams|switchboard)/m.test(history), 'no header lines inside the history');
    });

    it('mounts a long history as a file and puts the latest entries into the message', async () => {
        const root = h.message(`Long report:\n${'line of the report\n'.repeat(150)}`);
        await h.post(root);
        await eventually(() => h.thread(root.id).some((t) => t.startsWith('Echo:')));
        const sessionId = latestSession(h);
        h.claude.terminate(sessionId);
        await h.instances[0]?.sb.sessions.end(sessionId, 'terminated');
        const created = h.claude.createRequests.length;
        await h.post(h.message('Continue please', { rootId: root.id }));
        await eventually(() => h.claude.createRequests.length === created + 1);
        const request = h.request();
        const first = h.firstText();
        assert.ok(first.includes(`The full history`) && first.includes(HISTORY_FILE_PATH));
        const files = (request.resources ?? []).filter((r) => r.type === 'file');
        assert.deepEqual(
            files.map((r) => r.mount_path),
            [HISTORY_FILE_PATH]
        );
        assert.ok(h.claude.files.has(files[0]?.file_id ?? ''), 'history uploaded');
        assert.equal(CHANNEL.length > 0, true);
    });
});
