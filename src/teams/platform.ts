import { Activity, type ConversationReference } from '@microsoft/agents-activity';
import { CloudAdapter, type TurnContext } from '@microsoft/agents-hosting';
import { z } from 'zod';
import {
    type ChannelPlatform,
    type ChannelRef,
    CursorError,
    type ImageRef,
    type Mention,
    MessageGoneError,
    type OutboundContent,
    type Page,
    ReadAccessError,
    type ThreadMessage,
    type ThreadSummary,
} from '../core/platform.ts';
import type { Entities, TeamsRef } from '../store/entities.ts';
import { splitConversationId } from './activity.ts';
import { GRAPH_SCOPE, Graph, GraphError, type GraphMessage, isMessage, toThreadMessage } from './graph.ts';

const BOT_FRAMEWORK_SCOPE = 'https://api.botframework.com';
const ADAPTIVE_CARD = 'application/vnd.microsoft.card.adaptive';
const THREADS_PER_PAGE = 20;
const REPLIES_PER_PAGE = 50;
const MESSAGE_ID = /^\d{1,20}$/;

/** Hosts Teams serves attachment content from; nothing else is fetched with the bot's token. */
const ATTACHMENT_HOSTS = [/^smba\.trafficmanager\.net$/, /\.botframework\.com$/, /\.asm\.skype\.com$/];

export interface TeamsPlatformOptions {
    adapter: CloudAdapter;
    entities: Entities;
    /** The bot's app ID (Entra app registration); empty only in local anonymous mode. */
    botAppId: string;
    /** Microsoft Graph's base URL (tests). */
    graphBase?: string;
    /** Hosts attachments may be downloaded from (tests); Microsoft's hosts by default, HTTPS only. */
    attachmentHosts?: RegExp[];
}

const READ_ACCESS_HELP = [
    'Teams no longer grants Switchboard the permission to read this team’s channel messages ' +
        '(`ChannelMessage.Read.Group`); this happens, for example, when the app is updated in place. Until it is ' +
        'restored, messages without @Switchboard do not reach the agents, agents cannot list or read threads, and ' +
        'agents taking over a thread start without its earlier messages.',
    '',
    '**To fix it**, a team owner installs the app again: **Manage team → Apps**, remove Switchboard, then ' +
        '**Upload a custom app** there, choose the app package, select **Add** and accept the permissions.',
].join('\n');

/** `<at>` tags take plain text; Teams shows it as the mention's label. */
const atTag = (mention: Mention) => `<at>${mention.name.replace(/[<>&]/g, '')}</at>`;

/** Mentions go on a line of their own at the end; each needs an entity with the person's ID. */
export const toActivity = (content: OutboundContent): Activity => {
    if (content.card) {
        return Activity.fromObject({
            type: 'message',
            attachments: [{ contentType: ADAPTIVE_CARD, content: content.card }],
        });
    }
    const mentions = content.mentions ?? [];
    return Activity.fromObject({
        type: 'message',
        text: mentions.length > 0 ? `${content.text}\n\n${mentions.map(atTag).join(' ')}` : content.text,
        textFormat: 'markdown',
        ...(mentions.length > 0
            ? {
                  entities: mentions.map((mention) => ({
                      type: 'mention',
                      text: atTag(mention),
                      mentioned: { id: mention.id, name: mention.name },
                  })),
              }
            : {}),
    });
};

const TeamDetails = z.looseObject({ id: z.string(), name: z.string().nullish(), aadGroupId: z.string().nullish() });
const TeamChannels = z.looseObject({
    conversations: z.array(z.looseObject({ id: z.string(), name: z.string().nullish() })),
});

const latest = (root: GraphMessage) =>
    [root.createdDateTime, ...(root.replies ?? []).map((reply) => reply.createdDateTime)].sort().at(-1) ??
    root.createdDateTime;

/** A Bot Framework error that says the message (or its thread) is gone. */
const BotFrameworkError = z.object({
    status: z.number(),
    response: z.object({ data: z.object({ error: z.object({ code: z.string() }).optional() }).optional() }).optional(),
});
const isGone = (error: unknown) => {
    const parsed = BotFrameworkError.safeParse(error);
    if (!parsed.success) return false;
    return parsed.data.status === 404 || parsed.data.response?.data?.error?.code === 'ActivityDeletedInConversation';
};

