import { randomBytes } from 'node:crypto';
import type { SessionEvent } from '../claude/api.ts';
import { channelOf } from '../conversations/conversations.ts';
import { type CardJson, type ChannelRef, MessageGoneError } from '../core/platform.ts';
import { cardHeader, type Person } from '../core/text.ts';
import type { Card, SessionEntry } from '../store/entities.ts';
import type { Switchboard } from '../switchboard.ts';
import {
    buttonTitle,
    CardError,
    CLOSED_STATUS,
    type ConfirmationDetails,
    confirmationCard,
    lockedStatus,
    prepareAgentCard,
    summariseInput,
    VERB_ALLOW,
    VERB_DENY,
    withoutButtons,
} from './cards.ts';

export interface CardClick {
    cardId: string;
    verb: string;
    /** `action.data` with the input values, as Teams delivered it. */
    data: Record<string, unknown>;
    by: Person;
    /** Where the click came from (verified by the platform). */
    channel: ChannelRef;
    rootId: string | undefined;
}

export const newCardId = () => `card_${randomBytes(12).toString('base64url')}`;

/** The click as histories show it later; the verb of a confirmation is its decision. */
const lastClick = (click: CardClick, at: Date, data: string) => ({
    lastClickVerb: click.verb,
    lastClickBy: click.by.name ?? 'unknown',
    lastClickAad: click.by.aadObjectId,
    lastClickAt: at.toISOString(),
    lastClickData: data,
});

/** Agent cards and tool confirmations: showing, updating, the first click wins, closing when the session ends. */
export class CardService {
    readonly #sb: Switchboard;

    constructor(sb: Switchboard) {
        this.#sb = sb;
    }

    /** What the card shows now. */
    render(card: Card): CardJson {
        if (card.kind === 'confirmation') {
            const details = JSON.parse(card.json) as ConfirmationDetails;
            return confirmationCard(card.cardId, {
                ...details,
                ...(card.state === 'closed' && !card.lockedChoice ? { closed: true } : {}),
                ...(card.lockedChoice === 'allow' || card.lockedChoice === 'deny'
                    ? { decision: card.lockedChoice, by: card.lockedBy ?? 'someone' }
                    : {}),
            });
        }
        const json = JSON.parse(card.json) as CardJson;
        if (card.state === 'closed') return withoutButtons(json, CLOSED_STATUS);
        if (card.state === 'locked') return withoutButtons(json, lockedStatus(card.lockedBy, card.lockedChoice ?? ''));
        return json;
    }

