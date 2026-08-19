/**
 * Issue #1695 × #1621: the skip tally follows the poller across a rename.
 *
 * `migrateResponsePollerWorktreeIds` deliberately carries the prompt dedup hash
 * to the new worktree ID so the guard keeps suppressing the prompt currently on
 * screen. The tally that explains those suppressions has to travel with it —
 * left behind, `capture --json` would report zero skips for a session that is
 * still skipping, which is the false negative the field was added to remove.
 *
 * Driven through the real migrate function with `response-checker` stubbed: the
 * poller only has to be *registered* for the migration to see it, and letting
 * the real checker run would drag tmux, the database and the push stack into a
 * test about map re-keying.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/polling/response-checker', () => ({ checkForResponse: vi.fn(async () => false) }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({ broadcastTerminalSnapshot: vi.fn(async () => {}) }));

import {
  startPolling,
  stopAllPolling,
  migrateResponsePollerWorktreeIds,
} from '@/lib/polling/response-poller-core';
import {
  recordPromptDedupSkip,
  getPromptDedupSkips,
  clearPromptDedupSkips,
} from '@/lib/polling/prompt-dedup-state';

beforeEach(() => {
  clearPromptDedupSkips();
  stopAllPolling();
});

afterEach(() => {
  stopAllPolling();
});

describe('Issue #1695: skip tally survives a worktree-ID rename', () => {
  it('carries the tally to the new ID for the primary instance', () => {
    startPolling('wt-old-1695', 'copilot');
    recordPromptDedupSkip('wt-old-1695', 'copilot', undefined, 1_000);
    recordPromptDedupSkip('wt-old-1695', 'copilot', undefined, 2_000);

    const moved = migrateResponsePollerWorktreeIds(
      [{ oldId: 'wt-old-1695', newId: 'wt-new-1695' }],
      () => 'copilot',
    );

    // Guards the premise: no move means the assertion below would pass against
    // a tally nobody ever tried to migrate.
    expect(moved).toHaveLength(1);
    expect(getPromptDedupSkips('wt-new-1695', 'copilot')).toEqual({
      skippedCount: 2,
      lastSkippedAt: 2_000,
    });
    expect(getPromptDedupSkips('wt-old-1695', 'copilot').skippedCount).toBe(0);
  });

  it('carries the tally for an alias instance', () => {
    startPolling('wt-old-1695', 'copilot', 'copilot-2');
    recordPromptDedupSkip('wt-old-1695', 'copilot', 'copilot-2', 3_000);

    migrateResponsePollerWorktreeIds(
      [{ oldId: 'wt-old-1695', newId: 'wt-new-1695' }],
      () => 'copilot',
    );

    expect(getPromptDedupSkips('wt-new-1695', 'copilot', 'copilot-2')).toEqual({
      skippedCount: 1,
      lastSkippedAt: 3_000,
    });
  });

  it('leaves an unrelated session alone', () => {
    startPolling('wt-old-1695', 'copilot');
    recordPromptDedupSkip('wt-other-1695', 'copilot', undefined, 5_000);

    migrateResponsePollerWorktreeIds(
      [{ oldId: 'wt-old-1695', newId: 'wt-new-1695' }],
      () => 'copilot',
    );

    expect(getPromptDedupSkips('wt-other-1695', 'copilot')).toEqual({
      skippedCount: 1,
      lastSkippedAt: 5_000,
    });
  });
});
