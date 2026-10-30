import Anthropic from '@anthropic-ai/sdk';
import type { Env } from '../config/env.ts';

/**
 * The Claude API client. Without an API key the SDK resolves Workload Identity Federation from the environment
 * (`ANTHROPIC_FEDERATION_RULE_ID`, …): it exchanges the identity token for a short-lived access token and refreshes
 * it before it expires, re-reading the token file each time.
 */
export const createAnthropicClient = (env: Pick<Env, 'anthropicApiKey' | 'anthropicBaseUrl'>): Anthropic =>
    new Anthropic({
        ...(env.anthropicApiKey ? { apiKey: env.anthropicApiKey } : {}),
        baseURL: env.anthropicBaseUrl ?? null,
    });
