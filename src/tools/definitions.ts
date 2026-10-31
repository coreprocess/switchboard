import type { BetaManagedAgentsCustomToolParams } from '@anthropic-ai/sdk/resources/beta/agents/agents';
import { z } from 'zod';
import { MAX_WAIT_MINUTES } from './waits.ts';

/**
 * Switchboard's custom tools (concept: "Tools for agents"). Switchboard adds them to every session it creates;
 * agent definitions stay free of them. They act in the session's own channel only.
 */

export const TOOL_NAMES = [
    'send_update',
    'show_card',
    'update_card',
    'describe_conversation',
    'list_conversations',
    'read_conversation',
    'send_to_conversation',
    'start_new_conversation',
    'convert_to_conversation',
    'wait',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const markdown = (description: string) => ({ type: 'string', description: `${description} (Markdown).` }) as const;
const card = {
    type: 'object',
    description: 'An Adaptive Card: a JSON object with "type": "AdaptiveCard" and a "version" Teams supports.',
} as const;
const conversationId = (description: string) => ({ type: 'string', description }) as const;
const description = {
    title: { type: 'string', description: 'A short title (at most 200 characters).' },
    summary: {
        type: 'string',
        description: 'What the conversation is about and where it stands (at most 2000 characters).',
    },
    tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tags other sessions can find the conversation by, such as incident or ticket IDs.',
    },
} as const;

const definitions: Record<ToolName, BetaManagedAgentsCustomToolParams> = {
    send_update: {
        type: 'custom',
        name: 'send_update',
        description:
            'Posts `text` in your own thread immediately, for progress during long work. Your final answer is ' +
            'posted automatically at the end of the turn, so do not repeat it here. Fails while your session has ' +
            'no conversation (a job session before `convert_to_conversation`).',
        input_schema: {
            type: 'object',
            properties: { text: markdown('The update') },
            required: ['text'],
        },
    },
    show_card: {
        type: 'custom',
        name: 'show_card',
        description:
            'Shows an Adaptive Card in your thread and returns its `card_id`. Buttons must be `Action.Execute` ' +
            "(`Action.Submit` is rejected); put what you need to recognise the choice into the action's `verb` " +
            'and `data`. A click locks the card at once and you receive a `[switchboard:card]` message with the ' +
            'verb, the data, the input values and the verified clicker; call `update_card` promptly after it, ' +
            'which unlocks the card. Cards close for good when your session ends.',
        input_schema: { type: 'object', properties: { card }, required: ['card'] },
    },
    update_card: {
        type: 'custom',
        name: 'update_card',
        description:
            'Replaces one of your cards in place with `card` and unlocks it; the new card may have new buttons or ' +
            'none (for example to show a decision). Always call it after a `[switchboard:card]` message, also to ' +
            'just confirm the outcome. Only cards your session showed can be updated, and closed cards cannot.',
        input_schema: {
            type: 'object',
            properties: { card_id: { type: 'string', description: 'The ID `show_card` returned.' }, card },
            required: ['card_id', 'card'],
        },
    },
    describe_conversation: {
        type: 'custom',
        name: 'describe_conversation',
        description:
            'Sets the title, summary and tags of your own conversation; other sessions find conversations by them ' +
            '(`list_conversations`). Describe your conversation early and update the description whenever ' +
            'something important changes: status, cause found, decision taken. Fields you leave out stay as they ' +
            'are; `tags` replaces the list. Fails while your session has no conversation.',
        input_schema: { type: 'object', properties: description },
    },
    list_conversations: {
        type: 'custom',
        name: 'list_conversations',
        description:
            'Lists the threads of your channel, latest activity first, read from Teams: each with its ID, link, ' +
            'title, summary, tags, the start of its opening post, when it was opened and last active, and whether ' +
            'a session is active in it. Look here for an existing conversation on a topic (by tags, then titles) ' +
            'before opening a new one. Pass `cursor` from a result to get the next page.',
        input_schema: {
            type: 'object',
            properties: {
                active_only: { type: 'boolean', description: 'Only conversations with an active session.' },
                activity_since: {
                    type: 'string',
                    description: 'Only conversations active at or after this time (ISO 8601).',
                },
                tags: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Only conversations that have all of these tags.',
                },
                cursor: { type: 'string', description: 'The `cursor` of the previous result.' },
            },
        },
    },
    read_conversation: {
        type: 'custom',
        name: 'read_conversation',
        description:
            'Reads a thread of your channel as people see it in Teams, newest messages first, annotated with ' +
            'which session posted what, card states and clicks, and session starts and ends. Pass `cursor` from a ' +
            'result to read older messages.',
        input_schema: {
            type: 'object',
            properties: {
                conversation_id: conversationId('The conversation to read.'),
                cursor: { type: 'string', description: 'The `cursor` of the previous result.' },
            },
            required: ['conversation_id'],
        },
    },
    send_to_conversation: {
        type: 'custom',
        name: 'send_to_conversation',
        description:
            'Sends `message` into another conversation of your channel: it appears there as a visible note from ' +
            'you, and the session of that thread receives it (one is started if the thread has none). Use it to ' +
            'bring news to where a topic already lives. Fire and forget: nothing comes back to you, not even the ' +
            "other session's answer; read the thread later with `read_conversation` or `wait` for a message in " +
            'it. Not for your own conversation. `delivered: false` means the note is in the thread but its ' +
            'session could not be reached; do not send it again blindly.',
        input_schema: {
            type: 'object',
            properties: {
                conversation_id: conversationId('The conversation to send to.'),
                message: markdown('The message'),
            },
            required: ['conversation_id', 'message'],
        },
    },
    start_new_conversation: {
        type: 'custom',
        name: 'start_new_conversation',
        description:
            'Opens a new thread in your channel with `message` as its opening post, for a topic that should be ' +
            'followed on its own; check `list_conversations` first whether one exists already. No session starts ' +
            'yet: when someone replies or a session sends to it, a new session takes over the thread and receives ' +
            'the opening post, your `briefing` (never shown in Teams) and the new message. Your own session is not ' +
            'linked to the new thread. Returns its `conversation_id` and link.',
        input_schema: {
            type: 'object',
            properties: {
                message: markdown('The opening post of the new thread'),
                briefing: {
                    type: 'string',
                    description:
                        'Optional context for the session that will take over the thread: what you know, what to ' +
                        'check, what is open. Not shown in Teams.',
                },
                ...description,
            },
            required: ['message'],
        },
    },
    convert_to_conversation: {
        type: 'custom',
        name: 'convert_to_conversation',
        description:
            'Only for job (background) sessions: opens a new thread in your channel with `message` as its opening ' +
            'post and makes your session its owner. From then on your final answers are posted there and replies ' +
            'reach you, as in any conversation; use it when a finding needs discussion with the people in the ' +
            'channel. Fails if your session already owns a conversation. Returns its `conversation_id` and link.',
        input_schema: {
            type: 'object',
            properties: { message: markdown('The opening post of the thread'), ...description },
            required: ['message'],
        },
    },
    wait: {
        type: 'custom',
        name: 'wait',
        description:
            `Pauses your session for \`minutes\` (at most ${MAX_WAIT_MINUTES}; call it again to wait longer). With ` +
            '`conversation_id` (another conversation of your channel) it ends as soon as a new message appears ' +
            'there. It ends early when something arrives for you (a reply in your thread, a card click, a session ' +
            'message); handle that first. Returns `reason`: `timeout`, `conversation_message` (with the message in ' +
            'brief) or `own_message`.',
        input_schema: {
            type: 'object',
            properties: {
                minutes: { type: 'number', description: `How long to wait, at most ${MAX_WAIT_MINUTES}.` },
                conversation_id: conversationId('Optional: end the wait when a message appears in this conversation.'),
            },
            required: ['minutes'],
        },
    },
};

