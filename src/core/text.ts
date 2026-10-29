/**
 * Text that crosses the trust boundary between Teams and agents: the header Switchboard puts in front of every
 * human message, the approval marker only Switchboard may produce, and splitting long replies.
 */

/** First token of the machine-readable approval message (concept: approvals). */
export const APPROVAL_MARKER = '[switchboard:approval]';

/** Teams allows ~28 KB per message including markup; this leaves room for formatting. */
export const MAX_MESSAGE_CHARS = 12_000;

/** Characters that render as nothing; stripped so a zero-width space inside `[switchboard:` cannot hide it. */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;

/** `[switchboard:…]`, `[switchboard]` and `[teams]` in any case and spacing: tokens only Switchboard writes. */
const RESERVED = /\[\s*(switchboard\s*[:\]]|teams\s*\])/gi;

/**
 * Makes human text safe to pass to an agent: no reserved token survives, so a human can neither fake an approval
 * marker nor a second Switchboard header. NFKC folds look-alikes such as fullwidth brackets first.
 */
export const neutralise = (text: string): string =>
    text.normalize('NFKC').replace(INVISIBLE, '').replace(RESERVED, '[user-typed $1');

/** A display name as it may appear inside a header or marker line: one line, no brackets or quotes. */
export const sanitiseName = (name: string | undefined): string => {
    const cleaned = neutralise(name ?? '')
        .replace(/[\r\n\t"[\]()<>]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100);
    return cleaned || 'unknown';
};

export interface HumanMessage {
    channelKey: string;
    threadId: string;
    name: string | undefined;
    aadObjectId: string;
    at: Date;
    text: string;
}

/** The text sent to the agent for a human message: one Switchboard header line, then the neutralised text. */
export const formatHumanMessage = (message: HumanMessage): string =>
    `[teams] from: ${sanitiseName(message.name)} (${message.aadObjectId}) at ${message.at.toISOString()} ` +
    `channel: ${message.channelKey} thread: ${message.threadId}\n${neutralise(message.text)}`;

export interface ApprovalDecision {
    cardId: string;
    decision: 'approved' | 'denied';
    name: string | undefined;
    aadObjectId: string;
    at: Date;
}

/** The fixed, machine-readable message an agent receives for a decided approval card. */
export const formatApprovalMarker = (decision: ApprovalDecision): string =>
    `${APPROVAL_MARKER} card=${decision.cardId} decision=${decision.decision} ` +
    `by="${sanitiseName(decision.name)}" aad=${decision.aadObjectId} at=${decision.at.toISOString()}`;

/** First non-empty line, shortened, for session titles. */
export const firstLine = (text: string, max: number): string => {
    const line =
        text
            .split('\n')
            .map((l) => l.trim())
            .find((l) => l.length > 0) ?? '';
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

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

/** Shortens untrusted text for display (card fields, notices). */
export const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
