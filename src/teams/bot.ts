import { Activity } from '@microsoft/agents-activity';
import type { TurnContext } from '@microsoft/agents-hosting';
import { z } from 'zod';
import type { IncomingAttachment } from '../attachments/attachments.ts';
import { CARD_DATA_KEY, CONFIRMATION_DATA_KEY } from '../cards/cards.ts';
import type { CardJson } from '../core/gateway.ts';
import { clip } from '../core/text.ts';
import { markSeen } from '../store/entities.ts';
import type { Switchboard } from '../switchboard.ts';
import { commandOf, isBotMentioned, messageText, type TeamsOrigin, teamsOriginOf } from './activity.ts';
import { type Actor, ChannelAdmin, type ChannelContext, NOT_SET_UP } from './admin.ts';
import type { TeamsGateway } from './gateway.ts';
import { SETTINGS_DATA_KEY, SettingsInput, VERB_DISCONNECT, VERB_SAVE } from './settings-card.ts';

export const ONLY_IN_CHANNELS =
    'Switchboard works in team channels. Mention it there, for example `@Switchboard status`.';

const CardAction = z.object({
    action: z.object({
        verb: z.string().max(200),
        data: z.record(z.string(), z.unknown()).default({}),
    }),
    /** `automatic` for invokes Teams sends by itself (card refresh); only clicks count. */
    trigger: z.string().optional(),
});

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);

/** Handles activities from Teams: messages and commands in channels, and card clicks. */
export class TeamsBot {
    readonly #sb: Switchboard;
    readonly #teams: TeamsGateway;
    readonly #admin: ChannelAdmin;

    constructor(sb: Switchboard, teams: TeamsGateway) {
        this.#sb = sb;
        this.#teams = teams;
        this.#admin = new ChannelAdmin(sb, teams);
    }

    async handle(context: TurnContext): Promise<void> {
        const sb = this.#sb;
        const activity = context.activity;
        if (activity.from?.role === 'bot') return;
        const origin = teamsOriginOf(activity);
        if (!origin.tenantId || !sb.settings.tenants.includes(origin.tenantId)) return;
        await this.#rememberTeam(activity, origin);
        if (activity.type !== 'message' && activity.type !== 'invoke') return;
        // Teams may deliver an activity twice; every pod handles it at most once
        if (
            activity.id &&
            !(await markSeen(sb.entities, 'activity', `${origin.conversationId}|${activity.type}|${activity.id}`))
        ) {
            return;
        }
        if (activity.type === 'message') return this.#onMessage(context, origin);
        return this.#onInvoke(context, origin);
    }

