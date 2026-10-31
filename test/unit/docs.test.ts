import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { loadAppendix } from '../../src/claude/templates.ts';
import { TOOL_NAMES } from '../../src/tools/definitions.ts';

const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');

describe('README', () => {
    it('shows the system prompt appendix exactly as sessions get it', () => {
        assert.ok(readme.includes(loadAppendix()), 'README and prompt/switchboard-appendix.md differ');
    });

    it('documents every tool', () => {
        for (const name of TOOL_NAMES) assert.ok(readme.includes(`| \`${name}\` |`), name);
    });
});
