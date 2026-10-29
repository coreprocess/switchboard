import { APIError } from '@anthropic-ai/sdk';
import { Activity } from '@microsoft/agents-activity';
import type { TurnContext } from '@microsoft/agents-hosting';
import { z } from 'zod';
import type { Approvals } from '../approvals/approvals.ts';
import type { ClaudeApi } from '../claude/api.ts';
import { budgetOf, type ChannelsConfig } from '../config/channels.ts';
import { formatThreadId } from '../core/gateway.ts';
import type { Logger } from '../core/logger.ts';
import { clip, firstLine, formatHumanMessage } from '../core/text.ts';
import type { Relay, Thread } from '../relay/relay.ts';
import type { ConversationRecord, Store } from '../store/store.ts';
import {
    type Binding,
    bindingOf,
    hasFileAttachments,
    isBotMentioned,
    type TeamsOrigin,
    textWithoutBotMention,
    userAllowed,
} from './access.ts';

export const NOT_CONFIGURED = 'Switchboard is not configured for this conversation.';
export const NOT_ALLOWED = 'You are not allowed to talk to the agent in this channel.';
export const ATTACHMENTS_NOTICE = 'Attachments are not supported yet; only the text was passed to the agent.';
const EMPTY_MENTION = 'Mention me together with a message to start.';

const CardAction = z.object({
    action: z.object({
        verb: z.string(),
        data: z.looseObject({ card_id: z.string().regex(/^(card|tc)_[A-Za-z0-9_-]{1,200}$/) }),
    }),
    /** `automatic` for invokes Teams sends by itself (card refresh); only clicks count. */
    trigger: z.string().optional(),
});

export interface TeamsBotOptions {
    config: ChannelsConfig;
    store: Store;
    api: ClaudeApi;
    relay: Relay;
    approvals: Approvals;
    log: Logger;
}

type BoundBinding = Extract<Binding, { bound: true }>;

const errorText = (error: unknown) => clip(error instanceof Error ? error.message : String(error), 300);

/** Handles activities from Teams: messages in bound channels, approval card clicks and app installs. */
export class TeamsBot {
    readonly #config: ChannelsConfig;
    readonly #store: Store;
    readonly #api: ClaudeApi;
    readonly #relay: Relay;
    readonly #approvals: Approvals;
    readonly #log: Logger;
    /** Last conversation reference written per channel, to skip redundant writes. */
    readonly #remembered = new Map<string, string>();

    constructor(options: TeamsBotOptions) {
        this.#config = options.config;
        this.#store = options.store;
        this.#api = options.api;
        this.#relay = options.relay;
        this.#approvals = options.approvals;
        this.#log = options.log;
    }

