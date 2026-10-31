import { Cron } from 'croner';
import { clip, clipBytes, jobFailedHeader } from '../core/text.ts';
import { formatLocal } from '../core/time.ts';
import type { Binding, Job, JobRun, SessionEntry } from '../store/entities.ts';
import type { Switchboard } from '../switchboard.ts';

/** Kept per job; older runs are deleted by the daily cleanup. */
export const KEPT_RUNS = 200;
const FINAL_MESSAGE_BYTES = 2048;

/** Why a run failed, as people read it. */
const FAILURE_REASONS: Record<string, string> = {
    timeout: 'it ran longer than its maximum run time',
    budget_reached: 'it reached its budget',
    terminated: 'its session was terminated',
    deleted: 'its session was deleted',
    retries_exhausted: 'its turn failed after several retries',
    refusal: 'the agent declined to continue',
    needs_confirmation: 'it needs a confirmation',
};

export const isValidCron = (expression: string, timezone: string): boolean => {
    try {
        new Cron(expression, { timezone, paused: true });
        return expression.trim().split(/\s+/).length === 5;
    } catch {
        return false;
    }
};

export const nextRun = (job: Pick<Job, 'cron' | 'timezone'>, after: Date): Date | undefined =>
    new Cron(job.cron, { timezone: job.timezone, paused: true }).nextRun(after) ?? undefined;

/**
 * Jobs (concept: "Jobs"): every pod runs the timer; each tick is claimed by inserting its run entry, so exactly
 * one pod starts it. One run per job is active at a time (conditional write on the job's `activeRun`). Ticks
 * missed while no pod ran are not caught up.
 */
export class Jobs {
    readonly #sb: Switchboard;
    readonly #lastCheck = new Map<string, Date>();
    #timer: ReturnType<typeof setInterval> | undefined;

    constructor(sb: Switchboard) {
        this.#sb = sb;
    }

    start() {
        this.#timer = setInterval(() => void this.tick(), this.#sb.timing.schedulerMs);
        this.#timer.unref();
    }

