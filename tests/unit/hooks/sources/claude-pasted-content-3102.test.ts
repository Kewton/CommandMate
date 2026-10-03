/**
 * The paste wrapper Claude Code puts around a multi-line prompt (Issue #3102).
 *
 * @vitest-environment node
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildClaudeTurns,
  claudePastedContentPrompt,
  parseClaudeTranscript,
} from '@/lib/hooks/sources/claude/transcript';

describe('claudePastedContentPrompt', () => {
  it('takes off a wrapper that encloses the whole text', () => {
    const text = '\n\n<pasted_content id="6b21">\n/orchestrate 3099\n\n説明\n</pasted_content id="6b21">';
    expect(claudePastedContentPrompt(text).trim()).toBe('/orchestrate 3099\n\n説明');
  });

  it('replaces a wrapper in the middle of typed text', () => {
    const text = 'before <pasted_content id="a1">\nline1\nline2\n</pasted_content id="a1"> after';
    expect(claudePastedContentPrompt(text)).toBe('before line1\nline2 after');
  });

  it('replaces every wrapper when there are two', () => {
    const text = 'x <pasted_content id="a1">\nA\n</pasted_content id="a1"> y <pasted_content id="b2">\nB\n</pasted_content id="b2"> z';
    expect(claudePastedContentPrompt(text)).toBe('x A y B z');
  });

  it('leaves a pair whose ids differ', () => {
    const text = '<pasted_content id="a1">\nA\n</pasted_content id="b2">';
    expect(claudePastedContentPrompt(text)).toBe(text);
  });

  it('leaves an incomplete tag that is only written about', () => {
    const text = 'Claude wraps a paste in <pasted_content id="X"> and closes it later.';
    expect(claudePastedContentPrompt(text)).toBe(text);
  });

  it('keeps the original when the wrapper is empty', () => {
    const text = '<pasted_content id="a1">\n</pasted_content id="a1">';
    expect(claudePastedContentPrompt(text)).toBe(text);
  });

  it('returns text without a wrapper unchanged', () => {
    expect(claudePastedContentPrompt('plain')).toBe('plain');
  });
});

describe('a pasted user record from a transcript', () => {
  it('opens a turn whose promptText has no wrapper', () => {
    const raw = readFileSync(join(process.cwd(), 'tests/fixtures/claude-transcript-3102/pasted-user-record.jsonl'), 'utf8');
    const parsed = parseClaudeTranscript(raw);
    expect(parsed.malformedLines).toBe(0);
    const { turns } = buildClaudeTurns(parsed.records, 'fallback-session');
    expect(turns).toHaveLength(1);
    expect(turns[0].promptText).not.toContain('pasted_content');
    expect(turns[0].promptText.trim().startsWith('/orchestrate 3099 3100')).toBe(true);
  });
});
