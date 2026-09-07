/**
 * @vitest-environment jsdom
 */

/**
 * Shared ordering / aggregation rules behind the repository tab bar
 * (Issue #2374).
 *
 * These functions exist *because* the strip must agree with the sidebar. The
 * component tests prove the strip renders them; this file pins the rules
 * themselves, including the two that a rendering test cannot distinguish from
 * a coincidence — that the order comes from the saved order (not from the
 * alphabetical order the fixture happens to also satisfy), and that a
 * repository's dot reads the AGGREGATED per-instance status rather than the
 * branch-level one.
 */

import { describe, it, expect } from 'vitest';
import {
  aggregateGroupStatus,
  countWaitingBranches,
  orderBranchGroups,
  parseRepositoryOrder,
  persistRepositoryOrderCache,
  readRepositoryOrderCache,
  resolveBranchStatus,
  shouldShowRepositoryTabBar,
  SIDEBAR_GROUP_ORDER_CACHE_STORAGE_KEY,
  DEFAULT_REPO_TAB_BAR_MODE,
  REPO_TAB_BAR_MODES,
  isValidRepoTabBarMode,
} from '@/lib/sidebar-utils';
import type { BranchGroup } from '@/lib/sidebar-utils';
import type { BranchStatus, SidebarBranchItem } from '@/types/sidebar';

function branch(
  overrides: Partial<SidebarBranchItem> & Pick<SidebarBranchItem, 'id'>
): SidebarBranchItem {
  return {
    name: `branch-${overrides.id}`,
    repositoryName: 'repo',
    status: 'idle',
    hasUnread: false,
    ...overrides,
  };
}

function group(repositoryName: string, branches: SidebarBranchItem[] = []): BranchGroup {
  return { repositoryName, branches };
}

