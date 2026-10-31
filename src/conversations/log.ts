import { neutralise, quoted } from '../core/text.ts';
import type { LogEntry } from '../store/entities.ts';

/**
 * The conversation log (concept: "Session end and continuation"): what happened in a thread, written as it
 * happens, so a later session of the thread can continue with the history.
 */

export interface AttachmentRef {
    name: string;
    mediaType: string;
    size: number;
    /** Files API ID, when the attachment was passed on. */
    fileId?: string;
    /** Why it was not passed on. */
    unsupported?: string;
}

export type LogItem =
    | { kind: 'human'; name: string; aad: string; text: string; attachments?: AttachmentRef[] }
    | { kind: 'agent'; session: string; text: string; update: boolean }
    | { kind: 'opening'; session?: string; text: string }
    | { kind: 'card'; event: 'shown' | 'updated' | 'closed'; cardId: string; session: string; json?: string }
    | { kind: 'card-click'; cardId: string; session: string; verb: string; by: string; aad: string; data: string }
    | { kind: 'confirmation'; cardId: string; session: string; tool: string; decision?: string; by?: string }
    | { kind: 'session'; event: 'attached' | 'ended'; session: string; reason?: string }
    | { kind: 'note'; text: string };

/** Teams messages are read from the thread when Switchboard has no log; cards show their visible content. */
export interface HistoryMessage {
    at: string;
    name: string;
    aad?: string;
    text: string;
    fromApp: boolean;
}

const indent = (text: string) =>
    neutralise(text)
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n');

const attachmentLine = (a: AttachmentRef) =>
    a.unsupported
        ? `[attachment not supported] name=${a.name} type=${a.mediaType}`
        : `[attachment] name=${a.name} type=${a.mediaType} size=${a.size}${a.fileId ? ` file_id=${a.fileId}` : ''}`;

/** One entry as Markdown; every line of content is indented, so no line of the log can look like a header. */
export const formatItem = (at: string, item: LogItem): string => {
    switch (item.kind) {
        case 'human': {
            const lines = [item.text, ...(item.attachments ?? []).map(attachmentLine)].filter(Boolean);
            return `- ${at} · person ${quoted(item.name)} (aad ${item.aad}) wrote:\n${indent(lines.join('\n'))}`;
        }
        case 'agent':
            return `- ${at} · agent (session ${item.session}) ${item.update ? 'posted an update' : 'answered'}:\n${indent(item.text)}`;
        case 'opening':
            return `- ${at} · opening post${item.session ? ` (session ${item.session})` : ''}:\n${indent(item.text)}`;
        case 'card':
            return item.json
                ? `- ${at} · card ${item.cardId} ${item.event} (session ${item.session}):\n${indent(item.json)}`
                : `- ${at} · card ${item.cardId} ${item.event} (session ${item.session})`;
        case 'card-click':
            return `- ${at} · ${quoted(item.by)} (aad ${item.aad}) clicked verb=${quoted(item.verb)} on card ${item.cardId}:\n${indent(item.data)}`;
        case 'confirmation':
            return item.decision
                ? `- ${at} · ${quoted(item.by ?? 'someone')} decided ${item.decision} for tool ${quoted(item.tool)} (card ${item.cardId})`
                : `- ${at} · session ${item.session} asked to confirm tool ${item.tool} (card ${item.cardId})`;
        case 'session':
            return `- ${at} · session ${item.session} ${item.event}${item.reason ? ` (${item.reason})` : ''}`;
        case 'note':
            return `- ${at} · note:\n${indent(item.text)}`;
    }
};

export const formatEntries = (entries: LogEntry[]): string[] =>
    entries.map((entry) => formatItem(entry.at, JSON.parse(entry.item) as LogItem));

export const formatHistory = (messages: HistoryMessage[]): string[] =>
    messages.map(
        (m) =>
            `- ${m.at} · ${m.fromApp ? 'app' : 'person'} ${quoted(m.name)}${m.aad ? ` (aad ${m.aad})` : ''} wrote:\n${indent(m.text)}`
    );

export const RECENT_ENTRIES = 20;
export const LOG_FILE_PATH = '/mnt/session/uploads/switchboard/conversation-log.md';

export type LogPlacement = { inline: true; text: string } | { inline: false; file: string; text: string };

/**
 * The history for a first message: inline up to the limit; above it the whole history goes into a file (mounted
 * at `LOG_FILE_PATH`) and the message carries the latest entries and the path.
 */
export const placeLog = (lines: string[], limitBytes: number, note?: string): LogPlacement => {
    const full = [note, ...lines].filter(Boolean).join('\n');
    if (Buffer.byteLength(full) <= limitBytes) return { inline: true, text: full };
    const recent = lines.slice(-RECENT_ENTRIES);
    const text = [
        note,
        `The full history (${lines.length} entries) is in the file ${LOG_FILE_PATH}. The latest ${recent.length}:`,
        ...recent,
    ]
        .filter(Boolean)
        .join('\n');
    return { inline: false, file: `# Conversation history\n\n${full}\n`, text };
};
