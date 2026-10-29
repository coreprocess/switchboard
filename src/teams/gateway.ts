import { Activity, type ConversationReference } from '@microsoft/agents-activity';
import { CloudAdapter } from '@microsoft/agents-hosting';
import type { ChannelsConfig } from '../config/channels.ts';
import type { ChannelGateway, OutboundContent } from '../core/gateway.ts';
import type { ConversationRecord, Store } from '../store/store.ts';
import { splitConversationId } from './access.ts';

const BOT_FRAMEWORK_AUDIENCE = 'https://api.botframework.com';
const ADAPTIVE_CARD = 'application/vnd.microsoft.card.adaptive';

export interface TeamsGatewayOptions {
    adapter: CloudAdapter;
    store: Store;
    config: ChannelsConfig;
    /** The bot's app ID (Entra app registration); empty only in local anonymous mode. */
    botAppId: string;
}

export const toActivity = (content: OutboundContent): Activity =>
    Activity.fromObject(
        content.card
            ? { type: 'message', attachments: [{ contentType: ADAPTIVE_CARD, content: content.card }] }
            : { type: 'message', text: content.text, textFormat: 'markdown' }
    );

/** Link to a channel message in the Teams client. */
export const messageUrl = (ref: ConversationRecord, rootId: string, messageId: string) => {
    const params = new URLSearchParams({ tenantId: ref.tenantId, parentMessageId: rootId });
    if (ref.aadGroupId) params.set('groupId', ref.aadGroupId);
    return `https://teams.microsoft.com/l/message/${encodeURIComponent(ref.channelId)}/${messageId}?${params}`;
};

/** Posts into bound Teams channels proactively, with the conversation reference stored for each channel. */
export class TeamsGateway implements ChannelGateway {
    readonly #adapter: CloudAdapter;
    readonly #store: Store;
    readonly #config: ChannelsConfig;
    readonly #botAppId: string;
    /** `{ aud: <app id> }`, what the adapter derives from the app ID; also valid in anonymous development mode. */
    readonly #identity: ReturnType<typeof CloudAdapter.createIdentity>;

    constructor(options: TeamsGatewayOptions) {
        this.#adapter = options.adapter;
        this.#store = options.store;
        this.#config = options.config;
        this.#botAppId = options.botAppId;
        this.#identity = CloudAdapter.createIdentity(options.botAppId);
    }

    async #reference(channelKey: string): Promise<ConversationRecord> {
        const channel = this.#config.channels[channelKey];
        if (!channel) throw new Error(`unknown channel '${channelKey}'`);
        const stored = await this.#store.getConversation(channelKey);
        if (stored) return stored;
        if (!this.#config.service_url) {
            throw new Error(
                `no conversation reference for channel '${channelKey}' yet: add the app to the team or mention the bot once`
            );
        }
        return {
            channelKey,
            serviceUrl: this.#config.service_url,
            tenantId: this.#config.tenant_id,
            channelId: channel.channel_id,
            teamId: channel.team_id,
            aadGroupId: channel.team_aad_group_id,
            botId: `28:${this.#botAppId}`,
            updatedAt: new Date().toISOString(),
        };
    }

    #threadReference(ref: ConversationRecord, rootId: string): ConversationReference {
        return {
            channelId: 'msteams',
            serviceUrl: ref.serviceUrl,
            agent: { id: ref.botId },
            conversation: {
                id: `${ref.channelId};messageid=${rootId}`,
                isGroup: true,
                conversationType: 'channel',
                tenantId: ref.tenantId,
            },
        };
    }

    async postTopLevel(channelKey: string, content: OutboundContent) {
        const ref = await this.#reference(channelKey);
        let conversationId: string | undefined;
        await this.#adapter.createConversationAsync(
            this.#botAppId,
            'msteams',
            ref.serviceUrl,
            BOT_FRAMEWORK_AUDIENCE,
            {
                isGroup: true,
                agent: { id: ref.botId },
                tenantId: ref.tenantId,
                channelData: { channel: { id: ref.channelId }, tenant: { id: ref.tenantId } },
                activity: toActivity(content),
            },
            async (context) => {
                conversationId = context.activity.conversation?.id;
            }
        );
        const rootId = conversationId ? splitConversationId(conversationId).rootId : undefined;
        if (!rootId) throw new Error(`Teams did not return the new thread's ID (conversation '${conversationId}')`);
        return { rootId, url: messageUrl(ref, rootId, rootId) };
    }

    async reply(channelKey: string, rootId: string, content: OutboundContent) {
        const ref = await this.#reference(channelKey);
        let messageId: string | undefined;
        await this.#adapter.continueConversation(
            this.#identity,
            this.#threadReference(ref, rootId),
            async (context) => {
                messageId = (await context.sendActivity(toActivity(content)))?.id;
            }
        );
        if (!messageId) throw new Error('Teams did not return the reply ID');
        return { messageId };
    }

    async update(channelKey: string, rootId: string, messageId: string, content: OutboundContent) {
        const ref = await this.#reference(channelKey);
        const reference = this.#threadReference(ref, rootId);
        await this.#adapter.continueConversation(this.#identity, reference, async (context) => {
            const activity = toActivity(content);
            activity.id = messageId;
            activity.conversation = reference.conversation;
            await context.updateActivity(activity);
        });
    }

    async delete(channelKey: string, rootId: string, messageId: string) {
        const ref = await this.#reference(channelKey);
        await this.#adapter.continueConversation(
            this.#identity,
            this.#threadReference(ref, rootId),
            async (context) => {
                await context.deleteActivity(messageId);
            }
        );
    }
}
