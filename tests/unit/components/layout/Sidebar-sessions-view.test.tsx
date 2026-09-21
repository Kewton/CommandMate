/**
 * Sidebar "sessions" view (Issue #2656).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';
import type { Worktree } from '@/types/models';

import { UNCLASSIFIED_STATUS_DOT_CLASS } from '@/components/sidebar/BranchStatusIndicator';

const locale = vi.hoisted(() => ({ current: 'en' }));
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => locale.current);
});

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

import { Sidebar } from '@/components/layout/Sidebar';
import { SidebarProvider, SIDEBAR_VIEW_MODE_STORAGE_KEY } from '@/contexts/SidebarContext';
import { WorktreeSelectionProvider } from '@/contexts/WorktreeSelectionContext';

const WORKTREES: Worktree[] = [
  {
    id: 'wt-a', name: 'feature/a', path: '/repo/a', repositoryPath: '/repo', repositoryName: 'RepoA',
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    agentInstances: [
      { id: 'claude', cliTool: 'claude', order: 0 },
      { id: 'codex', cliTool: 'codex', alias: 'Reviewer', order: 1 },
    ],
    sessionStatusByInstance: {
      claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
      codex: { isRunning: true, isWaitingForResponse: true, isProcessing: false },
    },
  } as Worktree,
  {
    id: 'wt-b', name: 'feature/b', path: '/repo/b', repositoryPath: '/repo', repositoryName: 'RepoB',
    updatedAt: new Date('2026-09-02T00:00:00Z'),
    agentInstances: [{ id: 'claude', cliTool: 'claude', order: 0 }],
    sessionStatusByInstance: {},
  } as Worktree,
];

function renderSidebar(worktrees: Worktree[] = WORKTREES) {
  return render(
    <SidebarProvider>
      <WorktreeSelectionProvider externalWorktrees={worktrees} externalRepositories={[]}>
        <Sidebar />
      </WorktreeSelectionProvider>
    </SidebarProvider>,
  );
}

const sessionKeys = () =>
  screen.queryAllByTestId('session-list-item').map((el) => el.getAttribute('data-session-key'));

beforeEach(() => {
  locale.current = 'en';
  localStorage.clear();
  mockPush.mockClear();
  global.fetch = vi.fn().mockResolvedValue({ json: async () => ({ success: true, order: null }) }) as unknown as typeof fetch;
});

describe('Sidebar sessions view (Issue #2656)', () => {
  it('offers the sessions view as a third option', async () => {
    renderSidebar();

    const select = (await screen.findByTestId('view-mode-select')) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => [o.value, o.textContent])).toEqual([
      ['grouped', 'Repository'],
      ['flat', 'Branch'],
      ['sessions', 'Session'],
    ]);
  });

  it('lists one row per agent instance, attention first', async () => {
    localStorage.setItem(SIDEBAR_VIEW_MODE_STORAGE_KEY, 'sessions');
    renderSidebar();

    await waitFor(() => {
      expect(screen.getAllByTestId('session-list-item')).toHaveLength(3);
    });
    // waiting → ready → idle
    expect(sessionKeys()).toEqual(['wt-a:codex', 'wt-a:claude', 'wt-b:claude']);

    const rows = screen.getAllByTestId('session-list-item');
    expect(rows[0]).toHaveTextContent('Reviewer');
    expect(rows[0]).toHaveTextContent('feature/a · RepoA');
    expect(rows[2]).toHaveTextContent('Claude');
    expect(rows[2]).toHaveTextContent('feature/b · RepoB');

    // No groups and no branch rows in this view.
    expect(screen.queryAllByTestId('group-header')).toHaveLength(0);
    expect(screen.queryAllByTestId('branch-list-item')).toHaveLength(0);
    expect(screen.getByTestId('view-mode-select')).toHaveValue('sessions');
  });

  it('navigates to the branch with the instance in the query', async () => {
    localStorage.setItem(SIDEBAR_VIEW_MODE_STORAGE_KEY, 'sessions');
    renderSidebar();

    await waitFor(() => {
      expect(screen.getAllByTestId('session-list-item')).toHaveLength(3);
    });
    fireEvent.click(screen.getAllByTestId('session-list-item')[0]);

    expect(mockPush).toHaveBeenCalledWith('/worktrees/wt-a?instance=codex');
  });

  it('keeps the branch/repository search filter', async () => {
    localStorage.setItem(SIDEBAR_VIEW_MODE_STORAGE_KEY, 'sessions');
    renderSidebar();

    await waitFor(() => {
      expect(screen.getAllByTestId('session-list-item')).toHaveLength(3);
    });

    const search = screen.getByPlaceholderText('Search branches...');
    fireEvent.change(search, { target: { value: 'feature/b' } });
    await waitFor(() => {
      expect(screen.getAllByTestId('session-list-item')).toHaveLength(1);
    });

    fireEvent.change(search, { target: { value: 'nothing-matches' } });
    await waitFor(() => {
      expect(screen.queryAllByTestId('session-list-item')).toHaveLength(0);
    });
    expect(screen.getByTestId('branch-list')).toHaveTextContent('No branches found');
  });

  it('switches from the grouped view and persists the choice', async () => {
    renderSidebar();

    await waitFor(() => {
      expect(screen.getAllByTestId('group-header').length).toBeGreaterThan(0);
    });
    fireEvent.change(screen.getByTestId('view-mode-select'), { target: { value: 'sessions' } });

    await waitFor(() => {
      expect(screen.getAllByTestId('session-list-item')).toHaveLength(3);
    });
    expect(localStorage.getItem(SIDEBAR_VIEW_MODE_STORAGE_KEY)).toBe('sessions');
  });

  it('draws an unclassified instance with UNCLASSIFIED_STATUS_DOT_CLASS and 不明 label (Issue #2822)', async () => {
    locale.current = 'ja';
    localStorage.setItem(SIDEBAR_VIEW_MODE_STORAGE_KEY, 'sessions');

    const unclassifiedWorktree: Worktree = {
      id: 'wt-unclass',
      name: 'feature/unclass',
      path: '/repo/unclass',
      repositoryPath: '/repo',
      repositoryName: 'RepoUnclass',
      updatedAt: new Date('2026-09-01T00:00:00Z'),
      agentInstances: [
        { id: 'codex', cliTool: 'codex', alias: 'UnclassAgent', order: 0 },
        { id: 'claude', cliTool: 'claude', alias: 'NormalAgent', order: 1 },
      ],
      sessionStatusByInstance: {
        codex: {
          isRunning: true,
          isWaitingForResponse: false,
          isProcessing: false,
          isUnclassified: true,
        },
        claude: {
          isRunning: true,
          isWaitingForResponse: false,
          isProcessing: false,
        },
      },
    } as Worktree;

    renderSidebar([unclassifiedWorktree]);

    await waitFor(() => {
      expect(screen.getAllByTestId('session-list-item')).toHaveLength(2);
    });

    const items = screen.getAllByTestId('session-list-item');
    const unclassDot = items[0].querySelector('span.rounded-full') as HTMLElement;
    const normalDot = items[1].querySelector('span.rounded-full') as HTMLElement;

    // The unclassified instance gets UNCLASSIFIED_STATUS_DOT_CLASS and 不明
    for (const cls of UNCLASSIFIED_STATUS_DOT_CLASS.split(' ')) {
      expect(unclassDot.className).toContain(cls);
    }
    expect(unclassDot.getAttribute('aria-label')).toBe('不明');

    // The normal ready instance keeps standard ready styling and 準備完了
    expect(normalDot.className).not.toContain('bg-transparent');
    expect(normalDot.className).toContain('bg-success');
    expect(normalDot.getAttribute('aria-label')).toBe('準備完了');
  });
});
