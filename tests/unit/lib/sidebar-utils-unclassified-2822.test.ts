/**
 * Unit tests for unclassified status in sidebar utilities (Issue #2822).
 *
 * Tests:
 * - buildSessionRows populating `unclassified: true` only for ready instances
 *   in `unclassifiedInstanceIds`.
 * - isGroupUnclassified folding status across branches in a repository.
 */

import { describe, it, expect } from 'vitest';
import {
  buildSessionRows,
  isGroupUnclassified,
} from '@/lib/sidebar-utils';
import type { SidebarBranchItem } from '@/types/sidebar';

function item(overrides: Partial<SidebarBranchItem> & { id: string }): SidebarBranchItem {
  return {
    name: overrides.id,
    repositoryName: 'Repo',
    status: 'idle',
    hasUnread: false,
    ...overrides,
  };
}

describe('buildSessionRows unclassified handling (Issue #2822)', () => {
  it('marks only ready instances in unclassifiedInstanceIds as unclassified: true', () => {
    const rows = buildSessionRows([
      item({
        id: 'wt-mixed',
        cliStatus: {
          codex: 'ready',
          claude: 'running',
          gemini: 'waiting',
          copilot: 'ready',
        },
        unclassifiedInstanceIds: ['codex', 'claude', 'gemini'],
      }),
      item({
        id: 'wt-normal',
        cliStatus: {
          claude: 'ready',
        },
      }),
    ]);

    const byInstance = Object.fromEntries(rows.map((r) => [r.instanceId, r]));

    // Ready + in unclassifiedInstanceIds -> unclassified: true
    expect(byInstance.codex.unclassified).toBe(true);

    // Running / waiting in unclassifiedInstanceIds must NOT have unclassified: true
    expect(byInstance.claude.unclassified).toBeUndefined();
    expect(byInstance.gemini.unclassified).toBeUndefined();
    expect('unclassified' in byInstance.claude).toBe(false);
    expect('unclassified' in byInstance.gemini).toBe(false);

    // Ready but not in unclassifiedInstanceIds -> no unclassified property
    expect(byInstance.copilot.unclassified).toBeUndefined();
    expect('unclassified' in byInstance.copilot).toBe(false);

    // Item without unclassifiedInstanceIds keeps exact original shape without unclassified key
    const normalRow = rows.find((r) => r.worktreeId === 'wt-normal');
    expect(normalRow).toBeDefined();
    expect('unclassified' in normalRow!).toBe(false);
  });
});

describe('isGroupUnclassified (Issue #2822)', () => {
  it('returns true when all branches are unclassified ready', () => {
    const branches = [
      item({
        id: 'wt-1',
        cliStatus: { codex: 'ready' },
        unclassifiedInstanceIds: ['codex'],
      }),
    ];
    expect(isGroupUnclassified(branches)).toBe(true);
  });

  it('returns false when a running branch is present (running wins)', () => {
    const branches = [
      item({
        id: 'wt-1',
        cliStatus: { codex: 'ready' },
        unclassifiedInstanceIds: ['codex'],
      }),
      item({
        id: 'wt-2',
        cliStatus: { claude: 'running' },
      }),
    ];
    expect(isGroupUnclassified(branches)).toBe(false);
  });

  it('returns false when a waiting branch is present (waiting wins)', () => {
    const branches = [
      item({
        id: 'wt-1',
        cliStatus: { codex: 'ready' },
        unclassifiedInstanceIds: ['codex'],
      }),
      item({
        id: 'wt-2',
        cliStatus: { claude: 'waiting' },
      }),
    ];
    expect(isGroupUnclassified(branches)).toBe(false);
  });

  it('returns true when unclassified ready is mixed with normal ready (unclassified beats ready)', () => {
    const branches = [
      item({
        id: 'wt-1',
        cliStatus: { codex: 'ready' },
        unclassifiedInstanceIds: ['codex'],
      }),
      item({
        id: 'wt-2',
        cliStatus: { claude: 'ready' },
      }),
    ];
    expect(isGroupUnclassified(branches)).toBe(true);
  });
});
