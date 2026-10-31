import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Query, Row, Store, StoredRow, TableName } from './store.ts';

/**
 * Switchboard's data model (concept: "Data model"): one schema per entity, validated whenever a row is read.
 * Every entity keeps its key fields in the row too, so a row decodes on its own.
 */

const optional = z.string().optional();

export const BindingSchema = z.object({
    teamId: z.string(),
    channelId: z.string(),
    tenantId: z.string(),
    workspaceId: z.string(),
    conversationDeploymentId: z.string(),
    /** The team's Microsoft 365 group ID, for Graph (thread history). */
    aadGroupId: optional,
    teamName: optional,
    channelName: z.string(),
    /** A known limitation of the channel (for example: not a standard channel), shown in `status`. */
    channelNote: optional,
    createdBy: z.string(),
    createdAt: z.string(),
    updatedBy: z.string(),
    updatedAt: z.string(),
});
export type Binding = z.infer<typeof BindingSchema>;

export const JobSchema = z.object({
    channelId: z.string(),
    jobId: z.string(),
    teamId: z.string(),
    deploymentId: z.string(),
    cron: z.string(),
    timezone: z.string(),
    enabled: z.boolean(),
    maxRuntimeMin: z.number(),
    /** Row key of the run that is active, or absent. */
    activeRun: optional,
    updatedBy: z.string(),
    updatedAt: z.string(),
});
export type Job = z.infer<typeof JobSchema>;

