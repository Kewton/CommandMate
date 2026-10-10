/**
 * `partitionOtherBranches` / `isDetachedBranchName` (Issue #3509): which rows
 * fold into a repository's "Other (n)".
 */

import { describe, it, expect } from 'vitest';
import { isDetachedBranchName, partitionOtherBranches } from '@/lib/sidebar-utils';
import type { SidebarBranchItem } from '@/types/sidebar';

function item(overrides: Partial<SidebarBranchItem> & { id: string }): SidebarBranchItem {
  return { name: overrides.id, repositoryName: 'Repo', status: 'idle', hasUnread: false, ...overrides };
}

const ids = (list: SidebarBranchItem[]) => list.map((b) => b.id);

describe('isDetachedBranchName (Issue #3509)', () => {
  it('matches the name parseWorktreeList gives a detached HEAD', () => {
    expect(isDetachedBranchName('detached-1a2b3c4')).toBe(true);
  });

  it('does not match an ordinary branch that merely starts with the word', () => {
    expect(isDetachedBranchName('detached-head/fix')).toBe(false);
    expect(isDetachedBranchName('feature/detached-1a2b')).toBe(false);
    expect(isDetachedBranchName('main')).toBe(false);
  });
});

describe('partitionOtherBranches (Issue #3509)', () => {
  it('folds an idle detached row (positive control)', () => {
    const { shown, other } = partitionOtherBranches(
      [item({ id: 'main' }), item({ id: 'd', name: 'detached-abc1234' })],
      null
    );
    expect(ids(shown)).toEqual(['main']);
    expect(ids(other)).toEqual(['d']);
  });

  it('never folds a non-detached row (negative control)', () => {
    const { other } = partitionOtherBranches([item({ id: 'a' }), item({ id: 'b', status: 'ready' })], null);
    expect(other).toEqual([]);
  });

  it.each([
    ['selected', item({ id: 'd', name: 'detached-abc1234' }), 'd'],
    ['waiting (per instance)', item({ id: 'd', name: 'detached-abc1234', cliStatus: { claude: 'waiting' } }), null],
    ['waiting (worktree flag)', item({ id: 'd', name: 'detached-abc1234', status: 'waiting' }), null],
    ['running', item({ id: 'd', name: 'detached-abc1234', cliStatus: { claude: 'running' } }), null],
    ['generating', item({ id: 'd', name: 'detached-abc1234', cliStatus: { claude: 'generating' } }), null],
  ])('keeps a %s detached row in place', (_label, branch, selectedId) => {
    const { shown, other } = partitionOtherBranches([branch], selectedId);
    expect(ids(shown)).toEqual(['d']);
    expect(other).toEqual([]);
  });

  it('folds a ready or idle detached row that is not selected', () => {
    const { other } = partitionOtherBranches(
      [
        item({ id: 'r', name: 'detached-aaa', cliStatus: { claude: 'ready' } }),
        item({ id: 'i', name: 'detached-bbb', cliStatus: { claude: 'idle' } }),
      ],
      'someone-else'
    );
    expect(ids(other)).toEqual(['r', 'i']);
  });

  it('preserves the given order on both sides', () => {
    const { shown, other } = partitionOtherBranches(
      [
        item({ id: 'd1', name: 'detached-1' }),
        item({ id: 'a' }),
        item({ id: 'd2', name: 'detached-2' }),
        item({ id: 'b' }),
      ],
      null
    );
    expect(ids(shown)).toEqual(['a', 'b']);
    expect(ids(other)).toEqual(['d1', 'd2']);
  });
});