    stop() {
        if (this.#timer) clearInterval(this.#timer);
    }

    /** Starts the runs of ticks since the last check, and stops runs over their maximum run time. */
    async tick() {
        const sb = this.#sb;
        const now = sb.now();
        try {
            for (const { value: job } of await sb.entities.jobs.list()) {
                const key = `${job.channelId}/${job.jobId}`;
                const last = this.#lastCheck.get(key);
                this.#lastCheck.set(key, now);
                if (!last || !job.enabled) continue;
                let due = nextRun(job, last);
                while (due && due <= now) {
                    await this.#claim(job, due.toISOString(), 'schedule');
                    due = nextRun(job, due);
                }
            }
            await this.#timeouts(now);
        } catch (error) {
            sb.log.warn({ err: error }, 'job tick failed');
        }
    }

    /** The `run` command: a run now, under the same one-at-a-time rule. */
    async runNow(job: Job): Promise<JobRun | undefined> {
        return this.#claim(job, `manual-${this.#sb.now().toISOString()}`, 'manual');
    }

    async #claim(job: Job, runKey: string, trigger: 'schedule' | 'manual'): Promise<JobRun | undefined> {
        const sb = this.#sb;
        const now = sb.now().toISOString();
        const run: JobRun = {
            jobId: job.jobId,
            runKey,
            channelId: job.channelId,
            teamId: job.teamId,
            status: 'running',
            startedAt: now,
        };
        const inserted = await sb.entities.jobRuns.insert(run);
        if (!inserted) return undefined;
        if (!(await this.#activate(job, runKey))) {
            await sb.entities.jobRuns.upsert({
                ...run,
                status: 'skipped',
                reason: 'previous run active',
                endedAt: now,
            });
            sb.log.info({ jobId: job.jobId, runKey }, 'job tick skipped: previous run active');
            return { ...run, status: 'skipped' };
        }
        sb.log.info({ jobId: job.jobId, runKey, trigger }, 'job run starting');
        const binding = (await sb.entities.bindings.get(job.teamId, job.channelId))?.value;
        try {
            if (!binding) throw new Error('the channel is not connected');
            const entry = await sb.sessions.create({
                binding,
                kind: 'job',
                deploymentId: job.deploymentId,
                jobId: job.jobId,
                runKey,
                seq: 1,
                titleTime: sb.now(),
            });
            // only while it still runs: a very fast run may have ended already
            await sb.entities.jobRuns.modify(job.jobId, runKey, (current) => ({
                ...current,
                sessionId: entry.sessionId,
            }));
            return { ...run, sessionId: entry.sessionId };
        } catch (error) {
            const reason = error instanceof Error ? clip(error.message, 300) : 'unknown error';
            sb.log.warn({ err: error, jobId: job.jobId, runKey }, 'job session not created');
            await this.#finish(job.channelId, job.jobId, runKey, 'failed', `session not created: ${reason}`);
            if (binding) {
                await sb.gateway
                    .postThread(
                        { teamId: binding.teamId, channelId: binding.channelId },
                        { text: `⚠️ A job run could not start (${formatLocal(sb.now(), job.timezone)}): ${reason}` }
                    )
                    .catch(() => undefined);
            }
            return { ...run, status: 'failed', reason };
        }
    }

    /** Sets the job's active run, unless another run is still active (a stale entry is cleared). */
    async #activate(job: Job, runKey: string): Promise<boolean> {
        const sb = this.#sb;
        for (let attempt = 0; attempt < 5; attempt++) {
            const stored = await sb.entities.jobs.get(job.channelId, job.jobId);
            if (!stored) return false;
            const active = stored.value.activeRun;
            if (active && (await this.#stillActive(job.jobId, active))) return false;
            if (await sb.entities.jobs.update(stored, { ...stored.value, activeRun: runKey })) return true;
        }
        return false;
    }

    async #stillActive(jobId: string, runKey: string): Promise<boolean> {
        const run = (await this.#sb.entities.jobRuns.get(jobId, runKey))?.value;
        if (!run || run.status !== 'running') return false;
        if (!run.sessionId) return Date.parse(run.startedAt) > this.#sb.now().getTime() - 5 * 60 * 1000;
        const session = await this.#sb.sessions.get(run.sessionId);
        return session?.state === 'active';
    }

    /** Ends a run (if it is still running) and clears the job's active run. */
    async #finish(
        channelId: string,
        jobId: string,
        runKey: string,
        status: JobRun['status'],
        reason?: string,
        finalMessage?: string
    ): Promise<boolean> {
        const sb = this.#sb;
        let finished = false;
        await sb.entities.jobRuns.modify(jobId, runKey, (current) => {
            if (current.status !== 'running') return undefined;
            finished = true;
            return {
                ...current,
                status,
                endedAt: sb.now().toISOString(),
                ...(reason ? { reason } : {}),
                ...(finalMessage ? { finalMessage: clipBytes(finalMessage, FINAL_MESSAGE_BYTES) } : {}),
            };
        });
        await sb.entities.jobs.modify(channelId, jobId, (current) =>
            current.activeRun === runKey ? { ...current, activeRun: undefined } : undefined
        );
        return finished;
    }

    async markConverted(jobId: string, runKey: string) {
        await this.#sb.entities.jobRuns.modify(jobId, runKey, (current) => ({ ...current, converted: true }));
    }

    /** The job session ended its turn: the run succeeded; a background session is archived at once. */
    async turnEnded(entry: SessionEntry, finalText: string) {
        const sb = this.#sb;
        if (!entry.jobId || !entry.runKey) return;
        const finished = await this.#finish(
            entry.channelId,
            entry.jobId,
            entry.runKey,
            'succeeded',
            undefined,
            finalText
        );
        if (!finished || entry.rootId) return;
        sb.log.info({ sessionId: entry.sessionId, jobId: entry.jobId }, 'job run succeeded');
        await sb.sessions.archive(entry, 'job_done').catch((error: unknown) => {
            sb.log.warn({ err: error, sessionId: entry.sessionId }, 'job session not archived');
        });
    }

    /** The job session's turn failed (retries exhausted, refusal): the run failed; the session moves to a thread. */
    async turnFailed(entry: SessionEntry, reason: string) {
        if (!entry.jobId || !entry.runKey) return;
        const finished = await this.#finish(entry.channelId, entry.jobId, entry.runKey, 'failed', reason);
        if (finished) await this.moveToThread(entry, reason, true);
    }

    /** The job session ended (terminated, budget): the run failed; the thread gets the note, without an owner. */
    async sessionEnded(entry: SessionEntry, reason: string) {
        if (!entry.jobId || !entry.runKey) return;
        const finished = await this.#finish(entry.channelId, entry.jobId, entry.runKey, 'failed', reason);
        if (finished && !entry.rootId) await this.moveToThread(entry, reason, false);
    }

