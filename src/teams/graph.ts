import { z } from 'zod';
import { type CardJson, type ImageRef, ReadAccessError, type ThreadMessage } from '../core/platform.ts';
import { htmlToMarkdown } from './activity.ts';

/**
 * Reading Teams channels through Microsoft Graph, app-only with the bot's identity and the team's
 * resource-specific consent (`ChannelMessage.Read.Group`). Graph lists a channel's threads by latest activity and
 * has no sorting or filtering of its own; messages come as HTML, cards as attachments, images as hosted contents.
 */

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
export const GRAPH_SCOPE = 'https://graph.microsoft.com';

const GraphMessage = z.looseObject({
    id: z.string(),
    messageType: z.string().nullish(),
    createdDateTime: z.string(),
    subject: z.string().nullish(),
    deletedDateTime: z.string().nullish(),
    from: z
        .looseObject({
            user: z.looseObject({ id: z.string().nullish(), displayName: z.string().nullish() }).nullish(),
            application: z.looseObject({ displayName: z.string().nullish() }).nullish(),
        })
        .nullish(),
    body: z.looseObject({ contentType: z.string().nullish(), content: z.string().nullish() }).nullish(),
    attachments: z
        .array(
            z.looseObject({
                contentType: z.string().nullish(),
                content: z.string().nullish(),
                name: z.string().nullish(),
            })
        )
        .nullish(),
    replies: z
        .array(
            z.looseObject({
                createdDateTime: z.string(),
                messageType: z.string().nullish(),
                deletedDateTime: z.string().nullish(),
            })
        )
        .nullish(),
});
export type GraphMessage = z.infer<typeof GraphMessage>;

const Page = z.looseObject({ value: z.array(GraphMessage), '@odata.nextLink': z.string().nullish() });

const IMAGE = /<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi;
const ALT = /\balt="([^"]*)"/i;
const MENTION = /<at\b[^>]*>([^<]*)<\/at>/gi;
/** Stands for an image while the HTML becomes Markdown (which would escape the brackets of the marker). */
const IMAGE_TOKEN = / ?\bxsbimagex(\d+)x\b ?/g;

const parseCard = (content: string | null | undefined): CardJson | undefined => {
    if (!content) return undefined;
    try {
        const parsed: unknown = JSON.parse(content);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? (parsed as CardJson)
            : undefined;
    } catch {
        return undefined;
    }
};

/** A Graph channel message as a thread message: Markdown text, images as references, cards and files. */
export const toThreadMessage = (message: GraphMessage): ThreadMessage => {
    const html = message.body?.content ?? '';
    const images: ImageRef[] = [];
    const withoutImages = html.replace(IMAGE, (tag, src: string) => {
        images.push({ ref: src, name: ALT.exec(tag)?.[1] || `image ${images.length + 1}` });
        return ` xsbimagex${images.length - 1}x `;
    });
    const withMentions = withoutImages.replace(MENTION, '@$1');
    const markdown = message.body?.contentType === 'html' ? htmlToMarkdown(withMentions) : withMentions.trim();
    const text = markdown.replace(IMAGE_TOKEN, (token: string, index: string, offset: number, whole: string) => {
        const image = images[Number(index)];
        if (!image) return token;
        // the spaces around the token separate it from words; at the start or end of a line they go
        const end = offset + token.length;
        const before = token.startsWith(' ') && offset > 0 && whole[offset - 1] !== '\n' ? ' ' : '';
        const after = token.endsWith(' ') && end < whole.length && whole[end] !== '\n' ? ' ' : '';
        return `${before}[image: ${image.name}]${after}`;
    });
    const attachments = message.attachments ?? [];
    const user = message.from?.user;
    return {
        messageId: message.id,
        at: message.createdDateTime,
        author: user
            ? { name: user.displayName ?? 'unknown', ...(user.id ? { aadObjectId: user.id } : {}), isApp: false }
            : { name: message.from?.application?.displayName ?? 'app', isApp: true },
        ...(message.subject ? { subject: message.subject } : {}),
        text,
        cards: attachments.flatMap((a) => {
            const card = a.contentType === 'application/vnd.microsoft.card.adaptive' ? parseCard(a.content) : undefined;
            return card ? [card] : [];
        }),
        images,
        files: attachments.filter((a) => a.contentType === 'reference').map((a) => a.name ?? 'file'),
    };
};

