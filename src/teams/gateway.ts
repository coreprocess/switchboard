import { Activity, type ConversationReference } from '@microsoft/agents-activity';
import { CloudAdapter } from '@microsoft/agents-hosting';
import { z } from 'zod';
import type { ChannelGateway, ChannelRef, OutboundContent } from '../core/gateway.ts';
import type { Entities, TeamsRef } from '../store/entities.ts';
import { splitConversationId } from './activity.ts';

const BOT_FRAMEWORK_SCOPE = 'https://api.botframework.com';
const ADAPTIVE_CARD = 'application/vnd.microsoft.card.adaptive';

/** Hosts Teams serves attachment content from; nothing else is fetched with the bot's token. */
const ATTACHMENT_HOSTS = [/^smba\.trafficmanager\.net$/, /\.botframework\.com$/, /\.asm\.skype\.com$/];

export interface TeamsGatewayOptions {
    adapter: CloudAdapter;
    entities: Entities;
    /** The bot's app ID (Entra app registration); empty only in local anonymous mode. */
    botAppId: string;
    /** Hosts attachments may be downloaded from (tests); Microsoft's hosts by default, HTTPS only. */
    attachmentHosts?: RegExp[];
}

export const toActivity = (content: OutboundContent): Activity =>
    Activity.fromObject(
        content.card
            ? { type: 'message', attachments: [{ contentType: ADAPTIVE_CARD, content: content.card }] }
            : { type: 'message', text: content.text, textFormat: 'markdown' }
    );

const TeamDetails = z.looseObject({ id: z.string(), name: z.string().nullish(), aadGroupId: z.string().nullish() });
const TeamChannels = z.looseObject({
    conversations: z.array(z.looseObject({ id: z.string(), name: z.string().nullish() })),
});

/** Teams behind the platform boundary: posting into channels proactively, team details, attachment downloads. */
export class TeamsGateway implements ChannelGateway {
    readonly #adapter: CloudAdapter;
    readonly #entities: Entities;
    readonly #botAppId: string;
    /** `{ aud: <app id> }`, what the adapter derives from the app ID; also valid in anonymous development mode. */
    readonly #identity: ReturnType<typeof CloudAdapter.createIdentity>;
    readonly #attachmentHosts: RegExp[] | undefined;

    constructor(options: TeamsGatewayOptions) {
        this.#attachmentHosts = options.attachmentHosts;
        this.#adapter = options.adapter;
        this.#entities = options.entities;
        this.#botAppId = options.botAppId;
        this.#identity = CloudAdapter.createIdentity(options.botAppId);
    }

    /** A token of the bot's app registration (workload identity); `undefined` in anonymous development mode. */
    async token(scope: string): Promise<string | undefined> {
        if (!this.#botAppId) return undefined;
        return this.#adapter.connectionManager.getDefaultConnection().getAccessToken(scope);
    }

    async #reference(teamId: string): Promise<TeamsRef> {
        const ref = (await this.#entities.teamsRefs.get(teamId))?.value;
        if (!ref) throw new Error('Switchboard has not seen this team yet: add the app to the team or mention it once');
        return ref;
    }

    #threadReference(ref: TeamsRef, channel: ChannelRef, rootId: string): ConversationReference {
        return {
            channelId: 'msteams',
            serviceUrl: ref.serviceUrl,
            agent: { id: ref.botId },
            conversation: {
                id: `${channel.channelId};messageid=${rootId}`,
                isGroup: true,
                conversationType: 'channel',
                tenantId: ref.tenantId,
            },
        };
    }

