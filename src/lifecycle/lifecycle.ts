import { APIError } from '@anthropic-ai/sdk';
import { addDays } from '../core/time.ts';
import { KEPT_RUNS } from '../jobs/jobs.ts';
import { type Conversation, markSeen, type SessionEntry } from '../store/entities.ts';
import type { Switchboard } from '../switchboard.ts';

/** IDs used for deduplication, and tool call results, are kept this long. */
const SHORT_LIVED_DAYS = 7;

/**
 * The daily cleanup (concept: "Lifecycle: archive and delete"). Claude keeps sessions until they are deleted, so
 * Switchboard archives inactive conversations' sessions and, after the retention period, deletes the sessions,
 * the files it uploaded and its own data. Exactly one pod runs it per day (claimed like a job tick).
 */
export class Lifecycle {
    readonly #sb: Switchboard;

    constructor(sb: Switchboard) {
        this.#sb = sb;
    }

    /** Runs the cleanup if no pod has run it today. */
    async daily() {
        const sb = this.#sb;
        const day = sb.now().toISOString().slice(0, 10);
        if (!(await markSeen(sb.entities, 'cleanup', day))) return;
        sb.log.info({ day }, 'daily cleanup');
        await this.run();
    }

    async run() {
        const sb = this.#sb;
        for (const [name, step] of [
            ['archive', () => this.#archiveInactive()],
            ['delete', () => this.#deleteExpired()],
            ['job sessions', () => this.#cleanJobSessions()],
            ['job runs', () => this.#pruneRuns()],
            ['short-lived', () => this.#pruneShortLived()],
        ] as const) {
            try {
                await step();
            } catch (error) {
                sb.log.warn({ err: error, step: name }, 'cleanup step failed');
            }
        }
    }

    /** Conversations without activity for `SESSION_ARCHIVE_AFTER_DAYS`: their idle owning session is archived. */
    async #archiveInactive() {
        const sb = this.#sb;
        const cutoff = addDays(sb.now(), -sb.settings.sessionArchiveAfterDays).toISOString();
        const inactive = await sb.entities.conversations.list({
            where: [
                { field: 'lastActivity', op: 'lt', value: cutoff },
                { field: 'owningSession', op: 'gt', value: '' },
            ],
        });
        for (const { value: conversation } of inactive) {
            await this.#each('archive', conversation.conversationId, async () => {
                const entry = conversation.owningSession
                    ? await sb.sessions.get(conversation.owningSession)
                    : undefined;
                if (entry?.state !== 'active') return;
                const status = await this.#status(entry.workspaceId, entry.sessionId);
                if (status === 'gone') {
                    await sb.sessions.end(entry.sessionId, 'deleted');
                    return;
                }
                if (status !== 'idle') return;
                await sb.sessions.archive(entry, 'inactive');
                sb.log.info({ sessionId: entry.sessionId }, 'inactive session archived');
            });
        }
    }

    /** One item of a cleanup step; a failure is logged and the step goes on with the next item. */
    async #each(step: string, id: string, work: () => Promise<void>) {
        try {
            await work();
        } catch (error) {
            this.#sb.log.warn({ err: error, step, id }, 'cleanup item failed');
        }
    }

    /** The session's status in Claude; `gone` when it was deleted. */
    async #status(workspaceId: string, sessionId: string): Promise<string> {
        if (!this.#sb.workspaces.has(workspaceId)) return 'gone';
        try {
            return (await this.#sb.workspaces.get(workspaceId).retrieveSession(sessionId)).status;
        } catch (error) {
            if (error instanceof APIError && error.status === 404) return 'gone';
            throw error;
        }
    }

    /** Conversations without activity for `CONVERSATION_RETENTION_DAYS`: everything about them is deleted. */
    async #deleteExpired() {
        const sb = this.#sb;
        const cutoff = addDays(sb.now(), -sb.settings.conversationRetentionDays).toISOString();
        const expired = await sb.entities.conversations.list({
            where: [{ field: 'lastActivity', op: 'lt', value: cutoff }],
        });
        for (const { value: conversation } of expired) {
            await this.#each('delete', conversation.conversationId, () => this.#deleteConversation(conversation));
        }
    }

    async #deleteConversation(conversation: Conversation) {
        const sb = this.#sb;
        const api = sb.workspaces.has(conversation.workspaceId)
            ? sb.workspaces.get(conversation.workspaceId)
            : undefined;
        const sessions = await sb.entities.sessions.list({
            where: [
                { field: 'channelId', op: 'eq', value: conversation.channelId },
                { field: 'rootId', op: 'eq', value: conversation.rootId },
            ],
        });
        let remaining = 0;
        for (const { value: session } of sessions) {
            if (session.state === 'active') {
                const status = await this.#status(session.workspaceId, session.sessionId);
                const archived = status === 'gone' || (await sb.sessions.archive(session, 'retention'));
                if (!archived) {
                    // running: it is interrupted now and archived when idle; deleted on the next run
                    remaining++;
                    continue;
                }
            }
            await api?.deleteSession(session.sessionId);
            await sb.entities.sessions.delete(session.sessionId);
            await this.#deleteToolCalls(session.sessionId);
        }
        // the conversation goes only once all its sessions are gone, so nothing with Teams content stays behind
        if (remaining > 0) return;
        for (const { value: file } of await sb.entities.files.list({ partitionKey: conversation.conversationId })) {
            await api?.deleteFile(file.fileId);
            await sb.entities.files.delete(file.owner, file.fileId);
        }
        for (const { value: entry } of await sb.entities.logs.list({ partitionKey: conversation.conversationId })) {
            await sb.entities.logs.delete(entry.conversationId, entry.entryKey);
        }
        const cards = await sb.entities.cards.list({
            where: [{ field: 'conversationId', op: 'eq', value: conversation.conversationId }],
        });
        for (const { value: card } of cards) await sb.entities.cards.delete(card.cardId);
        await sb.entities.conversations.delete(conversation.channelId, conversation.rootId);
        sb.log.info({ conversationId: conversation.conversationId, sessions: sessions.length }, 'conversation deleted');
    }

