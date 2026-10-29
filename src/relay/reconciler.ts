import type { ClaudeApi } from '../claude/api.ts';
import type { Logger } from '../core/logger.ts';
import type { Store } from '../store/store.ts';
import type { Relay } from './relay.ts';

const ACTIVE_WINDOW_MS = 24 * 3_600_000;
const WEBHOOK_RETENTION_MS = 7 * 24 * 3_600_000;
const PURGE_EVERY_MS = 3_600_000;

export interface ReconcilerOptions {
    api: ClaudeApi;
    store: Store;
    relay: Relay;
    log: Logger;
    intervalMs?: number;
}

/**
 * Catches up on what the live streams and webhooks missed (restarts, dropped streams, lost deliveries): every
 * interval and on start, it relays whatever is new for sessions active in the last 24 hours and reopens streams
 * of pending sessions that are still running. Also purges old webhook dedupe records.
 */
export class Reconciler {
    readonly #api: ClaudeApi;
    readonly #store: Store;
    readonly #relay: Relay;
    readonly #log: Logger;
    readonly #intervalMs: number;
    #timer: NodeJS.Timeout | undefined;
    #running: Promise<void> | undefined;
    #lastPurge = 0;

    constructor(options: ReconcilerOptions) {
        this.#api = options.api;
        this.#store = options.store;
        this.#relay = options.relay;
        this.#log = options.log;
        this.#intervalMs = options.intervalMs ?? 60_000;
    }

    start(): void {
        const tick = () => {
            this.#running ??= this.tick()
                .catch((error: unknown) => this.#log.error({ err: error }, 'reconcile failed'))
                .finally(() => {
                    this.#running = undefined;
                });
        };
        tick();
        this.#timer = setInterval(tick, this.#intervalMs);
        this.#timer.unref();
    }

    async stop(): Promise<void> {
        clearInterval(this.#timer);
        await this.#running;
    }

    async tick(): Promise<void> {
        const now = Date.now();
        const sessions = await this.#store.listSessionsUpdatedSince(new Date(now - ACTIVE_WINDOW_MS).toISOString());
        for (const record of sessions) {
            try {
                if (record.pending && !this.#relay.isStreaming(record.sessionId)) {
                    const { status } = await this.#api.retrieveSession(record.sessionId);
                    if (status === 'running' || status === 'rescheduling')
                        await this.#relay.ensureStream(record.sessionId);
                }
                await this.#relay.drain(record.sessionId);
            } catch (error) {
                this.#log.warn({ err: error, sessionId: record.sessionId }, 'session not reconciled');
            }
        }
        if (now - this.#lastPurge >= PURGE_EVERY_MS) {
            const purged = await this.#store.purgeWebhookEvents(new Date(now - WEBHOOK_RETENTION_MS).toISOString());
            this.#lastPurge = now;
            if (purged > 0) this.#log.info({ purged }, 'webhook events purged');
        }
    }
}
