/**
 * @vitest-environment jsdom
 *
 * The global "N need your attention" badge (Issue #1788) — sidebar pill and
 * mobile nav bubble.
 *
 * Wording resolves through the real dictionary rather than the key-echoing
 * global mock, so these assertions prove `common.attention.*` exists.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
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

import { AttentionBadge } from '@/components/layout/AttentionBadge';
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

describe('AttentionBadge — sidebar pill (Issue #1788)', () => {
  it('renders nothing at zero', () => {
    render(<AttentionBadge />);
    expect(screen.queryByTestId('attention-badge')).toBeNull();
  });

  it('shows the count and links to the approval filter', () => {
    cacheMock.worktrees = [waiting('a'), waiting('b')];
    render(<AttentionBadge />);

    const badge = screen.getByTestId('attention-badge');
    expect(badge.getAttribute('href')).toBe('/review?filter=approval');
    expect(screen.getByTestId('attention-badge-count').textContent).toBe('2');
    expect(screen.getByText('Needs attention')).toBeDefined();
    expect(badge.getAttribute('aria-label')).toBe('2 worktrees need your attention');
  });

  it('is visible without hover — no opacity-0 reveal (touch devices)', () => {
    cacheMock.worktrees = [waiting('a')];
    render(<AttentionBadge />);
    expect(screen.getByTestId('attention-badge').className).not.toContain('opacity-0');
  });

  it('renders Japanese wording from the ja dictionary', () => {
    intlLocale.current = 'ja';
    cacheMock.worktrees = [waiting('a')];
    render(<AttentionBadge />);
    expect(screen.getByText('要対応')).toBeDefined();
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
    expect(screen.getByText('Home').closest('a')?.getAttribute('href')).toBe('/');
    expect(screen.getByText('Sessions').closest('a')?.getAttribute('href')).toBe('/sessions');
  });
});
