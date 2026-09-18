/**
 * @vitest-environment jsdom
 *
 * The global "N need your attention" count (Issue #1788) — the count chip on
 * the sidebar's Review row (Issue #2644, which replaced the sidebar pill) and
 * the mobile nav bubble.
 *
 * Wording resolves through the real dictionary rather than the key-echoing
 * global mock, so these assertions prove `common.attention.*` exists.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import type { Worktree } from '@/types/models';

const mockPathname = vi.fn(() => '/');
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname(),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('@/components/view-transitions/TransitionLink', () => ({
  TransitionLink: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('@/contexts/CommandPaletteContext', () => ({
  useCommandPalette: () => ({ setOpen: vi.fn() }),
}));

const intlLocale = vi.hoisted(() => ({ current: 'en' }));
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => intlLocale.current);
});

// The badge reads the shared cache through the optional context; driving that
// mock is how these tests set the count.
const cacheMock = vi.hoisted(() => ({ worktrees: [] as Worktree[] }));
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () =>
    ({ worktrees: cacheMock.worktrees, repositories: [], isLoading: false, error: null, refresh: async () => {} }),
}));

import { Sidebar } from '@/components/layout/Sidebar';
import { SidebarProvider } from '@/contexts/SidebarContext';
import { WorktreeSelectionProvider } from '@/contexts/WorktreeSelectionContext';
import { GlobalMobileNav } from '@/components/mobile/GlobalMobileNav';

function waiting(id: string): Worktree {
  return {
    id,
    name: id,
    path: `/${id}`,
    repositoryPath: '/repo',
    repositoryName: 'Repo',
    isWaitingForResponse: true,
  };
}

beforeEach(() => {
  cacheMock.worktrees = [];
  mockPathname.mockReturnValue('/');
  intlLocale.current = 'en';
});

describe('Sidebar Review row — attention count (Issue #2644)', () => {
  function renderSidebar() {
    return render(
      <SidebarProvider>
        <WorktreeSelectionProvider externalWorktrees={cacheMock.worktrees} externalRepositories={[]}>
          <Sidebar />
        </WorktreeSelectionProvider>
      </SidebarProvider>,
    );
  }

  beforeEach(() => {
    // The sidebar loads the saved repository group order on mount.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ json: async () => ({ success: true, order: null }) }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders no count at zero, and keeps the plain /review href', () => {
    renderSidebar();
    expect(screen.queryByTestId('sidebar-nav-review-count')).toBeNull();
    expect(screen.getByTestId('sidebar-nav-review').getAttribute('href')).toBe('/review');
  });

  it('shows the count and points Review at the approval filter', () => {
    cacheMock.worktrees = [waiting('a'), waiting('b')];
    renderSidebar();

    const count = screen.getByTestId('sidebar-nav-review-count');
    expect(count.textContent).toBe('2');
    expect(count.getAttribute('aria-label')).toBe('2 worktrees need your attention');
    expect(screen.getByTestId('sidebar-nav-review').getAttribute('href')).toBe('/review?filter=approval');
    expect(screen.getByTestId('sidebar-nav-review')).toContainElement(count);
  });

  it('is visible without hover — no opacity-0 reveal (touch devices)', () => {
    cacheMock.worktrees = [waiting('a')];
    renderSidebar();
    expect(screen.getByTestId('sidebar-nav-review-count').className).not.toContain('opacity-0');
  });

  it('caps the count at 99+ so it cannot widen the row', () => {
    cacheMock.worktrees = Array.from({ length: 120 }, (_, i) => waiting(`wt-${i}`));
    renderSidebar();
    expect(screen.getByTestId('sidebar-nav-review-count').textContent).toBe('99+');
  });

  it('renders Japanese wording from the ja dictionary', () => {
    intlLocale.current = 'ja';
    cacheMock.worktrees = [waiting('a')];
    renderSidebar();
    expect(screen.getByTestId('sidebar-nav-review').textContent).toContain('レビュー');
    expect(screen.getByTestId('sidebar-nav-review-count').getAttribute('aria-label')).toBe(
      '要対応のワークツリーが 1 件あります',
    );
  });

  it('marks only the current page with aria-current="page"', () => {
    mockPathname.mockReturnValue('/review');
    renderSidebar();
    expect(screen.getByTestId('sidebar-nav-review').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('sidebar-nav-sessions').getAttribute('aria-current')).toBeNull();
    expect(screen.getByTestId('sidebar-nav-repositories').getAttribute('aria-current')).toBeNull();
  });
});

describe('GlobalMobileNav — attention bubble (Issue #1788)', () => {
  it('renders no bubble at zero, and keeps the plain Review href', () => {
    render(<GlobalMobileNav />);
    expect(screen.queryByTestId('attention-badge-bubble')).toBeNull();
    const review = screen.getByText('Review').closest('a');
    expect(review?.getAttribute('href')).toBe('/review');
  });

  it('shows the bubble and points Review at the approval filter', () => {
    cacheMock.worktrees = [waiting('a'), waiting('b'), waiting('c')];
    render(<GlobalMobileNav />);

    expect(screen.getByTestId('attention-badge-bubble').textContent).toBe('3');
    const review = screen.getByText('Review').closest('a');
    expect(review?.getAttribute('href')).toBe('/review?filter=approval');
  });

  it('caps the bubble at 99+ so it cannot shove the tab label around', () => {
    cacheMock.worktrees = Array.from({ length: 120 }, (_, i) => waiting(`wt-${i}`));
    render(<GlobalMobileNav />);
    expect(screen.getByTestId('attention-badge-bubble').textContent).toBe('99+');
  });

  it('leaves the other tabs alone', () => {
    cacheMock.worktrees = [waiting('a')];
    render(<GlobalMobileNav />);
    expect(screen.getByText('Settings').closest('a')?.getAttribute('href')).toBe('/more');
    expect(screen.getByText('Sessions').closest('a')?.getAttribute('href')).toBe('/sessions');
  });
});