    /**
     * Opens a thread with a failure note for a job session. If the session can still take messages it becomes the
     * thread's owner (and, with `tell`, receives the `[switchboard:job-failed]` message); otherwise the next reply
     * starts a continuation. Returns the updated session entry.
     */
    async moveToThread(entry: SessionEntry, reason: string, tell = false): Promise<SessionEntry | undefined> {
        const sb = this.#sb;
        if (entry.rootId) return entry;
        const binding = (await sb.entities.bindings.get(entry.teamId, entry.channelId))?.value;
        if (!binding) return undefined;
        const usable = entry.state === 'active';
        const run =
            entry.jobId && entry.runKey ? (await sb.entities.jobRuns.get(entry.jobId, entry.runKey))?.value : undefined;
        const note = this.#failureNote(binding, entry, run, reason);
        const { conversation } = await sb.conversations.createThread({
            binding,
            text: note,
            origin: 'job_failure',
            ...(usable ? { owningSession: entry.sessionId } : {}),
        });
        if (!usable) {
            await sb.entities.conversations.modify(conversation.channelId, conversation.rootId, (current) => ({
                ...current,
                previousSession: entry.sessionId,
                previousReason: reason,
            }));
            return undefined;
        }
        const moved = await sb.sessions.modify(entry.sessionId, (current) => ({
            ...current,
            rootId: conversation.rootId,
        }));
        if (entry.jobId && entry.runKey) await this.markConverted(entry.jobId, entry.runKey);
        if (moved && tell) {
            const text = `${jobFailedHeader(reason, sb.now())}\nYou are now in a conversation in the channel; your final answer will be posted there.`;
            await sb.sessions.send(moved.value, [{ type: 'text', text }]).catch((error: unknown) => {
                sb.log.warn({ err: error, sessionId: entry.sessionId }, 'job failure message not sent');
            });
        }
        return moved?.value;
    }

    #failureNote(binding: Binding, entry: SessionEntry, run: JobRun | undefined, reason: string) {
        const zone = this.#sb.settings.defaultTimezone;
        const started = run ? formatLocal(new Date(run.startedAt), zone) : 'unknown';
        const what = reason === 'needs_confirmation' ? 'A job run needs a confirmation' : 'A job run failed';
        return (
            `⚠️ **${what}** in ${binding.channelName}: started ${started}, ` +
            `${FAILURE_REASONS[reason] ?? reason}. Session \`${entry.sessionId}\`. Reply in this thread to follow up.`
        );
    }

    /** Runs over their maximum run time are interrupted and fail with `timeout`; the session moves to a thread. */
    async #timeouts(now: Date) {
        const sb = this.#sb;
        const running = await sb.entities.jobRuns.list({ where: [{ field: 'status', op: 'eq', value: 'running' }] });
        for (const { value: run } of running) {
            const job = (await sb.entities.jobs.get(run.channelId, run.jobId))?.value;
            const maxMs = (job?.maxRuntimeMin ?? sb.settings.defaultJobMaxRuntimeMin) * 60_000;
            if (Date.parse(run.startedAt) + maxMs > now.getTime()) continue;
            if (!(await this.#finish(run.channelId, run.jobId, run.runKey, 'failed', 'timeout'))) continue;
            const entry = run.sessionId ? await sb.sessions.get(run.sessionId) : undefined;
            if (!entry) continue;
            sb.log.info({ sessionId: entry.sessionId, jobId: run.jobId }, 'job run timed out');
            if (entry.state === 'active') await sb.sessions.interrupt(entry, 'timeout');
            await this.moveToThread(entry, 'timeout', entry.state === 'active');
            // it is a conversation now; a later end gets its notice as usual
            await sb.sessions.modify(entry.sessionId, (current) =>
                current.stopping === 'timeout' ? { ...current, stopping: undefined } : undefined
            );
        }
    }

    /** Disconnect: the active run is cancelled and its session interrupted; the job is deleted. */
    async remove(channelId: string) {
        const sb = this.#sb;
        for (const { value: job } of await sb.entities.jobs.list({ partitionKey: channelId })) {
            if (job.activeRun) {
                const run = (await sb.entities.jobRuns.get(job.jobId, job.activeRun))?.value;
                await this.#finish(channelId, job.jobId, job.activeRun, 'cancelled', 'disconnected');
                const entry = run?.sessionId ? await sb.sessions.get(run.sessionId) : undefined;
                if (entry?.state === 'active') await sb.sessions.archive(entry, 'disconnected').catch(() => undefined);
            }
            await sb.entities.jobs.delete(channelId, job.jobId);
        }
    }

    async latestRun(jobId: string): Promise<JobRun | undefined> {
        const runs = await this.#sb.entities.jobRuns.list({ partitionKey: jobId });
        return runs.map((r) => r.value).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    }
}