    async handle(context: TurnContext): Promise<void> {
        const activity = context.activity;
        if (activity.from?.role === 'bot') return;
        const binding = bindingOf(this.#config, activity);
        await this.#rememberTeam(activity, binding.origin);
        switch (activity.type) {
            case 'message':
                return this.#onMessage(context, binding);
            case 'invoke':
                return this.#onInvoke(context, binding);
            default:
                return;
        }
    }

    /**
     * Stores a conversation reference for every bound channel of the activity's team (installs arrive from the
     * General channel), so Switchboard can post into those channels proactively.
     */
    async #rememberTeam(activity: Activity, origin: TeamsOrigin) {
        if (!activity.serviceUrl || !activity.recipient?.id) return;
        if (origin.tenantId?.toLowerCase() !== this.#config.tenant_id.toLowerCase()) return;
        if (!origin.teamId && !origin.aadGroupId) return;
        for (const [channelKey, channel] of Object.entries(this.#config.channels)) {
            const sameTeam =
                (channel.team_id !== undefined && channel.team_id === origin.teamId) ||
                (channel.team_aad_group_id !== undefined &&
                    channel.team_aad_group_id.toLowerCase() === origin.aadGroupId?.toLowerCase());
            if (!sameTeam) continue;
            const record: ConversationRecord = {
                channelKey,
                serviceUrl: activity.serviceUrl,
                tenantId: this.#config.tenant_id,
                channelId: channel.channel_id,
                teamId: origin.teamId ?? channel.team_id,
                aadGroupId: origin.aadGroupId ?? channel.team_aad_group_id,
                botId: activity.recipient.id,
                updatedAt: new Date().toISOString(),
            };
            const fingerprint = JSON.stringify({ ...record, updatedAt: undefined });
            if (this.#remembered.get(channelKey) === fingerprint) continue;
            await this.#store.putConversation(record);
            this.#remembered.set(channelKey, fingerprint);
        }
    }

    async #onMessage(context: TurnContext, binding: Binding) {
        const activity = context.activity;
        const mentioned = isBotMentioned(activity);
        if (!binding.bound) {
            // With resource-specific consent the bot sees every channel message; answer only when addressed.
            if (binding.origin.conversationType !== 'personal' && !mentioned) return;
            if (binding.reason === 'not_bound') {
                // The IDs to put into the channels file to bind this channel.
                const { teamId, aadGroupId, channelId } = binding.origin;
                this.#log.info({ teamId, aadGroupId, channelId }, 'mention in an unbound channel');
            }
            await context.sendActivity(NOT_CONFIGURED);
            return;
        }
        const aadObjectId = activity.from?.aadObjectId;
        if (!aadObjectId || !userAllowed(binding.channel, aadObjectId)) {
            if (mentioned) await context.sendActivity(NOT_ALLOWED);
            return;
        }
        const rootId = binding.origin.rootId ?? activity.id;
        if (!rootId) return;
        const thread: Thread = { channelKey: binding.channelKey, rootId };
        const link = await this.#store.getThread(thread.channelKey, rootId);
        if (!link && !mentioned) return;

        const text = textWithoutBotMention(activity);
        if (!text) {
            if (mentioned) await context.sendActivity(EMPTY_MENTION);
            return;
        }
        const message = formatHumanMessage({
            channelKey: thread.channelKey,
            threadId: formatThreadId(thread.channelKey, rootId),
            name: activity.from?.name,
            aadObjectId,
            at: new Date(),
            text,
        });

        if (!link) {
            await this.#startSession(context, binding, thread, message, text, aadObjectId);
        } else {
            try {
                await this.#relay.sendUserMessage(link.sessionId, thread, message);
            } catch (error) {
                if (mentioned && (await this.#sessionEnded(link.sessionId))) {
                    await this.#startSession(context, binding, thread, message, text, aadObjectId);
                } else {
                    this.#log.warn({ err: error, sessionId: link.sessionId }, 'message not delivered');
                    await context.sendActivity(`⚠️ Your message could not be passed to the agent: ${errorText(error)}`);
                }
            }
        }
        if (hasFileAttachments(activity)) await context.sendActivity(ATTACHMENTS_NOTICE);
    }

    async #sessionEnded(sessionId: string): Promise<boolean> {
        try {
            return (await this.#api.retrieveSession(sessionId)).status === 'terminated';
        } catch (error) {
            if (error instanceof APIError && error.status === 404) return true;
            throw error;
        }
    }

    async #startSession(
        context: TurnContext,
        binding: BoundBinding,
        thread: Thread,
        message: string,
        text: string,
        createdBy: string
    ) {
        const { channel, channelKey } = binding;
        const threadId = formatThreadId(channelKey, thread.rootId);
        const budget = budgetOf(channel);
        let sessionId: string;
        try {
            const session = await this.#api.createSession({
                agent: channel.agent.version
                    ? { type: 'agent', id: channel.agent.id, version: channel.agent.version }
                    : channel.agent.id,
                environment_id: channel.environment_id,
                ...(channel.vault_ids.length > 0 ? { vault_ids: channel.vault_ids } : {}),
                ...(channel.resources.length > 0 ? { resources: channel.resources } : {}),
                ...(budget ? { budget } : {}),
                title: `${channel.session_title_prefix}: ${firstLine(text, 120)}`,
                metadata: { switchboard_channel: channelKey, switchboard_thread: threadId },
            });
            sessionId = session.id;
        } catch (error) {
            this.#log.error({ err: error, channelKey }, 'session not created');
            await context.sendActivity(`⚠️ Could not start an agent session: ${errorText(error)}`);
            return;
        }
        this.#log.info({ sessionId, channelKey, threadId }, 'session started');
        await this.#relay.link(thread, sessionId, createdBy);
        await this.#relay.sendUserMessage(sessionId, thread, message);
    }

    async #onInvoke(context: TurnContext, binding: Binding) {
        const activity = context.activity;
        if (activity.name !== 'adaptiveCard/action') return;
        const respond = (body: Record<string, unknown>) =>
            context.sendActivity(Activity.fromObject({ type: 'invokeResponse', value: { status: 200, body } }));
        const message = (text: string) =>
            respond({ statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: text });

        const parsed = CardAction.safeParse(activity.value);
        if (!parsed.success) return void (await message('Unknown action.'));
        if (!binding.bound) return void (await message(NOT_CONFIGURED));
        if (parsed.data.trigger === 'automatic') return void (await message('Only a click decides.'));
        const result = await this.#approvals.click({
            cardId: parsed.data.action.data.card_id,
            verb: parsed.data.action.verb,
            channelKey: binding.channelKey,
            channel: binding.channel,
            rootId: binding.origin.rootId,
            messageId: activity.replyToId,
            aadObjectId: activity.from?.aadObjectId,
            name: activity.from?.name,
        });
        if ('message' in result) return void (await message(result.message));
        await respond({ statusCode: 200, type: 'application/vnd.microsoft.card.adaptive', value: result.card });
    }
}
