/**
 * Posting into a chat platform's channels and threads. Teams implements it (`src/teams/gateway.ts`); sessions,
 * tools, cards and jobs only use this interface, so another platform could be added.
 */

/** An Adaptive Card (JSON object with `type: "AdaptiveCard"`). */
export type CardJson = Record<string, unknown>;

export type OutboundContent = { text: string; card?: undefined } | { card: CardJson; text?: undefined };

/** A channel: its team and the channel itself. */
export interface ChannelRef {
    teamId: string;
    channelId: string;
}

export interface ChannelGateway {
    /** Starts a new thread in the channel; returns the root message ID and a link to it. */
    postThread(channel: ChannelRef, content: OutboundContent): Promise<{ rootId: string; url: string }>;
    /** Replies in a thread; returns the new message's ID. */
    reply(channel: ChannelRef, rootId: string, content: OutboundContent): Promise<{ messageId: string }>;
    update(channel: ChannelRef, rootId: string, messageId: string, content: OutboundContent): Promise<void>;
    delete(channel: ChannelRef, rootId: string, messageId: string): Promise<void>;
    /** Link to a message in the platform's client. */
    messageUrl(channel: ChannelRef, rootId: string, messageId: string): Promise<string>;
}
