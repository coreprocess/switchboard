/**
 * Text that crosses the trust boundary between Teams and agents: the header lines Switchboard puts in front of
 * every part of a message it writes (concept: "Message formats"), neutralising human text so only Switchboard can
 * produce such lines, and splitting long answers.
 */

/** Teams allows ~28 KB per message including markup; this leaves room for formatting. */
export const MAX_MESSAGE_CHARS = 12_000;

/** Characters that render as nothing; stripped so a zero-width space inside `[switchboard:` cannot hide it. */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;

/** `[switchboard:…]`, `[switchboard]` and `[teams]` in any case and spacing: tokens only Switchboard writes. */
const RESERVED = /\[\s*(switchboard\s*[:\]]|teams\s*\])/gi;

/**
 * Makes human text safe to pass to an agent: a reserved token becomes `[user-typed …`, so a human can never write
 * a Switchboard header line. NFKC folds look-alikes such as fullwidth brackets first.
 */
export const neutralise = (text: string): string =>
    text.normalize('NFKC').replace(INVISIBLE, '').replace(RESERVED, '[user-typed $1');

/** A quoted header value: one line, neutralised, quotes and backslashes escaped. */
export const quoted = (value: string | undefined): string => {
    const line = neutralise(value ?? '')
        .replace(/\p{Cc}/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
    return `"${(line || 'unknown').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
};

/** A bare header value (IDs, reasons, verbs): no whitespace or quotes. */
const bare = (value: string) => value.replace(/[\s"]+/g, '_').slice(0, 200) || '-';

export interface Person {
    name: string | undefined;
    aadObjectId: string;
}

export const teamsHeader = (from: Person, at: Date) =>
    `[teams] from=${quoted(from.name)} aad=${bare(from.aadObjectId)} at=${at.toISOString()}`;

/** A human message: the header, then the neutralised text. */
export const formatHumanMessage = (from: Person, at: Date, text: string) =>
    `${teamsHeader(from, at)}\n${neutralise(text)}`;

export const conversationStartHeader = (fromSession: string, postedAt: Date) =>
    `[switchboard:conversation-start] from_session=${bare(fromSession)} posted_at=${postedAt.toISOString()}`;

export const continuationHeader = (previousSession: string, reason: string, at: Date) =>
    `[switchboard:continuation] previous_session=${bare(previousSession)} reason=${bare(reason)} at=${at.toISOString()}`;

export const sessionMessageHeader = (fromSession: string, fromKind: string, fromConversation: string, at: Date) =>
    `[switchboard:session-message] from_session=${bare(fromSession)} from_kind=${bare(fromKind)} ` +
    `from_conversation=${bare(fromConversation)} at=${at.toISOString()}`;

export const jobFailedHeader = (reason: string, at: Date) =>
    `[switchboard:job-failed] reason=${bare(reason)} at=${at.toISOString()}`;

export const cardHeader = (cardId: string, verb: string, by: Person, at: Date) =>
    `[switchboard:card] card=${bare(cardId)} verb=${bare(verb)} by=${quoted(by.name)} aad=${bare(by.aadObjectId)} ` +
    `at=${at.toISOString()}`;

/** Splits text into messages of at most `max` characters, preferring paragraph, then line, then word breaks. */
export const splitMessage = (text: string, max = MAX_MESSAGE_CHARS): string[] => {
    const chunks: string[] = [];
    let rest = text.trim();
    while (rest.length > max) {
        const window = rest.slice(0, max);
        const cut = [window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' ')].find(
            (index) => index > max / 2
        );
        const at = cut ?? max;
        chunks.push(rest.slice(0, at).trimEnd());
        rest = rest.slice(at).trimStart();
    }
    if (rest.length > 0) chunks.push(rest);
    return chunks;
};

/** Shortens text for display or storage. */
export const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Shortens text to at most `maxBytes` UTF-8 bytes. */
export const clipBytes = (text: string, maxBytes: number): string => {
    if (Buffer.byteLength(text) <= maxBytes) return text;
    let end = Math.min(text.length, maxBytes);
    while (end > 0 && Buffer.byteLength(text.slice(0, end)) > maxBytes - 3) end--;
    return `${text.slice(0, end)}…`;
};
