import sharp from 'sharp';
import type { ContentBlock } from '../claude/templates.ts';
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

/** An attachment as recorded with a message: passed on (with its file ID) or not (with the reason). */
export interface AttachmentRef {
    name: string;
    mediaType: string;
    size: number;
    fileId?: string;
    unsupported?: string;
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

    /** Passes on the attachments of an incoming message; records the uploads with their conversation. */
    async prepare(workspaceId: string, owner: string, attachments: IncomingAttachment[]): Promise<PreparedAttachments> {
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
            const fileId = await this.#upload(
                workspaceId,
                owner,
                handler,
                attachment.name,
                attachment.data,
                attachment.mediaType
            );
            if (!fileId) {
                prepared.rejected.push({ ...ref, unsupported: 'could not be processed' });
                continue;
            }
            prepared.blocks.push(handler.block(fileId));
            prepared.refs.push({ ...ref, fileId });
        }
        return prepared;
    }

    /** Uploads an image from a thread's history; `undefined` when it is not an image Claude takes. */
    async uploadImage(workspaceId: string, owner: string, name: string, data: Uint8Array, mediaType: string) {
        if (!imageHandler.accepts({ name, mediaType, size: data.byteLength })) return undefined;
        if (data.byteLength > this.#sb.settings.attachmentMaxBytes) return undefined;
        return this.#upload(workspaceId, owner, imageHandler, name, data, mediaType);
    }

    async #upload(
        workspaceId: string,
        owner: string,
        handler: Handler,
        name: string,
        original: Uint8Array,
        originalType: string
    ): Promise<string | undefined> {
        const sb = this.#sb;
        try {
            const { data, mediaType } = await handler.prepare({
                name,
                mediaType: originalType,
                size: original.byteLength,
                data: original,
            });
            const fileId = await sb.workspaces.get(workspaceId).uploadFile(name, mediaType, data);
            await sb.entities.files.upsert({
                owner,
                fileId,
                workspaceId,
                kind: 'image',
                mediaType,
                name,
                size: data.byteLength,
                createdAt: sb.now().toISOString(),
            });
            sb.log.debug({ fileId, size: data.byteLength }, 'image passed on');
            return fileId;
        } catch (error) {
            sb.log.warn({ err: error, size: original.byteLength }, 'image not passed on');
            return undefined;
        }
    }
}
