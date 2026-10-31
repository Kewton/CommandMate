/**
 * The strip / breadcrumb open path lands on the waiting instance (Issue #4014),
 * like the sidebar rows (#4001).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Worktree } from '@/types/models';

const mockPush = vi.fn();
const mockSelect = vi.fn();
let mockWorktrees: Worktree[] = [];

vi.mock('@/contexts/WorktreeSelectionContext', () => ({
  useWorktreeSelection: () => ({ selectWorktree: mockSelect, worktrees: mockWorktrees }),
}));
vi.mock('@/components/providers/ViewTransitionsProvider', () => ({
  useViewTransitionRouter: () => ({ push: mockPush }),
}));

import { useOpenWorktreeFromBranchList } from '@/components/layout/RepositoryTabBar';

const idle = { isRunning: true, isWaitingForResponse: false, isProcessing: false };

function worktree(id: string, since: number | null): Worktree {
  return {
    id,
    name: id,
    path: `/r/${id}`,
    repositoryPath: '/r',
    repositoryName: 'r',
    isWaitingForResponse: true,
    agentInstances: [
      { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
      { id: 'claude-cc', cliTool: 'claude', alias: 'Command Code', order: 1 },
    ],
    sessionStatusByInstance: {
      claude: idle,
      'claude-cc': { isRunning: true, isWaitingForResponse: true, isProcessing: false, waitingKind: 'prompt', waitingSince: since },
    },
  } as unknown as Worktree;
}

describe('[#4014] useOpenWorktreeFromBranchList', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockSelect.mockClear();
    mockWorktrees = [worktree('wt-a', 1000), worktree('wt-b', null)];
  });

  it('opens the waiting instance with ?instance=', () => {
    const { result } = renderHook(() => useOpenWorktreeFromBranchList());
    result.current('wt-a');
    expect(mockSelect).toHaveBeenCalledWith('wt-a');
    expect(mockPush).toHaveBeenCalledWith('/worktrees/wt-a?instance=claude-cc');
  });

  it('keeps the bare URL when no waiting instance can be named', () => {
    const { result } = renderHook(() => useOpenWorktreeFromBranchList());
    result.current('wt-b');
    expect(mockPush).toHaveBeenCalledWith('/worktrees/wt-b');
  });

  it('keeps the bare URL for an id the list does not know', () => {
    const { result } = renderHook(() => useOpenWorktreeFromBranchList());
    result.current('wt-unknown');
    expect(mockPush).toHaveBeenCalledWith('/worktrees/wt-unknown');
  });
});
