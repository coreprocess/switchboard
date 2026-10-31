import { z } from 'zod';
import type { HistoryReader } from '../conversations/conversations.ts';
import type { HistoryMessage } from '../conversations/log.ts';
import type { Binding } from '../store/entities.ts';
import { htmlToMarkdown } from './activity.ts';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const GRAPH_SCOPE = 'https://graph.microsoft.com';

const GraphMessage = z.looseObject({
    id: z.string(),
    messageType: z.string().nullish(),
    createdDateTime: z.string(),
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
});
type GraphMessage = z.infer<typeof GraphMessage>;

const Page = z.looseObject({ value: z.array(GraphMessage), '@odata.nextLink': z.string().nullish() });

/** The visible text of an Adaptive Card: its TextBlocks and facts. */
const cardText = (json: string): string => {
    const lines: string[] = [];
    const walk = (value: unknown) => {
        if (Array.isArray(value)) return value.forEach(walk);
        if (typeof value !== 'object' || value === null) return;
        const object = value as Record<string, unknown>;
        if (object.type === 'TextBlock' && typeof object.text === 'string') lines.push(object.text);
        if (object.type === 'FactSet' && Array.isArray(object.facts)) {
            for (const fact of object.facts as { title?: unknown; value?: unknown }[]) {
                lines.push(`${String(fact.title ?? '')}: ${String(fact.value ?? '')}`);
            }
        }
        Object.values(object).forEach(walk);
    };
    try {
        walk(JSON.parse(json));
    } catch {
        return '';
    }
    return lines.join('\n');
};

const toHistory = (message: GraphMessage): HistoryMessage => {
    const body = message.body?.content ?? '';
    const text = (message.body?.contentType === 'html' ? htmlToMarkdown(body) : body.trim()).replace(
        /!\[[^\]]*\]\([^)]*\)/g,
        '[image not available]'
    );
    const cards = (message.attachments ?? [])
        .filter((a) => a.contentType === 'application/vnd.microsoft.card.adaptive' && a.content)
        .map((a) => `card (state at the time of reading):\n${cardText(a.content ?? '')}`);
    const files = (message.attachments ?? [])
        .filter((a) => a.contentType === 'reference')
        .map((a) => `[attachment] name=${a.name ?? 'file'}`);
    return {
        at: message.createdDateTime,
        name: message.from?.user?.displayName ?? message.from?.application?.displayName ?? 'unknown',
        ...(message.from?.user?.id ? { aad: message.from.user.id } : {}),
        text: [text, ...cards, ...files].filter(Boolean).join('\n'),
        fromApp: !message.from?.user,
    };
};

/** Reads channel threads through Microsoft Graph with the bot's app-only token (resource-specific consent). */
export class GraphHistory implements HistoryReader {
    readonly #token: (scope: string) => Promise<string | undefined>;
    readonly #base: string;

    constructor(token: (scope: string) => Promise<string | undefined>, base = GRAPH) {
        this.#token = token;
        this.#base = base;
    }

    async #get(url: string): Promise<unknown> {
        const token = await this.#token(GRAPH_SCOPE);
        if (!token) throw new Error('no Graph token (anonymous development mode)');
        const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
        if (!response.ok) throw new Error(`Graph: HTTP ${response.status}`);
        return response.json();
    }

    async read(binding: Binding, rootId: string, max: number) {
        if (!binding.aadGroupId) throw new Error('the team’s group ID is not known');
        const thread = `${this.#base}/teams/${encodeURIComponent(binding.aadGroupId)}/channels/${encodeURIComponent(
            binding.channelId
        )}/messages/${encodeURIComponent(rootId)}`;
        const root = GraphMessage.parse(await this.#get(thread));
        const replies: GraphMessage[] = [];
        let next: string | undefined = `${thread}/replies?$top=50`;
        while (next) {
            const page = Page.parse(await this.#get(next));
            replies.push(...page.value);
            next = page['@odata.nextLink'] ?? undefined;
            if (replies.length > max * 2) break;
        }
        const messages = [root, ...replies]
            .filter((m) => !m.messageType || m.messageType === 'message')
            .sort((a, b) => a.createdDateTime.localeCompare(b.createdDateTime));
        const truncated = messages.length > max;
        return { messages: messages.slice(-max).map(toHistory), truncated };
    }
}
