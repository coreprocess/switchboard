/** An Adaptive Card (JSON object with `type: "AdaptiveCard"`). */
export type Card = Record<string, unknown>;

export type OutboundContent = { text: string; card?: undefined } | { card: Card; text?: undefined };

/**
 * Posting into a chat platform's channels and threads. Teams implements it today; keeping the relay, the MCP tools
 * and approvals behind this interface is what would let another platform be added.
 */
export interface ChannelGateway {
    /** Starts a new thread in the channel; returns the root message ID and a link to it. */
    postTopLevel(channelKey: string, content: OutboundContent): Promise<{ rootId: string; url: string }>;
    /** Replies in a thread; returns the new message's ID. */
    reply(channelKey: string, rootId: string, content: OutboundContent): Promise<{ messageId: string }>;
    update(channelKey: string, rootId: string, messageId: string, content: OutboundContent): Promise<void>;
    delete(channelKey: string, rootId: string, messageId: string): Promise<void>;
}

/** Thread IDs agents see: `<channel key>/<root message id>`. */
export const formatThreadId = (channelKey: string, rootId: string) => `${channelKey}/${rootId}`;

export const parseThreadId = (threadId: string): { channelKey: string; rootId: string } | undefined => {
    const match = /^([a-z0-9][a-z0-9_-]{0,62})\/([A-Za-z0-9_-]{1,128})$/.exec(threadId.trim());
    if (!match?.[1] || !match[2]) return undefined;
    return { channelKey: match[1], rootId: match[2] };
};
