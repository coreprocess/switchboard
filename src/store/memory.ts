import type {
    ApprovalDecisionUpdate,
    ApprovalRecord,
    ConversationRecord,
    DecisionResult,
    SessionRecord,
    Store,
    ThreadLink,
} from './store.ts';

/** In-process store for tests and local development; state is lost on restart. */
export class MemoryStore implements Store {
    readonly #threads = new Map<string, ThreadLink>();
    readonly #sessions = new Map<string, SessionRecord>();
    readonly #approvals = new Map<string, ApprovalRecord>();
    readonly #conversations = new Map<string, ConversationRecord>();
    readonly #webhookEvents = new Map<string, string>();

    async init(): Promise<void> {
        // nothing to create
    }

    async ping(): Promise<void> {
        // always reachable
    }

    async getThread(channelKey: string, rootId: string) {
        return copy(this.#threads.get(`${channelKey}/${rootId}`));
    }

    async putThread(link: ThreadLink) {
        this.#threads.set(`${link.channelKey}/${link.rootId}`, { ...link });
    }

    async getSession(sessionId: string) {
        return copy(this.#sessions.get(sessionId));
    }

    async putSession(record: SessionRecord) {
        this.#sessions.set(record.sessionId, { ...record });
    }

    async listSessionsUpdatedSince(since: string) {
        return [...this.#sessions.values()].filter((s) => s.updatedAt >= since).map((s) => ({ ...s }));
    }

    async createApproval(record: ApprovalRecord) {
        if (this.#approvals.has(record.cardId)) return false;
        this.#approvals.set(record.cardId, { ...record, steps: [...record.steps] });
        return true;
    }

    async getApproval(cardId: string) {
        const record = this.#approvals.get(cardId);
        return record ? { ...record, steps: [...record.steps] } : undefined;
    }

    async setApprovalMessageId(cardId: string, messageId: string) {
        const record = this.#approvals.get(cardId);
        if (record) record.messageId = messageId;
    }

    async decideApproval(cardId: string, update: ApprovalDecisionUpdate): Promise<DecisionResult | undefined> {
        const record = this.#approvals.get(cardId);
        if (!record) return undefined;
        if (record.status !== 'pending') return { applied: false, record: { ...record, steps: [...record.steps] } };
        Object.assign(record, update);
        return { applied: true, record: { ...record, steps: [...record.steps] } };
    }

    async getConversation(channelKey: string) {
        return copy(this.#conversations.get(channelKey));
    }

    async putConversation(record: ConversationRecord) {
        this.#conversations.set(record.channelKey, { ...record });
    }

    async claimWebhookEvent(eventId: string, at: string) {
        if (this.#webhookEvents.has(eventId)) return false;
        this.#webhookEvents.set(eventId, at);
        return true;
    }

    async releaseWebhookEvent(eventId: string) {
        this.#webhookEvents.delete(eventId);
    }

    async purgeWebhookEvents(before: string) {
        let count = 0;
        for (const [id, at] of this.#webhookEvents) {
            if (at < before) {
                this.#webhookEvents.delete(id);
                count++;
            }
        }
        return count;
    }
}

const copy = <T extends object>(value: T | undefined): T | undefined => (value ? { ...value } : undefined);
