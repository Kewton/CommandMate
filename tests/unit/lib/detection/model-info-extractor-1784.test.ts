/**
 * Reading model + reasoning effort off the terminal frame (Issue #1784).
 *
 * Phase 1 (#1783) gets the model from hook payloads. No hook payload of any tool
 * carries a reasoning effort, so the TUI's own chrome is the only place it
 * exists — this suite is what says the scraping of that chrome is right, and,
 * just as importantly, that it stays quiet rather than guessing when the chrome
 * is not on screen.
 *
 * The real captures live in `tests/fixtures/model-info-captures.ts` and are
 * shot from throwaway sessions at a production pane geometry. Hand-written
 * strings appear here only for the legacy Codex footer formats, which cannot be
 * re-captured from a current CLI; they are transcribed from the format history
 * recorded in `cli-patterns.ts` (#1150).
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_BANNER_MODEL_PATTERN,
  ANTIGRAVITY_MODEL_ID_EFFORT_PATTERN,
  ANTIGRAVITY_STATUS_BAR_HINT_PATTERN,
  CLAUDE_STARTUP_BANNER_PATTERN,
  CODEX_FOOTER_MODEL_PATTERN,
  REASONING_EFFORT_LEVELS,
  deriveEffortFromModelId,
  extractModelInfo,
  mergeModelInfo,
  resolveEffortToken,
} from '@/lib/detection/model-info-extractor';
import {
  ANTIGRAVITY_GENERATING_CAPTURE_V1_1_13,
  ANTIGRAVITY_IDLE_CAPTURE_V1_1_13,
  ANTIGRAVITY_IDLE_CAPTURE_V1_1_13_ANSI,
  CLAUDE_STARTUP_BANNER_CAPTURE_V2_1_232,
  CODEX_FOOTER_CAPTURE_V0_147,
  CODEX_FOOTER_CAPTURE_V0_147_ANSI,
} from '../../../fixtures/model-info-captures';

const UNKNOWN = { model: null, effort: null };

// =============================================================================
// Codex — the footer, in every format the CLI has shipped
// =============================================================================

describe('extractModelInfo: codex', () => {
  it('reads model and effort from a real v0.147 capture', () => {
    expect(extractModelInfo('codex', CODEX_FOOTER_CAPTURE_V0_147)).toEqual({
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
    });
  });

  it('reads the current format: "<model> <effort> · <path>"', () => {
    const capture = ['some conversation', '', 'gpt-5.5 xhigh · ~/share/work/github_kewton/x'].join('\n');
    expect(extractModelInfo('codex', capture)).toEqual({ model: 'gpt-5.5', effort: 'xhigh' });
  });

  it('reads the legacy "% left" format: "<model> <effort> · N% left · <path>"', () => {
    const capture = ['conversation', 'gpt-5.4 high · 21% left · ~/share/work/github_kewton/x'].join('\n');
    expect(extractModelInfo('codex', capture)).toEqual({ model: 'gpt-5.4', effort: 'high' });
  });

  it('reads the legacy effort-less format and reports the model alone', () => {
    // The second token here is "50%", which a positional read would publish as
    // the reasoning effort. It must come back null instead.
    const capture = ['conversation', '  o4-mini            50% left · /path/to/project'].join('\n');
    expect(extractModelInfo('codex', capture)).toEqual({ model: 'o4-mini', effort: null });
  });

  it('takes the LAST status bar, so a scrolled-back one loses to the live one', () => {
    const capture = [
      'gpt-5.4 high · 21% left · ~/old/path',
      'more conversation',
      'gpt-5.6-sol minimal · ~/new/path',
    ].join('\n');
    expect(extractModelInfo('codex', capture)).toEqual({ model: 'gpt-5.6-sol', effort: 'minimal' });
  });

  it('ignores the splash box, which repeats the pair without a trailing path', () => {
    // The real v0.147 capture contains "│ model:     gpt-5.6-sol xhigh   /model
    // to change        │". Cut the footer off and nothing may be read from it.
    const withoutFooter = CODEX_FOOTER_CAPTURE_V0_147.split('\n').slice(0, -1).join('\n');
    expect(withoutFooter).toContain('model:     gpt-5.6-sol xhigh');
    expect(extractModelInfo('codex', withoutFooter)).toEqual(UNKNOWN);
  });

  it('answers unknown for a frame with no status bar at all', () => {
    expect(extractModelInfo('codex', 'just some output\n› \n')).toEqual(UNKNOWN);
  });

  it('does not read a sentence about a file as a model', () => {
    // "<token> … · <path>" is the *boundary* shape the detector uses inside a
    // window it already trusts (#1150). Codex's own prose satisfies it, and a
    // value read here latches for the session — so a version number or an
    // effort keyword is required as corroboration.
    expect(extractModelInfo('codex', 'Updated the helper · /src/lib/foo.ts')).toEqual(UNKNOWN);
    expect(extractModelInfo('codex', 'Wrote · ~/notes/todo.md')).toEqual(UNKNOWN);
  });

  it('still reads a hypothetical digit-less model when an effort corroborates it', () => {
    expect(extractModelInfo('codex', 'sonnet high · ~/share/work/x')).toEqual({
      model: 'sonnet',
      effort: 'high',
    });
  });
});

// =============================================================================
// Claude — the startup banner, and the honest null when it is gone
// =============================================================================

describe('extractModelInfo: claude', () => {
  it('reads model and effort from a real v2.1.232 startup capture', () => {
    expect(extractModelInfo('claude', CLAUDE_STARTUP_BANNER_CAPTURE_V2_1_232)).toEqual({
      model: 'Opus 5 (1M context)',
      effort: 'xhigh',
    });
  });

  it('reads a banner without the "(1M context)" qualifier', () => {
    const capture = '▝▜█████▛▘  Sonnet 5 with medium effort · Claude Pro';
    expect(extractModelInfo('claude', capture)).toEqual({ model: 'Sonnet 5', effort: 'medium' });
  });

  it('does not depend on the plan suffix, which varies by subscription', () => {
    const capture = '▝▜█████▛▘  Opus 5 with low effort';
    expect(extractModelInfo('claude', capture)).toEqual({ model: 'Opus 5', effort: 'low' });
  });

  it('reads the boxed welcome variant, whose art is a box frame not block art', () => {
    const capture =
      '│   Opus 4.8 (1M context) with xhigh effort · Claude Max ·    │';
    expect(extractModelInfo('claude', capture)).toEqual({
      model: 'Opus 4.8 (1M context)',
      effort: 'xhigh',
    });
  });

  it('answers {null, null} when the banner has scrolled out of history', () => {
    // The normal state of any long-lived session: tmux history-limit is 2000.
    const capture = [
      '  Sure, here is the patch.',
      '',
      '❯ ',
      '  ⏸ manual mode on · ? for shortcuts · ← for agents',
    ].join('\n');
    expect(extractModelInfo('claude', capture)).toEqual(UNKNOWN);
  });

  it('takes the LAST banner, so a mid-session /model switch wins', () => {
    const capture = [
      '▝▜█████▛▘  Opus 5 (1M context) with xhigh effort · Claude Max',
      '',
      '  … a few hundred lines of conversation …',
      '',
      '▝▜█████▛▘  Sonnet 5 with low effort · Claude Max',
      '',
      '❯ ',
    ].join('\n');
    expect(extractModelInfo('claude', capture)).toEqual({ model: 'Sonnet 5', effort: 'low' });
  });

  it('does not mistake Claude\'s own prose for a banner', () => {
    // The banner and the answers share one pane. Without the block-glyph anchor
    // this line reads as model "I reran the benchmark".
    const capture = 'I reran the benchmark with high effort and it passed.';
    expect(extractModelInfo('claude', capture)).toEqual(UNKNOWN);
  });

  it('rejects a truncated banner rather than reporting half a value', () => {
    // Narrow panes fold the welcome box: "with xh… · Claude Max".
    const capture = '│   Opus 4.8 (1M context) with xh… · Claude Max ·    │';
    expect(extractModelInfo('claude', capture)).toEqual(UNKNOWN);
  });
});

// =============================================================================
// Antigravity — the status bar (truncated by the renderer) and the banner
// =============================================================================

describe('extractModelInfo: antigravity', () => {
  it('reads the idle status bar from a real agy 1.1.13 capture', () => {
    // "Gemini 3.7 Flash · hig" — agy renders this bar one column short.
    expect(ANTIGRAVITY_IDLE_CAPTURE_V1_1_13).toContain('Gemini 3.7 Flash · hig');
    expect(ANTIGRAVITY_IDLE_CAPTURE_V1_1_13).not.toContain('Gemini 3.7 Flash · high');
    expect(extractModelInfo('antigravity', ANTIGRAVITY_IDLE_CAPTURE_V1_1_13)).toEqual({
      model: 'Gemini 3.7 Flash',
      effort: 'high',
    });
  });

  it('reads the generating status bar, whose left-hand hint differs', () => {
    expect(ANTIGRAVITY_GENERATING_CAPTURE_V1_1_13).toContain('esc to cancel');
    expect(extractModelInfo('antigravity', ANTIGRAVITY_GENERATING_CAPTURE_V1_1_13)).toEqual({
      model: 'Gemini 3.7 Flash',
      effort: 'high',
    });
  });

  it('accepts an untruncated bar too, in case agy fixes its off-by-one', () => {
    const capture = '? for shortcuts                    Gemini 3.5 Flash · medium';
    expect(extractModelInfo('antigravity', capture)).toEqual({
      model: 'Gemini 3.5 Flash',
      effort: 'medium',
    });
  });

  it('falls back to the startup banner when no status bar is on screen', () => {
    const bannerOnly = ANTIGRAVITY_IDLE_CAPTURE_V1_1_13.split('\n')
      .filter((line) => !/for shortcuts|esc to cancel/.test(line))
      .join('\n');
    expect(extractModelInfo('antigravity', bannerOnly)).toEqual({
      model: 'Gemini 3.7 Flash',
      effort: 'high',
    });
  });

  it('does not read the account line, which has the shape but not the vocabulary', () => {
    const capture = '     ▀▀▀▀▀▀       dev@example.com (Google AI Pro)';
    expect(extractModelInfo('antigravity', capture)).toEqual(UNKNOWN);
  });

  it('abandons a status bar whose trailing token is not an effort', () => {
    // Rather than shaving the last letter off a model name that has no effort
    // suffix. "Claude Sonnet 4." is exactly the value that must never ship.
    const capture = '? for shortcuts                    Claude Sonnet 4.6';
    expect(extractModelInfo('antigravity', capture)).toEqual(UNKNOWN);
  });
});

// =============================================================================
// Tools with no rule
// =============================================================================

describe('extractModelInfo: out-of-scope tools', () => {
  it.each(['gemini', 'copilot', 'vibe-local', 'opencode'] as const)(
    'answers unknown for %s',
    (cliToolId) => {
      expect(extractModelInfo(cliToolId, CODEX_FOOTER_CAPTURE_V0_147)).toEqual(UNKNOWN);
    }
  );

  it('answers unknown for empty text', () => {
    expect(extractModelInfo('codex', '')).toEqual(UNKNOWN);
    expect(extractModelInfo('claude', '')).toEqual(UNKNOWN);
  });
});

// =============================================================================
// ANSI — the failure mode that only shows up on a real machine
// =============================================================================

describe('ANSI-bearing captures', () => {
  it('reads the codex footer out of a real escape-laden capture', () => {
    // The SGR sequences land INSIDE the value:
    //   "\x1b[38;2;…m gpt-5.6-sol xhigh \x1b[2m\x1b[39m · …"
    expect(CODEX_FOOTER_CAPTURE_V0_147_ANSI).toContain('\u001b[');
    expect(extractModelInfo('codex', CODEX_FOOTER_CAPTURE_V0_147_ANSI)).toEqual({
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
    });
  });

  it('reads the agy status bar out of a real escape-laden capture', () => {
    expect(ANTIGRAVITY_IDLE_CAPTURE_V1_1_13_ANSI).toContain('\u001b[');
    expect(extractModelInfo('antigravity', ANTIGRAVITY_IDLE_CAPTURE_V1_1_13_ANSI)).toEqual({
      model: 'Gemini 3.7 Flash',
      effort: 'high',
    });
  });

  it('reads a claude banner with the escapes the real TUI emits', () => {
    const line =
      '\u001b[38;5;174m▝▜\u001b[48;5;16m█████\u001b[49m▛▘\u001b[39m  ' +
      '\u001b[38;5;246mOpus 5 (1M context) with xhigh effort · Claude Max\u001b[39m';
    expect(extractModelInfo('claude', line)).toEqual({
      model: 'Opus 5 (1M context)',
      effort: 'xhigh',
    });
  });
});

// =============================================================================
// Effort token resolution
// =============================================================================

describe('resolveEffortToken', () => {
  it.each(REASONING_EFFORT_LEVELS)('accepts %s verbatim', (level) => {
    expect(resolveEffortToken(level)).toBe(level);
    expect(resolveEffortToken(level.toUpperCase())).toBe(level);
  });

  it('rejects a word outside the vocabulary', () => {
    expect(resolveEffortToken('turbo')).toBeNull();
    expect(resolveEffortToken('')).toBeNull();
  });

  it('does NOT accept a truncated token by default', () => {
    expect(resolveEffortToken('hig')).toBeNull();
    expect(resolveEffortToken('mediu')).toBeNull();
  });

  it.each([
    ['hig', 'high'],
    ['lo', 'low'],
    ['mediu', 'medium'],
    ['xhig', 'xhigh'],
    ['minima', 'minimal'],
  ])('recovers agy\'s one-column truncation: %s → %s', (token, expected) => {
    expect(resolveEffortToken(token, { allowTruncated: true })).toBe(expected);
  });

  it('refuses anything shorter than one character short', () => {
    expect(resolveEffortToken('h', { allowTruncated: true })).toBeNull();
    expect(resolveEffortToken('hi', { allowTruncated: true })).toBeNull();
    expect(resolveEffortToken('m', { allowTruncated: true })).toBeNull();
  });
});

// =============================================================================
// Antigravity model ids carry the effort in the name
// =============================================================================

describe('deriveEffortFromModelId', () => {
  it.each([
    ['gemini-3.7-flash-high', 'high'],
    ['gemini-3.6-flash-medium', 'medium'],
    ['gemini-3.5-flash-low', 'low'],
  ])('derives %s → %s', (modelId, expected) => {
    expect(deriveEffortFromModelId(modelId)).toBe(expected);
  });

  it.each(['claude-sonnet-4-6', 'claude-opus-4-6-thinking'])(
    'answers null for %s, which carries no suffix',
    (modelId) => {
      expect(deriveEffortFromModelId(modelId)).toBeNull();
    }
  );

  it('applies the stated rule to gpt-oss-120b-medium', () => {
    // Issue #1784 lists this id among the "no suffix" models while also
    // specifying `-low|-medium|-high$` as the rule; the two contradict each
    // other and the rule is applied as written. Recorded as a test so the
    // choice is visible rather than incidental.
    expect(deriveEffortFromModelId('gpt-oss-120b-medium')).toBe('medium');
  });

  it('answers null for null / empty input', () => {
    expect(deriveEffortFromModelId(null)).toBeNull();
    expect(deriveEffortFromModelId(undefined)).toBeNull();
    expect(deriveEffortFromModelId('')).toBeNull();
  });

  it('does not treat minimal / xhigh as suffixes', () => {
    expect(deriveEffortFromModelId('some-model-xhigh')).toBeNull();
    expect(deriveEffortFromModelId('some-model-minimal')).toBeNull();
  });
});

// =============================================================================
// The merge rule
// =============================================================================

describe('mergeModelInfo', () => {
  it('prefers the hook-reported model over the scraped one when they disagree', () => {
    expect(
      mergeModelInfo('codex', 'gpt-5.6-sol-2026-08-01', { model: 'gpt-5.6-sol', effort: 'xhigh' })
    ).toEqual({ model: 'gpt-5.6-sol-2026-08-01', effort: 'xhigh' });
  });

  it('falls back to the scraped model when no hook has reported one', () => {
    expect(mergeModelInfo('claude', null, { model: 'Opus 5 (1M context)', effort: 'xhigh' })).toEqual({
      model: 'Opus 5 (1M context)',
      effort: 'xhigh',
    });
  });

  it('treats an empty hook model as no hook model', () => {
    expect(mergeModelInfo('codex', '', { model: 'o4-mini', effort: null })).toEqual({
      model: 'o4-mini',
      effort: null,
    });
  });

  it('takes effort from the capture for codex and claude', () => {
    expect(mergeModelInfo('codex', 'gpt-5.6-sol', { model: null, effort: 'minimal' }).effort).toBe(
      'minimal'
    );
    expect(mergeModelInfo('claude', 'claude-opus-5[1m]', { model: null, effort: 'high' }).effort).toBe(
      'high'
    );
  });

  it('prefers the id-derived effort over the capture for antigravity', () => {
    expect(
      mergeModelInfo('antigravity', 'gemini-3.5-flash-low', {
        model: 'Gemini 3.7 Flash',
        effort: 'high',
      })
    ).toEqual({ model: 'gemini-3.5-flash-low', effort: 'low' });
  });

  it('falls back to the capture for an antigravity id with no suffix', () => {
    expect(
      mergeModelInfo('antigravity', 'claude-sonnet-4-6', {
        model: 'Claude Sonnet 4.6',
        effort: 'medium',
      })
    ).toEqual({ model: 'claude-sonnet-4-6', effort: 'medium' });
  });

  it('answers all-null when neither source knows anything', () => {
    expect(mergeModelInfo('gemini', null, null)).toEqual(UNKNOWN);
    expect(mergeModelInfo('gemini', null, undefined)).toEqual(UNKNOWN);
  });
});

// =============================================================================
// Pattern hygiene — the repo-wide rules for detection regexes
// =============================================================================

describe('pattern hygiene', () => {
  const patterns: Array<[string, RegExp]> = [
    ['CODEX_FOOTER_MODEL_PATTERN', CODEX_FOOTER_MODEL_PATTERN],
    ['CLAUDE_STARTUP_BANNER_PATTERN', CLAUDE_STARTUP_BANNER_PATTERN],
    ['ANTIGRAVITY_STATUS_BAR_HINT_PATTERN', ANTIGRAVITY_STATUS_BAR_HINT_PATTERN],
    ['ANTIGRAVITY_BANNER_MODEL_PATTERN', ANTIGRAVITY_BANNER_MODEL_PATTERN],
    ['ANTIGRAVITY_MODEL_ID_EFFORT_PATTERN', ANTIGRAVITY_MODEL_ID_EFFORT_PATTERN],
  ];

  it.each(patterns)('%s carries no /g flag (stateless test/exec)', (_name, pattern) => {
    expect(pattern.global).toBe(false);
  });

  it.each(patterns)('%s has no nested quantifier (ReDoS-safe)', (_name, pattern) => {
    // A nested quantifier is a quantified group that itself ends in a
    // quantifier — `(a+)+`, `(?:x*)*`. Adjacent quantifiers are fine and are
    // what cli-patterns.ts already relies on.
    expect(pattern.source).not.toMatch(/[+*?}]\s*\)\s*[+*{]/);
  });

  it.each(patterns)('%s returns promptly on a long adversarial line', (_name, pattern) => {
    const hostile = `${' '.repeat(400)}${'·'.repeat(200)}${'a '.repeat(400)}`;
    const started = Date.now();
    pattern.test(hostile);
    expect(Date.now() - started).toBeLessThan(200);
  });
});
