import { randomUUID } from 'node:crypto';
import { Attachments } from './attachments/attachments.ts';
import { CardService } from './cards/service.ts';
import type { ClaudeWorkspaces } from './claude/api.ts';
import type { Templates } from './claude/templates.ts';
import type { Settings } from './config/env.ts';
import { Conversations } from './conversations/conversations.ts';
import { Delivery } from './conversations/delivery.ts';
import { HistoryReader } from './conversations/history.ts';
import type { Logger } from './core/logger.ts';
import type { ChannelPlatform } from './core/platform.ts';
import { Jobs } from './jobs/jobs.ts';
import { Lifecycle } from './lifecycle/lifecycle.ts';
import { Reconciler } from './relay/reconciler.ts';
import { Relay } from './relay/relay.ts';
import { Sessions } from './sessions/sessions.ts';
import type { Entities } from './store/entities.ts';
import { Tools } from './tools/tools.ts';
import { Waits } from './tools/waits.ts';

export interface Core {
    settings: Settings;
    entities: Entities;
    workspaces: ClaudeWorkspaces;
    templates: Templates;
    platform: ChannelPlatform;
    log: Logger;
    /** Identifies this pod in session leases. */
    podId?: string;
    /** Injectable clock for tests. */
    now?: () => Date;
    /** Shorter timings for tests. */
    timing?: Partial<Timing>;
}

export interface Timing {
    leaseMs: number;
    renewMs: number;
    drainIntervalMs: number;
    reconcileMs: number;
    schedulerMs: number;
    claimMs: number;
    claimWaitMs: number;
    waitTickMs: number;
}

const DEFAULT_TIMING: Timing = {
    leaseMs: 60_000,
    renewMs: 20_000,
    drainIntervalMs: 15_000,
    reconcileMs: 60_000,
    schedulerMs: 15_000,
    claimMs: 90_000,
    claimWaitMs: 30_000,
    waitTickMs: 10_000,
};

/** One Switchboard instance (pod): the shared parts and the services, which reach each other through it. */
export class Switchboard {
    readonly settings: Settings;
    readonly entities: Entities;
    readonly workspaces: ClaudeWorkspaces;
    readonly templates: Templates;
    readonly platform: ChannelPlatform;
    readonly log: Logger;
    readonly podId: string;
    readonly timing: Timing;
    readonly #now: () => Date;

    readonly sessions: Sessions;
    readonly conversations: Conversations;
    readonly history: HistoryReader;
    readonly delivery: Delivery;
    readonly cards: CardService;
    readonly attachments: Attachments;
    readonly tools: Tools;
    readonly waits: Waits;
    readonly relay: Relay;
    readonly jobs: Jobs;
    readonly lifecycle: Lifecycle;
    readonly reconciler: Reconciler;

    constructor(core: Core) {
        this.settings = core.settings;
        this.entities = core.entities;
        this.workspaces = core.workspaces;
        this.templates = core.templates;
        this.platform = core.platform;
        this.log = core.log;
        this.podId = core.podId ?? `pod-${randomUUID()}`;
        this.timing = { ...DEFAULT_TIMING, ...core.timing };
        this.#now = core.now ?? (() => new Date());

        this.sessions = new Sessions(this);
        this.conversations = new Conversations(this);
        this.history = new HistoryReader(this);
        this.delivery = new Delivery(this);
        this.cards = new CardService(this);
        this.attachments = new Attachments(this);
        this.tools = new Tools(this);
        this.waits = new Waits(this);
        this.relay = new Relay(this);
        this.jobs = new Jobs(this);
        this.lifecycle = new Lifecycle(this);
        this.reconciler = new Reconciler(this);
    }

    now(): Date {
        return this.#now();
    }

    /** Starts the background loops: reconciler (which also runs the daily cleanup), job scheduler, wait timer. */
    start() {
        this.reconciler.start();
        this.jobs.start();
        this.waits.start();
    }

    /** Stops the loops and releases this pod's session leases, so another pod takes over at once. */
    async stop() {
        this.jobs.stop();
        this.waits.stop();
        await this.reconciler.stop();
        await this.relay.close();
    }
}
