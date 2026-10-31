import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
    CHANNEL,
    eventually,
    type Harness,
    OTHER_CHANNEL,
    sleep,
    startHarness,
    TEAM,
    WORKSPACE,
} from '../helpers/harness.ts';
import type { Turn } from '../helpers/mock-claude.ts';

type Result = { text: string; isError: boolean };
type Json = Record<string, unknown>;

const json = (result: Result | undefined): Json => JSON.parse(result?.text ?? '{}');
const rootOf = (h: Harness, text: string) => h.connector.posts.find((p) => p.activity.text === text)?.id ?? '';

describe('conversation tools', () => {
    let h: Harness;
    const results: Record<string, Result> = {};
    /** What the agent does when the last line of its input matches. */
    const scripts: [RegExp, (turn: Turn, match: RegExpExecArray) => Promise<void>][] = [];
    let jobPlan: ((turn: Turn) => Promise<void>) | undefined;
    const script = (pattern: RegExp, run: (turn: Turn, match: RegExpExecArray) => Promise<void>) =>
        scripts.push([pattern, run]);
    const sessionOf = async (rootId: string) =>
        (await h.instances[0]?.sb.conversations.get(CHANNEL, rootId))?.owningSession ?? '';

    before(async () => {
        h = await startHarness({ loops: true });
        await h.bind({ job_deployment: `${WORKSPACE}|depl_job`, job_cron: '0 3 * * *', job_enabled: 'false' });
        h.claude.agent = async (turn: Turn) => {
            if (turn.text.includes('Run the hourly check.') && jobPlan) return jobPlan(turn);
            const last = turn.text.split('\n').at(-1) ?? '';
            for (const [pattern, run] of scripts) {
                const match = pattern.exec(last);
                if (match) return run(turn, match);
            }
            turn.say(`Echo: ${last}`);
        };
        script(/^describe me$/, async (turn) => {
            results.describe = await turn.callTool('describe_conversation', {
                title: 'Payment import failing',
                summary: 'Imports fail since 10:00.',
                tags: ['INC-1', 'import'],
            });
            turn.say('Described.');
        });
        script(/^(list|read|send|wait)(?: (\S+))?(?: (.+))?$/, async (turn, [, tool, id, rest]) => {
            const key = `${tool}:${id ?? ''}:${rest ?? ''}`;
            if (tool === 'list') results[key] = await turn.callTool('list_conversations', JSON.parse(id ?? '{}'));
            if (tool === 'read') {
                results[key] = await turn.callTool('read_conversation', {
                    conversation_id: id,
                    ...(rest ? { cursor: rest } : {}),
                });
            }
            if (tool === 'send') {
                results[key] = await turn.callTool('send_to_conversation', { conversation_id: id, message: rest });
            }
            if (tool === 'wait') results[key] = await turn.callTool('wait', JSON.parse(id ?? '{}'));
            turn.say(`Done: ${tool}`);
        });
    });

    after(async () => {
        await h.stop();
    });

    it('lists the channel’s threads from Teams, joined with descriptions, and filters them', async () => {
        const since = new Date(Date.now() - 1_000).toISOString();
        const legacy = h.message('Legacy incident notes');
        h.connector.human({ ...legacy, timestamp: '2026-10-01T08:00:00.000Z' });
        const described = h.message('describe me');
        await h.post(described);
        await eventually(() => h.thread(described.id).includes('Described.'));
        assert.equal(results.describe?.isError, false);
        assert.deepEqual(json(results.describe).tags, ['INC-1', 'import']);
        const plain = h.message('plain thread');
        await h.post(plain);
        await eventually(() => h.thread(plain.id).includes('Echo: plain thread'));

        const lister = h.message('list');
        await h.post(lister);
        await eventually(() => h.thread(lister.id).includes('Done: list'));
        const all = json(results['list::']).conversations as Json[];
        const byId = new Map(all.map((c) => [c.conversation_id, c]));
        assert.equal(all[0]?.conversation_id, lister.id, 'latest activity first');
        assert.equal(byId.get(lister.id)?.own, true);
        assert.deepEqual(byId.get(described.id), {
            ...byId.get(described.id),
            title: 'Payment import failing',
            summary: 'Imports fail since 10:00.',
            tags: ['INC-1', 'import'],
            opening_post: 'describe me',
            has_active_session: true,
        });
        assert.equal(byId.get(plain.id)?.title, 'plain thread');
        assert.equal(byId.get(legacy.id)?.title, 'Legacy incident notes');
        assert.equal(byId.get(legacy.id)?.has_active_session, false);
        assert.match(String(byId.get(legacy.id)?.url), /^https:\/\/teams\.microsoft\.com\/l\/message\//);

        for (const [filter, expected] of [
            [{ tags: ['inc-1'] }, [described.id]],
            [{ active_only: true }, [lister.id, plain.id, described.id]],
            [{ activity_since: since }, [lister.id, plain.id, described.id]],
        ] as const) {
            const asked = h.message(`list ${JSON.stringify(filter)}`);
            await h.post(asked);
            await eventually(() => h.thread(asked.id).includes('Done: list'));
            const known = [lister.id, plain.id, described.id, legacy.id];
            const found = (json(results[`list:${JSON.stringify(filter)}:`]).conversations as Json[])
                .map((c) => c.conversation_id)
                .filter((id) => known.includes(String(id)));
            assert.deepEqual(found, expected, JSON.stringify(filter));
        }
    });

    it('reads a thread as people see it, annotated and paged, newest first', async () => {
        const root = h.message('Many replies');
        h.connector.human(root);
        for (let index = 1; index <= 40; index++) {
            h.connector.human(h.message(`reply ${index}`, { rootId: root.id }));
        }
        const described = rootOf(h, 'describe me');
        const reader = h.message(`read ${described}`);
        await h.post(reader);
        await eventually(() => h.thread(reader.id).includes('Done: read'));
        const read = json(results[`read:${described}:`]);
        const entries = read.entries as Json[];
        assert.equal(read.cursor, undefined);
        assert.deepEqual(entries.map((e) => e.kind).sort(), ['answer', 'message', 'session-change']);
        const sessionId = await sessionOf(described);
        const answer = entries.find((e) => e.kind === 'answer');
        assert.deepEqual(answer, {
            message_id: answer?.message_id,
            at: answer?.at,
            kind: 'answer',
            from: 'agent',
            session: sessionId,
            text: 'Described.',
        });
        assert.deepEqual(entries.at(-1), { ...entries.at(-1), kind: 'message', from: 'Jane Doe', text: 'describe me' });

        const pager = h.message(`read ${root.id}`);
        await h.post(pager);
        await eventually(() => h.thread(pager.id).includes('Done: read'));
        const first = json(results[`read:${root.id}:`]);
        assert.equal((first.entries as Json[]).length, 30);
        assert.equal((first.entries as Json[])[0]?.text, 'reply 40');
        const next = h.message(`read ${root.id} ${String(first.cursor)}`);
        await h.post(next);
        await eventually(() => h.thread(next.id).includes('Done: read'));
        const second = json(results[`read:${root.id}:${String(first.cursor)}`]);
        const rest = (second.entries as Json[]).map((e) => e.text);
        assert.equal(rest.length, 11);
        assert.equal(rest.at(-1), 'Many replies');
        assert.equal(second.cursor, undefined);
    });

    it('annotates cards with their state and last click', async () => {
        script(/^card please$/, async (turn) => {
            const shown = await turn.callTool('show_card', {
                card: {
                    type: 'AdaptiveCard',
                    version: '1.5',
                    body: [{ type: 'TextBlock', text: 'Roll back?' }],
                    actions: [{ type: 'Action.Execute', title: 'Yes', verb: 'rollback', data: { to: 41 } }],
                },
            });
            results.card = shown;
            turn.say('Card shown.');
        });
        const root = h.message('card please');
        await h.post(root);
        await eventually(() => h.thread(root.id).includes('Card shown.'));
        const cardId = String(json(results.card).card_id);
        const posted = h.connector.messages.find((m) => JSON.stringify(m.activity).includes(cardId));
        assert.ok(posted);
        await h.post(h.click(root.id, posted.id, 'rollback', { to: 41, switchboard_card: cardId }));
        const reader = h.message(`read ${root.id}`);
        await h.post(reader);
        await eventually(() => h.thread(reader.id).includes('Done: read'));
        const card = (json(results[`read:${root.id}:`]).entries as Json[]).find((e) => e.kind === 'card');
        assert.equal(card?.text, 'Roll back?');
        const annotation = card?.card as Json;
        assert.equal(annotation.card_id, cardId);
        assert.equal(annotation.state, 'locked');
        const click = annotation.last_click as Json;
        assert.equal(click.verb, 'rollback');
        assert.equal(click.by, 'Jane Doe');
        assert.match(String(click.data), /"to": 41/);
    });

    it('lets a job find a thread by tag and send to it; the owning session answers there', async () => {
        const target = rootOf(h, 'describe me');
        const owner = await sessionOf(target);
        const before = (await h.instances[0]?.sb.conversations.get(CHANNEL, target))?.lastActivity ?? '';
        jobPlan = async (turn) => {
            results.jobDescribe = await turn.callTool('describe_conversation', { title: 'x' });
            const listed = await turn.callTool('list_conversations', { tags: ['INC-1'] });
            const [first] = json(listed).conversations as Json[];
            results.jobSend = await turn.callTool('send_to_conversation', {
                conversation_id: first?.conversation_id,
                message: 'Deployment 42 was rolled back.',
            });
            turn.say('Job done.');
        };
        await h.post(h.message('run', { mention: true, from: h.admin }));
        await eventually(() => results.jobSend !== undefined, 8000, 'job sent');
        jobPlan = undefined;
        assert.equal(results.jobDescribe?.isError, true);
        assert.match(results.jobDescribe?.text ?? '', /no conversation to describe/);
        assert.equal(json(results.jobSend).conversation_id, target);
        assert.equal(json(results.jobSend).delivered, true);
        assert.match(String(json(results.jobSend).url), /^https:\/\/teams\.microsoft\.com\//);
        assert.ok(
            h.thread(target).includes('🔁 **From a job of this channel:**\n\nDeployment 42 was rolled back.'),
            'visible note'
        );
        await eventually(() => h.thread(target).includes('Echo: Deployment 42 was rolled back.'), 8000, 'answer');
        const received = h.claude.userMessages(owner).at(-1) ?? '';
        assert.match(
            received,
            /^\[switchboard:session-message\] from_session=sesn_\w+ from_kind=job from_conversation=none at=\S+\nDeployment 42 was rolled back\.$/
        );
        const after = (await h.instances[0]?.sb.conversations.get(CHANNEL, target))?.lastActivity ?? '';
        assert.ok(after > before, 'a delivered session message counts as activity');
    });

    it('starts a continuation when the target thread has no active session', async () => {
        const sb = h.instances[0]?.sb;
        assert.ok(sb);
        const target = rootOf(h, 'plain thread');
        const previous = await sessionOf(target);
        h.claude.terminate(previous);
        await sb.sessions.end(previous, 'terminated');
        const sender = h.message(`send ${target} Please check the import again.`);
        const created = h.claude.createRequests.length;
        await h.post(sender);
        await eventually(() => h.thread(sender.id).includes('Done: send'));
        await eventually(() => h.claude.createRequests.length === created + 2, 8000, 'target session created');
        assert.equal(results[`send:${target}:Please check the import again.`]?.isError, false);
        assert.ok(
            h
                .thread(target)
                .includes(
                    `🔁 **From send ${target} Please check the import again.:**\n\nPlease check the import again.`
                )
        );
        const first = h.firstText();
        assert.match(
            first,
            new RegExp(`^\\[switchboard:continuation\\] previous_session=${previous} reason=terminated`)
        );
        assert.match(first, /person "Jane Doe" .*wrote:\n {4}plain thread/);
        assert.match(
            first,
            new RegExp(
                `\\n\\[switchboard:session-message\\] from_session=\\S+ from_kind=conversation from_conversation=${sender.id} at=\\S+\\nPlease check the import again\\.$`
            )
        );
        assert.equal(first.split('Please check the import again.').length, 2, 'the message only once');
    });

    it('gives an old thread Switchboard never saw an entry and a session', async () => {
        const legacy = rootOf(h, 'Legacy incident notes');
        assert.equal(await h.instances[0]?.sb.conversations.get(CHANNEL, legacy), undefined);
        const sender = h.message(`send ${legacy} Is this still relevant?`);
        const created = h.claude.createRequests.length;
        await h.post(sender);
        await eventually(() => h.claude.createRequests.length === created + 2, 8000, 'target session created');
        assert.ok(await sessionOf(legacy));
        const first = h.firstText();
        assert.match(first, /^\[switchboard:continuation\] previous_session=none reason=first_session/);
        assert.match(first, /2026-10-01T08:00:00.000Z · person "Jane Doe" .*\n {4}Legacy incident notes/);
    });

    it('rejects sending into the own conversation, another channel or an unknown thread', async () => {
        const elsewhere = h.message('In another channel', { channel: OTHER_CHANNEL });
        h.connector.human(elsewhere);
        const placeholder = h.message('placeholder');
        const own = { ...placeholder, text: `send ${placeholder.id} hello` };
        for (const [target, expected] of [
            [own.id, /own conversation/],
            [elsewhere.id, /is not a conversation of your channel/],
            ['1234', /is not a conversation of your channel/],
        ] as const) {
            const asked = target === own.id ? own : h.message(`send ${target} hello`);
            await h.post(asked);
            await eventually(() => h.thread(asked.id).includes('Done: send'));
            const result = results[`send:${target}:hello`];
            assert.equal(result?.isError, true, target);
            assert.match(result?.text ?? '', expected);
        }
        assert.equal(TEAM.length > 0, true);
    });

    it('waits until the deadline, a message in a watched thread, or something for itself', async () => {
        const sb = h.instances[0]?.sb;
        assert.ok(sb);
        const started = Date.now();
        const timeout = h.message('wait {"minutes":0.01}');
        await h.post(timeout);
        await eventually(() => h.thread(timeout.id).includes('Done: wait'));
        assert.deepEqual(json(results['wait:{"minutes":0.01}:']), { reason: 'timeout' });
        assert.ok(Date.now() - started >= 500);

        const watched = rootOf(h, 'describe me');
        const watcher = h.message(`wait {"minutes":1,"conversation_id":"${watched}"}`);
        await h.post(watcher);
        const watcherSession = async () => sessionOf(watcher.id);
        await eventually(
            async () => {
                const entry = await sb.sessions.get(await watcherSession());
                return entry?.relayOwner === undefined && entry?.workingMessageId !== undefined;
            },
            8000,
            'waiting without a lease'
        );
        await h.post(h.message('A new finding', { rootId: watched }));
        await eventually(() => h.thread(watcher.id).includes('Done: wait'), 8000, 'wait ended by the message');
        const ended = json(results[`wait:{"minutes":1,"conversation_id":"${watched}"}:`]);
        assert.equal(ended.reason, 'conversation_message');
        assert.equal(ended.conversation_id, watched);
        assert.deepEqual(ended.message, { ...(ended.message as Json), from: 'Jane Doe', text: 'A new finding' });

        const capped = h.message('wait {"minutes":60}');
        await h.post(capped);
        const cappedSession = async () => sessionOf(capped.id);
        await eventually(async () => {
            const calls = await sb.entities.toolCalls.list({ partitionKey: await cappedSession() });
            return calls.some((call) => call.value.status === 'waiting');
        });
        const waiting = (await sb.entities.toolCalls.list({ partitionKey: await cappedSession() })).find(
            (call) => call.value.status === 'waiting'
        );
        const until = Date.parse(waiting?.value.waitUntil ?? '');
        assert.ok(until - Date.now() <= 5 * 60_000 && until - Date.now() > 4 * 60_000, 'capped at 5 minutes');
        await h.post(h.message('Are you there?', { rootId: capped.id }));
        await eventually(() => h.thread(capped.id).includes('Echo: Are you there?'), 8000, 'reply handled');
        assert.deepEqual(json(results['wait:{"minutes":60}:']), { reason: 'own_message' });

        const ownRoot = h.message('placeholder');
        const self = { ...ownRoot, text: `wait {"minutes":1,"conversation_id":"${ownRoot.id}"}` };
        await h.post(self);
        await eventually(() => h.thread(self.id).includes('Done: wait'));
        assert.match(results[`wait:{"minutes":1,"conversation_id":"${self.id}"}:`]?.text ?? '', /own conversation/);
        await sleep(50);
    });

    it('ends a wait at once when input arrived after the call but before the wait was stored', async () => {
        const sb = h.instances[0]?.sb;
        assert.ok(sb);
        const root = h.message('race');
        await h.post(root);
        await eventually(() => h.thread(root.id).includes('Echo: race'));
        const sessionId = await sessionOf(root.id);
        const event = h.claude.emit(sessionId, { type: 'agent.custom_tool_use', name: 'wait', input: { minutes: 1 } });
        const calledAt = String(event.processed_at);
        await sb.sessions.modify(sessionId, (current) => ({
            ...current,
            lastInputAt: new Date(Date.parse(calledAt) + 1_000).toISOString(),
        }));
        const state = await sb.tools.handle(sessionId, {
            ...event,
            type: 'agent.custom_tool_use' as const,
            id: String(event.id),
            name: 'wait',
            input: { minutes: 1 },
            processed_at: calledAt,
        });
        assert.equal(state, 'waiting');
        const stored = await sb.entities.toolCalls.get(sessionId, String(event.id));
        assert.equal(stored?.value.status, 'done');
        assert.deepEqual(JSON.parse(stored?.value.result ?? '{}'), { reason: 'own_message' });
    });

    it('works without Graph: continuations start without history, the tools report an error', async () => {
        const sb = h.instances[0]?.sb;
        assert.ok(sb);
        const target = rootOf(h, 'describe me');
        const previous = await sessionOf(target);
        h.claude.terminate(previous);
        await sb.sessions.end(previous, 'terminated');
        h.connector.graphDown = true;
        try {
            const created = h.claude.createRequests.length;
            await h.post(h.message('Still failing?', { rootId: target }));
            await eventually(() => h.claude.createRequests.length === created + 1);
            const first = h.firstText();
            assert.match(first, /^\[switchboard:continuation\] previous_session=\S+ reason=terminated/);
            assert.ok(first.includes('The earlier messages of this thread could not be read.'));
            await eventually(() =>
                h.thread(target).some((t) => t.includes('could not be read; the agent starts without'))
            );

            const lister = h.message('list');
            await h.post(lister);
            await eventually(() => h.thread(lister.id).includes('Done: list'));
            assert.equal(results['list::']?.isError, true);
            assert.match(results['list::']?.text ?? '', /list_conversations failed: Graph: HTTP 503/);
        } finally {
            h.connector.graphDown = false;
        }
    });
});
