import type { ChannelBinding } from '../config/channels.ts';
import type { Card, ChannelGateway } from '../core/gateway.ts';
import type { Logger } from '../core/logger.ts';
import { clip, formatApprovalMarker, sanitiseName } from '../core/text.ts';
import type { Relay } from '../relay/relay.ts';
import type { ApprovalRecord, Store } from '../store/store.ts';
import { userAllowed } from '../teams/access.ts';
import { renderApprovalCard, VERB_APPROVE, VERB_DENY } from './cards.ts';
import { newCardId, postApprovalCard } from './post.ts';

export interface ApprovalRequest {
    channelKey: string;
    rootId: string;
    sessionId: string;
    title: string;
    summary: string;
    steps: string[];
}

/** A click on an approval card's button, from a bound channel. */
export interface CardClick {
    cardId: string;
    verb: string;
    channelKey: string;
    channel: ChannelBinding;
    /** Root message of the thread the click came from. */
    rootId: string | undefined;
    /** Teams message ID of the card that was clicked (`replyToId`). */
    messageId: string | undefined;
    aadObjectId: string | undefined;
    name: string | undefined;
}

/** The answer to a click: the card in its new state, or a message shown only to the person who clicked. */
export type ClickResult = { card: Card } | { message: string };

export interface ApprovalsOptions {
    store: Store;
    gateway: ChannelGateway;
    relay: Relay;
    log: Logger;
    expiryHours: number | undefined;
}

export class Approvals {
    readonly #store: Store;
    readonly #gateway: ChannelGateway;
    readonly #relay: Relay;
    readonly #log: Logger;
    readonly #expiryHours: number | undefined;

    constructor(options: ApprovalsOptions) {
        this.#store = options.store;
        this.#gateway = options.gateway;
        this.#relay = options.relay;
        this.#log = options.log;
        this.#expiryHours = options.expiryHours;
    }

    /** Posts an Approve / Deny card for an agent's `request_approval` call. */
    request(request: ApprovalRequest): Promise<ApprovalRecord> {
        return postApprovalCard(
            this.#store,
            this.#gateway,
            { ...request, cardId: newCardId(), kind: 'approval', toolUseId: undefined },
            this.#expiryHours
        );
    }

    /**
     * Applies a click: only from the card's own channel and message, only by someone allowed there, and only the
     * first decision counts. The agent is told after the click has been answered.
     */
    async click(click: CardClick): Promise<ClickResult> {
        const record = await this.#store.getApproval(click.cardId);
        if (!record) return { message: 'This card is not known to Switchboard.' };
        // The click must come from the card itself: same channel and thread, and the card's message when Teams
        // names it (`replyToId`). Agent cards cannot carry Switchboard's verbs or a card ID (sanitiseAgentCard).
        const foreignMessage = click.messageId !== undefined && record.messageId !== click.messageId;
        if (
            record.channelKey !== click.channelKey ||
            record.rootId !== click.rootId ||
            record.messageId === undefined ||
            foreignMessage
        ) {
            this.#log.warn({ cardId: click.cardId, channelKey: click.channelKey }, 'card click from a foreign card');
            return { message: 'This button does not belong to the approval card.' };
        }
        if (!click.aadObjectId || !userAllowed(click.channel, click.aadObjectId)) {
            return { message: 'You are not allowed to decide this approval.' };
        }
        const now = new Date();
        const expired =
            record.status === 'pending' && record.expiresAt !== undefined && now.toISOString() > record.expiresAt;
        const decision = expired
            ? 'expired'
            : click.verb === VERB_APPROVE
              ? 'approved'
              : click.verb === VERB_DENY
                ? 'denied'
                : undefined;
        if (!decision) return { message: 'Unknown action.' };
        const name = sanitiseName(click.name);
        const result = await this.#store.decideApproval(click.cardId, {
            status: decision,
            decidedBy: expired ? undefined : name,
            decidedByAad: expired ? undefined : click.aadObjectId,
            decidedAt: now.toISOString(),
        });
        if (!result) return { message: 'This card is not known to Switchboard.' };
        const card = renderApprovalCard(result.record);
        if (!result.applied) return { card };
        this.#log.info(
            {
                audit: 'approval',
                cardId: record.cardId,
                kind: record.kind,
                sessionId: record.sessionId,
                channelKey: record.channelKey,
                decision,
                by: click.aadObjectId,
                at: now.toISOString(),
            },
            'approval decided'
        );
        void this.#afterDecision(result.record, card);
        return { card };
    }

    /** Shows the decision to everyone in the thread and passes it to the session. */
    async #afterDecision(record: ApprovalRecord, card: Card) {
        const thread = { channelKey: record.channelKey, rootId: record.rootId };
        if (record.messageId) {
            await this.#gateway
                .update(record.channelKey, record.rootId, record.messageId, { card })
                .catch((error: unknown) => this.#log.warn({ err: error, cardId: record.cardId }, 'card update failed'));
        }
        if (record.status !== 'approved' && record.status !== 'denied') return;
        try {
            if (record.kind === 'tool_confirmation' && record.toolUseId) {
                await this.#relay.sendToolConfirmation(
                    record.sessionId,
                    thread,
                    record.toolUseId,
                    record.status === 'approved',
                    record.decidedBy ?? 'unknown'
                );
                return;
            }
            await this.#relay.sendUserMessage(
                record.sessionId,
                thread,
                formatApprovalMarker({
                    cardId: record.cardId,
                    decision: record.status,
                    name: record.decidedBy,
                    aadObjectId: record.decidedByAad ?? 'unknown',
                    at: new Date(record.decidedAt ?? Date.now()),
                })
            );
        } catch (error) {
            this.#log.error(
                { err: error, cardId: record.cardId, sessionId: record.sessionId },
                'decision not delivered'
            );
            const reason = error instanceof Error ? clip(error.message, 300) : 'unknown error';
            await this.#gateway
                .reply(record.channelKey, record.rootId, {
                    text: `⚠️ The decision was recorded but could not be passed to the agent: ${reason}`,
                })
                .catch((e: unknown) => this.#log.error({ err: e }, 'notice failed'));
        }
    }
}
