/**
 * Session rows for the sidebar's "sessions" view (Issue #2656).
 *
 * The view lists one agent instance per row, so the interesting behaviour is
 * entirely in these pure helpers: which rows exist (`buildSessionRows`), what
 * order they are in (`sortSessionRows` — status always first, except when the
 * user sorts BY status) and where a row leads (`buildSessionRowHref`).
 */

import { describe, it, expect } from 'vitest';
import {
  buildSessionRows,
  sortSessionRows,
  buildSessionRowHref,
  isValidViewMode,
  VIEW_MODES,
  SESSION_INSTANCE_QUERY_PARAM,
  type SessionRow,
} from '@/lib/sidebar-utils';
import type { SidebarBranchItem } from '@/types/sidebar';

function item(overrides: Partial<SidebarBranchItem> & { id: string }): SidebarBranchItem {
  return { name: overrides.id, repositoryName: 'Repo', status: 'idle', hasUnread: false, ...overrides };
}

function row(overrides: Partial<SessionRow> & { key: string }): SessionRow {
  const [worktreeId, instanceId] = overrides.key.split(':');
  return {
    worktreeId, instanceId, label: instanceId, status: 'idle',
    branchName: worktreeId, repositoryName: 'Repo', exited: false,
    ...overrides,
  };
}

const keys = (rows: SessionRow[]) => rows.map((r) => r.key);

describe('VIEW_MODES / isValidViewMode (Issue #2656)', () => {
  it('lists exactly the three sidebar view modes', () => {
    expect(VIEW_MODES).toEqual(['grouped', 'flat', 'sessions']);
  });

  it('accepts every listed mode', () => {
    for (const mode of VIEW_MODES) {
      expect(isValidViewMode(mode), mode).toBe(true);
    }
  });

  it.each(['', 'Sessions', 'tile', '__proto__'])('rejects %j', (value) => {
    expect(isValidViewMode(value)).toBe(false);
  });
});

describe('buildSessionRows (Issue #2656)', () => {
  it('expands each branch item into one row per cliStatus entry', () => {
    const rows = buildSessionRows([
      item({
        id: 'wt-a',
        name: 'feature/a',
        repositoryName: 'RepoA',
        lastActivity: '2026-09-01T00:00:00Z',
        cliStatus: { claude: 'ready', 'codex-2': 'waiting' },
        cliStatusLabels: { claude: 'Claude', 'codex-2': 'Review' },
        exitedInstanceIds: ['claude'],
      }),
      item({ id: 'wt-b', cliStatus: { codex: 'idle' } }),
    ]);

    expect(rows).toEqual([
      {
        key: 'wt-a:claude',
        worktreeId: 'wt-a',
        instanceId: 'claude',
        label: 'Claude',
        status: 'ready',
        branchName: 'feature/a',
        repositoryName: 'RepoA',
        lastActivity: '2026-09-01T00:00:00Z',
        exited: true,
      },
      {
        key: 'wt-a:codex-2',
        worktreeId: 'wt-a',
        instanceId: 'codex-2',
        label: 'Review',
        status: 'waiting',
        branchName: 'feature/a',
        repositoryName: 'RepoA',
        lastActivity: '2026-09-01T00:00:00Z',
        exited: false,
      },
      {
        key: 'wt-b:codex',
        worktreeId: 'wt-b',
        instanceId: 'codex',
        label: 'codex',
        status: 'idle',
        branchName: 'wt-b',
        repositoryName: 'Repo',
        lastActivity: undefined,
        exited: false,
      },
    ]);
  });

  it('contributes no rows for an item without cliStatus, and none for an empty list', () => {
    expect(buildSessionRows([item({ id: 'wt-none' })])).toEqual([]);
    expect(buildSessionRows([])).toEqual([]);
  });
});

describe('sortSessionRows (Issue #2656)', () => {
  const rows = [
    row({ key: 'b:claude', status: 'idle', repositoryName: 'beta', branchName: 'b', lastActivity: '2026-09-03T00:00:00Z' }),
    row({ key: 'a:codex', status: 'waiting', repositoryName: 'Alpha', branchName: 'a', lastActivity: '2026-09-01T00:00:00Z' }),
    row({ key: 'c:claude', status: 'running', repositoryName: 'gamma', branchName: 'c', lastActivity: '2026-09-02T00:00:00Z' }),
    row({ key: 'd:claude', status: 'idle', repositoryName: 'alpha', branchName: 'D', lastActivity: '2026-09-04T00:00:00Z' }),
    row({ key: 'e:claude', status: 'ready', repositoryName: 'Zeta', branchName: 'e' }),
  ];

  it('puts status first for updatedAt, newest first within a status', () => {
    expect(keys(sortSessionRows(rows, 'updatedAt', 'desc'))).toEqual([
      'a:codex', 'e:claude', 'c:claude', 'd:claude', 'b:claude',
    ]);
  });

  it('keeps status first even when the direction is ascending', () => {
    expect(keys(sortSessionRows(rows, 'updatedAt', 'asc'))).toEqual([
      'a:codex', 'e:claude', 'c:claude', 'b:claude', 'd:claude',
    ]);
  });

  it('follows the direction for the status stage when sorting BY status', () => {
    expect(keys(sortSessionRows(rows, 'status', 'asc'))).toEqual([
      'a:codex', 'e:claude', 'c:claude', 'd:claude', 'b:claude',
    ]);
    // idle first, and within a status still newest first
    expect(keys(sortSessionRows(rows, 'status', 'desc'))).toEqual([
      'd:claude', 'b:claude', 'c:claude', 'e:claude', 'a:codex',
    ]);
  });

  it('compares repository names case-insensitively within a status', () => {
    const same = [
      row({ key: 'x:1', repositoryName: 'beta' }),
      row({ key: 'y:1', repositoryName: 'Alpha' }),
      row({ key: 'z:1', repositoryName: 'gamma' }),
    ];
    expect(keys(sortSessionRows(same, 'repositoryName', 'asc'))).toEqual(['y:1', 'x:1', 'z:1']);
    expect(keys(sortSessionRows(same, 'repositoryName', 'desc'))).toEqual(['z:1', 'x:1', 'y:1']);
  });

  it('compares branch names case-insensitively within a status', () => {
    const same = [
      row({ key: 'x:1', branchName: 'b' }),
      row({ key: 'y:1', branchName: 'C' }),
      row({ key: 'z:1', branchName: 'a' }),
    ];
    expect(keys(sortSessionRows(same, 'branchName', 'asc'))).toEqual(['z:1', 'x:1', 'y:1']);
  });

  it('keeps the input order for full ties and does not mutate the input', () => {
    const tied = [
      row({ key: 'p:claude' }),
      row({ key: 'p:codex' }),
      row({ key: 'q:claude', branchName: 'p' }),
    ];
    const before = keys(tied);
    expect(keys(sortSessionRows(tied, 'repositoryName', 'asc'))).toEqual([
      'p:claude', 'p:codex', 'q:claude',
    ]);
    expect(keys(tied)).toEqual(before);
  });
});

describe('buildSessionRowHref (Issue #2656)', () => {
  it('uses the `instance` query parameter', () => {
    expect(SESSION_INSTANCE_QUERY_PARAM).toBe('instance');
    expect(buildSessionRowHref({ worktreeId: 'wt-1', instanceId: 'codex-2' })).toBe(
      '/worktrees/wt-1?instance=codex-2'
    );
  });

  it('encodes the instance id', () => {
    expect(buildSessionRowHref({ worktreeId: 'wt-1', instanceId: 'a b&c' })).toBe(
      '/worktrees/wt-1?instance=a%20b%26c'
    );
  });
});
