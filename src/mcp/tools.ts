import { type CallToolResult, McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Approvals } from '../approvals/approvals.ts';
import { MAX_STEPS, sanitiseAgentCard } from '../approvals/cards.ts';
import type { CallerResolver } from '../claude/caller.ts';
import type { ChannelsConfig } from '../config/channels.ts';
import { type ChannelGateway, formatThreadId, type OutboundContent, parseThreadId } from '../core/gateway.ts';
import type { Logger } from '../core/logger.ts';
import { splitMessage } from '../core/text.ts';
import { VERSION } from '../core/version.ts';
import type { Relay, Thread } from '../relay/relay.ts';
import type { Store } from '../store/store.ts';
import { grantOf, type McpGrant } from './auth.ts';

/** Agents send at most this much text per call; longer posts are split into replies. */
const MAX_TEXT = 60_000;
const MAX_STEPS_JSON = 16_000;

export interface McpContext {
    config: ChannelsConfig;
    store: Store;
    gateway: ChannelGateway;
    relay: Relay;
    approvals: Approvals;
    resolver: CallerResolver;
    log: Logger;
}

/** An expected failure, reported to the agent as the tool's error. */
class ToolError extends Error {}

const json = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

const fail = (context: McpContext, tool: string, error: unknown): CallToolResult => {
    if (!(error instanceof ToolError)) context.log.error({ err: error, tool }, 'tool failed');
    const message = error instanceof ToolError ? error.message : 'internal error, see the Switchboard log';
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
};

const grantFrom = (ctx: ServerContext): McpGrant => {
    const grant = grantOf(ctx.http?.authInfo);
    if (!grant) throw new ToolError('unauthorized');
    return grant;
};

const requireChannel = (context: McpContext, grant: McpGrant, channelKey: string) => {
    if (!context.config.channels[channelKey] || !grant.channels.includes(channelKey)) {
        throw new ToolError(`channel '${channelKey}' is not available to this token (see list_channels)`);
    }
};

const requireThread = (context: McpContext, grant: McpGrant, threadId: string): Thread => {
    const thread = parseThreadId(threadId);
    if (!thread) throw new ToolError(`invalid thread_id '${threadId}' (expected '<channel>/<message id>')`);
    requireChannel(context, grant, thread.channelKey);
    return thread;
};

/** Text or card, exactly one; text longer than one message is returned as several. */
const contentsOf = (text: string | undefined, card: Record<string, unknown> | undefined): OutboundContent[] => {
    if ((text === undefined) === (card === undefined)) throw new ToolError('pass exactly one of text and card');
    if (card !== undefined) {
        try {
            return [{ card: sanitiseAgentCard(card) }];
        } catch (error) {
            throw new ToolError(error instanceof Error ? error.message : 'invalid card');
        }
    }
    const chunks = splitMessage(text ?? '');
    if (chunks.length === 0) throw new ToolError('text is empty');
    return chunks.map((chunk) => ({ text: chunk }));
};

const textSchema = z.string().min(1).max(MAX_TEXT).optional().describe('Message text (Teams markdown)');
const cardSchema = z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Adaptive Card JSON (type "AdaptiveCard"), instead of text');