    /**
     * Job sessions that never became conversations: archived once their run ended (normally at once), deleted
     * `CONVERSATION_RETENTION_DAYS` after the run.
     */
    async #cleanJobSessions() {
        const sb = this.#sb;
        const cutoff = addDays(sb.now(), -sb.settings.conversationRetentionDays).toISOString();
        const jobSessions = await sb.entities.sessions.list({ where: [{ field: 'kind', op: 'eq', value: 'job' }] });
        for (const { value: session } of jobSessions) {
            await this.#each('job sessions', session.sessionId, () => this.#cleanJobSession(session, cutoff));
        }
    }

    async #cleanJobSession(session: SessionEntry, cutoff: string) {
        const sb = this.#sb;
        if (session.rootId) return;
        const run =
            session.jobId && session.runKey
                ? (await sb.entities.jobRuns.get(session.jobId, session.runKey))?.value
                : undefined;
        if (session.state === 'active' && run?.status !== 'running') {
            await sb.sessions.archive(session, 'job_done').catch(() => false);
            return;
        }
        const endedAt = run?.endedAt ?? session.lastActivity;
        if (session.state === 'active' || endedAt >= cutoff) return;
        if (sb.workspaces.has(session.workspaceId)) {
            await sb.workspaces.get(session.workspaceId).deleteSession(session.sessionId);
        }
        for (const { value: file } of await sb.entities.files.list({
            partitionKey: `session:${session.sessionId}`,
        })) {
            if (sb.workspaces.has(file.workspaceId)) await sb.workspaces.get(file.workspaceId).deleteFile(file.fileId);
            await sb.entities.files.delete(file.owner, file.fileId);
        }
        await sb.entities.sessions.delete(session.sessionId);
        await this.#deleteToolCalls(session.sessionId);
        sb.log.info({ sessionId: session.sessionId }, 'job session deleted');
    }

    async #deleteToolCalls(sessionId: string) {
        for (const { value: call } of await this.#sb.entities.toolCalls.list({ partitionKey: sessionId })) {
            await this.#sb.entities.toolCalls.delete(call.sessionId, call.eventId);
        }
    }

    /** The latest `KEPT_RUNS` runs per job are kept. */
    async #pruneRuns() {
        const sb = this.#sb;
        const byJob = new Map<string, { jobId: string; runKey: string; startedAt: string }[]>();
        for (const { value: run } of await sb.entities.jobRuns.list()) {
            byJob.set(run.jobId, [...(byJob.get(run.jobId) ?? []), run]);
        }
        for (const runs of byJob.values()) {
            const old = runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(KEPT_RUNS);
            for (const run of old) await sb.entities.jobRuns.delete(run.jobId, run.runKey);
        }
    }

    async #pruneShortLived() {
        const sb = this.#sb;
        const cutoff = addDays(sb.now(), -SHORT_LIVED_DAYS).toISOString();
        for (const { value: seen } of await sb.entities.seen.list({
            where: [{ field: 'at', op: 'lt', value: cutoff }],
        })) {
            await sb.entities.seen.delete(seen.kind, seen.id);
        }
        const calls = await sb.entities.toolCalls.list({ where: [{ field: 'startedAt', op: 'lt', value: cutoff }] });
        for (const { value: call } of calls) await sb.entities.toolCalls.delete(call.sessionId, call.eventId);
    }
}
