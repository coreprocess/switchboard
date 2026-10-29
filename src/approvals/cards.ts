import type { Card } from '../core/gateway.ts';
import { clip } from '../core/text.ts';
import type { ApprovalRecord } from '../store/store.ts';

export const VERB_APPROVE = 'switchboard.approve';
export const VERB_DENY = 'switchboard.deny';
const RESERVED_VERB = /^switchboard\./i;

const SCHEMA = 'http://adaptivecards.io/schemas/adaptive-card.json';

const MAX_TITLE = 200;
const MAX_SUMMARY = 4000;
const MAX_STEP = 1000;
export const MAX_STEPS = 50;

const timeOf = (iso: string | undefined) => (iso ? `${iso.replace('T', ' ').slice(0, 16)} UTC` : '');

const statusLine = (record: ApprovalRecord): string | undefined => {
    const who = record.decidedBy ?? 'unknown';
    switch (record.status) {
        case 'approved':
            return `✅ ${record.kind === 'approval' ? 'Approved' : 'Allowed'} by ${who} at ${timeOf(record.decidedAt)}`;
        case 'denied':
            return `❌ Denied by ${who} at ${timeOf(record.decidedAt)}`;
        case 'expired':
            return `⌛ Expired at ${timeOf(record.decidedAt)}`;
        case 'pending':
            return undefined;
    }
};

/** The card for an approval or a tool confirmation, in its current state: buttons while pending, the outcome after. */
export const renderApprovalCard = (record: ApprovalRecord): Card => {
    const body: Record<string, unknown>[] = [
        { type: 'TextBlock', text: clip(record.title, MAX_TITLE), weight: 'Bolder', size: 'Medium', wrap: true },
    ];
    if (record.summary) body.push({ type: 'TextBlock', text: clip(record.summary, MAX_SUMMARY), wrap: true });
    if (record.steps.length > 0) {
        const steps = record.steps.slice(0, MAX_STEPS).map((step, i) => `${i + 1}. ${clip(step, MAX_STEP)}`);
        body.push({
            type: 'TextBlock',
            text: steps.join('\n'),
            wrap: true,
            ...(record.kind === 'tool_confirmation' ? { fontType: 'Monospace' } : {}),
        });
    }
    const status = statusLine(record);
    if (status) body.push({ type: 'TextBlock', text: status, weight: 'Bolder', wrap: true, spacing: 'Medium' });
    body.push({ type: 'TextBlock', text: `Card ${record.cardId}`, isSubtle: true, size: 'Small', wrap: true });

    const card: Card = { type: 'AdaptiveCard', $schema: SCHEMA, version: '1.5', body };
    if (record.status === 'pending') {
        const data = { card_id: record.cardId };
        card.actions = [
            {
                type: 'Action.Execute',
                title: record.kind === 'approval' ? 'Approve' : 'Allow',
                verb: VERB_APPROVE,
                data,
                style: 'positive',
            },
            { type: 'Action.Execute', title: 'Deny', verb: VERB_DENY, data, style: 'destructive' },
        ];
    }
    return card;
};

/** A short card used as the answer to a click that could not be applied (unknown card, not allowed). */
export const noticeCard = (text: string): Card => ({
    type: 'AdaptiveCard',
    $schema: SCHEMA,
    version: '1.5',
    body: [{ type: 'TextBlock', text, wrap: true }],
});

const isReservedAction = (value: unknown): boolean => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const action = value as Record<string, unknown>;
    if (typeof action.verb === 'string' && RESERVED_VERB.test(action.verb)) return true;
    const data = action.data;
    return data !== null && typeof data === 'object' && !Array.isArray(data) && 'card_id' in data;
};

/** Removes reserved actions wherever they sit: in arrays, and as property values (`selectAction`, `fallback`, …). */
const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.filter((item) => !isReservedAction(item)).map(strip);
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value)
                // `refresh` makes Teams send invokes by itself, as the listed users, without a click
                .filter(([key, item]) => key !== 'refresh' && !isReservedAction(item))
                .map(([key, item]) => [key, strip(item)])
        );
    }
    return value;
};

/**
 * Validates a card an agent wants to post and removes every action that looks like one of Switchboard's own
 * (reserved verbs, a `card_id` in its data) at any depth, and `refresh`, so an agent card cannot trigger an
 * approval.
 */
export const sanitiseAgentCard = (card: unknown): Card => {
    if (card === null || typeof card !== 'object' || Array.isArray(card)) throw new Error('card must be a JSON object');
    if ((card as Record<string, unknown>).type !== 'AdaptiveCard') throw new Error('card.type must be "AdaptiveCard"');
    return strip(card) as Card;
};