/** The MCP server agents call to post into channels and ask for approval. One instance per request (stateless). */
export const createMcpServer = (context: McpContext): McpServer => {
    const server = new McpServer({ name: 'switchboard', version: VERSION });

    server.registerTool(
        'list_channels',
        {
            title: 'List channels',
            description: 'Lists the Teams channels this agent may post to, with their keys and descriptions.',
            inputSchema: z.object({}),
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async (_args, ctx) => {
            try {
                const grant = grantFrom(ctx);
                const channels = grant.channels
                    .filter((key) => context.config.channels[key])
                    .map((key) => ({ channel: key, description: context.config.channels[key]?.description ?? '' }));
                return json({ channels });
            } catch (error) {
                return fail(context, 'list_channels', error);
            }
        }
    );

    server.registerTool(
        'post_message',
        {
            title: 'Post a new message',
            description:
                'Starts a new thread in a channel. With link_thread (default true) human replies in that thread are ' +
                'sent to this session. Returns thread_id (for reply and request_approval) and message_url.',
            inputSchema: z.object({
                channel: z.string().describe('Channel key from list_channels'),
                text: textSchema,
                card: cardSchema,
                link_thread: z.boolean().default(true).describe('Send human replies in the thread to this session'),
            }),
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        async (args, ctx) => {
            try {
                const grant = grantFrom(ctx);
                requireChannel(context, grant, args.channel);
                const [first, ...rest] = contentsOf(args.text, args.card);
                if (!first) throw new ToolError('nothing to post');
                const { rootId, url } = await context.gateway.postTopLevel(args.channel, first);
                for (const content of rest) await context.gateway.reply(args.channel, rootId, content);
                const threadId = formatThreadId(args.channel, rootId);
                let linkedSession: string | undefined;
                if (args.link_thread) {
                    const caller = await context.resolver.resolve({
                        tool: 'post_message',
                        input: { channel: args.channel, text: args.text, card: args.card },
                        headers: ctx.http?.req?.headers,
                    });
                    if (caller) {
                        await context.relay.link({ channelKey: args.channel, rootId }, caller.sessionId, 'agent', {
                            eventId: caller.eventId,
                            at: caller.eventAt,
                        });
                        linkedSession = caller.sessionId;
                        context.log.info({ threadId, sessionId: caller.sessionId, via: caller.via }, 'thread linked');
                    } else {
                        context.log.warn(
                            { threadId, token: grant.name },
                            'calling session not found, thread not linked'
                        );
                    }
                }
                return json({ thread_id: threadId, message_url: url, linked: linkedSession !== undefined });
            } catch (error) {
                return fail(context, 'post_message', error);
            }
        }
    );

    server.registerTool(
        'reply',
        {
            title: 'Reply in a thread',
            description: 'Replies in an existing thread. thread_id comes from post_message or a message header.',
            inputSchema: z.object({
                thread_id: z.string().describe('Thread ID, "<channel>/<message id>"'),
                text: textSchema,
                card: cardSchema,
            }),
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        async (args, ctx) => {
            try {
                const thread = requireThread(context, grantFrom(ctx), args.thread_id);
                let messageId = '';
                for (const content of contentsOf(args.text, args.card)) {
                    messageId = (await context.gateway.reply(thread.channelKey, thread.rootId, content)).messageId;
                }
                return json({ message_id: messageId });
            } catch (error) {
                return fail(context, 'reply', error);
            }
        }
    );

    server.registerTool(
        'request_approval',
        {
            title: 'Request approval',
            description:
                'Posts an Approve / Deny card listing the steps into the thread and returns card_id at once. End your ' +
                'turn afterwards: the decision arrives as a message starting with "[switchboard:approval] card=<card_id>".',
            inputSchema: z.object({
                thread_id: z.string().describe('Thread ID, "<channel>/<message id>"'),
                title: z.string().min(1).max(200),
                summary: z.string().max(4000).describe('What will happen and why'),
                steps: z
                    .array(z.string().min(1).max(1000))
                    .min(1)
                    .max(MAX_STEPS)
                    // the stored record keeps all steps in one property (Table Storage: at most 32K characters)
                    .refine((steps) => JSON.stringify(steps).length <= MAX_STEPS_JSON, {
                        message: `steps together must stay under ${MAX_STEPS_JSON} characters`,
                    })
                    .describe('The steps to approve'),
            }),
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        async (args, ctx) => {
            try {
                const thread = requireThread(context, grantFrom(ctx), args.thread_id);
                let sessionId = (await context.store.getThread(thread.channelKey, thread.rootId))?.sessionId;
                if (!sessionId) {
                    const caller = await context.resolver.resolve({
                        tool: 'request_approval',
                        input: { ...args },
                        headers: ctx.http?.req?.headers,
                    });
                    if (!caller) {
                        throw new ToolError(
                            'the thread is not linked to a session, so the decision could not be delivered'
                        );
                    }
                    await context.relay.link(thread, caller.sessionId, 'agent', {
                        eventId: caller.eventId,
                        at: caller.eventAt,
                    });
                    sessionId = caller.sessionId;
                }
                const record = await context.approvals.request({
                    ...thread,
                    sessionId,
                    title: args.title,
                    summary: args.summary,
                    steps: args.steps,
                });
                return json({ card_id: record.cardId });
            } catch (error) {
                return fail(context, 'request_approval', error);
            }
        }
    );

    return server;
};
