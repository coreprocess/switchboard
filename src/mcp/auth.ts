import { timingSafeEqual } from 'node:crypto';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { NextFunction, Request, Response } from 'express';
import { digestToken, type McpToken } from '../config/env.ts';

/** What a validated MCP token grants, carried in `AuthInfo.extra`. */
export interface McpGrant {
    name: string;
    channels: string[];
}

export const grantOf = (authInfo: AuthInfo | undefined): McpGrant | undefined => {
    const grant = authInfo?.extra?.grant as McpGrant | undefined;
    return grant && typeof grant.name === 'string' && Array.isArray(grant.channels) ? grant : undefined;
};

/** Finds the configured token, comparing SHA-256 digests in constant time. */
export const findToken = (tokens: McpToken[], presented: string): McpToken | undefined => {
    const digest = digestToken(presented);
    let found: McpToken | undefined;
    for (const token of tokens) {
        if (timingSafeEqual(token.digest, digest)) found = token;
    }
    return found;
};

/**
 * `Authorization: Bearer <token>` against `SWITCHBOARD_MCP_TOKENS`. Sets `req.auth`, which the MCP SDK's Node
 * handler passes to tools as `ctx.http.authInfo`.
 */
export const mcpBearerAuth =
    (tokens: McpToken[]) =>
    (req: Request, res: Response, next: NextFunction): void => {
        const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
        const token = match?.[1] ? findToken(tokens, match[1]) : undefined;
        if (!token) {
            res.status(401)
                .set('WWW-Authenticate', 'Bearer')
                .json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
            return;
        }
        const grant: McpGrant = { name: token.name, channels: token.channels };
        const auth: AuthInfo = { token: '[redacted]', clientId: token.name, scopes: [], extra: { grant } };
        (req as Request & { auth?: AuthInfo }).auth = auth;
        next();
    };