export const RUN_STATUSES = ['running', 'succeeded', 'failed', 'skipped', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const JobRunSchema = z.object({
    jobId: z.string(),
    /** `<scheduled ISO time>` for ticks, `manual-<ISO time>` for runs started with the `run` command. */
    runKey: z.string(),
    channelId: z.string(),
    teamId: z.string(),
    status: z.enum(RUN_STATUSES),
    reason: optional,
    sessionId: optional,
    startedAt: z.string(),
    endedAt: optional,
    /** The session's final message, at most 2 KB. */
    finalMessage: optional,
    /** Whether the run's session became a conversation (then it is not archived when the run ends). */
    converted: z.boolean().optional(),
});
export type JobRun = z.infer<typeof JobRunSchema>;

export const CONVERSATION_ORIGINS = [
    'human',
    'start_new_conversation',
    'convert_to_conversation',
    'job_failure',
] as const;

export const ConversationSchema = z.object({
    channelId: z.string(),
    rootId: z.string(),
    conversationId: z.string(),
    teamId: z.string(),
    workspaceId: z.string(),
    origin: z.enum(CONVERSATION_ORIGINS),
    /** The owning session, or absent. */
    owningSession: optional,
    /** Set while one pod creates the owning session; others wait for it. */
    claimedBy: optional,
    claimedUntil: optional,
    sessionCount: z.number(),
    /** A thread Switchboard had not seen: its first session reads the thread's history from Teams. */
    historyFromTeams: z.boolean().optional(),
    /** The last session that owned the thread and why it ended, for continuations. */
    previousSession: optional,
    previousReason: optional,
    /** For threads started by `start_new_conversation`: the opening post, the briefing and the caller. */
    openingText: optional,
    briefing: optional,
    originSession: optional,
    createdAt: z.string(),
    lastActivity: z.string(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

export const SESSION_STATES = ['active', 'ended', 'archived'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const SessionSchema = z.object({
    sessionId: z.string(),
    workspaceId: z.string(),
    teamId: z.string(),
    channelId: z.string(),
    kind: z.enum(['conversation', 'job']),
    /** Root message of the conversation the session owns (foreground), or absent (background). */
    rootId: optional,
    jobId: optional,
    runKey: optional,
    deploymentId: z.string(),
    agentId: z.string(),
    agentVersion: z.number(),
    /** Sequence number of the session in its thread (1, 2, …). */
    seq: z.number(),
    state: z.enum(SESSION_STATES),
    endReason: optional,
    /** Last event relayed; the relay continues after it. */
    watermarkEventId: optional,
    watermarkAt: optional,
    /** Session lease: the pod that follows the session's events, and until when. */
    relayOwner: optional,
    relayValidUntil: optional,
    /** The "working…" message in the thread, while a turn runs. */
    workingMessageId: optional,
    /** Set before Switchboard interrupts or archives the session itself (timeout, inactivity, disconnect). */
    stopping: optional,
    createdAt: z.string(),
    lastActivity: z.string(),
});
export type SessionEntry = z.infer<typeof SessionSchema>;

export const CARD_STATES = ['open', 'locked', 'closed'] as const;

export const CardSchema = z.object({
    cardId: z.string(),
    /** `agent` for cards from `show_card`, `confirmation` for tool confirmations. */
    kind: z.enum(['agent', 'confirmation']),
    sessionId: z.string(),
    teamId: z.string(),
    channelId: z.string(),
    rootId: z.string(),
    conversationId: z.string(),
    /** The Teams message that shows the card. */
    activityId: optional,
    /** The card as last set by the agent (agent cards) or the confirmation's details (confirmations, JSON). */
    json: z.string(),
    state: z.enum(CARD_STATES),
    lockedBy: optional,
    lockedAad: optional,
    lockedAt: optional,
    lockedChoice: optional,
    /** Confirmation cards: the tool use waiting for it. */
    toolUseId: optional,
    createdAt: z.string(),
});
export type Card = z.infer<typeof CardSchema>;

export const LogEntrySchema = z.object({
    conversationId: z.string(),
    entryKey: z.string(),
    at: z.string(),
    /** JSON of a `LogItem` (conversations/log.ts). */
    item: z.string(),
});
export type LogEntry = z.infer<typeof LogEntrySchema>;

export const ToolCallSchema = z.object({
    sessionId: z.string(),
    eventId: z.string(),
    tool: z.string(),
    status: z.enum(['started', 'done']),
    result: optional,
    isError: z.boolean().optional(),
    startedAt: z.string(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const UploadedFileSchema = z.object({
    /** The conversation ID, or `session:<id>` for files of a job session. */
    owner: z.string(),
    fileId: z.string(),
    workspaceId: z.string(),
    kind: z.enum(['log', 'attachment']),
    messageId: optional,
    mediaType: z.string(),
    name: z.string(),
    size: z.number(),
    createdAt: z.string(),
});
export type UploadedFile = z.infer<typeof UploadedFileSchema>;

export const TeamsRefSchema = z.object({
    teamId: z.string(),
    tenantId: z.string(),
    serviceUrl: z.string(),
    botId: z.string(),
    aadGroupId: optional,
    teamName: optional,
    updatedAt: z.string(),
});
export type TeamsRef = z.infer<typeof TeamsRefSchema>;

export const SeenSchema = z.object({ kind: z.string(), id: z.string(), at: z.string() });
export type Seen = z.infer<typeof SeenSchema>;

export interface Versioned<T> {
    value: T;
    etag: string;
}

const toRow = (value: object): Row =>
    Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as Row;

/** Typed access to one table, with the conditional writes Switchboard coordinates through. */
export class Collection<T extends object> {
    readonly #store: Store;
    readonly #table: TableName;
    readonly #schema: z.ZodType<T>;
    readonly #keys: (value: T) => [string, string];

    constructor(store: Store, table: TableName, schema: z.ZodType<T>, keys: (value: T) => [string, string]) {
        this.#store = store;
        this.#table = table;
        this.#schema = schema;
        this.#keys = keys;
    }

    #decode(stored: StoredRow): Versioned<T> {
        return { value: this.#schema.parse(stored.row), etag: stored.etag };
    }

    #stored(versioned: Versioned<T>): StoredRow {
        const [partitionKey, rowKey] = this.#keys(versioned.value);
        return { partitionKey, rowKey, etag: versioned.etag, row: {} };
    }

    async get(partitionKey: string, rowKey = ''): Promise<Versioned<T> | undefined> {
        const stored = await this.#store.get(this.#table, partitionKey, rowKey);
        return stored ? this.#decode(stored) : undefined;
    }

    /** `undefined` when the entity exists already. */
    async insert(value: T): Promise<Versioned<T> | undefined> {
        const [partitionKey, rowKey] = this.#keys(value);
        const stored = await this.#store.insert(this.#table, partitionKey, rowKey, toRow(value));
        return stored ? this.#decode(stored) : undefined;
    }

    /** Replaces the entity if it did not change since `current` was read; `undefined` otherwise. */
    async update(current: Versioned<T>, value: T): Promise<Versioned<T> | undefined> {
        const stored = await this.#store.update(this.#table, this.#stored(current), toRow(value));
        return stored ? this.#decode(stored) : undefined;
    }

    async upsert(value: T): Promise<void> {
        const [partitionKey, rowKey] = this.#keys(value);
        await this.#store.upsert(this.#table, partitionKey, rowKey, toRow(value));
    }

    async delete(partitionKey: string, rowKey = '', etag?: string): Promise<boolean> {
        return this.#store.delete(this.#table, partitionKey, rowKey, etag);
    }

    async list(query?: Query): Promise<Versioned<T>[]> {
        return (await this.#store.list(this.#table, query)).map((stored) => this.#decode(stored));
    }

    /**
     * Read, change and write back with the ETag, retrying on conflicts. `change` returns the new value, or
     * `undefined` to leave the entity as it is. Returns the written (or unchanged) entity; `undefined` when absent.
     */
    async modify(
        partitionKey: string,
        rowKey: string,
        change: (current: T) => T | undefined,
        attempts = 8
    ): Promise<Versioned<T> | undefined> {
        for (let attempt = 0; attempt < attempts; attempt++) {
            const current = await this.get(partitionKey, rowKey);
            if (!current) return undefined;
            const next = change(current.value);
            if (!next) return current;
            const written = await this.update(current, next);
            if (written) return written;
        }
        throw new Error(`${this.#table} ${partitionKey}/${rowKey}: too many concurrent changes`);
    }
}

/** Table Storage keys for IDs of unknown shape (Teams activity IDs, conversation IDs). */
export const hashKey = (value: string) => createHash('sha256').update(value).digest('hex');

export const createEntities = (store: Store) => ({
    store,
    bindings: new Collection(store, 'bindings', BindingSchema, (b) => [b.teamId, b.channelId]),
    jobs: new Collection(store, 'jobs', JobSchema, (j) => [j.channelId, j.jobId]),
    jobRuns: new Collection(store, 'jobruns', JobRunSchema, (r) => [r.jobId, r.runKey]),
    conversations: new Collection(store, 'conversations', ConversationSchema, (c) => [c.channelId, c.rootId]),
    sessions: new Collection(store, 'sessions', SessionSchema, (s) => [s.sessionId, '']),
    cards: new Collection(store, 'cards', CardSchema, (c) => [c.cardId, '']),
    logs: new Collection(store, 'logs', LogEntrySchema, (l) => [l.conversationId, l.entryKey]),
    toolCalls: new Collection(store, 'toolcalls', ToolCallSchema, (t) => [t.sessionId, t.eventId]),
    files: new Collection(store, 'files', UploadedFileSchema, (f) => [f.owner, f.fileId]),
    teamsRefs: new Collection(store, 'teamsrefs', TeamsRefSchema, (t) => [t.teamId, '']),
    seen: new Collection(store, 'seen', SeenSchema, (s) => [s.kind, s.id]),
});

export type Entities = ReturnType<typeof createEntities>;

/** Records that an ID was handled; `false` when it was handled before (deduplication across pods). */
export const markSeen = async (entities: Entities, kind: string, id: string): Promise<boolean> =>
    (await entities.seen.insert({ kind, id: hashKey(id), at: new Date().toISOString() })) !== undefined;

/** Forgets a handled ID, so a redelivery is handled again (after a failure). */
export const forgetSeen = async (entities: Entities, kind: string, id: string): Promise<void> => {
    await entities.seen.delete(kind, hashKey(id));
};
