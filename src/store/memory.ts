import { matches, type Query, type Row, type Store, type StoredRow, type TableName } from './store.ts';

/** In-memory store for tests and local development. Several Switchboard instances may share one. */
export class MemoryStore implements Store {
    readonly #tables = new Map<TableName, Map<string, StoredRow>>();
    #version = 0;

    #table(table: TableName) {
        let rows = this.#tables.get(table);
        if (!rows) {
            rows = new Map();
            this.#tables.set(table, rows);
        }
        return rows;
    }

    #write(table: TableName, partitionKey: string, rowKey: string, row: Row): StoredRow {
        const stored = { partitionKey, rowKey, etag: `v${++this.#version}`, row: { ...row } };
        this.#table(table).set(JSON.stringify([partitionKey, rowKey]), stored);
        return { ...stored, row: { ...stored.row } };
    }

    async init() {
        // nothing to create
    }

    async ping() {
        // always reachable
    }

    async get(table: TableName, partitionKey: string, rowKey: string) {
        const stored = this.#table(table).get(JSON.stringify([partitionKey, rowKey]));
        return stored ? { ...stored, row: { ...stored.row } } : undefined;
    }

    async insert(table: TableName, partitionKey: string, rowKey: string, row: Row) {
        if (this.#table(table).has(JSON.stringify([partitionKey, rowKey]))) return undefined;
        return this.#write(table, partitionKey, rowKey, row);
    }

    async update(table: TableName, current: StoredRow, row: Row) {
        const existing = this.#table(table).get(JSON.stringify([current.partitionKey, current.rowKey]));
        if (!existing || existing.etag !== current.etag) return undefined;
        return this.#write(table, current.partitionKey, current.rowKey, row);
    }

    async upsert(table: TableName, partitionKey: string, rowKey: string, row: Row) {
        this.#write(table, partitionKey, rowKey, row);
    }

    async delete(table: TableName, partitionKey: string, rowKey: string, etag?: string) {
        const key = JSON.stringify([partitionKey, rowKey]);
        const existing = this.#table(table).get(key);
        if (!existing || (etag !== undefined && existing.etag !== etag)) return false;
        return this.#table(table).delete(key);
    }

    async list(table: TableName, query?: Query) {
        return [...this.#table(table).values()]
            .filter((stored) => matches(stored.row, stored.partitionKey, query))
            .map((stored) => ({ ...stored, row: { ...stored.row } }));
    }
}
