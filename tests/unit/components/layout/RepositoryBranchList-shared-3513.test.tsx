/**
 * @vitest-environment jsdom
 */

/**
 * The tab strip's lists and the worktree breadcrumb's list behave as one
 * (Issue #3513, consistency review).
 *
 *   1. Picking a branch from the breadcrumb goes through the strip's own pick:
 *      `selectWorktree()` (selected id + the "viewed" mark) and then navigation.
 *   2. An open list's max-height follows the window height while it stays open.
 *      Resizing the height alone leaves the strip's sideways overflow ("…")
 *      exactly as it was.
 *   3. At most one list is open across the strip and the breadcrumb, and
 *      picking any row — even the worktree already on screen, which does not
 *      change the pathname — closes them all.
 *
 * The strip and the header are rendered in ONE tree under the real
 * `SidebarProvider` / `WorktreeSelectionProvider`; only the list API and the
 * cache hook the breadcrumb reads are stubbed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import React from 'react';
import type { Worktree } from '@/types/models';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    worktreeApi: { getAll: vi.fn(), getById: vi.fn(), markAsViewed: vi.fn() },
    repositoryApi: { sync: vi.fn() },
  };
});

const cacheState = vi.hoisted(() => ({ worktrees: [] as unknown[] }));
vi.mock('@/components/providers/WorktreesCacheProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/providers/WorktreesCacheProvider')>()),
  useOptionalWorktreesCacheContext: () => ({
    worktrees: cacheState.worktrees,
    repositories: [],
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

import { worktreeApi } from '@/lib/api-client';
import { RepositoryTabBar } from '@/components/layout/RepositoryTabBar';
import { DesktopHeader } from '@/components/worktree/WorktreeDetailSubComponents';
import { ToastProvider } from '@/components/common/Toast';
import { SidebarProvider } from '@/contexts/SidebarContext';
import {
  WorktreeSelectionProvider,
  useWorktreeSelection,
} from '@/contexts/WorktreeSelectionContext';

function worktree(id: string, name: string, repo: string): Worktree {
  return {
    id,
    name,
    path: `/repos/${repo}/${id}`,
    repositoryPath: `/repos/${repo}`,
    repositoryName: repo,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  } as Worktree;
}

const WORKTREES: Worktree[] = [
  worktree('alpha-a', 'a', 'alpha'),
  worktree('alpha-b', 'b', 'alpha'),
  worktree('beta-main', 'main', 'beta'),
];

/** The band beside the rail: 64px header + 32px band. */
const ANCHOR_BOTTOM = 96;
const CAP = 520;

function SelectionProbe() {
  const { selectedWorktreeId, selectWorktree } = useWorktreeSelection();
  return (
    <>
      <span data-testid="selected-id">{selectedWorktreeId ?? ''}</span>
      <button data-testid="select-a" onClick={() => void selectWorktree('alpha-a')}>
        a
      </button>
    </>
  );
}

function renderBoth() {
  return render(
    <ToastProvider>
      <SidebarProvider>
        <WorktreeSelectionProvider>
          <RepositoryTabBar />
          <DesktopHeader
            worktreeId="alpha-a"
            worktreeName="a"
            repositoryName="alpha"
            status="idle"
            onInfoClick={vi.fn()}
          />
          <SelectionProbe />
        </WorktreeSelectionProvider>
      </SidebarProvider>
    </ToastProvider>
  );
}

function tab(name: string): HTMLElement {
  return screen
    .getAllByTestId('repository-tab')
    .find((t) => t.getAttribute('data-repository') === name)!;
}

async function ready(): Promise<void> {
  renderBoth();
  await waitFor(() => expect(screen.getAllByTestId('repository-tab')).toHaveLength(2));
}

function setViewportHeight(height: number): void {
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true });
}

