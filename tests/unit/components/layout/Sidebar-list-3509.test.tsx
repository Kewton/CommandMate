/**
 * Sidebar list redesign (Issue #3509): Needs attention, "Other (n)" for
 * detached worktrees, and the shared View / Sort / filter toolbar.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import React from 'react';
import type { Worktree } from '@/types/models';
import type { RepositorySummary } from '@/lib/api-client';

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
import { ATTENTION_REVIEW_HREF } from '@/config/review-config';

const REPO = '/repos/app';
const HIDDEN_REPO = '/repos/hidden';

/** Loosely typed so fixtures can omit roster fields the sidebar does not read. */
function wt(overrides: Record<string, unknown> & { id: string }): Worktree {
  return {
    name: overrides.id,
    path: `${REPO}/${overrides.id}`,
    repositoryPath: REPO,
    repositoryName: 'App',
    ...overrides,
  } as unknown as Worktree;
}

function repo(path: string, name: string, visible: boolean): RepositorySummary {
  return { path, name, worktreeCount: 1, visible, enabled: true } as RepositorySummary;
}

function renderSidebar(worktrees: Worktree[], repositories: RepositorySummary[] = []) {
  return render(
    <SidebarProvider>
      <WorktreeSelectionProvider externalWorktrees={worktrees} externalRepositories={repositories}>
        <Sidebar />
      </WorktreeSelectionProvider>
    </SidebarProvider>,
  );
}

/** Review's approval membership predicate (ReviewTab `FILTER_PREDICATES.approval`). */
const reviewApprovalCount = (list: Worktree[]) =>
  list.filter((w) => w.isWaitingForResponse === true).length;

const branchRowNames = () =>
  screen.queryAllByTestId('branch-list-item').map((el) => el.querySelector('p')?.textContent);

beforeEach(() => {
  localStorage.clear();
  mockPush.mockClear();
  global.fetch = vi.fn().mockResolvedValue({ json: async () => ({ success: true, order: null }) }) as unknown as typeof fetch;
});

