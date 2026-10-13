/**
 * @vitest-environment jsdom
 */

/**
 * A row's "…" menu inside the breadcrumb's ▾ list (Issue #3576).
 *
 * The menu is portalled out of the list, so the list's outside-click rule must
 * treat it as the list's own — with the same check the tab strip uses — or the
 * mousedown closes the list (and unmounts the menu) before the click lands.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup, waitFor } from '@testing-library/react';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});
import React from 'react';
import type { Worktree } from '@/types/models';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/worktrees/beta-develop',
  useSearchParams: () => new URLSearchParams(),
}));

const cacheState = vi.hoisted(() => ({
  value: null as null | { worktrees: unknown[]; repositories: unknown[] },
}));
vi.mock('@/components/providers/WorktreesCacheProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/providers/WorktreesCacheProvider')>()),
  useOptionalWorktreesCacheContext: () =>
    cacheState.value
      ? {
          ...cacheState.value,
          isLoading: false,
          error: null,
          refresh: vi.fn(),
        }
      : null,
}));

const sidebarState = vi.hoisted(() => ({
  value: null as null | Record<string, unknown>,
}));
vi.mock('@/contexts/SidebarContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/contexts/SidebarContext')>()),
  useSidebarContext: () => sidebarState.value,
}));

// The cache provider wraps its children in WorktreeSelectionProvider; here the
// selection is a stub so a pick can be observed (Issue #3513 review).
const mockSelectWorktree = vi.fn(async () => {});
vi.mock('@/contexts/WorktreeSelectionContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/contexts/WorktreeSelectionContext')>()),
  useWorktreeSelection: () => ({ selectWorktree: mockSelectWorktree }),
}));

import { DesktopHeader } from '@/components/worktree/WorktreeDetailSubComponents';

function worktree(overrides: Partial<Worktree> & Pick<Worktree, 'id'>): Worktree {
  return {
    name: `branch-${overrides.id}`,
    path: `/repos/${overrides.id}`,
    repositoryPath: '/repos/alpha',
    repositoryName: 'alpha',
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as Worktree;
}

/** Two repositories, each with a `develop`. */
const WORKTREES: Worktree[] = [
  worktree({ id: 'alpha-develop', name: 'develop', repositoryPath: '/repos/alpha', repositoryName: 'alpha' }),
  worktree({ id: 'alpha-main', name: 'main', repositoryPath: '/repos/alpha', repositoryName: 'alpha' }),
  worktree({ id: 'beta-develop', name: 'develop', repositoryPath: '/repos/beta', repositoryName: 'beta' }),
  worktree({ id: 'beta-fix', name: 'fix/3513', repositoryPath: '/repos/beta', repositoryName: 'beta' }),
];

/** The sidebar settings the header reads; the tab-strip state is varied per test. */
function sidebar(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sortKey: 'updatedAt',
    sortDirection: 'desc',
    repositoryOrder: [],
    isOpen: false,
    repoTabBarMode: 'collapsed',
    ...overrides,
  };
}

function renderHeader(props: { worktreeId?: string; worktreeName: string; repositoryName: string }) {
  return render(
    <DesktopHeader {...props} status="idle" onInfoClick={vi.fn()} />
  );
}

const originalClipboard = navigator.clipboard;

beforeAll(() => installRadixJsdomPolyfills());

beforeEach(() => {
  mockPush.mockReset();
  cacheState.value = { worktrees: WORKTREES, repositories: [] };
  sidebarState.value = sidebar();
});

afterEach(() => {
  cleanup();
  Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true });
});

function openList(): HTMLElement {
  renderHeader({ worktreeId: 'beta-develop', worktreeName: 'develop', repositoryName: 'beta' });
  fireEvent.click(screen.getByTestId('worktree-breadcrumb-branch'));
  return screen.getByTestId('repository-tab-popover');
}

describe('row "…" menu in the breadcrumb list (Issue #3576)', () => {
  it('copies the branch name and leaves the list open (mousedown, then click)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const popover = openList();

    fireEvent.keyDown(within(popover).getByTestId('branch-row-actions'), { key: 'Enter' });
    const item = screen.getByRole('menuitem', { name: 'Copy branch name' });
    fireEvent.mouseDown(item);
    fireEvent.click(item);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('develop'));
    expect(screen.getByTestId('repository-tab-popover')).toBeInTheDocument();
  });

  it('still closes on a click outside the list (negative control)', () => {
    openList();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('repository-tab-popover')).toBeNull();
  });
});
