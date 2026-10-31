import type { BetaManagedAgentsCustomToolParams } from '@anthropic-ai/sdk/resources/beta/agents/agents';
import { z } from 'zod';

/**
 * Switchboard's custom tools (concept: "Tools for agents"). Switchboard adds them to every session it creates;
 * agent definitions stay free of them. Every tool acts on the calling session only.
 */

export const TOOL_NAMES = [
    'start_new_conversation',
    'convert_to_conversation',
    'send_update',
    'show_card',
    'update_card',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const markdown = { type: 'string', description: 'Markdown text.' } as const;
const card = {
    type: 'object',
    description: 'An Adaptive Card: a JSON object with "type": "AdaptiveCard" and a "version" Teams supports.',
} as const;

const definitions: Record<ToolName, BetaManagedAgentsCustomToolParams> = {
    start_new_conversation: {
        type: 'custom',
        name: 'start_new_conversation',
        description:
            'Opens a new thread in your channel with `message` as its opening post, for a topic that should be ' +
            'followed on its own. No session starts yet: when someone replies, a new session takes over the ' +
            'thread and receives the opening post, your `briefing` (never shown in Teams) and the reply. Your own ' +
            'session is not linked to the new thread, so use it for handing a topic over, not for continuing yourself.',
        input_schema: {
            type: 'object',
            properties: {
                message: { ...markdown, description: 'The opening post of the new thread (Markdown).' },
                briefing: {
                    type: 'string',
                    description:
                        'Optional context for the session that will take over the thread: what you know, what to ' +
                        'check, what is open. Not shown in Teams.',
                },
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
            'channel. Fails if your session already owns a conversation.',
        input_schema: {
            type: 'object',
            properties: { message: { ...markdown, description: 'The opening post of the thread (Markdown).' } },
            required: ['message'],
        },
    },
    send_update: {
        type: 'custom',
        name: 'send_update',
        description:
            'Posts `text` in your own thread immediately, for progress during long work. Your final answer is ' +
            'posted automatically at the end of the turn, so do not repeat it here. Fails while your session has ' +
            'no conversation (a job session before `convert_to_conversation`).',
        input_schema: {
            type: 'object',
            properties: { text: { ...markdown, description: 'The update (Markdown).' } },
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
            properties: {
                card_id: { type: 'string', description: 'The ID `show_card` returned.' },
                card,
            },
            required: ['card_id', 'card'],
        },
    },
};

/** The tools added to a session of this kind. Job sessions get all of them, as they can become conversations. */
export const toolsFor = (kind: 'conversation' | 'job'): BetaManagedAgentsCustomToolParams[] =>
    TOOL_NAMES.filter((name) => kind === 'job' || name !== 'convert_to_conversation').map((name) => definitions[name]);

export const isToolName = (name: string): name is ToolName => (TOOL_NAMES as readonly string[]).includes(name);

const Card = z.record(z.string(), z.unknown());

/** Tool inputs, validated before a call is carried out (agents are untrusted). */
export const ToolInputs = {
    start_new_conversation: z.object({ message: z.string().min(1), briefing: z.string().optional() }),
    convert_to_conversation: z.object({ message: z.string().min(1) }),
    send_update: z.object({ text: z.string().min(1) }),
    show_card: z.object({ card: Card }),
    update_card: z.object({ card_id: z.string().min(1), card: Card }),
} satisfies Record<ToolName, z.ZodType>;
