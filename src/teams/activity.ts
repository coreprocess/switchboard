import type { Activity } from '@microsoft/agents-activity';
import { NodeHtmlMarkdown } from 'node-html-markdown';
import { z } from 'zod';

/** The parts of Teams' `channelData` Switchboard reads. Untrusted input: parsed, never assumed. */
const TeamsChannelData = z.looseObject({
    tenant: z.looseObject({ id: z.string().optional() }).optional(),
    team: z
        .looseObject({ id: z.string().optional(), aadGroupId: z.string().optional(), name: z.string().optional() })
        .optional(),
    channel: z.looseObject({ id: z.string().optional(), name: z.string().optional() }).optional(),
    /** For `messageUpdate` activities: `editMessage`, `undeleteMessage`, … */
    eventType: z.string().optional(),
});

/** Where an activity came from, as far as Teams tells us. */
export interface TeamsOrigin {
    tenantId: string | undefined;
    conversationType: string | undefined;
    conversationId: string;
    /** The team's `19:…@thread.tacv2` ID, which Teams sends with messages and card clicks alike. */
    teamId: string | undefined;
    /** The team's Microsoft 365 group ID; not sent with card clicks. */
    aadGroupId: string | undefined;
    teamName: string | undefined;
    channelId: string | undefined;
    /** Root message of the thread the activity belongs to (channel conversations only). */
    rootId: string | undefined;
    /** What a `messageUpdate` activity is about (`editMessage` for an edit). */
    eventType: string | undefined;
}

/** `19:…@thread.tacv2;messageid=123` → channel conversation and root message ID. */
export const splitConversationId = (id: string): { channelConversationId: string; rootId: string | undefined } => {
    const match = /^(.*);messageid=([^;]+)$/.exec(id);
    return match?.[1] && match[2]
        ? { channelConversationId: match[1], rootId: match[2] }
        : { channelConversationId: id, rootId: undefined };
};

export const teamsOriginOf = (activity: Activity): TeamsOrigin => {
    const data = TeamsChannelData.safeParse(activity.channelData ?? {});
    const channelData = data.success ? data.data : {};
    const conversationId = activity.conversation?.id ?? '';
    const split = splitConversationId(conversationId);
    return {
        tenantId: (channelData.tenant?.id ?? activity.conversation?.tenantId)?.toLowerCase(),
        conversationType: activity.conversation?.conversationType,
        conversationId,
        teamId: channelData.team?.id,
        aadGroupId: channelData.team?.aadGroupId,
        teamName: channelData.team?.name,
        channelId:
            channelData.channel?.id ?? (conversationId.includes('@thread') ? split.channelConversationId : undefined),
        rootId: split.rootId,
        eventType: channelData.eventType,
    };
};

const botMentions = (activity: Activity) =>
    (activity.entities ?? []).filter((entity) => {
        if (entity.type !== 'mention') return false;
        const mentioned = (entity as { mentioned?: { id?: string } }).mentioned;
        return mentioned?.id !== undefined && mentioned.id === activity.recipient?.id;
    });

export const isBotMentioned = (activity: Activity): boolean => botMentions(activity).length > 0;

const markdown = new NodeHtmlMarkdown({ keepDataImages: false });

/** HTML (Teams messages, Graph message bodies) as Markdown; plain text stays as it is. */
export const htmlToMarkdown = (text: string): string =>
    /<\/?[a-z][^>]*>/i.test(text) ? markdown.translate(text).trim() : text.trim();

/** The message text without the bot's mention, as Markdown; mentions of people become `@Name`. */
export const messageText = (activity: Activity): string => {
    let text = activity.text ?? '';
    for (const mention of botMentions(activity)) {
        const mentionText = (mention as { text?: string }).text;
        if (mentionText) text = text.split(mentionText).join('');
    }
    return htmlToMarkdown(text.replace(/<at>([^<]*)<\/at>/g, '@$1'));
};

export const COMMANDS = ['settings', 'status', 'pause', 'resume', 'run', 'upgrade', 'disconnect'] as const;
export type Command = (typeof COMMANDS)[number];

/** A command: a message that mentions the bot and consists only of the command word. */
export const commandOf = (activity: Activity): Command | undefined => {
    if (!isBotMentioned(activity)) return undefined;
    const word = messageText(activity)
        .toLowerCase()
        .replace(/[.!?]+$/, '')
        .trim();
    return COMMANDS.find((command) => command === word);
};
