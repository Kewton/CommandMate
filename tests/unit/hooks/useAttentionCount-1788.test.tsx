/**
 * The single attention-count derivation (Issue #1788).
 * @vitest-environment jsdom
 *
 * The counting rule is the specification, not an implementation detail, because
 * Issue #1789 is about to render the same number in the tab title, the favicon
 * and the OS badge. It is pinned here so a later change has to argue with a test
 * rather than quietly disagree with the Review list.
 */

import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  selectAttentionCount,
  selectAttentionWorktrees,
  useAttentionCount,
  ATTENTION_REVIEW_HREF,
} from '@/hooks/useAttentionCount';
import type { Worktree } from '@/types/models';

function wt(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id,
    name: id,
    path: `/${id}`,
    repositoryPath: '/repo',
    repositoryName: 'Repo',
    ...overrides,
  };
}

describe('selectAttentionCount (Issue #1788)', () => {
  it('is 0 with no worktrees, and 0 when none is waiting', () => {
    expect(selectAttentionCount([])).toBe(0);
    expect(selectAttentionCount([wt('a'), wt('b', { isWaitingForResponse: false })])).toBe(0);
  });

  it('counts every waiting worktree', () => {
    const list = [
      wt('a', { isWaitingForResponse: true }),
      wt('b'),
      wt('c', { isWaitingForResponse: true }),
      wt('d', { isWaitingForResponse: false }),
    ];
    expect(selectAttentionCount(list)).toBe(2);
    expect(selectAttentionWorktrees(list).map((w) => w.id)).toEqual(['a', 'c']);
  });

  it('counts a worktree ONCE however many of its instances are waiting', () => {
    // The number is a link to a list of worktrees. Counting instances would say
    // 3 and open a list of 1.
    const list = [
      wt('multi', {
        isWaitingForResponse: true,
        sessionStatusByInstance: {
          claude: { isRunning: true, isWaitingForResponse: true, isProcessing: false },
          'codex-2': { isRunning: true, isWaitingForResponse: true, isProcessing: false },
          'codex-3': { isRunning: true, isWaitingForResponse: true, isProcessing: false },
        },
      }),
    ];
    expect(selectAttentionCount(list)).toBe(1);
  });

  it('follows the worktree-level aggregate, not the instance map', () => {
    // The server already ORs across instances (`worktree-status-helper`). A
    // worktree whose aggregate is false does not count even if a stale instance
    // entry says otherwise, and vice versa — one source of truth, not two.
    const staleInstanceSaysWaiting = wt('a', {
      isWaitingForResponse: false,
      sessionStatusByInstance: {
        claude: { isRunning: true, isWaitingForResponse: true, isProcessing: false },
      },
    });
    const aggregateSaysWaiting = wt('b', {
      isWaitingForResponse: true,
      sessionStatusByInstance: {
        claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
      },
    });
    expect(selectAttentionCount([staleInstanceSaysWaiting])).toBe(0);
    expect(selectAttentionCount([aggregateSaysWaiting])).toBe(1);
  });

  it('treats an absent field as not-waiting (payload from an older server)', () => {
    expect(selectAttentionCount([wt('a')])).toBe(0);
  });

  it('matches the Review approval filter predicate exactly', () => {
    const list = [
      wt('a', { isWaitingForResponse: true }),
      wt('b', { isWaitingForResponse: false }),
      wt('c'),
    ];
    const reviewApprovalPredicate = (w: Worktree) => w.isWaitingForResponse === true;
    expect(selectAttentionWorktrees(list)).toEqual(list.filter(reviewApprovalPredicate));
  });
});

describe('useAttentionCount (Issue #1788)', () => {
  it('degrades to 0 with no WorktreesCacheProvider above it', () => {
    // Every badge must be mountable outside the provider, or the mobile nav
    // could not be unit-tested and a provider-less page would crash.
    const { result } = renderHook(() => useAttentionCount());
    expect(result.current.count).toBe(0);
    expect(result.current.worktrees).toEqual([]);
  });
});

describe('the deep link (Issue #1788)', () => {
  it('is the approval filter, re-exported from the hook module', () => {
    expect(ATTENTION_REVIEW_HREF).toBe('/review?filter=approval');
  });
});
