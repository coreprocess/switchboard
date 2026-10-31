import sharp from 'sharp';
import type { ContentBlock } from '../claude/templates.ts';
import type { AttachmentRef } from '../conversations/log.ts';
import type { Switchboard } from '../switchboard.ts';

/**
 * Attachments of incoming messages (concept: "Attachments"): one handler per type. v1 passes images on; other
 * types are named in a line for the agent and once in the thread, so further handlers fit in without changing
 * the data model or the message formats.
 */

export interface IncomingAttachment {
    name: string;
    mediaType: string;
    size: number;
    /** The content, when the platform could fetch it. */
    data?: Uint8Array;
    /** Why it could not be fetched. */
    problem?: string;
}

export interface PreparedAttachments {
    /** Content blocks after the message text. */
    blocks: ContentBlock[];
    refs: AttachmentRef[];
    /** Attachments not passed on: named in the message and noted once in the thread. */
    rejected: AttachmentRef[];
}

/** Claude's limits for image input. */
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_SIDE = 8000;
const SCALED_SIDE = 2048;

interface Handler {
    accepts(attachment: IncomingAttachment): boolean;
    prepare(attachment: IncomingAttachment & { data: Uint8Array }): Promise<{ data: Uint8Array; mediaType: string }>;
    block(fileId: string): ContentBlock;
}

/** Images within Claude's limits; larger ones are scaled down and re-encoded. */
const imageHandler: Handler = {
    accepts: (attachment) => IMAGE_TYPES.includes(attachment.mediaType.toLowerCase()),
    prepare: async ({ data, mediaType }) => {
        const image = sharp(data, { animated: false });
        const meta = await image.metadata();
        const tooLarge = (meta.width ?? 0) > MAX_IMAGE_SIDE || (meta.height ?? 0) > MAX_IMAGE_SIDE;
        if (!tooLarge && data.byteLength <= MAX_IMAGE_BYTES) return { data, mediaType };
        const resized = image.resize({
            width: SCALED_SIDE,
            height: SCALED_SIDE,
            fit: 'inside',
            withoutEnlargement: true,
        });
        if (meta.hasAlpha) return { data: await resized.png().toBuffer(), mediaType: 'image/png' };
        return { data: await resized.jpeg({ quality: 85 }).toBuffer(), mediaType: 'image/jpeg' };
    },
    block: (fileId) => ({ type: 'image', source: { type: 'file', file_id: fileId } }),
};

const HANDLERS: Record<string, Handler> = { image: imageHandler };

export class Attachments {
    readonly #sb: Switchboard;

    constructor(sb: Switchboard) {
        this.#sb = sb;
    }

    /** Uploads what can be passed on to the workspace's Files API and records it with its owner. */
    async prepare(
        workspaceId: string,
        owner: string,
        messageId: string,
        attachments: IncomingAttachment[]
    ): Promise<PreparedAttachments> {
        const sb = this.#sb;
        const prepared: PreparedAttachments = { blocks: [], refs: [], rejected: [] };
        const enabled = sb.settings.attachmentTypes.flatMap((type) => (HANDLERS[type] ? [HANDLERS[type]] : []));
        for (const attachment of attachments) {
            const ref = { name: attachment.name, mediaType: attachment.mediaType, size: attachment.size };
            const handler = enabled.find((h) => h.accepts(attachment));
            if (!handler) {
                prepared.rejected.push({ ...ref, unsupported: 'type not supported' });
                continue;
            }
            if (!attachment.data || attachment.problem) {
                prepared.rejected.push({ ...ref, unsupported: attachment.problem ?? 'could not be fetched' });
                continue;
            }
            if (attachment.size > sb.settings.attachmentMaxBytes) {
                prepared.rejected.push({ ...ref, unsupported: 'too large' });
                continue;
            }
            try {
                const { data, mediaType } = await handler.prepare({ ...attachment, data: attachment.data });
                const fileId = await sb.workspaces.get(workspaceId).uploadFile(attachment.name, mediaType, data);
                await sb.entities.files.upsert({
                    owner,
                    fileId,
                    workspaceId,
                    kind: 'attachment',
                    messageId,
                    mediaType,
                    name: attachment.name,
                    size: data.byteLength,
                    createdAt: sb.now().toISOString(),
                });
                prepared.blocks.push(handler.block(fileId));
                prepared.refs.push({ ...ref, mediaType, size: data.byteLength, fileId });
                sb.log.debug({ fileId, size: data.byteLength }, 'attachment passed on');
            } catch (error) {
                sb.log.warn({ err: error, size: attachment.size }, 'attachment not passed on');
                prepared.rejected.push({ ...ref, unsupported: 'could not be processed' });
            }
        }
        return prepared;
    }
}

/** Image blocks for attachments already uploaded (continuations show the images of the latest messages). */
export const imageBlocks = (refs: AttachmentRef[]): ContentBlock[] =>
    refs
        .filter((ref) => ref.fileId && IMAGE_TYPES.includes(ref.mediaType))
        .map((ref) => imageHandler.block(ref.fileId ?? ''));
