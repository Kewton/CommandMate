/**
 * Tests for Header navigation active indicator (Issue #1119)
 *
 * Verifies aria-current="page" assignment and the sliding underline
 * indicator classes for each route.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { Header } from '@/components/layout/Header';

const usePathnameMock = vi.fn<() => string>(() => '/');

vi.mock('next/navigation', () => ({
  usePathname: () => usePathnameMock(),
}));

vi.mock('@/contexts/CommandPaletteContext', () => ({
  useCommandPalette: () => ({ setOpen: vi.fn() }),
}));

vi.mock('@/components/common/ThemeToggle', () => ({
  ThemeToggle: () => <div data-testid="theme-toggle" />,
}));

vi.mock('@/components/layout/PcDisplaySizeSelector', () => ({
  PcDisplaySizeSelector: () => <div data-testid="pc-display-size-selector" />,
}));

const NAV_LABELS = ['Home', 'Chat', 'Sessions', 'Repos', 'Review/Report', 'More'] as const;

const ROUTE_CASES: Array<{ pathname: string; activeLabel: (typeof NAV_LABELS)[number] }> = [
  { pathname: '/', activeLabel: 'Home' },
  { pathname: '/chat', activeLabel: 'Chat' },
  { pathname: '/sessions', activeLabel: 'Sessions' },
  { pathname: '/sessions/abc123', activeLabel: 'Sessions' },
  { pathname: '/repositories', activeLabel: 'Repos' },
  { pathname: '/review', activeLabel: 'Review/Report' },
  { pathname: '/more', activeLabel: 'More' },
];

function getNavLink(label: string): HTMLElement {
  return screen.getByRole('link', { name: label });
}

describe('Header navigation active indicator', () => {
  beforeEach(() => {
    usePathnameMock.mockReturnValue('/');
  });

  describe.each(ROUTE_CASES)('pathname: $pathname', ({ pathname, activeLabel }) => {
    it(`marks only "${activeLabel}" with aria-current="page"`, () => {
      usePathnameMock.mockReturnValue(pathname);
      render(<Header />);

      for (const label of NAV_LABELS) {
        const link = getNavLink(label);
        if (label === activeLabel) {
          expect(link).toHaveAttribute('aria-current', 'page');
        } else {
          expect(link).not.toHaveAttribute('aria-current');
        }
      }
    });
  });

  it('renders the underline indicator expanded only on the active item', () => {
    usePathnameMock.mockReturnValue('/sessions');
    render(<Header />);

    expect(getNavLink('Sessions').className).toContain('after:scale-x-100');
    expect(getNavLink('Home').className).toContain('after:scale-x-0');
  });

  it('does not mark Home as active on non-root routes', () => {
    usePathnameMock.mockReturnValue('/chat');
    render(<Header />);

    expect(getNavLink('Home')).not.toHaveAttribute('aria-current');
    expect(getNavLink('Chat')).toHaveAttribute('aria-current', 'page');
  });
});
