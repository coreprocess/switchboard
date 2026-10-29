import { randomBytes } from 'node:crypto';
import type { ChannelGateway } from '../core/gateway.ts';
import type { ApprovalRecord, Store } from '../store/store.ts';
import { renderApprovalCard } from './cards.ts';

export const newCardId = () => `card_${randomBytes(16).toString('base64url')}`;

export type NewApproval = Omit<
    ApprovalRecord,
    'messageId' | 'status' | 'decidedBy' | 'decidedByAad' | 'decidedAt' | 'createdAt' | 'expiresAt'
>;

/**
 * Stores an approval card and posts it into its thread. Idempotent per card ID: a card that was posted is not
 * posted again, so deterministic IDs (tool confirmations) survive a repeated relay pass; one whose post failed is.
 */
export const postApprovalCard = async (
    store: Store,
    gateway: ChannelGateway,
    approval: NewApproval,
    expiryHours: number | undefined
): Promise<ApprovalRecord> => {
    const now = new Date();
    const record: ApprovalRecord = {
        ...approval,
        messageId: undefined,
        status: 'pending',
        decidedBy: undefined,
        decidedByAad: undefined,
        decidedAt: undefined,
        createdAt: now.toISOString(),
        expiresAt: expiryHours ? new Date(now.getTime() + expiryHours * 3_600_000).toISOString() : undefined,
    };
    if (!(await store.createApproval(record))) {
        const existing = await store.getApproval(record.cardId);
        // Posted before, or decided: nothing to do. A pending card whose post failed is posted again.
        if (!existing || existing.messageId !== undefined || existing.status !== 'pending') return existing ?? record;
    }
    const { messageId } = await gateway.reply(record.channelKey, record.rootId, { card: renderApprovalCard(record) });
    await store.setApprovalMessageId(record.cardId, messageId);
    return { ...record, messageId };
};
