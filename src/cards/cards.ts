import type { CardJson } from '../core/platform.ts';
import { clip } from '../core/text.ts';

/**
 * Agent cards (README: "Cards"): Switchboard passes an agent's Adaptive Card through unchanged, except that every
 * `Action.Execute` gets `switchboard_card: <card id>` in its data so clicks reach Switchboard. It renders the
 * locked and closed states itself, and the generic confirmation card for tools set to "always ask".
 */

/** Adaptive Card versions Teams renders. */
export const SUPPORTED_VERSIONS = ['1.0', '1.1', '1.2', '1.3', '1.4', '1.5'];

/** Teams accepts about 28 KB per message; the card has to fit with its envelope. */
export const MAX_CARD_BYTES = 25_000;

export const CARD_DATA_KEY = 'switchboard_card';
export const CONFIRMATION_DATA_KEY = 'switchboard_confirmation';
export const VERB_ALLOW = 'switchboard.allow';
export const VERB_DENY = 'switchboard.deny';

export class CardError extends Error {}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** Calls `visit` for every object in the card, depth first; `visit` may replace the object. */
const transform = (value: unknown, visit: (object: Json) => Json | undefined): unknown => {
    if (Array.isArray(value)) {
        return value.map((item) => transform(item, visit)).filter((item) => item !== undefined);
    }
    if (!isObject(value)) return value;
    const children = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, transform(child, visit)]));
    return visit(children);
};

/** Checks an agent's card and returns it with Switchboard's card ID in every `Action.Execute`. */
export const prepareAgentCard = (card: unknown, cardId: string): CardJson => {
    if (!isObject(card) || card.type !== 'AdaptiveCard')
        throw new CardError('card must be an object with "type": "AdaptiveCard"');
    if (typeof card.version !== 'string' || !SUPPORTED_VERSIONS.includes(card.version)) {
        throw new CardError(`card "version" must be one of ${SUPPORTED_VERSIONS.join(', ')}`);
    }
    const prepared = transform(card, (object) => {
        if (object.type === 'Action.Submit') {
            throw new CardError('Action.Submit is not supported, use Action.Execute');
        }
        if (object.type !== 'Action.Execute') return object;
        if (object.data !== undefined && !isObject(object.data)) {
            throw new CardError('the "data" of an Action.Execute must be an object');
        }
        return { ...object, data: { ...(object.data ?? {}), [CARD_DATA_KEY]: cardId } };
    }) as CardJson;
    const bytes = Buffer.byteLength(JSON.stringify(prepared));
    if (bytes > MAX_CARD_BYTES) throw new CardError(`card is ${bytes} bytes; Teams allows at most ${MAX_CARD_BYTES}`);
    return prepared;
};

/** The title of the button that was clicked: the first `Action.Execute` with that verb. */
export const buttonTitle = (card: CardJson, verb: string): string => {
    let title: string | undefined;
    transform(card, (object) => {
        if (title === undefined && object.type === 'Action.Execute' && object.verb === verb) {
            title = typeof object.title === 'string' ? object.title : undefined;
        }
        return object;
    });
    return title ?? verb;
};

/** The card without its `Action.Execute` buttons (and action sets left empty), with a status line at the end. */
export const withoutButtons = (card: CardJson, status: string): CardJson => {
    const stripped = transform(card, (object) => {
        if (object.type === 'Action.Execute') return undefined;
        // a removed `selectAction` is left as `undefined`, which serialises as absent
        const next = { ...object };
        if (next.type === 'ActionSet' && Array.isArray(next.actions) && next.actions.length === 0) return undefined;
        if (Array.isArray(next.actions) && next.actions.length === 0) delete next.actions;
        return next;
    }) as CardJson;
    const body = Array.isArray(stripped.body) ? stripped.body : [];
    return {
        ...stripped,
        body: [...body, { type: 'TextBlock', text: status, wrap: true, isSubtle: true, separator: true }],
    };
};

export const lockedStatus = (name: string | undefined, choice: string) =>
    `⏳ ${clip(name ?? 'Someone', 80)} chose "${clip(choice, 80)}" – waiting for the agent`;

export const CLOSED_STATUS = 'Closed – the session ended';

export interface ConfirmationDetails {
    toolName: string;
    /** Short summary of the tool input. */
    input: string;
    decision?: 'allow' | 'deny';
    by?: string;
    closed?: boolean;
}

/** The platform's native tool confirmation (a tool set to "always ask"), as a card with Approve and Deny. */
export const confirmationCard = (cardId: string, details: ConfirmationDetails): CardJson => {
    const status = details.closed
        ? CLOSED_STATUS
        : details.decision === 'allow'
          ? `✅ Approved by ${clip(details.by ?? 'someone', 80)}`
          : details.decision === 'deny'
            ? `❌ Denied by ${clip(details.by ?? 'someone', 80)}`
            : undefined;
    const data = { [CONFIRMATION_DATA_KEY]: cardId };
    return {
        type: 'AdaptiveCard',
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version: '1.5',
        body: [
            { type: 'TextBlock', text: 'The agent asks to use a tool', weight: 'Bolder', size: 'Medium', wrap: true },
            { type: 'FactSet', facts: [{ title: 'Tool', value: clip(details.toolName, 200) }] },
            { type: 'TextBlock', text: clip(details.input, 2_000), wrap: true, fontType: 'Monospace', size: 'Small' },
            ...(status ? [{ type: 'TextBlock', text: status, wrap: true, isSubtle: true, separator: true }] : []),
        ],
        ...(status
            ? {}
            : {
                  actions: [
                      { type: 'Action.Execute', title: 'Approve', verb: VERB_ALLOW, style: 'positive', data },
                      { type: 'Action.Execute', title: 'Deny', verb: VERB_DENY, style: 'destructive', data },
                  ],
              }),
    };
};

/** A short, readable summary of a tool input for the confirmation card. */
export const summariseInput = (input: unknown): string => clip(JSON.stringify(input, null, 2) ?? '', 2_000);

/** The text a card shows (its TextBlocks and facts), for histories and summaries. */
export const cardText = (card: CardJson): string => {
    const lines: string[] = [];
    transform(card, (object) => {
        if (object.type === 'TextBlock' && typeof object.text === 'string') lines.push(object.text);
        if (object.type === 'FactSet' && Array.isArray(object.facts)) {
            for (const fact of object.facts) {
                if (isObject(fact)) lines.push(`${String(fact.title ?? '')}: ${String(fact.value ?? '')}`);
            }
        }
        return object;
    });
    return lines.join('\n');
};