    /** Stores the team's conversation reference, so Switchboard can post into its channels proactively. */
    async #rememberTeam(activity: Activity, origin: TeamsOrigin) {
        const sb = this.#sb;
        if (!origin.teamId || !activity.serviceUrl || !activity.recipient?.id || !origin.tenantId) return;
        const existing = (await sb.entities.teamsRefs.get(origin.teamId))?.value;
        const next = {
            teamId: origin.teamId,
            tenantId: origin.tenantId,
            serviceUrl: activity.serviceUrl,
            botId: activity.recipient.id,
            aadGroupId: origin.aadGroupId ?? existing?.aadGroupId,
            teamName: origin.teamName ?? existing?.teamName,
            updatedAt: sb.now().toISOString(),
        };
        const same =
            existing &&
            existing.serviceUrl === next.serviceUrl &&
            existing.botId === next.botId &&
            existing.aadGroupId === next.aadGroupId &&
            existing.teamName === next.teamName;
        if (!same) await sb.entities.teamsRefs.upsert(next);
    }

    #channel(origin: TeamsOrigin): ChannelContext | undefined {
        if (origin.conversationType !== 'channel' || !origin.teamId || !origin.channelId || !origin.tenantId)
            return undefined;
        return {
            teamId: origin.teamId,
            channelId: origin.channelId,
            tenantId: origin.tenantId,
            aadGroupId: origin.aadGroupId,
            teamName: origin.teamName,
        };
    }

    #actor(activity: Activity, origin: TeamsOrigin): Actor {
        return { tenantId: origin.tenantId ?? '', aadObjectId: activity.from?.aadObjectId, name: activity.from?.name };
    }

    async #onMessage(context: TurnContext, origin: TeamsOrigin) {
        const sb = this.#sb;
        const activity = context.activity;
        const mentioned = isBotMentioned(activity);
        const channel = this.#channel(origin);
        if (!channel) {
            if (mentioned) await context.sendActivity(ONLY_IN_CHANNELS);
            return;
        }
        const command = commandOf(activity);
        if (command) {
            const answer = await this.#admin.command(command, channel, this.#actor(activity, origin));
            await context.sendActivity(
                'card' in answer
                    ? Activity.fromObject({
                          type: 'message',
                          attachments: [
                              { contentType: 'application/vnd.microsoft.card.adaptive', content: answer.card },
                          ],
                      })
                    : Activity.fromObject({ type: 'message', text: answer.text, textFormat: 'markdown' })
            );
            return;
        }
        const binding = await this.#admin.binding(channel);
        if (!binding) {
            if (mentioned) await context.sendActivity(NOT_SET_UP);
            return;
        }
        const aadObjectId = activity.from?.aadObjectId;
        if (!aadObjectId || !activity.id) return;
        const rootId = origin.rootId ?? activity.id;
        if (!binding.aadGroupId && origin.aadGroupId) {
            await sb.entities.bindings.modify(binding.teamId, binding.channelId, (current) => ({
                ...current,
                aadGroupId: origin.aadGroupId,
            }));
        }
        await sb.conversations.onHuman({
            binding: { ...binding, aadGroupId: binding.aadGroupId ?? origin.aadGroupId },
            rootId,
            messageId: activity.id,
            isRoot: rootId === activity.id,
            from: { name: activity.from?.name, aadObjectId },
            at: activity.timestamp ? new Date(activity.timestamp) : sb.now(),
            text: messageText(activity),
            attachments: await this.#attachments(activity),
        });
    }

    /** Images Teams attached (inline pictures); files and other types are passed on as "not supported". */
    async #attachments(activity: Activity): Promise<IncomingAttachment[]> {
        const sb = this.#sb;
        const result: IncomingAttachment[] = [];
        for (const attachment of activity.attachments ?? []) {
            const type = attachment.contentType ?? '';
            if (type.startsWith('text/html') || type === 'application/vnd.microsoft.card.adaptive') continue;
            const name = attachment.name ?? 'attachment';
            if (!type.startsWith('image/') || !attachment.contentUrl) {
                result.push({
                    name,
                    mediaType: type === 'reference' ? 'file' : type || 'unknown',
                    size: 0,
                    problem: 'type not supported',
                });
                continue;
            }
            try {
                const { data, mediaType } = await this.#teams.download(attachment.contentUrl);
                const actualType =
                    mediaType && mediaType.startsWith('image/') ? mediaType : type === 'image/*' ? 'image/png' : type;
                result.push({ name, mediaType: actualType.split(';')[0] ?? actualType, size: data.byteLength, data });
            } catch (error) {
                sb.log.warn({ err: error }, 'attachment not downloaded');
                result.push({ name, mediaType: type, size: 0, problem: 'could not be fetched' });
            }
        }
        return result;
    }

    async #onInvoke(context: TurnContext, origin: TeamsOrigin) {
        const sb = this.#sb;
        const activity = context.activity;
        if (activity.name !== 'adaptiveCard/action') return;
        const respond = (body: Record<string, unknown>) =>
            context.sendActivity(Activity.fromObject({ type: 'invokeResponse', value: { status: 200, body } }));
        const message = (text: string) =>
            respond({ statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: text });
        const card = (value: CardJson) =>
            respond({ statusCode: 200, type: 'application/vnd.microsoft.card.adaptive', value });
        const answer = (result: CardJson | { message: string }) =>
            'message' in result && typeof result.message === 'string' && Object.keys(result).length === 1
                ? message(result.message)
                : card(result as CardJson);

        const parsed = CardAction.safeParse(activity.value);
        if (!parsed.success) return void (await message('Unknown action.'));
        if (parsed.data.trigger === 'automatic') return void (await message('Only a click counts.'));
        const channel = this.#channel(origin);
        if (!channel) return void (await message(ONLY_IN_CHANNELS));
        const { verb, data } = parsed.data.action;
        const actor = this.#actor(activity, origin);
        const by = { name: activity.from?.name, aadObjectId: activity.from?.aadObjectId ?? '' };
        if (!by.aadObjectId) return void (await message('Your identity could not be verified.'));

        if (data[SETTINGS_DATA_KEY] !== undefined) {
            if (data[SETTINGS_DATA_KEY] !== channel.channelId)
                return void (await message('This card belongs to another channel.'));
            if (verb === VERB_SAVE)
                return void (await answer(await this.#admin.save(channel, actor, SettingsInput.parse(data))));
            if (verb === VERB_DISCONNECT) {
                if (!this.#admin.isAdmin(actor))
                    return void (await message('Only Switchboard admins can change this.'));
                const binding = await this.#admin.binding(channel);
                if (binding) await this.#admin.disconnect(binding, actor);
                return void (await card(await this.#admin.settingsCard(channel, '🔌 Disconnected.')));
            }
            return void (await message('Unknown action.'));
        }
        const click = { verb, data, by, channel, rootId: origin.rootId };
        const confirmation = ID.safeParse(data[CONFIRMATION_DATA_KEY]);
        if (confirmation.success)
            return void (await answer(await sb.cards.confirm({ ...click, cardId: confirmation.data })));
        const cardId = ID.safeParse(data[CARD_DATA_KEY]);
        if (cardId.success) return void (await answer(await sb.cards.click({ ...click, cardId: cardId.data })));
        await message(`Unknown card (${clip(verb, 60)}).`);
    }
}