describe('Needs attention (Issue #3509)', () => {
  const WORKTREES: Worktree[] = [
    wt({ id: 'wait-1', name: 'feature/one', isSessionRunning: true, isWaitingForResponse: true }),
    wt({ id: 'wait-2', name: 'feature/two', isSessionRunning: true, isWaitingForResponse: true }),
    // One worktree with several waiting instances is ONE entry.
    wt({
      id: 'wait-multi',
      name: 'feature/multi',
      isSessionRunning: true,
      isWaitingForResponse: true,
      agentInstances: [
        { id: 'claude', cliTool: 'claude', order: 0 },
        { id: 'codex', cliTool: 'codex', order: 1 },
      ],
      sessionStatusByInstance: {
        claude: { isRunning: true, isWaitingForResponse: true, isProcessing: false },
        codex: { isRunning: true, isWaitingForResponse: true, isProcessing: false },
      },
    }),
    // Hidden repository: out of the list, still in Review — and so still counted.
    wt({
      id: 'wait-hidden',
      name: 'feature/hidden',
      path: `${HIDDEN_REPO}/x`,
      repositoryPath: HIDDEN_REPO,
      repositoryName: 'Hidden',
      isSessionRunning: true,
      isWaitingForResponse: true,
    }),
    wt({ id: 'idle', name: 'feature/idle', isSessionRunning: false, isWaitingForResponse: false }),
  ];
  const REPOS = [repo(REPO, 'App', true), repo(HIDDEN_REPO, 'Hidden', false)];

  it('counts what Review approval counts, hidden repository included', async () => {
    renderSidebar(WORKTREES, REPOS);

    const count = await screen.findByTestId('sidebar-needs-attention-count');
    expect(reviewApprovalCount(WORKTREES)).toBe(4);
    expect(count).toHaveTextContent('4');
    // The list below still drops the hidden repository (Issue #690)…
    expect(branchRowNames()).not.toContain('feature/hidden');
    // …so the count is larger than the waiting rows in the list, and the
    // section says why.
  });

  it('previews a few, marks the hidden-repository one, and links the rest to Review', async () => {
    // Put the hidden one first so it is inside the preview.
    renderSidebar([WORKTREES[3], ...WORKTREES.slice(0, 3), WORKTREES[4]], REPOS);

    const section = await screen.findByTestId('sidebar-needs-attention');
    const items = within(section).getAllByTestId('sidebar-attention-item');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveAttribute('data-hidden-repository', 'true');
    expect(within(items[0]).getByLabelText('Hidden repository')).toBeInTheDocument();
    expect(items[1]).not.toHaveAttribute('data-hidden-repository');

    const link = within(section).getByTestId('sidebar-needs-attention-review-link');
    expect(link).toHaveAttribute('href', ATTENTION_REVIEW_HREF);
    expect(link).toHaveTextContent('+1 more in Review');

    fireEvent.click(items[1]);
    expect(mockPush).toHaveBeenCalledWith('/worktrees/wait-1');
  });

  it('renders nothing when nothing waits (negative control)', async () => {
    renderSidebar([WORKTREES[4]], REPOS);
    await screen.findAllByTestId('branch-list-item');
    expect(screen.queryByTestId('sidebar-needs-attention')).not.toBeInTheDocument();
  });

  it('does not count a worktree whose waiting flag is only per instance (same as Review)', async () => {
    const instanceOnly = wt({
      id: 'inst',
      name: 'feature/inst',
      agentInstances: [{ id: 'claude', cliTool: 'claude', order: 0 }],
      sessionStatusByInstance: { claude: { isRunning: true, isWaitingForResponse: true, isProcessing: false } },
    });
    renderSidebar([WORKTREES[0], instanceOnly], REPOS);

    expect(await screen.findByTestId('sidebar-needs-attention-count')).toHaveTextContent('1');
    expect(reviewApprovalCount([WORKTREES[0], instanceOnly])).toBe(1);
  });

  it.each(['grouped', 'flat', 'sessions'] as const)('is shown in the %s view and ignores the filter', async (mode) => {
    localStorage.setItem(SIDEBAR_VIEW_MODE_STORAGE_KEY, mode);
    renderSidebar(WORKTREES, REPOS);

    await screen.findByTestId('sidebar-needs-attention');
    fireEvent.change(screen.getByPlaceholderText('Search branches...'), { target: { value: 'idle' } });
    await waitFor(() => {
      expect(screen.getByTestId('sidebar-needs-attention-count')).toHaveTextContent('4');
    });
  });
});