    /** Shows the card's current state in Teams; `activity` when the change counts as activity. */
    async #refresh(card: Card, activity: boolean) {
        if (!card.activityId) return;
        await this.#sb.conversations.edit(
            channelOf(card),
            card.rootId,
            card.activityId,
            { card: this.render(card) },
            { kind: 'card', sessionId: card.sessionId, activity }
        );
    }

    /** Posts a card that is recorded already and remembers the Teams message that shows it. */
    async #post(card: Card, json: CardJson) {
        const sb = this.#sb;
        const { messageId } = await sb.conversations.post(
            channelOf(card),
            card.rootId,
            { card: json },
            { kind: 'card', sessionId: card.sessionId }
        );
        await sb.entities.cards.modify(card.cardId, '', (current) => ({ ...current, activityId: messageId }));
    }

    /** `show_card`: posts the card in the session's thread. */
    async show(entry: SessionEntry, json: unknown): Promise<string> {
        const sb = this.#sb;
        if (!entry.rootId)
            throw new CardError('this session has no conversation yet; use convert_to_conversation first');
        const cardId = newCardId();
        const prepared = prepareAgentCard(json, cardId);
        const card: Card = {
            cardId,
            kind: 'agent',
            sessionId: entry.sessionId,
            teamId: entry.teamId,
            channelId: entry.channelId,
            rootId: entry.rootId,
            json: JSON.stringify(prepared),
            state: 'open',
            createdAt: sb.now().toISOString(),
        };
        await sb.entities.cards.upsert(card);
        await this.#post(card, prepared);
        return cardId;
    }

    /** `update_card`: replaces the card in place and unlocks it. */
    async update(entry: SessionEntry, cardId: string, json: unknown) {
        const sb = this.#sb;
        const prepared = prepareAgentCard(json, cardId);
        let updated: Card | undefined;
        let problem: string | undefined;
        await sb.entities.cards.modify(cardId, '', (current) => {
            if (current.sessionId !== entry.sessionId || current.kind !== 'agent') {
                problem = 'this card belongs to another session';
                return undefined;
            }
            if (current.state === 'closed') {
                problem = 'card is closed';
                return undefined;
            }
            updated = {
                ...current,
                json: JSON.stringify(prepared),
                state: 'open',
                lockedBy: undefined,
                lockedAad: undefined,
                lockedAt: undefined,
                lockedChoice: undefined,
            };
            return updated;
        });
        if (problem) throw new CardError(problem);
        if (!updated) throw new CardError(`unknown card '${cardId}'`);
        await this.#refresh(updated, true).catch((error: unknown) => {
            throw error instanceof MessageGoneError ? new CardError('the card was deleted in Teams') : error;
        });
    }

    /**
     * A click on an agent card. The first click locks the card (conditional write) and reaches the session once;
     * every other click gets the card's current state. Returns what Teams should show at once.
     */
    async click(click: CardClick): Promise<CardJson | { message: string }> {
        const sb = this.#sb;
        const stored = await sb.entities.cards.get(click.cardId);
        if (!stored || stored.value.kind !== 'agent') return { message: 'This card is no longer known.' };
        const card = stored.value;
        const fromCard =
            card.teamId === click.channel.teamId &&
            card.channelId === click.channel.channelId &&
            (click.rootId === undefined || click.rootId === card.rootId);
        if (!fromCard) return { message: 'This click does not come from the card’s channel.' };
        if (card.state !== 'open') return this.render(card);
        const at = sb.now();
        const data = JSON.stringify(click.data, null, 2);
        const locked = await sb.entities.cards.update(stored, {
            ...card,
            state: 'locked',
            lockedBy: click.by.name ?? 'Someone',
            lockedAad: click.by.aadObjectId,
            lockedAt: at.toISOString(),
            lockedChoice: buttonTitle(JSON.parse(card.json) as CardJson, click.verb),
            ...lastClick(click, at, data),
        });
        if (!locked) {
            const latest = await sb.entities.cards.get(click.cardId);
            return latest ? this.render(latest.value) : { message: 'This card is no longer known.' };
        }
        await sb.conversations.touch(card.channelId, card.rootId);
        const session = await sb.sessions.get(card.sessionId);
        if (session?.state !== 'active') return this.render(locked.value);
        try {
            const text = `${cardHeader(card.cardId, click.verb, click.by, at)}\n${data}`;
            await sb.sessions.send(session, [{ type: 'text', text }]);
        } catch (error) {
            // the agent did not get the click: unlock the card, so the click can be repeated
            sb.log.warn({ err: error, cardId: card.cardId }, 'card click not delivered');
            await sb.entities.cards.update(locked, card);
            return { message: 'The agent could not be reached; please try again.' };
        }
        return this.render(locked.value);
    }

    /** A tool set to "always ask" waits for a person: posts the confirmation card once per tool use. */
    async askConfirmation(entry: SessionEntry, event: SessionEvent) {
        const sb = this.#sb;
        if (!entry.rootId) return;
        if (event.type !== 'agent.tool_use' && event.type !== 'agent.mcp_tool_use') return;
        const cardId = `conf_${event.id}`;
        const toolName = event.type === 'agent.mcp_tool_use' ? `${event.mcp_server_name} / ${event.name}` : event.name;
        const details: ConfirmationDetails = { toolName, input: summariseInput(event.input) };
        const inserted = await sb.entities.cards.insert({
            cardId,
            kind: 'confirmation',
            sessionId: entry.sessionId,
            teamId: entry.teamId,
            channelId: entry.channelId,
            rootId: entry.rootId,
            json: JSON.stringify(details),
            state: 'open',
            toolUseId: event.id,
            createdAt: sb.now().toISOString(),
        });
        const card = inserted?.value ?? (await sb.entities.cards.get(cardId))?.value;
        // a card recorded before but never posted (the post failed, or its pod died) is posted now
        if (!card || card.activityId) return;
        await this.#post(card, confirmationCard(cardId, details));
    }

    /** A click on a confirmation card: the first decision is sent to the session as a tool confirmation. */
    async confirm(click: CardClick): Promise<CardJson | { message: string }> {
        const sb = this.#sb;
        const stored = await sb.entities.cards.get(click.cardId);
        if (!stored || stored.value.kind !== 'confirmation') return { message: 'This card is no longer known.' };
        const card = stored.value;
        if (card.teamId !== click.channel.teamId || card.channelId !== click.channel.channelId) {
            return { message: 'This click does not come from the card’s channel.' };
        }
        if (card.state !== 'open' || (click.verb !== VERB_ALLOW && click.verb !== VERB_DENY)) return this.render(card);
        const decision = click.verb === VERB_ALLOW ? 'allow' : 'deny';
        const at = sb.now();
        const decided = await sb.entities.cards.update(stored, {
            ...card,
            state: 'locked',
            lockedBy: click.by.name ?? 'Someone',
            lockedAad: click.by.aadObjectId,
            lockedAt: at.toISOString(),
            lockedChoice: decision,
            ...lastClick(click, at, '{}'),
        });
        if (!decided) {
            const latest = await sb.entities.cards.get(click.cardId);
            return latest ? this.render(latest.value) : { message: 'This card is no longer known.' };
        }
        await sb.conversations.touch(card.channelId, card.rootId);
        const session = await sb.sessions.get(card.sessionId);
        if (session?.state === 'active' && card.toolUseId) {
            try {
                await sb.sessions.sendEvents(session, [
                    {
                        type: 'user.tool_confirmation',
                        tool_use_id: card.toolUseId,
                        result: decision,
                        ...(decision === 'deny'
                            ? { deny_message: `Denied by ${click.by.name ?? 'a person'} in Teams.` }
                            : {}),
                    },
                ]);
            } catch (error) {
                // the decision did not reach the session: open the card again, so it can be decided again
                sb.log.warn({ err: error, cardId: card.cardId }, 'tool confirmation not delivered');
                await sb.entities.cards.update(decided, card);
                return { message: 'The agent could not be reached; please try again.' };
            }
        }
        return this.render(decided.value);
    }

    /** The session ended: its open cards close for good (decided confirmations keep their decision). */
    async closeAll(sessionId: string) {
        const sb = this.#sb;
        const cards = await sb.entities.cards.list({ where: [{ field: 'sessionId', op: 'eq', value: sessionId }] });
        for (const { value: card } of cards) {
            const decidedConfirmation = card.kind === 'confirmation' && card.state !== 'open';
            if (card.state === 'closed' || decidedConfirmation) continue;
            const closed = await sb.entities.cards.modify(card.cardId, '', (current) =>
                current.state === 'closed' ? undefined : { ...current, state: 'closed' }
            );
            if (!closed) continue;
            await this.#refresh(closed.value, false).catch((error: unknown) => {
                if (error instanceof MessageGoneError)
                    sb.log.debug({ cardId: card.cardId }, 'closed card deleted in Teams');
                else sb.log.warn({ err: error, cardId: card.cardId }, 'closed card not updated in Teams');
            });
        }
    }
}
