/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for Header component
 * Issue #600: UX refresh - PC 5-screen horizontal navigation
 * Issue #3512: the Header is the screen name + connection status + update
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

// Mock next/navigation
const mockPathname = vi.fn(() => '/');
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname(),
  // TransitionLink (#1122) reads the router at render time via useViewTransitionRouter.
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ href, children, className, ...props }: { href: string; children: React.ReactNode; className?: string; [key: string]: unknown }) => (
    <a href={href} className={className} {...props}>{children}</a>
  ),
}));

// Issue #1206: resolve labels through the real dictionary instead of the global
// key-echoing mock in tests/setup.ts. The English assertions below are the
// pre-i18n literals, so they only stay green while common.nav.* renders the
// exact same wording it replaced.
const intlLocale = vi.hoisted(() => ({ current: 'en' }));
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => intlLocale.current);
});

import { Header } from '@/components/layout/Header';

describe('Header', () => {
  beforeEach(() => {
    mockPathname.mockReturnValue('/');
    intlLocale.current = 'en';
  });

  it('should render the logo and title', () => {
    render(<Header />);
    expect(screen.getByText('CommandMate')).toBeDefined();
  });

  it('should render custom title', () => {
    render(<Header title="MyApp" />);
    expect(screen.getByText('MyApp')).toBeDefined();
  });

  // Issue #3512: the screen links, the logo link, GitHub and the theme toggle
  // left the Header. Where each former `it` now lives is listed in the commit
  // body; the link / aria-current cases moved to
  // tests/unit/components/layout/Header.test.tsx (sidebar + icon rail).
  it('should render the screen name instead of navigation links (Issue #3512)', () => {
    mockPathname.mockReturnValue('/sessions');
    render(<Header />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Sessions');
    expect(screen.queryByText('Repos')).toBeNull();
    expect(screen.queryByText('Review/Report')).toBeNull();
    expect(screen.queryByText('Home')).toBeNull();
    expect(screen.queryByText('Chat')).toBeNull();
  });

  it('has no links and no navigation landmark (Issue #3512)', () => {
    render(<Header />);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByText('GitHub')).toBeNull();
    expect(screen.queryByTestId('theme-toggle')).toBeNull();
  });

  it('should apply a translucent backdrop-blur header with an opaque fallback (Issue #1049)', () => {
    const { container } = render(<Header />);
    const header = container.querySelector('header');
    expect(header).not.toBeNull();
    const cls = header!.className;
    // opaque fallback + translucent-only-when-supported + blur + hairline token
    expect(cls).toContain('bg-background');
    expect(cls).toContain('supports-[backdrop-filter]:bg-background/80');
    expect(cls).toContain('backdrop-blur-md');
    expect(cls).toContain('border-border');
  });

  describe('i18n (Issue #1206)', () => {
    it('renders every screen name in Japanese under the ja locale', () => {
      intlLocale.current = 'ja';
      const cases: Array<[string, string]> = [
        ['/sessions', 'セッション'],
        ['/repositories', 'リポジトリ'],
        ['/review', 'レビュー'],
        ['/more', '設定'],
      ];
      for (const [pathname, label] of cases) {
        mockPathname.mockReturnValue(pathname);
        const { unmount } = render(<Header />);
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(label);
        unmount();
      }
    });

    it('leaves no English screen name behind under the ja locale', () => {
      intlLocale.current = 'ja';
      for (const [pathname, label] of [
        ['/sessions', 'Sessions'],
        ['/repositories', 'Repositories'],
        ['/review', 'Review'],
        ['/more', 'Settings'],
      ] as const) {
        mockPathname.mockReturnValue(pathname);
        const { unmount } = render(<Header />);
        expect(screen.queryByText(label), `"${label}" is still hardcoded English`).toBeNull();
        unmount();
      }
    });
  });
});
