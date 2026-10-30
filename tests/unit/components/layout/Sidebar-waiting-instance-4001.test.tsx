/**
 * Opening a waiting worktree from the sidebar lands on the waiting instance
 * (Issue #4001): Needs attention and the branch rows open
 * `/worktrees/<id>?instance=<waiting instance>` instead of restoring the saved
 * selection.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';
import type { Worktree } from '@/types/models';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    worktreeApi: {
      getAll: vi.fn(),
      getById: vi.fn().mockResolvedValue(null),
      markAsViewed: vi.fn().mockResolvedValue(undefined),
    },
    repositoryApi: { sync: vi.fn() },
  };
});

import { Sidebar } from '@/components/layout/Sidebar';
import { SidebarProvider, SIDEBAR_VIEW_MODE_STORAGE_KEY } from '@/contexts/SidebarContext';
import { WorktreeSelectionProvider } from '@/contexts/WorktreeSelectionContext';

/** The 2026-10-30 case: Claude is the saved choice, Command Code waits on a plan review. */
function waitingWorktree(commandCodeSince: number | null): Worktree {
  return {
    id: 'wt-plan',
    name: 'feature/plan',
    path: '/repos/app/wt-plan',
    repositoryPath: '/repos/app',
    repositoryName: 'App',
    isSessionRunning: true,
    isWaitingForResponse: true,
    agentInstances: [
      { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
      { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 },
      { id: 'claude-cc', cliTool: 'claude', alias: 'Command Code', order: 2 },
    ],
    sessionStatusByInstance: {
      claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
      codex: { isRunning: true, isWaitingForResponse: false, isProcessing: true },
      'claude-cc': {
        isRunning: true,
        isWaitingForResponse: true,
        isProcessing: false,
        waitingKind: 'prompt',
        waitingSince: commandCodeSince,
      },
    },
  } as unknown as Worktree;
}

function renderSidebar(worktrees: Worktree[]) {
  return render(
    <SidebarProvider>
      <WorktreeSelectionProvider externalWorktrees={worktrees} externalRepositories={[]}>
        <Sidebar />
      </WorktreeSelectionProvider>
    </SidebarProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  // The saved selection the worktree screen would otherwise restore.
  localStorage.setItem('activeInstanceId-wt-plan', 'claude');
  mockPush.mockClear();
  global.fetch = vi.fn().mockResolvedValue({ json: async () => ({ success: true, order: null }) }) as unknown as typeof fetch;
});

describe('Sidebar opens the waiting instance (Issue #4001)', () => {
  it('Needs attention opens the waiting instance, not the saved one (positive)', async () => {
    renderSidebar([waitingWorktree(1_000)]);

    const section = await screen.findByTestId('sidebar-needs-attention');
    fireEvent.click(within(section).getByTestId('sidebar-attention-item'));

    expect(mockPush).toHaveBeenCalledWith('/worktrees/wt-plan?instance=claude-cc');
  });

  it('the branch row (grouped and flat) opens the waiting instance (positive)', async () => {
    const { unmount } = renderSidebar([waitingWorktree(1_000)]);
    fireEvent.click(await screen.findByTestId('branch-list-item'));
    expect(mockPush).toHaveBeenLastCalledWith('/worktrees/wt-plan?instance=claude-cc');
    unmount();

    localStorage.setItem(SIDEBAR_VIEW_MODE_STORAGE_KEY, 'flat');
    renderSidebar([waitingWorktree(1_000)]);
    fireEvent.click(await screen.findByTestId('branch-list-item'));
    expect(mockPush).toHaveBeenLastCalledWith('/worktrees/wt-plan?instance=claude-cc');
  });

  it('a second press on the same worktree opens it with the instance again', async () => {
    renderSidebar([waitingWorktree(1_000)]);

    const section = await screen.findByTestId('sidebar-needs-attention');
    fireEvent.click(within(section).getByTestId('sidebar-attention-item'));
    fireEvent.click(within(section).getByTestId('sidebar-attention-item'));

    expect(mockPush).toHaveBeenCalledTimes(2);
    expect(mockPush).toHaveBeenNthCalledWith(2, '/worktrees/wt-plan?instance=claude-cc');
  });

  it('opens the bare URL when the waiting instance has no waitingSince (negative)', async () => {
    renderSidebar([waitingWorktree(null)]);

    const section = await screen.findByTestId('sidebar-needs-attention');
    fireEvent.click(within(section).getByTestId('sidebar-attention-item'));
    fireEvent.click(await screen.findByTestId('branch-list-item'));

    expect(mockPush).toHaveBeenNthCalledWith(1, '/worktrees/wt-plan');
    expect(mockPush).toHaveBeenNthCalledWith(2, '/worktrees/wt-plan');
  });

  it('opens the bare URL for a branch where nothing waits (negative)', async () => {
    const idle = {
      ...waitingWorktree(1_000),
      isWaitingForResponse: false,
      sessionStatusByInstance: {
        claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
      },
    } as Worktree;
    renderSidebar([idle]);

    fireEvent.click(await screen.findByTestId('branch-list-item'));
    expect(mockPush).toHaveBeenCalledWith('/worktrees/wt-plan');
  });
});
