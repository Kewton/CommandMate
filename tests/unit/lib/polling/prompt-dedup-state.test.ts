/**
 * Issue #1695: the tally of prompts the dedup guard suppressed.
 *
 * The store is what lets `capture --json` say "the guard dropped it" instead of
 * leaving an operator unable to tell that from "nothing classified the frame"
 * (Issue #1676), so the properties that matter are: it counts rather than
 * overwrites, it reports an explicit zero for a session it has never fired for,
 * per-session isolation via the composite key, and it survives a worktree-ID
 * rename the way the dedup hash it explains does.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordPromptDedupSkip,
  getPromptDedupSkips,
  renamePromptDedupSkips,
  clearPromptDedupSkips,
} from '@/lib/polling/prompt-dedup-state';

beforeEach(() => {
  clearPromptDedupSkips();
});

describe('prompt-dedup-state', () => {
  it('reports an explicit zero for a session the guard never fired for', () => {
    // Not null and not undefined: a consumer reading `promptDedup.skippedCount`
    // must get a number it can compare, because "0 skips" is half the answer the
    // field exists to give.
    expect(getPromptDedupSkips('wt-a', 'claude')).toEqual({
      skippedCount: 0,
      lastSkippedAt: null,
    });
  });

  it('counts skips rather than overwriting them, and dates the last one', () => {
    recordPromptDedupSkip('wt-a', 'copilot', undefined, 1_000);
    recordPromptDedupSkip('wt-a', 'copilot', undefined, 2_000);
    recordPromptDedupSkip('wt-a', 'copilot', undefined, 3_500);

    expect(getPromptDedupSkips('wt-a', 'copilot')).toEqual({
      skippedCount: 3,
      lastSkippedAt: 3_500,
    });
  });

  it('defaults the timestamp to now', () => {
    const before = Date.now();
    recordPromptDedupSkip('wt-a', 'copilot', undefined);
    const after = Date.now();

    const record = getPromptDedupSkips('wt-a', 'copilot');
    expect(record.skippedCount).toBe(1);
    expect(record.lastSkippedAt).toBeGreaterThanOrEqual(before);
    expect(record.lastSkippedAt).toBeLessThanOrEqual(after);
  });

  it('keeps sessions independent: worktree, tool, and instance are all part of the key', () => {
    recordPromptDedupSkip('wt-a', 'copilot', undefined, 1_000);

    expect(getPromptDedupSkips('wt-b', 'copilot').skippedCount).toBe(0);
    expect(getPromptDedupSkips('wt-a', 'opencode').skippedCount).toBe(0);
    expect(getPromptDedupSkips('wt-a', 'copilot', 'copilot-2').skippedCount).toBe(0);
    expect(getPromptDedupSkips('wt-a', 'copilot').skippedCount).toBe(1);
  });

  it('treats the primary instance id as equivalent to omitting it (2-part key compat)', () => {
    recordPromptDedupSkip('wt-a', 'copilot', 'copilot', 1_000);

    expect(getPromptDedupSkips('wt-a', 'copilot')).toEqual({
      skippedCount: 1,
      lastSkippedAt: 1_000,
    });
  });

  it('carries the tally across a worktree-ID rename and leaves nothing behind', () => {
    // Issue #1621 moves the dedup hash rather than dropping it, so the guard
    // goes on suppressing under the new ID. A tally left at the old key would
    // report zero for a session that is still skipping.
    recordPromptDedupSkip('wt-old', 'copilot', 'copilot-2', 1_000);
    recordPromptDedupSkip('wt-old', 'copilot', 'copilot-2', 2_000);

    renamePromptDedupSkips('wt-old', 'wt-new', 'copilot', 'copilot-2');

    expect(getPromptDedupSkips('wt-new', 'copilot', 'copilot-2')).toEqual({
      skippedCount: 2,
      lastSkippedAt: 2_000,
    });
    expect(getPromptDedupSkips('wt-old', 'copilot', 'copilot-2').skippedCount).toBe(0);
  });

  it('renaming a session with no tally does not invent one', () => {
    renamePromptDedupSkips('wt-old', 'wt-new', 'copilot');

    expect(getPromptDedupSkips('wt-new', 'copilot')).toEqual({
      skippedCount: 0,
      lastSkippedAt: null,
    });
  });

  it('renaming to the same ID is a no-op rather than a delete', () => {
    recordPromptDedupSkip('wt-a', 'copilot', undefined, 1_000);

    renamePromptDedupSkips('wt-a', 'wt-a', 'copilot');

    expect(getPromptDedupSkips('wt-a', 'copilot').skippedCount).toBe(1);
  });
});