    async postThread(channel: ChannelRef, content: OutboundContent) {
        const ref = await this.#reference(channel.teamId);
        let conversationId: string | undefined;
        await this.#adapter.createConversationAsync(
            this.#botAppId,
            'msteams',
            ref.serviceUrl,
            BOT_FRAMEWORK_SCOPE,
            {
                isGroup: true,
                agent: { id: ref.botId },
                tenantId: ref.tenantId,
                channelData: { channel: { id: channel.channelId }, tenant: { id: ref.tenantId } },
                activity: toActivity(content),
            },
            async (context) => {
                conversationId = context.activity.conversation?.id;
            }
        );
        const rootId = conversationId ? splitConversationId(conversationId).rootId : undefined;
        if (!rootId) throw new Error('Teams did not return the new thread’s ID');
        return { rootId, url: await this.messageUrl(channel, rootId, rootId) };
    }

    async reply(channel: ChannelRef, rootId: string, content: OutboundContent) {
        const ref = await this.#reference(channel.teamId);
        let messageId: string | undefined;
        await this.#adapter.continueConversation(
            this.#identity,
            this.#threadReference(ref, channel, rootId),
            async (context) => {
                messageId = (await context.sendActivity(toActivity(content)))?.id;
            }
        );
        if (!messageId) throw new Error('Teams did not return the reply’s ID');
        return { messageId };
    }

    async update(channel: ChannelRef, rootId: string, messageId: string, content: OutboundContent) {
        const ref = await this.#reference(channel.teamId);
        const reference = this.#threadReference(ref, channel, rootId);
        await this.#adapter.continueConversation(this.#identity, reference, async (context) => {
            const activity = toActivity(content);
            activity.id = messageId;
            activity.conversation = reference.conversation;
            await context.updateActivity(activity);
        });
    }

    async delete(channel: ChannelRef, rootId: string, messageId: string) {
        const ref = await this.#reference(channel.teamId);
        await this.#adapter.continueConversation(
            this.#identity,
            this.#threadReference(ref, channel, rootId),
            async (context) => {
                await context.deleteActivity(messageId);
            }
        );
    }

    async messageUrl(channel: ChannelRef, rootId: string, messageId: string) {
        const ref = (await this.#entities.teamsRefs.get(channel.teamId))?.value;
        const params = new URLSearchParams({ parentMessageId: rootId });
        if (ref) params.set('tenantId', ref.tenantId);
        if (ref?.aadGroupId) params.set('groupId', ref.aadGroupId);
        return `https://teams.microsoft.com/l/message/${encodeURIComponent(channel.channelId)}/${messageId}?${params}`;
    }

    async #botFramework(ref: TeamsRef, path: string): Promise<unknown> {
        const token = await this.token(BOT_FRAMEWORK_SCOPE);
        const response = await fetch(
            new URL(path, ref.serviceUrl.endsWith('/') ? ref.serviceUrl : `${ref.serviceUrl}/`),
            {
                headers: token ? { authorization: `Bearer ${token}` } : {},
            }
        );
        if (!response.ok) throw new Error(`Bot Framework ${path}: HTTP ${response.status}`);
        return response.json();
    }

    /** The team's name and Microsoft 365 group ID (Graph needs the group ID). */
    async teamDetails(teamId: string): Promise<{ name: string | undefined; aadGroupId: string | undefined }> {
        const ref = await this.#reference(teamId);
        const details = TeamDetails.parse(await this.#botFramework(ref, `v3/teams/${encodeURIComponent(teamId)}`));
        return { name: details.name ?? undefined, aadGroupId: details.aadGroupId ?? undefined };
    }

    /**
     * The channel's display name (the General channel has none in the API), and whether the team's channel list
     * shows it: private and shared channels are missing there.
     */
    async channelInfo(teamId: string, channelId: string): Promise<{ name: string | undefined; listed: boolean }> {
        const ref = await this.#reference(teamId);
        const channels = TeamChannels.parse(
            await this.#botFramework(ref, `v3/teams/${encodeURIComponent(teamId)}/conversations`)
        );
        const channel = channels.conversations.find((c) => c.id === channelId);
        if (!channel) return { name: undefined, listed: false };
        return { name: channel.name ?? (channelId === teamId ? 'General' : undefined), listed: true };
    }

    /** Downloads an attachment Teams serves with the bot's token; other hosts are refused. */
    async download(contentUrl: string): Promise<{ data: Uint8Array; mediaType: string | undefined }> {
        const url = new URL(contentUrl);
        const hosts = this.#attachmentHosts ?? ATTACHMENT_HOSTS;
        const secure = url.protocol === 'https:' || this.#attachmentHosts !== undefined;
        if (!secure || !hosts.some((host) => host.test(url.hostname))) {
            throw new Error(`attachment host ${url.hostname} is not allowed`);
        }
        const token = await this.token(BOT_FRAMEWORK_SCOPE);
        const response = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
        if (!response.ok) throw new Error(`attachment download: HTTP ${response.status}`);
        return {
            data: new Uint8Array(await response.arrayBuffer()),
            mediaType: response.headers.get('content-type') ?? undefined,
        };
    }
}
