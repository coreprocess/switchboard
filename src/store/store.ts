/**
 * Switchboard's persistent state. Implementations: Azure Table Storage (production) and memory (tests, local
 * development). Every record is small; no implementation needs transactions beyond the conditional writes below.
 */

/** A Teams thread linked to the agent session that receives its replies. */
export interface ThreadLink {
    channelKey: string;
    /** ID of the thread's root message. */
    rootId: string;
    sessionId: string;
    createdAt: string;
    /** Entra object ID of the person who started the thread, or `agent` for threads an agent posted. */
    createdBy: string;
}

/** Relay state of a linked session. */
export interface SessionRecord {
    sessionId: string;
    channelKey: string;
    rootId: string;
    /** The last session event the relay has handled; everything after it is still to be relayed. */
    watermarkEventId: string | undefined;
    /** When the watermark event was created (approximately), to narrow event listings. */
    watermarkAt: string | undefined;
    /** Switchboard sent something into the session and waits for the turn to end (stream state). */
    pending: boolean;
    /** The last event Switchboard sent; a turn only counts as answered at an idle after it. */
    lastSentEventId: string | undefined;
    /** The "working…" message shown in the thread while the turn runs. */
    workingMessageId: string | undefined;
    updatedAt: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface ApprovalRecord {
    cardId: string;
    /** `approval`: request_approval card; `tool_confirmation`: a tool call waiting for `user.tool_confirmation`. */
    kind: 'approval' | 'tool_confirmation';
    sessionId: string;
    channelKey: string;
    rootId: string;
    /** Teams message ID of the card, once posted. */
    messageId: string | undefined;
    title: string;
    summary: string;
    steps: string[];
    /** For `tool_confirmation`: the `agent.tool_use` / `agent.mcp_tool_use` event to confirm. */
    toolUseId: string | undefined;
    status: ApprovalStatus;
    decidedBy: string | undefined;
    decidedByAad: string | undefined;
    decidedAt: string | undefined;
    createdAt: string;
    expiresAt: string | undefined;
}

export interface ApprovalDecisionUpdate {
    status: Exclude<ApprovalStatus, 'pending'>;
    decidedBy: string | undefined;
    decidedByAad: string | undefined;
    decidedAt: string;
}

export interface DecisionResult {
    /** `false` when the card was already decided: the first decision wins. */
    applied: boolean;
    record: ApprovalRecord;
}

/** What Switchboard needs to post into a channel proactively. */
export interface ConversationRecord {
    channelKey: string;
    serviceUrl: string;
    tenantId: string;
    /** Teams channel ID (conversation ID of the channel without `;messageid=`). */
    channelId: string;
    teamId: string | undefined;
    aadGroupId: string | undefined;
    botId: string;
    updatedAt: string;
}

export interface Store {
    /** Creates tables or schemas if they don't exist. */
    init(): Promise<void>;
    /** Fails when the store is unreachable (readiness probe). */
    ping(): Promise<void>;

    getThread(channelKey: string, rootId: string): Promise<ThreadLink | undefined>;
    putThread(link: ThreadLink): Promise<void>;

    getSession(sessionId: string): Promise<SessionRecord | undefined>;
    putSession(record: SessionRecord): Promise<void>;
    listSessionsUpdatedSince(since: string): Promise<SessionRecord[]>;

    /** Creates the card's record; `false` if a record with this card ID exists already. */
    createApproval(record: ApprovalRecord): Promise<boolean>;
    getApproval(cardId: string): Promise<ApprovalRecord | undefined>;
    setApprovalMessageId(cardId: string, messageId: string): Promise<void>;
    /** Applies the decision only while the card is still pending; `undefined` for an unknown card. */
    decideApproval(cardId: string, update: ApprovalDecisionUpdate): Promise<DecisionResult | undefined>;

    getConversation(channelKey: string): Promise<ConversationRecord | undefined>;
    putConversation(record: ConversationRecord): Promise<void>;

    /** Records a webhook event as being processed; `false` if it was recorded before (duplicate delivery). */
    claimWebhookEvent(eventId: string, at: string): Promise<boolean>;
    /** Forgets a claimed event whose processing failed, so a redelivery is processed. */
    releaseWebhookEvent(eventId: string): Promise<void>;
    /** Deletes webhook events recorded before `before`; returns how many. */
    purgeWebhookEvents(before: string): Promise<number>;
}
