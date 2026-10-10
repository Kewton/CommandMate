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

describe('partitionOtherBranches reads both status levels (Issue #3509 review)', () => {
  it.each([
    ['no map, worktree-level running', item({ id: 'd', name: 'detached-abc', status: 'running' })],
    ['no map, worktree-level generating', item({ id: 'd', name: 'detached-abc', status: 'generating' })],
    ['map idle, worktree-level running', item({ id: 'd', name: 'detached-abc', status: 'running', cliStatus: { claude: 'idle' } })],
    ['map running, worktree-level idle', item({ id: 'd', name: 'detached-abc', status: 'idle', cliStatus: { claude: 'running' } })],
    ['map idle, worktree-level waiting', item({ id: 'd', name: 'detached-abc', status: 'waiting', cliStatus: { claude: 'idle' } })],
  ])('keeps the row in place: %s (positive control)', (_label, branch) => {
    const { shown, other } = partitionOtherBranches([branch], null);
    expect(ids(shown)).toEqual(['d']);
    expect(other).toEqual([]);
  });

  it('still folds a detached row idle at both levels (negative control)', () => {
    const { other } = partitionOtherBranches(
      [item({ id: 'd', name: 'detached-abc', status: 'idle', cliStatus: { claude: 'idle' } })],
      null
    );
    expect(ids(other)).toEqual(['d']);
  });
});

describe('partitionOtherBranches judges the current row, not a frozen one (Issue #3509 review)', () => {
  const frozen = [item({ id: 'a' }), item({ id: 'd', name: 'detached-abc', status: 'idle' })];

  it.each(['waiting', 'running', 'generating'] as const)(
    'keeps a frozen-idle row that is now %s in place, in the frozen order',
    (status) => {
      const current = new Map([['d', item({ id: 'd', name: 'detached-abc', status })]]);
      const { shown, other } = partitionOtherBranches(frozen, null, current);
      expect(ids(shown)).toEqual(['a', 'd']);
      expect(other).toEqual([]);
      // The frozen object itself is what is returned: only the decision is live.
      expect(shown[1]).toBe(frozen[1]);
    }
  );

  it('folds as before when the current row is unchanged (negative control)', () => {
    const current = new Map(frozen.map((b) => [b.id, b]));
    expect(ids(partitionOtherBranches(frozen, null, current).other)).toEqual(['d']);
  });
});

describe('partitionOtherBranches stickyIds (Issue #3509 review 2)', () => {
  const det = item({ id: 'd', name: 'detached-abc', status: 'idle' });

  it('keeps a sticky row in place even when it would fold (positive control)', () => {
    const { shown, other } = partitionOtherBranches([det], null, undefined, new Set(['d']));
    expect(ids(shown)).toEqual(['d']);
    expect(other).toEqual([]);
  });

  it('folds it when it is not sticky (negative control)', () => {
    expect(ids(partitionOtherBranches([det], null, undefined, new Set(['x'])).other)).toEqual(['d']);
  });
});