/** The tools added to a session of this kind. Job sessions get all of them, as they can become conversations. */
export const toolsFor = (kind: 'conversation' | 'job'): BetaManagedAgentsCustomToolParams[] =>
    TOOL_NAMES.filter((name) => kind === 'job' || name !== 'convert_to_conversation').map((name) => definitions[name]);

export const isToolName = (name: string): name is ToolName => (TOOL_NAMES as readonly string[]).includes(name);

const Card = z.record(z.string(), z.unknown());
const Id = z.string().min(1).max(200);
const Description = {
    title: z.string().min(1).max(200).optional(),
    summary: z.string().max(2_000).optional(),
    tags: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
};
/** Leaves room for the note's sender line within one Teams message. */
const Message = z.string().min(1).max(10_000);

/** Tool inputs, validated before a call is carried out (agents are untrusted). */
export const ToolInputs = {
    send_update: z.object({ text: z.string().min(1) }),
    show_card: z.object({ card: Card }),
    update_card: z.object({ card_id: Id, card: Card }),
    describe_conversation: z.object(Description),
    list_conversations: z.object({
        active_only: z.boolean().optional(),
        activity_since: z.iso.datetime({ offset: true }).optional(),
        tags: z.array(z.string().trim().min(1)).optional(),
        cursor: z.string().min(1).optional(),
    }),
    read_conversation: z.object({ conversation_id: Id, cursor: z.string().min(1).optional() }),
    send_to_conversation: z.object({ conversation_id: Id, message: Message }),
    start_new_conversation: z.object({ message: Message, briefing: z.string().optional(), ...Description }),
    convert_to_conversation: z.object({ message: Message, ...Description }),
    wait: z.object({ minutes: z.number().positive(), conversation_id: Id.optional() }),
} satisfies Record<ToolName, z.ZodType>;
export type ToolInput<T extends ToolName> = z.infer<(typeof ToolInputs)[T]>;
