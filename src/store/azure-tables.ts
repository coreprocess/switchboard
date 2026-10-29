import { odata, RestError, TableClient, type TableEntityResult } from '@azure/data-tables';
import type { TokenCredential } from '@azure/identity';
import type {
    ApprovalDecisionUpdate,
    ApprovalRecord,
    ConversationRecord,
    DecisionResult,
    SessionRecord,
    Store,
    ThreadLink,
} from './store.ts';

/** Table names: Azure allows only letters and digits. */
const TABLES = ['threads', 'sessions', 'approvals', 'conversations', 'webhookevents'] as const;
type TableName = (typeof TABLES)[number];

/** Single-key tables use the key as partition key and an empty row key. */
const ROW = '';

type Row = Record<string, string | boolean | number | undefined>;

export interface AzureTablesOptions {
    endpoint: string | undefined;
    connectionString: string | undefined;
    credential: TokenCredential | undefined;
}

const isStatus = (error: unknown, status: number) => error instanceof RestError && error.statusCode === status;

/** Drops undefined values: Table Storage has no null, an absent property is the empty value. */
const compact = (row: Row): Record<string, string | boolean | number> =>
    Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)) as Record<
        string,
        string | boolean | number
    >;

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const required = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Azure Table Storage, authenticated with a token credential (workload identity) or a connection string. */
export class AzureTableStore implements Store {
    readonly #clients: Record<TableName, TableClient>;

    constructor(options: AzureTablesOptions) {
        const client = (table: TableName): TableClient => {
            if (options.connectionString) {
                return TableClient.fromConnectionString(options.connectionString, table, {
                    allowInsecureConnection:
                        options.connectionString.includes('UseDevelopmentStorage=true') ||
                        /DefaultEndpointsProtocol=http;/i.test(options.connectionString),
                });
            }
            if (!options.endpoint || !options.credential)
                throw new Error('Table Storage needs an endpoint and a credential');
            return new TableClient(options.endpoint, table, options.credential);
        };
        this.#clients = Object.fromEntries(TABLES.map((table) => [table, client(table)])) as Record<
            TableName,
            TableClient
        >;
    }

    async init() {
        for (const table of TABLES) await this.#clients[table].createTable();
    }

    async ping() {
        const page = this.#clients.sessions.listEntities().byPage({ maxPageSize: 1 });
        await page.next();
    }