/** Opaque cursors for agents; they carry a Graph link that is checked against the channel before use. */
const encodeCursor = (link: string) => Buffer.from(link).toString('base64url');
const decodeCursor = (cursor: string) => Buffer.from(cursor, 'base64url').toString('utf8');

/** Teams behind the platform boundary: posting proactively, reading threads through Graph, team details. */
export class TeamsPlatform implements ChannelPlatform {
    readonly #adapter: CloudAdapter;
    readonly #entities: Entities;
    readonly #botAppId: string;
    readonly #graph: Graph;
    readonly #attachmentHosts: RegExp[] | undefined;
    /** `{ aud: <app id> }`, what the adapter derives from the app ID; also valid in anonymous development mode. */
    readonly #identity: ReturnType<typeof CloudAdapter.createIdentity>;
    readonly readAccessHelp = READ_ACCESS_HELP;

    constructor(options: TeamsPlatformOptions) {
        this.#adapter = options.adapter;
        this.#entities = options.entities;
        this.#botAppId = options.botAppId;
        this.#attachmentHosts = options.attachmentHosts;
        this.#identity = CloudAdapter.createIdentity(options.botAppId);
        this.#graph = new Graph(() => this.token(GRAPH_SCOPE), options.graphBase);
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

    // --- posting -----------------------------------------------------------------------------------------------

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
        let messageId: string | undefined;
        await this.#inThread(channel, rootId, async (context) => {
            messageId = (await context.sendActivity(toActivity(content)))?.id;
        });
        if (!messageId) throw new Error('Teams did not return the reply’s ID');
        return { messageId };
    }

    async update(channel: ChannelRef, rootId: string, messageId: string, content: OutboundContent) {
        await this.#inThread(channel, rootId, async (context, reference) => {
            const activity = toActivity(content);
            activity.id = messageId;
            activity.conversation = reference.conversation;
            await context.updateActivity(activity);
        });
    }

    async delete(channel: ChannelRef, rootId: string, messageId: string) {
        await this.#inThread(channel, rootId, async (context) => {
            await context.deleteActivity(messageId);
        });
    }

    /**
     * Runs `work` in a thread on Switchboard's own initiative. The adapter would hand an error to its turn error
     * handler and return as if it had worked; here it reaches the caller, and a deleted message is recognisable.
     */
    async #inThread(
        channel: ChannelRef,
        rootId: string,
        work: (context: TurnContext, reference: ConversationReference) => Promise<void>
    ) {
        const reference = this.#threadReference(await this.#reference(channel.teamId), channel, rootId);
        let failure: unknown;
        await this.#adapter.continueConversation(this.#identity, reference, async (context) => {
            try {
                await work(context, reference);
            } catch (error) {
                failure = error;
            }
        });
        if (failure === undefined) return;
        throw isGone(failure) ? new MessageGoneError('the message was deleted in Teams') : failure;
    }

    async messageUrl(channel: ChannelRef, rootId: string, messageId: string) {
        return this.#link((await this.#entities.teamsRefs.get(channel.teamId))?.value, channel, rootId, messageId);
    }

    #link(ref: TeamsRef | undefined, channel: ChannelRef, rootId: string, messageId: string) {
        const params = new URLSearchParams({ parentMessageId: rootId });
        if (ref) params.set('tenantId', ref.tenantId);
        if (ref?.aadGroupId) params.set('groupId', ref.aadGroupId);
        return `https://teams.microsoft.com/l/message/${encodeURIComponent(channel.channelId)}/${messageId}?${params}`;
    }

    // --- reading (Teams is the truth) --------------------------------------------------------------------------

    /**
     * The channel's Graph URL, which every URL the bot's token goes to must start with, and the team's reference.
     * The team's group ID is looked up once through the Bot Framework and kept.
     */
    async #channelScope(channel: ChannelRef): Promise<{ scope: string; ref: TeamsRef }> {
        const ref = await this.#reference(channel.teamId);
        const groupId = ref.aadGroupId ?? (await this.#lookUpGroupId(channel.teamId));
        return { scope: this.#graph.channelUrl(groupId, channel.channelId), ref: { ...ref, aadGroupId: groupId } };
    }

    async #lookUpGroupId(teamId: string): Promise<string> {
        const groupId = (await this.teamDetails(teamId)).aadGroupId;
        if (!groupId) throw new Error('the team’s group ID is not known');
        await this.#entities.teamsRefs.modify(teamId, '', (current) => ({ ...current, aadGroupId: groupId }));
        return groupId;
    }

    #summary(ref: TeamsRef, channel: ChannelRef, root: GraphMessage): ThreadSummary {
        return {
            rootId: root.id,
            url: this.#link(ref, channel, root.id, root.id),
            root: toThreadMessage(root),
            replyCount: (root.replies ?? []).filter(isMessage).length,
            lastActivity: latest(root),
        };
    }

    async listThreads(channel: ChannelRef, cursor?: string): Promise<Page<ThreadSummary>> {
        const { scope, ref } = await this.#channelScope(channel);
        const url = cursor ? decodeCursor(cursor) : `${scope}/messages?$top=${THREADS_PER_PAGE}&$expand=replies`;
        if (!this.#graph.within(scope, url)) throw new CursorError('the cursor is not valid');
        const page = await this.#graph.page(scope, url);
        const items = page.value.filter(isMessage).map((root) => this.#summary(ref, channel, root));
        const next = page['@odata.nextLink'];
        return { items, ...(next ? { cursor: encodeCursor(next) } : {}) };
    }

    async thread(channel: ChannelRef, rootId: string): Promise<ThreadSummary | undefined> {
        // Teams message IDs are numbers; anything else (other platforms' IDs, dot segments) is no thread here
        if (!MESSAGE_ID.test(rootId)) return undefined;
        const { scope, ref } = await this.#channelScope(channel);
        try {
            const root = await this.#graph.message(
                scope,
                `${scope}/messages/${encodeURIComponent(rootId)}?$expand=replies`
            );
            return isMessage(root) && root.id === rootId ? this.#summary(ref, channel, root) : undefined;
        } catch (error) {
            if (error instanceof GraphError && (error.status === 404 || error.status === 400)) return undefined;
            throw error;
        }
    }

    async readThread(channel: ChannelRef, rootId: string, limit: number) {
        const { scope } = await this.#channelScope(channel);
        const thread = `${scope}/messages/${encodeURIComponent(rootId)}`;
        const root = await this.#graph.message(scope, thread);
        const replies: GraphMessage[] = [];
        let next: string | undefined = `${thread}/replies?$top=${REPLIES_PER_PAGE}`;
        while (next && replies.length < limit * 2) {
            const page = await this.#graph.page(scope, next);
            replies.push(...page.value);
            next = page['@odata.nextLink'] ?? undefined;
        }
        const messages: ThreadMessage[] = [root, ...replies]
            .filter(isMessage)
            .sort((a, b) => a.createdDateTime.localeCompare(b.createdDateTime))
            .map(toThreadMessage);
        return { messages: messages.slice(-limit), truncated: messages.length > limit || next !== undefined };
    }

    async fetchImage(channel: ChannelRef, image: ImageRef) {
        return this.#graph.bytes((await this.#channelScope(channel)).scope, image.ref);
    }

    /** Reads the channel's latest thread, which needs the same permission as every other read. */
    async canRead(channel: ChannelRef) {
        const { scope } = await this.#channelScope(channel);
        try {
            await this.#graph.page(scope, `${scope}/messages?$top=1`);
            return true;
        } catch (error) {
            if (error instanceof ReadAccessError) return false;
            throw error;
        }
    }

    // --- Teams specifics: team details, attachments of incoming activities -------------------------------------

    async #botFramework(ref: TeamsRef, path: string): Promise<unknown> {
        const token = await this.token(BOT_FRAMEWORK_SCOPE);
        const base = ref.serviceUrl.endsWith('/') ? ref.serviceUrl : `${ref.serviceUrl}/`;
        const response = await fetch(new URL(path, base), {
            headers: token ? { authorization: `Bearer ${token}` } : {},
        });
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
