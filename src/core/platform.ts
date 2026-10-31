/**
 * The chat platform behind Switchboard (Teams today, `src/teams/`). The platform's threads are the truth for what
 * was said; Switchboard posts into them and reads them back. Sessions, conversations, tools, cards and jobs only
 * use this interface, so another platform could be added.
 */

/** An Adaptive Card (JSON object with `type: "AdaptiveCard"`). */
export type CardJson = Record<string, unknown>;

export type OutboundContent = { text: string; card?: undefined } | { card: CardJson; text?: undefined };

/** A channel: its team and the channel itself. */
export interface ChannelRef {
    teamId: string;
    channelId: string;
}

export interface ThreadAuthor {
    name: string;
    /** Entra object ID of a person; absent for apps (Switchboard's own posts). */
    aadObjectId?: string;
    isApp: boolean;
}

/** An image in a message, fetched on demand with `fetchImage`. */
export interface ImageRef {
    /** Platform reference (for Teams: the Graph hosted-content URL). */
    ref: string;
    name: string;
}

export interface ThreadMessage {
    messageId: string;
    at: string;
    author: ThreadAuthor;
    /** The post's subject line, if it has one (root posts). */
    subject?: string;
    /** The text as Markdown. */
    text: string;
    /** Adaptive Cards in the message, as they currently show. */
    cards: CardJson[];
    images: ImageRef[];
    /** Files attached as references (not passed on). */
    files: string[];
}

export interface ThreadSummary {
    rootId: string;
    url: string;
    root: ThreadMessage;
    replyCount: number;
    /** The time of the latest message in the thread. */
    lastActivity: string;
}

/** A cursor the platform did not hand out (agents pass cursors back). */
export class CursorError extends Error {}

export interface Page<T> {
    items: T[];
    /** Pass back to continue; absent on the last page. */
    cursor?: string;
}

export interface ChannelPlatform {
    /** Starts a new thread in the channel; returns its root message ID and a link to it. */
    postThread(channel: ChannelRef, content: OutboundContent): Promise<{ rootId: string; url: string }>;
    /** Replies in a thread; returns the new message's ID. */
    reply(channel: ChannelRef, rootId: string, content: OutboundContent): Promise<{ messageId: string }>;
    update(channel: ChannelRef, rootId: string, messageId: string, content: OutboundContent): Promise<void>;
    delete(channel: ChannelRef, rootId: string, messageId: string): Promise<void>;
    /** Link to a message in the platform's client. */
    messageUrl(channel: ChannelRef, rootId: string, messageId: string): Promise<string>;
    /** The channel's threads, latest activity first. */
    listThreads(channel: ChannelRef, cursor?: string): Promise<Page<ThreadSummary>>;
    /** One thread's summary; `undefined` when it does not exist in the channel. */
    thread(channel: ChannelRef, rootId: string): Promise<ThreadSummary | undefined>;
    /** The thread's messages (root and replies), oldest first; at most the latest `limit`. */
    readThread(
        channel: ChannelRef,
        rootId: string,
        limit: number
    ): Promise<{ messages: ThreadMessage[]; truncated: boolean }>;
    fetchImage(channel: ChannelRef, image: ImageRef): Promise<{ data: Uint8Array; mediaType: string }>;
}