    async #get(table: TableName, partitionKey: string, rowKey = ROW): Promise<TableEntityResult<Row> | undefined> {
        try {
            return await this.#clients[table].getEntity<Row>(partitionKey, rowKey);
        } catch (error) {
            if (isStatus(error, 404)) return undefined;
            throw error;
        }
    }

    async #put(table: TableName, partitionKey: string, rowKey: string, row: Row) {
        await this.#clients[table].upsertEntity({ partitionKey, rowKey, ...compact(row) }, 'Replace');
    }

    async getThread(channelKey: string, rootId: string): Promise<ThreadLink | undefined> {
        const row = await this.#get('threads', channelKey, rootId);
        if (!row) return undefined;
        return {
            channelKey,
            rootId,
            sessionId: required(row.sessionId),
            createdAt: required(row.createdAt),
            createdBy: required(row.createdBy),
        };
    }

    async putThread(link: ThreadLink) {
        await this.#put('threads', link.channelKey, link.rootId, {
            sessionId: link.sessionId,
            createdAt: link.createdAt,
            createdBy: link.createdBy,
        });
    }

    async getSession(sessionId: string): Promise<SessionRecord | undefined> {
        const row = await this.#get('sessions', sessionId);
        return row ? toSession(sessionId, row) : undefined;
    }

    async putSession(record: SessionRecord) {
        const { sessionId, ...rest } = record;
        await this.#put('sessions', sessionId, ROW, rest);
    }

    async listSessionsUpdatedSince(since: string) {
        const sessions: SessionRecord[] = [];
        const rows = this.#clients.sessions.listEntities<Row>({
            queryOptions: { filter: odata`updatedAt ge ${since}` },
        });
        for await (const row of rows) sessions.push(toSession(row.partitionKey ?? '', row));
        return sessions;
    }

    async createApproval(record: ApprovalRecord) {
        const { cardId, steps, ...rest } = record;
        try {
            await this.#clients.approvals.createEntity({
                partitionKey: cardId,
                rowKey: ROW,
                ...compact({ ...rest, steps: JSON.stringify(steps) }),
            });
            return true;
        } catch (error) {
            if (isStatus(error, 409)) return false;
            throw error;
        }
    }

    async getApproval(cardId: string) {
        const row = await this.#get('approvals', cardId);
        return row ? toApproval(cardId, row) : undefined;
    }

    async setApprovalMessageId(cardId: string, messageId: string) {
        await this.#clients.approvals.updateEntity({ partitionKey: cardId, rowKey: ROW, messageId }, 'Merge');
    }

    async decideApproval(cardId: string, update: ApprovalDecisionUpdate): Promise<DecisionResult | undefined> {
        const row = await this.#get('approvals', cardId);
        if (!row) return undefined;
        const record = toApproval(cardId, row);
        if (record.status !== 'pending') return { applied: false, record };
        try {
            // Conditional on the ETag read above: of two concurrent decisions only the first write succeeds.
            await this.#clients.approvals.updateEntity(
                { partitionKey: cardId, rowKey: ROW, ...compact({ ...update }) },
                'Merge',
                { etag: row.etag }
            );
        } catch (error) {
            if (!isStatus(error, 412)) throw error;
            const current = await this.getApproval(cardId);
            return current ? { applied: false, record: current } : undefined;
        }
        return { applied: true, record: { ...record, ...update } };
    }

    async getConversation(channelKey: string): Promise<ConversationRecord | undefined> {
        const row = await this.#get('conversations', channelKey);
        if (!row) return undefined;
        return {
            channelKey,
            serviceUrl: required(row.serviceUrl),
            tenantId: required(row.tenantId),
            channelId: required(row.channelId),
            teamId: text(row.teamId),
            aadGroupId: text(row.aadGroupId),
            botId: required(row.botId),
            updatedAt: required(row.updatedAt),
        };
    }

    async putConversation(record: ConversationRecord) {
        const { channelKey, ...rest } = record;
        await this.#put('conversations', channelKey, ROW, rest);
    }

    async claimWebhookEvent(eventId: string, at: string) {
        try {
            await this.#clients.webhookevents.createEntity({ partitionKey: eventId, rowKey: ROW, processedAt: at });
            return true;
        } catch (error) {
            if (isStatus(error, 409)) return false;
            throw error;
        }
    }

    async releaseWebhookEvent(eventId: string) {
        try {
            await this.#clients.webhookevents.deleteEntity(eventId, ROW);
        } catch (error) {
            if (!isStatus(error, 404)) throw error;
        }
    }

    async purgeWebhookEvents(before: string) {
        let count = 0;
        const rows = this.#clients.webhookevents.listEntities<Row>({
            queryOptions: { filter: odata`processedAt lt ${before}`, select: ['PartitionKey', 'RowKey'] },
        });
        for await (const row of rows) {
            await this.releaseWebhookEvent(row.partitionKey ?? '');
            count++;
        }
        return count;
    }
}

const toSession = (sessionId: string, row: Row): SessionRecord => ({
    sessionId,
    channelKey: required(row.channelKey),
    rootId: required(row.rootId),
    watermarkEventId: text(row.watermarkEventId),
    watermarkAt: text(row.watermarkAt),
    pending: row.pending === true,
    lastSentEventId: text(row.lastSentEventId),
    workingMessageId: text(row.workingMessageId),
    updatedAt: required(row.updatedAt),
});

const toApproval = (cardId: string, row: Row): ApprovalRecord => ({
    cardId,
    kind: row.kind === 'tool_confirmation' ? 'tool_confirmation' : 'approval',
    sessionId: required(row.sessionId),
    channelKey: required(row.channelKey),
    rootId: required(row.rootId),
    messageId: text(row.messageId),
    title: required(row.title),
    summary: required(row.summary),
    steps: parseSteps(row.steps),
    toolUseId: text(row.toolUseId),
    status: (['pending', 'approved', 'denied', 'expired'] as const).find((s) => s === row.status) ?? 'pending',
    decidedBy: text(row.decidedBy),
    decidedByAad: text(row.decidedByAad),
    decidedAt: text(row.decidedAt),
    createdAt: required(row.createdAt),
    expiresAt: text(row.expiresAt),
});

const parseSteps = (value: unknown): string[] => {
    if (typeof value !== 'string') return [];
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
};
