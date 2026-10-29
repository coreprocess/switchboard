import { type Logger, pino } from 'pino';

/** Paths that may carry credentials; pino replaces their values before anything is written. */
const REDACT = [
    'authorization',
    '*.authorization',
    'headers.authorization',
    '*.headers.authorization',
    'token',
    '*.token',
    'apiKey',
    '*.apiKey',
    'secret',
    '*.secret',
];

/**
 * Errors are logged by type, message, status, code and stack only. HTTP client errors carry the request they
 * belong to (`config.data`, `response`, …), which holds message text and headers that must not reach the log.
 */
export const serializeError = (value: unknown): Record<string, unknown> => {
    if (!(value instanceof Error)) return { message: String(value) };
    const fields = value as Error & { status?: unknown; statusCode?: unknown; code?: unknown };
    const status = fields.status ?? fields.statusCode;
    return {
        type: value.constructor.name,
        message: value.message,
        ...(typeof status === 'number' ? { status } : {}),
        ...(typeof fields.code === 'string' || typeof fields.code === 'number' ? { code: fields.code } : {}),
        stack: value.stack,
        ...(value.cause !== undefined ? { cause: serializeError(value.cause) } : {}),
    };
};

export type { Logger };

export const createLogger = (level: string): Logger =>
    pino({
        level,
        base: { service: 'switchboard' },
        redact: { paths: REDACT, censor: '[redacted]' },
        serializers: { err: serializeError },
    });

/** Silent logger for tests. */
export const nullLogger = (): Logger => pino({ level: 'silent' });
