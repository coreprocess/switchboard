import { type ChannelPlatform, type ChannelRef, type Mention, ReadAccessError } from '../core/platform.ts';
import { formatLocal } from '../core/time.ts';
import { type Binding, type ChannelAccess, forgetSeen, markSeen, type Versioned } from '../store/entities.ts';
import type { Switchboard } from '../switchboard.ts';

/**
 * Read access (README: "Read access"): the platform can stop letting Switchboard read a channel while posting
 * still works (for Teams: the team's consent is lost when the app is updated in place). Nothing fails loudly then:
 * messages simply stop arriving. So one pod per interval checks every bound channel, and every read the platform
 * refuses counts as a check too. While reading is denied, Switchboard warns in the channel and notifies the admins,
 * at most once per channel and day; when it works again, it says so in the latest warning thread.
 */
export class ReadAccess {
    readonly #sb: Switchboard;
    readonly #platform: ChannelPlatform;

    constructor(sb: Switchboard, platform: ChannelPlatform) {
        this.#sb = sb;
        this.#platform = platform;
    }

    /** The platform as the services use it: a read it refuses is reported here before the error goes on. */
    watch(): ChannelPlatform {
        const platform = this.#platform;
        const reported = async <T>(channel: ChannelRef, read: () => Promise<T>): Promise<T> => {
            try {
                return await read();
            } catch (error) {
                if (error instanceof ReadAccessError) await this.denied(channel);
                throw error;
            }
        };
        return {
            readAccessHelp: platform.readAccessHelp,
            postThread: (channel, content) => platform.postThread(channel, content),
            reply: (channel, rootId, content) => platform.reply(channel, rootId, content),
            update: (channel, rootId, messageId, content) => platform.update(channel, rootId, messageId, content),
            delete: (channel, rootId, messageId) => platform.delete(channel, rootId, messageId),
            messageUrl: (channel, rootId, messageId) => platform.messageUrl(channel, rootId, messageId),
            canRead: (channel) => platform.canRead(channel),
            listThreads: (channel, cursor) => reported(channel, () => platform.listThreads(channel, cursor)),
            thread: (channel, rootId) => reported(channel, () => platform.thread(channel, rootId)),
            readThread: (channel, rootId, limit) =>
                reported(channel, () => platform.readThread(channel, rootId, limit)),
            fetchImage: (channel, image) => reported(channel, () => platform.fetchImage(channel, image)),
        };
    }