describe('"Other" for detached worktrees (Issue #3509)', () => {
  const WORKTREES: Worktree[] = [
    wt({ id: 'main', name: 'main', isSessionRunning: false }),
    wt({ id: 'd-idle', name: 'detached-aaaa111', isSessionRunning: false }),
    wt({ id: 'd-idle-2', name: 'detached-bbbb222', isSessionRunning: false }),
    wt({ id: 'd-wait', name: 'detached-cccc333', isSessionRunning: true, isWaitingForResponse: true }),
    wt({
      id: 'd-run',
      name: 'detached-dddd444',
      isSessionRunning: true,
      agentInstances: [{ id: 'claude', cliTool: 'claude', order: 0 }],
      sessionStatusByInstance: { claude: { isRunning: true, isWaitingForResponse: false, isProcessing: true } },
    }),
  ];

  it('folds idle detached rows into "Other (n)" (positive control)', async () => {
    renderSidebar(WORKTREES);

    const toggle = await screen.findByTestId('branch-group-other-toggle');
    expect(toggle).toHaveTextContent('Other (2)');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(branchRowNames()).not.toContain('detached-aaaa111');
    expect(branchRowNames()).not.toContain('detached-bbbb222');

    fireEvent.click(toggle);
    expect(branchRowNames()).toEqual(expect.arrayContaining(['detached-aaaa111', 'detached-bbbb222']));
  });

  it('keeps waiting and running detached rows in place (negative control)', async () => {
    renderSidebar(WORKTREES);

    await screen.findByTestId('branch-group-other-toggle');
    const names = branchRowNames();
    expect(names).toContain('main');
    expect(names).toContain('detached-cccc333');
    expect(names).toContain('detached-dddd444');
  });

  it('keeps the selected detached row in place once the fold is closed again', async () => {
    renderSidebar(WORKTREES);

    fireEvent.click(await screen.findByTestId('branch-group-other-toggle'));
    const row = screen
      .getAllByTestId('branch-list-item')
      .find((el) => el.querySelector('p')?.textContent === 'detached-aaaa111')!;
    fireEvent.click(row);
    await waitFor(() => {
      expect(screen.getByTestId('branch-group-other-toggle')).toHaveTextContent('Other (1)');
    });
    fireEvent.click(screen.getByTestId('branch-group-other-toggle'));
    expect(screen.getByTestId('branch-group-other-toggle')).toHaveAttribute('aria-expanded', 'false');
    expect(branchRowNames()).toContain('detached-aaaa111');
    expect(branchRowNames()).not.toContain('detached-bbbb222');
  });

  it('opens "Other" while the filter is in use', async () => {
    renderSidebar(WORKTREES);
    await screen.findByTestId('branch-group-other-toggle');

    fireEvent.change(screen.getByPlaceholderText('Search branches...'), { target: { value: 'bbbb' } });
    await waitFor(() => {
      expect(branchRowNames()).toEqual(['detached-bbbb222']);
    });
    expect(screen.getByTestId('branch-group-other-toggle')).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows no "Other" when no detached row would fold (negative control)', async () => {
    renderSidebar([WORKTREES[0], WORKTREES[3]]);
    await screen.findAllByTestId('branch-list-item');
    expect(screen.queryByTestId('branch-group-other-toggle')).not.toBeInTheDocument();
  });
});

