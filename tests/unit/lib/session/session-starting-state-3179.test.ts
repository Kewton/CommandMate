/**
 * Issue #3179 — the record of a launch in progress, and its escape hatches.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearSessionStarting,
  getSessionStartingSince,
  markSessionStarting,
  observeSessionStartingFrame,
  resetSessionStartingState,
  startingStatusResult,
} from '@/lib/session/session-starting-state';
import {
  SESSION_STARTING_GRACE_MS,
  SESSION_STARTING_PROMPT_GRACE_MS,
  getSessionStartingMaxMs,
} from '@/config/session-starting-config';
import { STATUS_REASON } from '@/lib/detection/status-reason';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';

const WT = 'wt-3179';
const T0 = 1_000_000;

describe('[#3179] session-starting-state', () => {
  beforeEach(() => resetSessionStartingState());

  it('answers the start time between mark and clear, and null after', () => {
    expect(getSessionStartingSince(WT, 'antigravity', undefined, T0)).toBeNull();
    markSessionStarting(WT, 'antigravity', undefined, T0);
    expect(getSessionStartingSince(WT, 'antigravity', undefined, T0 + 1000)).toBe(T0);
    clearSessionStarting(WT, 'antigravity');
    expect(getSessionStartingSince(WT, 'antigravity', undefined, T0 + 1000)).toBeNull();
  });

  it('keys by instance: the primary and an alias are separate launches', () => {
    markSessionStarting(WT, 'claude', 'claude-2', T0);
    expect(getSessionStartingSince(WT, 'claude', 'claude-2', T0)).toBe(T0);
    expect(getSessionStartingSince(WT, 'claude', undefined, T0)).toBeNull();
    expect(getSessionStartingSince(WT, 'claude', 'claude', T0)).toBeNull();
  });

  it('treats the primary instance id and an omitted id as the same key', () => {
    markSessionStarting(WT, 'codex', 'codex', T0);
    expect(getSessionStartingSince(WT, 'codex', undefined, T0)).toBe(T0);
  });

  it('clear never throws, even for an id that cannot form a key', () => {
    expect(() => clearSessionStarting('bad:id', 'claude')).not.toThrow();
  });

  it.each(CLI_TOOL_IDS)('%s: stops answering past its readiness wait (the over-limit escape)', (tool) => {
    markSessionStarting(WT, tool, undefined, T0);
    const max = getSessionStartingMaxMs(tool);
    expect(getSessionStartingSince(WT, tool, undefined, T0 + max)).toBe(T0);
    expect(getSessionStartingSince(WT, tool, undefined, T0 + max + 1)).toBeNull();
  });

  it('gives claude its 60 s composer wait and the rest their 30 s, plus the grace', () => {
    expect(getSessionStartingMaxMs('claude')).toBe(60_000 + SESSION_STARTING_GRACE_MS);
    expect(getSessionStartingMaxMs('antigravity')).toBe(30_000 + SESSION_STARTING_GRACE_MS);
  });

  it('a dialog the launch answers quickly does not end the starting state', () => {
    markSessionStarting(WT, 'antigravity', undefined, T0);
    expect(observeSessionStartingFrame(WT, 'antigravity', undefined, true, T0 + 1000)).toBe(T0);
    expect(observeSessionStartingFrame(WT, 'antigravity', undefined, true, T0 + 2000)).toBe(T0);
    // Answered: the dwell resets.
    expect(observeSessionStartingFrame(WT, 'antigravity', undefined, false, T0 + 3000)).toBe(T0);
    expect(
      observeSessionStartingFrame(WT, 'antigravity', undefined, true, T0 + 3000 + SESSION_STARTING_PROMPT_GRACE_MS - 1),
    ).toBe(T0);
  });

  it('a dialog the launch does not answer ends it, and it stays ended (the unanswered-prompt escape)', () => {
    markSessionStarting(WT, 'claude', undefined, T0);
    expect(observeSessionStartingFrame(WT, 'claude', undefined, true, T0 + 1000)).toBe(T0);
    expect(
      observeSessionStartingFrame(WT, 'claude', undefined, true, T0 + 1000 + SESSION_STARTING_PROMPT_GRACE_MS),
    ).toBeNull();
    // Answered afterwards: no flicker back to "starting".
    expect(observeSessionStartingFrame(WT, 'claude', undefined, false, T0 + 20_000)).toBeNull();
    expect(getSessionStartingSince(WT, 'claude', undefined, T0 + 20_000)).toBeNull();
  });

  it('a new launch after a release starts afresh', () => {
    markSessionStarting(WT, 'claude', undefined, T0);
    observeSessionStartingFrame(WT, 'claude', undefined, true, T0);
    observeSessionStartingFrame(WT, 'claude', undefined, true, T0 + SESSION_STARTING_PROMPT_GRACE_MS);
    markSessionStarting(WT, 'claude', undefined, T0 + 60_000);
    expect(getSessionStartingSince(WT, 'claude', undefined, T0 + 60_001)).toBe(T0 + 60_000);
  });

  it('startingStatusResult neutralises any verdict to running/starting with no prompt', () => {
    const raw = detectSessionStatus('Do you trust the contents of this project?\n1. Yes\n2. No\n', 'antigravity');
    const neutral = startingStatusResult(raw);
    expect(neutral.status).toBe('running');
    expect(neutral.reason).toBe(STATUS_REASON.STARTING);
    expect(neutral.hasActivePrompt).toBe(false);
    expect(neutral.promptDetection.isPrompt).toBe(false);
    expect(neutral.promptDetection.promptData).toBeUndefined();
  });
});
