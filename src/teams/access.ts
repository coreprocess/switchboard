import type { Activity } from '@microsoft/agents-activity';
import { z } from 'zod';
import type { ChannelBinding, ChannelsConfig } from '../config/channels.ts';

/** The parts of Teams' `channelData` Switchboard reads. Untrusted input: parsed, never assumed. */
const TeamsChannelData = z.looseObject({
    tenant: z.looseObject({ id: z.string().optional() }).optional(),
    team: z.looseObject({ id: z.string().optional(), aadGroupId: z.string().optional() }).optional(),
    channel: z.looseObject({ id: z.string().optional() }).optional(),
});

/** Where an activity came from, as far as Teams tells us. */
export interface TeamsOrigin {
    tenantId: string | undefined;
    conversationType: string | undefined;
    conversationId: string;
    teamId: string | undefined;
    aadGroupId: string | undefined;
    channelId: string | undefined;
    /** Root message of the thread the activity belongs to (channel conversations only). */
    rootId: string | undefined;
}

export type Binding =
    | { bound: true; channelKey: string; channel: ChannelBinding; origin: TeamsOrigin }
    | { bound: false; reason: 'tenant' | 'not_a_channel' | 'not_bound'; origin: TeamsOrigin };

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
    const { rootId } = splitConversationId(conversationId);
    return {
        tenantId: channelData.tenant?.id ?? activity.conversation?.tenantId,
        conversationType: activity.conversation?.conversationType,
        conversationId,
        teamId: channelData.team?.id,
        aadGroupId: channelData.team?.aadGroupId,
        channelId: channelData.channel?.id,
        rootId,
    };
};

/**
 * Whether the activity's team does not contradict the channel's configured team. Teams sends the team's group ID
 * with messages but not with card clicks, so only the IDs present on both sides are compared; the channel ID, which
 * Teams assigns uniquely, has matched already.
 */
const teamConsistent = (channel: ChannelBinding, origin: TeamsOrigin): boolean => {
    if (channel.team_id !== undefined && origin.teamId !== undefined && channel.team_id !== origin.teamId) {
        return false;
    }
    return !(
        channel.team_aad_group_id !== undefined &&
        origin.aadGroupId !== undefined &&
        channel.team_aad_group_id.toLowerCase() !== origin.aadGroupId.toLowerCase()
    );
};

/** Whether the activity comes from a channel bound in the configured tenant, and which. */
export const bindingOf = (config: ChannelsConfig, activity: Activity): Binding => {
    const origin = teamsOriginOf(activity);
    if (origin.tenantId?.toLowerCase() !== config.tenant_id.toLowerCase()) {
        return { bound: false, reason: 'tenant', origin };
    }
    if (origin.conversationType !== 'channel' || !origin.channelId) {
        return { bound: false, reason: 'not_a_channel', origin };
    }
    for (const [channelKey, channel] of Object.entries(config.channels)) {
        if (channel.channel_id === origin.channelId && teamConsistent(channel, origin)) {
            return { bound: true, channelKey, channel, origin };
        }
    }
    return { bound: false, reason: 'not_bound', origin };
};

/**
 * Whether the sender may talk to the agent and approve. Members of the bound team can, which a message or card
 * click from the bound channel shows; `allowlist` narrows that to listed Entra object IDs.
 */
export const userAllowed = (channel: ChannelBinding, aadObjectId: string | undefined): boolean => {
    if (!aadObjectId) return false;
    if (channel.access === 'allowlist') {
        return (channel.allowlist ?? []).some((id) => id.toLowerCase() === aadObjectId.toLowerCase());
    }
    return true;
};

const botMentions = (activity: Activity) =>
    (activity.entities ?? []).filter((entity) => {
        if (entity.type !== 'mention') return false;
        const mentioned = (entity as { mentioned?: { id?: string } }).mentioned;
        return mentioned?.id !== undefined && mentioned.id === activity.recipient?.id;
    });

export const isBotMentioned = (activity: Activity): boolean => botMentions(activity).length > 0;

/** The message text without the bot's mention; mentions of people become `@Name`. */
export const textWithoutBotMention = (activity: Activity): string => {
    let text = activity.text ?? '';
    for (const mention of botMentions(activity)) {
        const mentionText = (mention as { text?: string }).text;
        if (mentionText) text = text.split(mentionText).join('');
    }
    return text.replace(/<at>([^<]*)<\/at>/g, '@$1').trim();
};

/** Teams adds a `text/html` copy of every message as an attachment; anything else is a real attachment. */
export const hasFileAttachments = (activity: Activity): boolean =>
    (activity.attachments ?? []).some((a) => a.contentType !== 'text/html');
