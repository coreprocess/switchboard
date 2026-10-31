/**
 * Switchboard's only shared state: rows in tables, coordinated through conditional writes. An insert fails when
 * the row exists; an update or delete with an ETag fails when the row changed in the meantime. Several pods use
 * the same store; nothing else is shared between them.
 */

export const TABLES = [
    'bindings',
    'jobs',
    'jobruns',
    'conversations',
    'sessions',
    'files',
    'cards',
    'posted',
    'toolcalls',
    'teamsrefs',
    'seen',
] as const;

export type TableName = (typeof TABLES)[number];

export type Scalar = string | number | boolean;

/** Row properties; an absent property is the empty value (Table Storage has no null). */
export type Row = Record<string, Scalar>;

export interface StoredRow {
    partitionKey: string;
    rowKey: string;
    /** Changes with every write; conditional updates and deletes compare it. */
    etag: string;
    row: Row;
}

export interface Condition {
    field: string;
    op: 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge';
    value: Scalar;
}

export interface Query {
    partitionKey?: string;
    /** All conditions must hold. */
    where?: Condition[];
}

export interface Store {
    /** Creates missing tables. */
    init(): Promise<void>;
    /** Throws when the store cannot be reached (readiness). */
    ping(): Promise<void>;
    get(table: TableName, partitionKey: string, rowKey: string): Promise<StoredRow | undefined>;
    /** `undefined` when a row with these keys exists already. */
    insert(table: TableName, partitionKey: string, rowKey: string, row: Row): Promise<StoredRow | undefined>;
    /** Replaces the row if its ETag still matches; `undefined` when it changed or is gone. */
    update(table: TableName, current: StoredRow, row: Row): Promise<StoredRow | undefined>;
    /** Writes the row unconditionally. */
    upsert(table: TableName, partitionKey: string, rowKey: string, row: Row): Promise<void>;
    /** Deletes the row (only if its ETag matches, when given); `false` when it was gone or changed. */
    delete(table: TableName, partitionKey: string, rowKey: string, etag?: string): Promise<boolean>;
    list(table: TableName, query?: Query): Promise<StoredRow[]>;
}

/** Whether a row satisfies a query; the in-memory store uses it, the Table Storage store sends it as a filter. */
export const matches = (row: Row, partitionKey: string, query: Query = {}): boolean => {
    if (query.partitionKey !== undefined && query.partitionKey !== partitionKey) return false;
    return (query.where ?? []).every(({ field, op, value }) => {
        const actual = row[field];
        // as in Table Storage: a condition on a missing property never matches
        if (actual === undefined) return false;
        switch (op) {
            case 'eq':
                return actual === value;
            case 'ne':
                return actual !== value;
            case 'lt':
                return actual < value;
            case 'le':
                return actual <= value;
            case 'gt':
                return actual > value;
            case 'ge':
                return actual >= value;
        }
    });
};
