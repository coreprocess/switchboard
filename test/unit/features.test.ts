import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import sharp from 'sharp';
import { CHANNEL, eventually, type Harness, startHarness, TEAM, WORKSPACE } from '../helpers/harness.ts';
import type { Turn } from '../helpers/mock-claude.ts';

const latestSession = (h: Harness) => [...h.claude.sessions.keys()].at(-1) ?? '';

describe('features', () => {
    let h: Harness;
    const results: Record<string, { text: string; isError: boolean }> = {};

    before(async () => {
        h = await startHarness({
            history: [
                {
                    at: '2026-10-30T08:00:00Z',
                    name: 'Jane Doe',
                    aad: 'aaaa',
                    text: 'Old question from before the binding',
                    fromApp: false,
                },
                {
                    at: '2026-10-30T08:05:00Z',
                    name: 'Jane Doe',
                    aad: 'aaaa',
                    text: 'The reply being delivered',
                    fromApp: false,
                },
            ],
        });
        await h.bind({ job_deployment: `${WORKSPACE}|depl_job`, job_cron: '0 3 * * *', job_enabled: 'false' });
        h.claude.agent = async (turn: Turn) => {
            const last = turn.text.split('\n').at(-1) ?? '';
            if (turn.text.includes('Run the hourly check.')) {
                results.convert = await turn.callTool('convert_to_conversation', {
                    message: 'Found an anomaly, let us discuss.',
                });
                turn.say('Here are the details of the anomaly.');
                return;
            }
            if (last === 'convert me') {
                results.convertForeground = await turn.callTool('convert_to_conversation', { message: 'x' });
                return;
            }
            if (last === 'delete the temp files') {
                results.confirmation = {
                    text: await turn.askConfirmation('bash', { command: 'rm -rf /tmp/x' }),
                    isError: false,
                };
                turn.say('Deleted.');
                return;
            }
            turn.say(`Echo: ${last}`);
        };
    });

    after(async () => {
        await h.stop();
    });

    it('turns a job session into a conversation with convert_to_conversation', async () => {
        await h.post(h.message('run', { mention: true, from: h.admin }));
        await eventually(() => results.convert !== undefined, 8000, 'convert');
        assert.equal(results.convert?.isError, false);
        const opening = h.connector.messages.find((m) => m.activity.text === 'Found an anomaly, let us discuss.');
        assert.ok(opening);
        await eventually(() => h.thread(opening.id).includes('Here are the details of the anomaly.'));
        const jobSession = latestSession(h);
        await h.post(h.message('Tell me more', { rootId: opening.id }));
        await eventually(() => h.claude.userMessages(jobSession).some((m) => m.endsWith('Tell me more')));
    });

    it('rejects convert_to_conversation in a conversation session', async () => {
        await h.post(h.message('convert me'));
        await eventually(() => results.convertForeground !== undefined);
        assert.equal(results.convertForeground?.isError, true);
        assert.match(results.convertForeground?.text ?? '', /already owns a conversation/);
    });

    it('asks people to confirm a tool set to "always ask"', async () => {
        const root = h.message('delete the temp files');
        await h.post(root);
        const card = await (async () => {
            await eventually(() => h.thread(root.id).some((t) => t.includes('The agent asks to use a tool')));
            return h.connector.messages.find(
                (m) =>
                    JSON.stringify(m.activity).includes('The agent asks to use a tool') &&
                    m.conversationId.endsWith(root.id)
            );
        })();
        assert.ok(card);
        const data = JSON.parse(JSON.stringify(card.activity)).attachments[0].content.actions[0].data;
        const clicked = await h.post(h.click(root.id, card.id, 'switchboard.allow', data, h.admin));
        assert.match(JSON.stringify(clicked.body?.value), /Approved by Ada Admin/);
        await eventually(() => h.thread(root.id).includes('Deleted.'));
        assert.equal(results.confirmation?.text, 'allow');
        const again = await h.post(h.click(root.id, card.id, 'switchboard.deny', data));
        assert.match(JSON.stringify(again.body?.value), /Approved by Ada Admin/, 'decided once');
    });

    it('passes images to the agent and notes unsupported attachments', async () => {
        const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#336699' } })
            .png()
            .toBuffer();
        h.connector.attachments.set('img1', { type: 'image/png', data: png });
        const root = h.message('What is wrong here?', {
            attachments: [
                { contentType: 'text/html', content: '<p>What is wrong here?</p>' },
                { contentType: 'image/*', contentUrl: `${h.connector.url}attachments/img1`, name: 'screenshot.png' },
                { contentType: 'reference', contentUrl: 'https://example.com/report.xlsx', name: 'report.xlsx' },
            ],
        });
        await h.post(root);
        await eventually(() => h.thread(root.id).some((t) => t.startsWith('Echo:')));
        const content = h.firstContent();
        const image = content.find((block) => block.type === 'image');
        assert.equal(image?.source?.type, 'file');
        assert.ok(h.claude.files.has(image?.source?.file_id ?? ''));
        assert.match(content[1]?.text ?? '', /\[attachment not supported\] name=report\.xlsx type=file/);
        assert.ok(h.thread(root.id).some((t) => t.startsWith('ℹ️ Not passed to the agent: report.xlsx')));
    });

    it('reads the history from Teams for a thread Switchboard does not know', async () => {
        await h.post(h.message('The reply being delivered', { rootId: '1793300000000' }));
        await eventually(() => h.thread('1793300000000').some((t) => t.startsWith('Echo:')));
        const first = h.firstText();
        assert.match(first, /^\[switchboard:continuation\] previous_session=none reason=history_from_teams at=/);
        assert.ok(first.includes('Old question from before the binding'));
        assert.match(first, /\[teams\] from="Jane Doe".*\nThe reply being delivered$/);
    });

    it('disconnects: archives the sessions and ignores later messages', async () => {
        const sb = h.instances[0]?.sb;
        assert.ok(sb);
        await h.post(h.message('disconnect', { mention: true, from: h.admin }));
        await eventually(() =>
            h.connector.messages.some((m) => String(m.activity.text).startsWith('🔌 Switchboard is disconnected'))
        );
        assert.equal(await sb.entities.bindings.get(TEAM, CHANNEL), undefined);
        assert.equal((await sb.entities.jobs.list({ partitionKey: CHANNEL })).length, 0);
        const active = await sb.entities.sessions.list({ where: [{ field: 'state', op: 'eq', value: 'active' }] });
        // idle sessions are archived at once; a running one is interrupted and archived later by the reconciler
        assert.ok(active.length <= 1);
        const before = h.claude.createRequests.length;
        await h.post(h.message('anyone?'));
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(h.claude.createRequests.length, before);
    });
});
