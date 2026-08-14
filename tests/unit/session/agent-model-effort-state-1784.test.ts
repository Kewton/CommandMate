/**
 * Remembering what the terminal frame showed (Issue #1784).
 *
 * The retention half of Phase 2. `extractModelInfo` is pure and is proved
 * elsewhere; what this suite is about is the two things a pure function cannot
 * say:
 *
 *  - **the latch**, because Claude prints its model exactly once, in a banner
 *    that tmux's 2000-line history evicts within an hour of ordinary work. A
 *    poll that reads a frame with no banner is not the model becoming unknown.
 *  - **the precedence**, because two sources now answer "which model" and one
 *    of them is a display name the other spells exactly (`Gemini 3.7 Flash` vs
 *    `gemini-3.7-flash-high`). Written into one map, the wrong one wins
 *    whenever it was written last.
 *
 * The state lives on `globalThis` and CI runs with `fileParallelism: false`, so
 * `clearAgentStopEvents` runs before AND after each test — a value latched here
 * and read by an unrelated suite is a failure that reproduces only in CI, in
 * file order.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  beginAgentEventGeneration,
  clearAgentStopEvents,
  discardAgentEventState,
  getLastCapturedModelInfo,
  getLastKnownAgentEffort,
  getLastKnownAgentModel,
  getResolvedAgentModelInfo,
  recordAgentEvent,
  recordCapturedModelInfo,
} from '@/lib/session/agent-event-state';
import { extractModelInfo } from '@/lib/detection/model-info-extractor';
import { MAX_EVENT_DETAIL_LENGTH } from '@/lib/hooks/agent-event-types';
import {
  ANTIGRAVITY_IDLE_CAPTURE_V1_1_13,
  CLAUDE_STARTUP_BANNER_CAPTURE_V2_1_232,
  CODEX_FOOTER_CAPTURE_V0_147,
} from '../../fixtures/model-info-captures';

const WT = 'wt-1784';
const NOW = 1_800_000_000_000;

beforeEach(() => clearAgentStopEvents());
afterEach(() => clearAgentStopEvents());

/** One `session_start` delivery carrying a model — the #1783 half. */
function hookSaid(cliToolId: 'codex' | 'claude' | 'antigravity', model: string): void {
  recordAgentEvent(WT, cliToolId, cliToolId, {
    event: 'session_start',
    at: NOW,
    detail: null,
    sessionId: 'ses-1784',
    model,
  });
}

/** What the status poll does: capture → extract → latch. */
function poll(cliToolId: 'codex' | 'claude' | 'antigravity', capture: string, instanceId?: string) {
  recordCapturedModelInfo(WT, cliToolId, instanceId, extractModelInfo(cliToolId, capture));
}

describe('recordCapturedModelInfo', () => {
  it('answers all-null before any frame has been read', () => {
    expect(getLastCapturedModelInfo(WT, 'codex', 'codex')).toEqual({ model: null, effort: null });
    expect(getResolvedAgentModelInfo(WT, 'codex', 'codex')).toEqual({ model: null, effort: null });
    expect(getLastKnownAgentEffort(WT, 'codex', 'codex')).toBeNull();
  });

  it('latches what a real codex footer showed', () => {
    poll('codex', CODEX_FOOTER_CAPTURE_V0_147, 'codex');
    expect(getLastCapturedModelInfo(WT, 'codex', 'codex')).toEqual({
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
    });
  });

  it('keeps the last sighting when the banner scrolls out — the Claude case', () => {
    poll('claude', CLAUDE_STARTUP_BANNER_CAPTURE_V2_1_232, 'claude');
    expect(getLastKnownAgentEffort(WT, 'claude', 'claude')).toBe('xhigh');

    // An hour later the banner is gone from a 2000-line history. This is the
    // ordinary state of a working session, not an error.
    poll('claude', '  Done. Anything else?\n\n❯ \n', 'claude');
    expect(getResolvedAgentModelInfo(WT, 'claude', 'claude')).toEqual({
      model: 'Opus 5 (1M context)',
      effort: 'xhigh',
    });
  });

  it('lets a newer frame overwrite an older one — the /model switch case', () => {
    poll('claude', '▝▜█████▛▘  Opus 5 (1M context) with xhigh effort · Claude Max', 'claude');
    poll('claude', '▝▜█████▛▘  Sonnet 5 with low effort · Claude Max', 'claude');
    expect(getResolvedAgentModelInfo(WT, 'claude', 'claude')).toEqual({
      model: 'Sonnet 5',
      effort: 'low',
    });
  });

  it('latches each half independently', () => {
    // A codex footer with an effort, then a legacy one without: the effort that
    // was proved must not be blanked by a frame that simply does not show one.
    poll('codex', 'gpt-5.6-sol xhigh · ~/a/b', 'codex');
    poll('codex', '  o4-mini            50% left · /a/b', 'codex');
    expect(getLastCapturedModelInfo(WT, 'codex', 'codex')).toEqual({
      model: 'o4-mini',
      effort: 'xhigh',
    });
  });

  it('writes nothing at all for a frame that showed nothing', () => {
    poll('codex', 'no chrome here', 'codex');
    expect(getLastCapturedModelInfo(WT, 'codex', 'codex')).toEqual({ model: null, effort: null });
  });

  it('bounds the model it stores', () => {
    recordCapturedModelInfo(WT, 'codex', 'codex', { model: 'x'.repeat(5000), effort: null });
    expect(getLastCapturedModelInfo(WT, 'codex', 'codex').model).toHaveLength(
      MAX_EVENT_DETAIL_LENGTH
    );
  });

  it('keeps instances, tools and worktrees apart', () => {
    poll('codex', 'gpt-5.6-sol xhigh · ~/a', 'codex');
    poll('codex', 'gpt-5.4 low · ~/a', 'codex-2');
    expect(getLastCapturedModelInfo(WT, 'codex', 'codex').effort).toBe('xhigh');
    expect(getLastCapturedModelInfo(WT, 'codex', 'codex-2').effort).toBe('low');
    expect(getLastCapturedModelInfo(WT, 'claude', 'claude').effort).toBeNull();
    expect(getLastCapturedModelInfo('other-wt', 'codex', 'codex').effort).toBeNull();
  });
});