/** Whether a Graph item is a message people or apps wrote (not a system event, not deleted). */
export const isMessage = (message: Pick<GraphMessage, 'messageType' | 'deletedDateTime'>) =>
    (!message.messageType || message.messageType === 'message') && !message.deletedDateTime;

export class Graph {
    readonly #token: () => Promise<string | undefined>;
    readonly #base: string;

    constructor(token: () => Promise<string | undefined>, base = GRAPH_BASE) {
        this.#token = token;
        this.#base = base.replace(/\/$/, '');
    }

    /** The Graph URL of a channel; every other URL the bot's token goes to must start with it. */
    channelUrl(groupId: string, channelId: string) {
        return `${this.#base}/teams/${encodeURIComponent(groupId)}/channels/${encodeURIComponent(channelId)}`;
    }

    /**
     * Whether a URL lies within the channel's Graph URL: same origin, no credentials, and the channel's path
     * segments first. Segments are compared decoded (Graph writes channel IDs unencoded in its own URLs, such as
     * image sources), and a segment that decodes to a separator or a dot segment is refused, so nothing encoded can
     * lead out of the channel. Cursors and image references come from Graph's answers and from agents.
     */
    within(scope: string, url: string): boolean {
        const target = parse(url);
        const base = parse(scope);
        if (!target || !base || target.origin !== base.origin || target.username || target.password) return false;
        const targetPath = segments(target);
        const basePath = segments(base);
        if (!targetPath || !basePath || targetPath.length <= basePath.length) return false;
        return basePath.every((segment, index) => targetPath[index] === segment);
    }

    async #fetch(url: string, scope: string): Promise<Response> {
        if (!this.within(scope, url)) throw new Error('Graph URL outside the channel');
        const token = await this.#token();
        // without a token only a test endpoint can be reached (anonymous development mode)
        if (!token && this.#base === GRAPH_BASE) throw new Error('no Graph token');
        const response = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
        // the only reason Graph refuses channel reads to the bot: the team's consent is missing
        if (response.status === 403) throw new ReadAccessError('Switchboard is not allowed to read this channel');
        if (!response.ok) throw new GraphError(response.status);
        return response;
    }

    async page(scope: string, url: string) {
        const response = await this.#fetch(url, scope);
        return Page.parse(await response.json());
    }

    async message(scope: string, url: string) {
        const response = await this.#fetch(url, scope);
        return GraphMessage.parse(await response.json());
    }

    async bytes(scope: string, url: string): Promise<{ data: Uint8Array; mediaType: string }> {
        const response = await this.#fetch(url, scope);
        return {
            data: new Uint8Array(await response.arrayBuffer()),
            mediaType: (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0] ?? '',
        };
    }
}

export class GraphError extends Error {
    readonly status: number;

    constructor(status: number) {
        super(`Graph: HTTP ${status}`);
        this.status = status;
    }
}

const parse = (url: string): URL | undefined => {
    try {
        return new URL(url);
    } catch {
        return undefined;
    }
};

/** The path's segments, decoded; `undefined` when one hides a separator or a dot segment. */
const segments = (url: URL): string[] | undefined => {
    const decoded: string[] = [];
    for (const raw of url.pathname.split('/').filter(Boolean)) {
        let segment: string;
        try {
            segment = decodeURIComponent(raw);
        } catch {
            return undefined;
        }
        if (/[/\\]/.test(segment) || segment === '.' || segment === '..') return undefined;
        decoded.push(segment);
    }
    return decoded;
};