describe('orderBranchGroups (Issue #2374)', () => {
  it('returns the input order untouched when nothing has been reordered', () => {
    const groups = [group('alpha'), group('beta'), group('gamma')];
    expect(orderBranchGroups(groups, []).map((g) => g.repositoryName)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });

  /**
   * The saved order is deliberately the REVERSE of alphabetical here: an
   * assertion against a fixture that is already alphabetical would pass even if
   * `repositoryOrder` were ignored entirely.
   */
  it('places repositories in the saved order, not alphabetically', () => {
    const groups = [group('alpha'), group('beta'), group('gamma')];
    const ordered = orderBranchGroups(groups, ['gamma', 'beta', 'alpha']);
    expect(ordered.map((g) => g.repositoryName)).toEqual(['gamma', 'beta', 'alpha']);
  });

  it('appends repositories missing from the saved order, alphabetically', () => {
    const groups = [group('alpha'), group('beta'), group('newer'), group('another')];
    const ordered = orderBranchGroups(groups, ['beta', 'alpha']);
    expect(ordered.map((g) => g.repositoryName)).toEqual([
      'beta',
      'alpha',
      'another',
      'newer',
    ]);
  });

  it('does not mutate the input array', () => {
    const groups = [group('alpha'), group('beta')];
    const snapshot = groups.map((g) => g.repositoryName);
    orderBranchGroups(groups, ['beta', 'alpha']);
    expect(groups.map((g) => g.repositoryName)).toEqual(snapshot);
  });
});

describe('resolveBranchStatus / aggregateGroupStatus (Issue #2374)', () => {
  it('prefers the aggregated per-instance status over the branch-level one', () => {
    const item = branch({
      id: 'a',
      status: 'idle',
      cliStatus: { claude: 'idle', 'codex-2': 'waiting' },
    });
    expect(resolveBranchStatus(item)).toBe('waiting');
  });

  it('falls back to the branch-level status when there is no instance map', () => {
    expect(resolveBranchStatus(branch({ id: 'a', status: 'running' }))).toBe('running');
    expect(resolveBranchStatus(branch({ id: 'b', status: 'ready', cliStatus: {} }))).toBe(
      'ready'
    );
  });

  it.each<[BranchStatus[], BranchStatus]>([
    [['idle', 'ready', 'running', 'waiting'], 'waiting'],
    [['idle', 'ready', 'running'], 'running'],
    [['idle', 'ready', 'generating'], 'generating'],
    [['idle', 'ready'], 'ready'],
    [['idle', 'idle'], 'idle'],
  ])('folds %j to %s', (statuses, expected) => {
    const branches = statuses.map((status, index) => branch({ id: `b${index}`, status }));
    expect(aggregateGroupStatus(branches)).toBe(expected);
  });

  it('reports idle for a repository with no branches', () => {
    expect(aggregateGroupStatus([])).toBe('idle');
  });

  it('surfaces a waiting agent instance even when every branch-level status is idle', () => {
    const branches = [
      branch({ id: 'a', status: 'idle' }),
      branch({ id: 'b', status: 'idle', cliStatus: { 'claude-2': 'waiting' } }),
    ];
    expect(aggregateGroupStatus(branches)).toBe('waiting');
  });
});

describe('countWaitingBranches (Issue #2374)', () => {
  it('counts branches, not waiting agent instances', () => {
    const branches = [
      branch({ id: 'a', cliStatus: { claude: 'waiting', codex: 'waiting' } }),
      branch({ id: 'b', cliStatus: { claude: 'idle' } }),
      branch({ id: 'c', status: 'waiting' }),
    ];
    expect(countWaitingBranches(branches)).toBe(2);
  });

  it('is zero when nothing is waiting', () => {
    expect(countWaitingBranches([branch({ id: 'a' })])).toBe(0);
  });
});

describe('shouldShowRepositoryTabBar (Issue #2374)', () => {
  it.each<[Parameters<typeof shouldShowRepositoryTabBar>[0], boolean, boolean]>([
    ['always', true, true],
    ['always', false, true],
    ['collapsed', true, false],
    ['collapsed', false, true],
    ['hidden', true, false],
    ['hidden', false, false],
  ])('mode=%s sidebarOpen=%s -> %s', (mode, isOpen, expected) => {
    expect(shouldShowRepositoryTabBar(mode, isOpen)).toBe(expected);
  });

  it('defaults to the collapsed-only rule', () => {
    expect(DEFAULT_REPO_TAB_BAR_MODE).toBe('collapsed');
    expect(REPO_TAB_BAR_MODES).toContain(DEFAULT_REPO_TAB_BAR_MODE);
  });

  it('validates stored modes against the same list the selector renders', () => {
    for (const mode of REPO_TAB_BAR_MODES) {
      expect(isValidRepoTabBarMode(mode)).toBe(true);
    }
    expect(isValidRepoTabBarMode('sometimes')).toBe(false);
    expect(isValidRepoTabBarMode('')).toBe(false);
  });
});

describe('repository order cache (Issue #2374)', () => {
  it('round-trips through localStorage', () => {
    localStorage.clear();
    persistRepositoryOrderCache(['beta', 'alpha']);
    expect(localStorage.getItem(SIDEBAR_GROUP_ORDER_CACHE_STORAGE_KEY)).toBe(
      JSON.stringify(['beta', 'alpha'])
    );
    expect(readRepositoryOrderCache()).toEqual(['beta', 'alpha']);
  });

  it('discards a stored value that is not an array of strings', () => {
    expect(parseRepositoryOrder('not json')).toEqual([]);
    expect(parseRepositoryOrder('{"order":["a"]}')).toEqual([]);
    expect(parseRepositoryOrder('["a", 3, null, "b"]')).toEqual(['a', 'b']);
  });

  it('caps a stored order at 500 entries, matching the API limit', () => {
    const huge = JSON.stringify(Array.from({ length: 600 }, (_, i) => `repo-${i}`));
    expect(parseRepositoryOrder(huge)).toHaveLength(500);
  });

  it('reads an empty order when nothing is stored', () => {
    localStorage.clear();
    expect(readRepositoryOrderCache()).toEqual([]);
  });
});