// =============================================================================
// The precedence between the two sources
// =============================================================================

describe('getResolvedAgentModelInfo', () => {
  it('prefers the hook-reported model and keeps the scraped effort', () => {
    hookSaid('codex', 'gpt-5.6-sol-2026-08-01');
    poll('codex', 'gpt-5.6-sol xhigh · ~/a/b', 'codex');

    expect(getResolvedAgentModelInfo(WT, 'codex', 'codex')).toEqual({
      // The exact id the agent named itself with, not the footer's short form.
      model: 'gpt-5.6-sol-2026-08-01',
      // Which no hook payload of any tool carries — the screen is the only source.
      effort: 'xhigh',
    });
  });

  it('fills the hole hooks leave: a model from the frame alone', () => {
    // The claude-after-a-server-restart case. `getLastKnownAgentModel` is still
    // null; the resolved answer is not.
    poll('claude', CLAUDE_STARTUP_BANNER_CAPTURE_V2_1_232, 'claude');
    expect(getLastKnownAgentModel(WT, 'claude', 'claude')).toBeNull();
    expect(getResolvedAgentModelInfo(WT, 'claude', 'claude')).toEqual({
      model: 'Opus 5 (1M context)',
      effort: 'xhigh',
    });
  });

  it('prefers antigravity\'s id-derived effort over its truncated status bar', () => {
    hookSaid('antigravity', 'gemini-3.5-flash-low');
    // The live bar says "high" (as "hig"); the id the agent reports says low.
    poll('antigravity', ANTIGRAVITY_IDLE_CAPTURE_V1_1_13, 'antigravity');

    expect(getResolvedAgentModelInfo(WT, 'antigravity', 'antigravity')).toEqual({
      model: 'gemini-3.5-flash-low',
      effort: 'low',
    });
  });

  it('falls back to the bar for an antigravity id with no effort suffix', () => {
    hookSaid('antigravity', 'claude-sonnet-4-6');
    poll('antigravity', ANTIGRAVITY_IDLE_CAPTURE_V1_1_13, 'antigravity');

    expect(getResolvedAgentModelInfo(WT, 'antigravity', 'antigravity')).toEqual({
      model: 'claude-sonnet-4-6',
      effort: 'high',
    });
  });
});

// =============================================================================
// Identity — the latch does not outlive the process it described
// =============================================================================

describe('lifecycle', () => {
  it('drops the scraped values when a new generation opens', () => {
    poll('codex', CODEX_FOOTER_CAPTURE_V0_147, 'codex');
    expect(getLastKnownAgentEffort(WT, 'codex', 'codex')).toBe('xhigh');

    beginAgentEventGeneration(WT, 'codex', 'codex');
    expect(getLastCapturedModelInfo(WT, 'codex', 'codex')).toEqual({ model: null, effort: null });
    expect(getLastKnownAgentEffort(WT, 'codex', 'codex')).toBeNull();
  });

  it('drops them when the session is discarded', () => {
    poll('codex', CODEX_FOOTER_CAPTURE_V0_147, 'codex');
    discardAgentEventState(WT, 'codex', 'codex');
    expect(getLastCapturedModelInfo(WT, 'codex', 'codex')).toEqual({ model: null, effort: null });
  });

  it('drops them on the test seam, so no suite leaks into the next', () => {
    poll('codex', CODEX_FOOTER_CAPTURE_V0_147, 'codex');
    clearAgentStopEvents();
    expect(getLastCapturedModelInfo(WT, 'codex', 'codex')).toEqual({ model: null, effort: null });
  });
});