describe('List toolbar (Issue #3509)', () => {
  const WORKTREES: Worktree[] = [
    wt({ id: 'a', name: 'feature/alpha', agentInstances: [{ id: 'claude', cliTool: 'claude', order: 0 }], sessionStatusByInstance: {} }),
    wt({ id: 'b', name: 'feature/beta', agentInstances: [{ id: 'claude', cliTool: 'claude', order: 0 }], sessionStatusByInstance: {} }),
  ];

  it('holds the filter, View and Sort outside the header and outside any group heading', async () => {
    renderSidebar(WORKTREES);

    const toolbar = await screen.findByTestId('sidebar-list-toolbar');
    expect(toolbar).toContainElement(screen.getByTestId('view-mode-select'));
    expect(toolbar).toContainElement(screen.getByTestId('sort-selector-base'));
    expect(toolbar).toContainElement(screen.getByPlaceholderText('Search branches...'));
    expect(screen.getByTestId('sidebar-header')).not.toContainElement(screen.getByTestId('view-mode-select'));
    for (const header of screen.getAllByTestId('group-header')) {
      expect(header).not.toContainElement(screen.getByTestId('view-mode-select'));
    }
  });

  it.each([
    ['grouped', 'branch-list-item'],
    ['flat', 'branch-list-item'],
    ['sessions', 'session-list-item'],
  ] as const)('filters and switches the view from the %s view', async (mode, rowTestId) => {
    localStorage.setItem(SIDEBAR_VIEW_MODE_STORAGE_KEY, mode);
    renderSidebar(WORKTREES);

    await waitFor(() => expect(screen.getAllByTestId(rowTestId)).toHaveLength(2));
    expect(screen.getByTestId('view-mode-select')).toHaveValue(mode);
    expect(screen.getByRole('button', { name: /^Sort by/ })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search branches...'), { target: { value: 'beta' } });
    await waitFor(() => expect(screen.getAllByTestId(rowTestId)).toHaveLength(1));

    const next = mode === 'flat' ? 'sessions' : 'flat';
    fireEvent.change(screen.getByTestId('view-mode-select'), { target: { value: next } });
    await waitFor(() => {
      expect(screen.getAllByTestId(next === 'sessions' ? 'session-list-item' : 'branch-list-item')).toHaveLength(1);
    });
  });
});

describe('Group headings (Issue #3509)', () => {
  it('are not upper-cased', async () => {
    renderSidebar([wt({ id: 'a', name: 'feature/a' })]);
    const header = await screen.findByTestId('group-header');
    expect(header.className).not.toMatch(/uppercase/);
    expect(header.className).toMatch(/text-xs/);
  });
});

describe('"Other" under the hover-freeze (Issue #3509 review)', () => {
  const at = (day: number) => new Date(`2026-10-0${day}T00:00:00Z`);
  const BEFORE: Worktree[] = [
    wt({ id: 'newer', name: 'feature/newer', isSessionRunning: false, updatedAt: at(3) }),
    wt({ id: 'older', name: 'feature/older', isSessionRunning: false, updatedAt: at(2) }),
    wt({ id: 'det', name: 'detached-abc1234', isSessionRunning: false, updatedAt: at(1) }),
  ];

  function renderLive(initial: Worktree[]) {
    const ui = (list: Worktree[]) => (
      <SidebarProvider>
        <WorktreeSelectionProvider externalWorktrees={list} externalRepositories={[]}>
          <Sidebar />
        </WorktreeSelectionProvider>
      </SidebarProvider>
    );
    const result = render(ui(initial));
    return (next: Worktree[]) => result.rerender(ui(next));
  }

  it.each([
    ['waiting', { isSessionRunning: true, isWaitingForResponse: true }],
    ['running', { isSessionRunning: true, isProcessing: true }],
  ] as const)('takes a detached row out of "Other" when it turns %s while frozen (positive control)', async (_label, change) => {
    const update = renderLive(BEFORE);
    await screen.findByTestId('branch-group-other-toggle');
    expect(branchRowNames()).not.toContain('detached-abc1234');

    fireEvent.mouseEnter(screen.getByTestId('branch-list'));
    update(BEFORE.map((w) => (w.id === 'det' ? ({ ...w, ...change } as Worktree) : w)));

    await waitFor(() => {
      expect(branchRowNames()).toContain('detached-abc1234');
    });
    expect(screen.queryByTestId('branch-group-other-toggle')).not.toBeInTheDocument();
  });

  it('keeps a detached row running only at the worktree level (no per-instance map) out of "Other"', async () => {
    // No `sessionStatusByInstance`: toBranchItem builds the legacy map (idle),
    // while `isProcessing` makes the worktree-level status `running`.
    renderLive([BEFORE[0], { ...BEFORE[2], isSessionRunning: true, isProcessing: true } as Worktree]);
    await waitFor(() => expect(branchRowNames()).toContain('detached-abc1234'));
    expect(screen.queryByTestId('branch-group-other-toggle')).not.toBeInTheDocument();
  });

  it('keeps the frozen order of rows whose state did not change (negative control)', async () => {
    const update = renderLive(BEFORE);
    await screen.findByTestId('branch-group-other-toggle');
    expect(branchRowNames()).toEqual(['feature/newer', 'feature/older']);

    fireEvent.mouseEnter(screen.getByTestId('branch-list'));
    // Swap the timestamps: unfrozen, this would reorder the two rows.
    update(
      BEFORE.map((w) =>
        w.id === 'newer' ? { ...w, updatedAt: at(1) } : w.id === 'older' ? { ...w, updatedAt: at(4) } : w
      )
    );

    // Give the deferred value and the memo a chance to run.
    await waitFor(() => {
      expect(screen.getByTestId('branch-group-other-toggle')).toHaveTextContent('Other (1)');
    });
    expect(branchRowNames()).toEqual(['feature/newer', 'feature/older']);
  });
});
