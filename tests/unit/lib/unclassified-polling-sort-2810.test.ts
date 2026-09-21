/**
 * Issue #2810 (B3): what an unclassified-only worktree does to the list's
 * polling cadence and to the sidebar's order — pinned as a decision, not an
 * accident of #2775.
 *
 * Both stay where #2775 put them, i.e. with `ready`:
 *
 *  - Polling: `SESSION_RUNNING` (5s), not `PROCESSING` (2s). The fast cadence
 *    exists to catch the end of a turn the server has seen in progress, and an
 *    unreadable frame is not that observation. A frame no rule can read may
 *    stay that way indefinitely (a stuck overlay, #2774's misread idle
 *    composer), and every list poll captures every running pane — 2s would pin
 *    the whole app at the fast cadence for as long as it lasts. The detail
 *    screen's own per-pane poller is untouched by this.
 *  - Sort: the `ready` slot of `STATUS_PRIORITY`, above `running`. That order
 *    floats "the user should look at this" above "still working", and a pane
 *    nothing could read is one a human should look at (the precedence
 *    `isBranchUnclassified` gives the dot). Ranking it as `running` would sink
 *    it below the rows the user can ignore.
 */

import { describe, it, expect } from 'vitest';
import { getPollingInterval, POLLING_INTERVALS } from '@/contexts/WorktreeSelectionContext';
import { sortBranches, STATUS_PRIORITY } from '@/lib/sidebar-utils';
import { toBranchItem } from '@/types/sidebar';
import type { Worktree } from '@/types/models';

const BASE = {
  isRunning: true,
  isWaitingForResponse: false,
  waitingKind: null,
  waitingSince: null,
  awaitingInstruction: false,
} as const;

const UNCLASSIFIED = {
  ...BASE,
  isProcessing: false,
  statusEvidence: 'none' as const,
  sessionStatusReason: 'default',
  isUnclassified: true,
};

const THINKING = {
  ...BASE,
  isProcessing: true,
  statusEvidence: 'positive' as const,
  sessionStatusReason: 'thinking_indicator',
};

function worktree(id: string, entry: typeof UNCLASSIFIED | typeof THINKING): Worktree {
  return {
    id,
    name: id,
    path: `/tmp/${id}`,
    repositoryPath: '/tmp/repo',
    repositoryName: 'repo',
    selectedAgents: ['codex'],
    sessionStatusByCli: { codex: entry },
    isSessionRunning: true,
    isWaitingForResponse: false,
    isProcessing: entry.isProcessing,
  } as Worktree;
}

describe('[#2810] B3: an unclassified-only worktree', () => {
  it('polls at the session-running cadence, not the processing one', () => {
    expect(getPollingInterval([worktree('wt-u', UNCLASSIFIED)])).toBe(POLLING_INTERVALS.SESSION_RUNNING);
    // Control: a positive running still gets the fast cadence.
    expect(getPollingInterval([worktree('wt-r', THINKING)])).toBe(POLLING_INTERVALS.PROCESSING);
  });

  it('sorts in the ready slot, above a running branch', () => {
    const unclassified = toBranchItem(worktree('wt-u', UNCLASSIFIED));
    const running = toBranchItem(worktree('wt-r', THINKING));

    expect(unclassified.status).toBe('ready');
    expect(STATUS_PRIORITY[unclassified.status]).toBeLessThan(STATUS_PRIORITY[running.status]);
    expect(sortBranches([running, unclassified], 'status', 'asc').map((b) => b.id)).toEqual([
      'wt-u',
      'wt-r',
    ]);
  });
});
