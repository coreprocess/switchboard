import { APIError } from '@anthropic-ai/sdk';
import type { SessionEntry } from '../store/entities.ts';
import type { Switchboard } from '../switchboard.ts';

/** Sessions with activity in this window are checked. */
const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Catches up on what streams and webhooks missed (README: "Operations"). Runs on every pod
 * every 60 s with jitter and at start: active sessions with recent activity whose lease is free get followed
 * again when they have something to relay; ends that went unnoticed are handled. Also triggers the daily cleanup
 * and the read access check.
 */
export class Reconciler {
    readonly #sb: Switchboard;
    #timer: ReturnType<typeof setTimeout> | undefined;
    #running: Promise<void> | undefined;
    #stopped = false;

    constructor(sb: Switchboard) {
        this.#sb = sb;
    }

    start() {
        this.#stopped = false;
        this.#plan(0);
    }

    async stop() {
        this.#stopped = true;
        if (this.#timer) clearTimeout(this.#timer);
        await this.#running;
    }

    #plan(delay: number) {
        if (this.#stopped) return;
        this.#timer = setTimeout(() => {
            this.#running = this.tick().finally(() => {
                this.#running = undefined;
                const base = this.#sb.timing.reconcileMs;
                this.#plan(base * (0.75 + Math.random() * 0.5));
            });
        }, delay);
        this.#timer.unref();
    }

    async tick() {
        const sb = this.#sb;
        try {
            const since = new Date(sb.now().getTime() - WINDOW_MS).toISOString();
            const sessions = await sb.entities.sessions.list({
                where: [
                    { field: 'state', op: 'eq', value: 'active' },
                    { field: 'lastActivity', op: 'ge', value: since },
                ],
            });
            for (const { value: entry } of sessions) {
                if (sb.relay.isFollowing(entry.sessionId)) continue;
                await this.#check(entry).catch((error: unknown) => {
                    sb.log.warn({ err: error, sessionId: entry.sessionId }, 'session not reconciled');
                });
            }
            await sb.lifecycle.daily();
        } catch (error) {
            sb.log.warn({ err: error }, 'reconcile failed');
        }
        await sb.access.periodic().catch((error: unknown) => {
            sb.log.warn({ err: error }, 'read access check failed');
        });
    }

    async #check(entry: SessionEntry) {
        const sb = this.#sb;
        const leaseValid = entry.relayOwner && (entry.relayValidUntil ?? '') > sb.now().toISOString();
        if (leaseValid) return;
        const api = sb.workspaces.get(entry.workspaceId);
        let status: string;
        let archived: boolean;
        try {
            const session = await api.retrieveSession(entry.sessionId);
            status = session.status;
            archived = session.archived_at !== null;
        } catch (error) {
            if (error instanceof APIError && error.status === 404) {
                await sb.sessions.end(entry.sessionId, 'deleted');
                return;
            }
            throw error;
        }
        if (archived && status !== 'running') {
            await sb.relay.wake(entry.sessionId);
            await sb.sessions.end(entry.sessionId, entry.stopping ? 'archived' : 'terminated');
            return;
        }
        if (status === 'running' || status === 'rescheduling' || status === 'terminated') {
            await sb.relay.wake(entry.sessionId);
            return;
        }
        // idle: relay only if something happened after the watermark
        const [latest] = await api.listEvents(entry.sessionId, { order: 'desc', max: 1 });
        if (latest && latest.id !== entry.watermarkEventId) await sb.relay.wake(entry.sessionId);
    }
}
