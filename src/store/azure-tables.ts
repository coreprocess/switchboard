import { RestError, TableClient, type TableEntityResult } from '@azure/data-tables';
import type { TokenCredential } from '@azure/identity';
import {
    type Condition,
    type Query,
    type Row,
    type Scalar,
    type Store,
    type StoredRow,
    TABLES,
    type TableName,
} from './store.ts';

export interface AzureTablesOptions {
    endpoint: string | undefined;
    connectionString: string | undefined;
    credential: TokenCredential | undefined;
    /** Prepended to every table name, so several installations can share an account (letters and digits). */
    tablePrefix: string;
}

/** A string property holds at most 64 KiB (32 Ki UTF-16 units); longer strings are split across properties. */
const MAX_PART = 30_000;
const PART = '__part';
const PARTS = '__parts';

/** Characters Table Storage does not allow in keys, plus the escape character itself. */
const KEY_UNSAFE = /[%/\\#?\p{Cc}]/gu;

export const encodeKey = (key: string) =>
    key.replace(KEY_UNSAFE, (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
export const decodeKey = (key: string) =>
    key.replace(/%([0-9a-f]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

const isStatus = (error: unknown, ...statuses: number[]) =>
    error instanceof RestError && statuses.includes(error.statusCode ?? 0);

/** Splits long strings into `name__part0`, `name__part1`, … with `name__parts` holding the count. */
const toEntity = (row: Row): Record<string, Scalar> => {
    const entity: Record<string, Scalar> = {};
    for (const [name, value] of Object.entries(row)) {
        if (typeof value !== 'string' || value.length <= MAX_PART) {
            entity[name] = value;
            continue;
        }
        const parts = Math.ceil(value.length / MAX_PART);
        entity[`${name}${PARTS}`] = parts;
        for (let index = 0; index < parts; index++) {
            entity[`${name}${PART}${index}`] = value.slice(index * MAX_PART, (index + 1) * MAX_PART);
        }
    }
    return entity;
};

const fromEntity = (entity: TableEntityResult<Record<string, unknown>>): StoredRow => {
    const row: Row = {};
    for (const [name, value] of Object.entries(entity)) {
        if (['partitionKey', 'rowKey', 'etag', 'timestamp', 'odata.metadata'].includes(name)) continue;
        if (name.endsWith(PARTS)) {
            const base = name.slice(0, -PARTS.length);
            const parts: string[] = [];
            for (let index = 0; index < Number(value); index++) parts.push(String(entity[`${base}${PART}${index}`]));
            row[base] = parts.join('');
            continue;
        }
        if (name.includes(PART)) continue;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') row[name] = value;
    }
    return {
        partitionKey: decodeKey(entity.partitionKey ?? ''),
        rowKey: decodeKey(entity.rowKey ?? ''),
        etag: entity.etag,
        row,
    };
};

const literal = (value: Scalar) => {
    if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return Number.isInteger(value) ? `${value}L` : String(value);
};

const condition = ({ field, op, value }: Condition) => {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(field)) throw new Error(`invalid field name '${field}'`);
    return `${field} ${op} ${literal(value)}`;
};

const filterOf = (query: Query = {}) => {
    const parts = (query.where ?? []).map(condition);
    if (query.partitionKey !== undefined) parts.unshift(`PartitionKey eq ${literal(encodeKey(query.partitionKey))}`);
    return parts.length > 0 ? parts.join(' and ') : undefined;
};

/** Azure Table Storage, authenticated with a token credential (workload identity) or a connection string. */
export class AzureTableStore implements Store {
    readonly #clients: Record<TableName, TableClient>;

    constructor(options: AzureTablesOptions) {
        if (!/^[A-Za-z][A-Za-z0-9]{0,30}$/.test(options.tablePrefix)) {
            throw new Error('the table prefix must start with a letter and contain only letters and digits');
        }
        const client = (name: string): TableClient => {
            if (options.connectionString) {
                return TableClient.fromConnectionString(options.connectionString, name, {
                    allowInsecureConnection:
                        options.connectionString.includes('UseDevelopmentStorage=true') ||
                        /DefaultEndpointsProtocol=http;/i.test(options.connectionString),
                });
            }
            if (!options.endpoint || !options.credential) {
                throw new Error('Table Storage needs an endpoint and a credential');
            }
            return new TableClient(options.endpoint, name, options.credential);
        };
        this.#clients = Object.fromEntries(
            TABLES.map((table) => [table, client(`${options.tablePrefix}${table}`)])
        ) as Record<TableName, TableClient>;
    }

    async init() {
        for (const table of TABLES) await this.#clients[table].createTable();
    }

    async ping() {
        await this.#clients.bindings.listEntities().byPage({ maxPageSize: 1 }).next();
    }

    async get(table: TableName, partitionKey: string, rowKey: string) {
        try {
            const entity = await this.#clients[table].getEntity<Record<string, unknown>>(
                encodeKey(partitionKey),
                encodeKey(rowKey)
            );
            return fromEntity(entity);
        } catch (error) {
            if (isStatus(error, 404)) return undefined;
            throw error;
        }
    }

    async insert(table: TableName, partitionKey: string, rowKey: string, row: Row) {
        try {
            await this.#clients[table].createEntity({
                partitionKey: encodeKey(partitionKey),
                rowKey: encodeKey(rowKey),
                ...toEntity(row),
            });
        } catch (error) {
            if (isStatus(error, 409)) return undefined;
            throw error;
        }
        return this.get(table, partitionKey, rowKey);
    }

    async update(table: TableName, current: StoredRow, row: Row) {
        try {
            await this.#clients[table].updateEntity(
                { partitionKey: encodeKey(current.partitionKey), rowKey: encodeKey(current.rowKey), ...toEntity(row) },
                'Replace',
                { etag: current.etag }
            );
        } catch (error) {
            if (isStatus(error, 412, 404)) return undefined;
            throw error;
        }
        return this.get(table, current.partitionKey, current.rowKey);
    }

    async upsert(table: TableName, partitionKey: string, rowKey: string, row: Row) {
        await this.#clients[table].upsertEntity(
            { partitionKey: encodeKey(partitionKey), rowKey: encodeKey(rowKey), ...toEntity(row) },
            'Replace'
        );
    }

    async delete(table: TableName, partitionKey: string, rowKey: string, etag?: string) {
        try {
            await this.#clients[table].deleteEntity(
                encodeKey(partitionKey),
                encodeKey(rowKey),
                etag ? { etag } : undefined
            );
            return true;
        } catch (error) {
            if (isStatus(error, 404, 412)) return false;
            throw error;
        }
    }

    async list(table: TableName, query?: Query) {
        const filter = filterOf(query);
        const rows: StoredRow[] = [];
        const entities = this.#clients[table].listEntities<Record<string, unknown>>(
            filter ? { queryOptions: { filter } } : {}
        );
        for await (const entity of entities) rows.push(fromEntity(entity));
        return rows;
    }
}