    async state(binding: Binding): Promise<ChannelAccess | undefined> {
        return (await this.#sb.entities.access.get(binding.teamId, binding.channelId))?.value;
    }

    /** Checks every bound channel, unless another pod has checked them in this interval. */
    async periodic() {
        const sb = this.#sb;
        const slot = Math.floor(sb.now().getTime() / sb.timing.accessCheckMs);
        if (!(await markSeen(sb.entities, 'access-check', String(slot)))) return;
        for (const { value: binding } of await sb.entities.bindings.list()) await this.check(binding);
    }

    /** Checks one channel (also for `status`); when the platform cannot tell (an outage), nothing changes. */
    async check(binding: Binding): Promise<'readable' | 'denied' | 'unknown'> {
        const sb = this.#sb;
        let readable: boolean;
        try {
            readable = await this.#platform.canRead({ teamId: binding.teamId, channelId: binding.channelId });
        } catch (error) {
            sb.log.warn({ err: error, channelId: binding.channelId }, 'read access not checked');
            return 'unknown';
        }
        await (readable ? this.#readable(binding) : this.#denied(binding));
        return readable ? 'readable' : 'denied';
    }

    /** The platform refused a read in the channel. */
    async denied(channel: ChannelRef) {
        const binding = (await this.#sb.entities.bindings.get(channel.teamId, channel.channelId))?.value;
        if (binding) await this.#denied(binding);
    }

    /** Called when a binding is removed. */
    async forget(binding: Binding) {
        await this.#sb.entities.access.delete(binding.teamId, binding.channelId);
    }

    async #denied(binding: Binding) {
        const sb = this.#sb;
        const now = sb.now().toISOString();
        try {
            await this.#write(binding, (current) => ({
                teamId: binding.teamId,
                channelId: binding.channelId,
                readable: false,
                checkedAt: now,
                deniedSince: current?.readable === false ? current.deniedSince : now,
                warningRootId: current?.warningRootId,
            }));
            await this.#warn(binding, now);
        } catch (error) {
            sb.log.warn({ err: error, channelId: binding.channelId }, 'read access denial not handled');
        }
    }

    /** The warning, once per channel and day (the first pod to record it posts it). */
    async #warn(binding: Binding, now: string) {
        const sb = this.#sb;
        const key = `${binding.channelId}|${now.slice(0, 10)}`;
        if (!(await markSeen(sb.entities, 'access-warning', key))) return;
        const deniedSince = (await this.state(binding))?.deniedSince ?? now;
        const text = [
            '⚠️ **Switchboard cannot read this channel**',
            '',
            `Reading this channel’s messages has been refused since ${formatLocal(new Date(deniedSince), sb.settings.defaultTimezone)}; posting still works.`,
            '',
            this.#platform.readAccessHelp,
            '',
            'Switchboard checks again regularly, says so here once reading works again, and repeats this warning ' +
                'at most once a day while the problem lasts.',
        ].join('\n');
        try {
            const { conversation } = await sb.conversations.open({
                binding,
                text,
                mentions: this.#admins(binding),
                origin: 'notice',
            });
            await sb.entities.access.modify(binding.teamId, binding.channelId, (current) =>
                current.readable ? undefined : { ...current, warningRootId: conversation.rootId }
            );
            sb.log.warn({ channelId: binding.channelId }, 'read access denied: warning posted');
        } catch (error) {
            // another attempt (a later check) posts it
            await forgetSeen(sb.entities, 'access-warning', key);
            throw error;
        }
    }

    /** The admins of the binding's tenant, notified with the warning. */
    #admins(binding: Binding): Mention[] {
        const tenant = binding.tenantId.toLowerCase();
        return this.#sb.settings.admins
            .filter((admin) => admin.tenant.toLowerCase() === tenant)
            .map((admin) => ({ id: admin.objectId, name: admin.label ?? 'Switchboard admin' }));
    }

    /** Reading works: after a denial, the pod that records the change says so in the latest warning thread. */
    async #readable(binding: Binding) {
        const sb = this.#sb;
        const now = sb.now().toISOString();
        const { before } = await this.#write(binding, () => ({
            teamId: binding.teamId,
            channelId: binding.channelId,
            readable: true,
            checkedAt: now,
        }));
        if (before?.readable !== false) return;
        sb.log.info({ channelId: binding.channelId }, 'read access restored');
        if (!before.warningRootId) return;
        await sb.conversations
            .post(
                { teamId: binding.teamId, channelId: binding.channelId },
                before.warningRootId,
                { text: '✅ Switchboard can read this channel again.' },
                { kind: 'note' }
            )
            .catch((error: unknown) => {
                sb.log.warn({ err: error, channelId: binding.channelId }, 'read access note not posted');
            });
    }

    /** Writes the channel's entry with a conditional write; returns the entry it replaced. */
    async #write(
        binding: Binding,
        next: (current: ChannelAccess | undefined) => ChannelAccess
    ): Promise<{ before: ChannelAccess | undefined }> {
        const access = this.#sb.entities.access;
        for (let attempt = 0; attempt < 8; attempt++) {
            const current: Versioned<ChannelAccess> | undefined = await access.get(binding.teamId, binding.channelId);
            const written = current
                ? await access.update(current, next(current.value))
                : await access.insert(next(undefined));
            if (written) return { before: current?.value };
        }
        throw new Error(`access ${binding.channelId}: too many concurrent changes`);
    }
}