function resizeTo(height: number): void {
  setViewportHeight(height);
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

const originalInnerHeight = window.innerHeight;
const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  cacheState.worktrees = WORKTREES;
  (worktreeApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
    worktrees: WORKTREES,
    repositories: [],
  });
  (worktreeApi.getById as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) =>
    WORKTREES.find((w) => w.id === id)
  );
  (worktreeApi.markAsViewed as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ success: true, order: [] }),
  })) as unknown as typeof fetch;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 56,
    right: 200,
    top: ANCHOR_BOTTOM - 32,
    bottom: ANCHOR_BOTTOM,
    width: 144,
    height: 32,
    x: 56,
    y: ANCHOR_BOTTOM - 32,
    toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => {
  setViewportHeight(originalInnerHeight);
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('one pick for both lists (Issue #3513)', () => {
  it('selects and marks viewed what the breadcrumb picks, after an earlier pick', async () => {
    await ready();
    fireEvent.click(screen.getByTestId('select-a'));
    await waitFor(() => expect(screen.getByTestId('selected-id')).toHaveTextContent('alpha-a'));
    (worktreeApi.markAsViewed as ReturnType<typeof vi.fn>).mockClear();

    fireEvent.click(screen.getByTestId('worktree-breadcrumb-branch'));
    const popover = screen.getByTestId('repository-tab-popover');
    fireEvent.click(within(popover).getByText('b'));

    await waitFor(() => expect(screen.getByTestId('selected-id')).toHaveTextContent('alpha-b'));
    expect(worktreeApi.markAsViewed).toHaveBeenCalledWith('alpha-b');
    expect(mockPush).toHaveBeenCalledWith('/worktrees/alpha-b');
  });

  it('leaves the strip pick as it was: select, mark viewed, navigate', async () => {
    await ready();
    fireEvent.click(tab('beta'));
    fireEvent.click(within(screen.getByTestId('repository-tab-popover')).getByText('main'));

    await waitFor(() => expect(screen.getByTestId('selected-id')).toHaveTextContent('beta-main'));
    expect(worktreeApi.markAsViewed).toHaveBeenCalledWith('beta-main');
    expect(mockPush).toHaveBeenCalledWith('/worktrees/beta-main');
  });
});

describe('an open list follows the window height (Issue #3513)', () => {
  function maxHeightOf(testId: string): number {
    return Number.parseFloat(screen.getByTestId(testId).style.maxHeight);
  }

  it("re-caps the strip's branch list when the window shrinks and grows while open", async () => {
    setViewportHeight(1080);
    await ready();
    fireEvent.click(tab('alpha'));
    expect(maxHeightOf('repository-tab-popover-list')).toBe(CAP);

    resizeTo(580);
    expect(maxHeightOf('repository-tab-popover-list')).toBeLessThan(CAP);
    expect(ANCHOR_BOTTOM + 4 + maxHeightOf('repository-tab-popover-list')).toBeLessThanOrEqual(580);

    resizeTo(1080);
    expect(maxHeightOf('repository-tab-popover-list')).toBe(CAP);
  });

  it("re-caps the breadcrumb's list the same way", async () => {
    setViewportHeight(1080);
    await ready();
    fireEvent.click(screen.getByTestId('worktree-breadcrumb-branch'));
    expect(maxHeightOf('repository-tab-popover-list')).toBe(CAP);

    resizeTo(580);
    expect(ANCHOR_BOTTOM + 4 + maxHeightOf('repository-tab-popover-list')).toBeLessThanOrEqual(580);
  });

  it('re-caps the "…" menu, and a height-only resize keeps the "…" as it was', async () => {
    setViewportHeight(1080);
    await ready();
    const strip = screen.getByTestId('repository-tab-strip');
    Object.defineProperty(strip, 'scrollWidth', { value: 2400, configurable: true });
    Object.defineProperty(strip, 'clientWidth', { value: 400, configurable: true });
    resizeTo(1080);
    fireEvent.click(screen.getByTestId('repository-tab-overflow'));
    expect(maxHeightOf('repository-tab-overflow-list')).toBe(CAP);

    resizeTo(580);
    expect(screen.getByTestId('repository-tab-overflow')).toBeInTheDocument();
    expect(ANCHOR_BOTTOM + 4 + maxHeightOf('repository-tab-overflow-list')).toBeLessThanOrEqual(580);
  });

  it('shows no "…" after a height-only resize when every tab fits', async () => {
    setViewportHeight(1080);
    await ready();
    resizeTo(580);
    expect(screen.queryByTestId('repository-tab-overflow')).toBeNull();
  });
});

describe('one list open at a time (Issue #3513)', () => {
  it("closes the strip's list when the breadcrumb's opens (keyboard path)", async () => {
    await ready();
    fireEvent.keyDown(tab('alpha'), { key: 'ArrowDown' });
    expect(tab('alpha')).toHaveAttribute('aria-expanded', 'true');

    const crumb = screen.getByTestId('worktree-breadcrumb-branch');
    crumb.focus();
    fireEvent.keyDown(crumb, { key: 'ArrowDown' });

    expect(tab('alpha')).toHaveAttribute('aria-expanded', 'false');
    expect(crumb).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByTestId('repository-tab-popover')).toHaveLength(1);
  });

  it("closes the breadcrumb's list when a tab's opens", async () => {
    await ready();
    const crumb = screen.getByTestId('worktree-breadcrumb-branch');
    fireEvent.click(crumb);
    fireEvent.keyDown(tab('beta'), { key: 'ArrowDown' });

    expect(crumb).toHaveAttribute('aria-expanded', 'false');
    const popovers = screen.getAllByTestId('repository-tab-popover');
    expect(popovers).toHaveLength(1);
    expect(popovers[0]).toHaveAttribute('data-repository', 'beta');
  });

  it('closes everything when the worktree on screen is picked again', async () => {
    await ready();
    fireEvent.keyDown(tab('alpha'), { key: 'ArrowDown' });
    fireEvent.click(screen.getByTestId('worktree-breadcrumb-branch'));
    const popover = screen.getByTestId('repository-tab-popover');
    fireEvent.click(within(popover).getByText('a'));

    expect(screen.queryByTestId('repository-tab-popover')).toBeNull();
    expect(tab('alpha')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('worktree-breadcrumb-branch')).toHaveAttribute('aria-expanded', 'false');
  });

  it('still closes on Escape and on an outside click', async () => {
    await ready();
    fireEvent.click(tab('alpha'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('repository-tab-popover')).toBeNull();

    fireEvent.click(screen.getByTestId('worktree-breadcrumb-branch'));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('repository-tab-popover')).toBeNull();
  });
});
