/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for GlobalMobileNav component
 * Issue #600: UX refresh - mobile bottom tab bar with 4 tabs
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

// Mock next/navigation
const mockPathname = vi.fn(() => '/');
const mockRouterPush = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname(),
  useRouter: () => ({ push: mockRouterPush }),
}));

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ href, children, className, ...props }: { href: string; children: React.ReactNode; className?: string; [key: string]: unknown }) => (
    <a href={href} className={className} {...props}>{children}</a>
  ),
}));

// Issue #1206: resolve labels through the real dictionary instead of the global
// key-echoing mock in tests/setup.ts, so the English assertions below only stay
// green while common.nav.* renders the exact wording it replaced.
const intlLocale = vi.hoisted(() => ({ current: 'en' }));
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => intlLocale.current);
});

import { GlobalMobileNav } from '@/components/mobile/GlobalMobileNav';

describe('GlobalMobileNav', () => {
  beforeEach(() => {
    mockPathname.mockReturnValue('/');
    mockRouterPush.mockClear();
    intlLocale.current = 'en';
  });

  it('should render 5 tabs: Home, Chat, Sessions, Review, More', () => {
    render(<GlobalMobileNav />);
    expect(screen.getByText('Home')).toBeDefined();
    expect(screen.getByText('Chat')).toBeDefined();
    expect(screen.getByText('Sessions')).toBeDefined();
    expect(screen.getByText('Review')).toBeDefined();
    expect(screen.getByText('More')).toBeDefined();
  });

  it('should NOT render Repositories tab (it is under More)', () => {
    render(<GlobalMobileNav />);
    expect(screen.queryByText('Repos')).toBeNull();
    expect(screen.queryByText('Repositories')).toBeNull();
  });

  it('should have correct hrefs for tabs', () => {
    render(<GlobalMobileNav />);
    const homeLink = screen.getByText('Home').closest('a');
    const chatLink = screen.getByText('Chat').closest('a');
    const sessionsLink = screen.getByText('Sessions').closest('a');
    const reviewLink = screen.getByText('Review').closest('a');
    const moreLink = screen.getByText('More').closest('a');

    expect(homeLink?.getAttribute('href')).toBe('/');
    expect(chatLink?.getAttribute('href')).toBe('/chat');
    expect(sessionsLink?.getAttribute('href')).toBe('/sessions');
    expect(reviewLink?.getAttribute('href')).toBe('/review');
    expect(moreLink?.getAttribute('href')).toBe('/more');
  });

  it('should highlight active Home tab when on /', () => {
    mockPathname.mockReturnValue('/');
    render(<GlobalMobileNav />);
    const homeLink = screen.getByText('Home').closest('a');
    expect(homeLink?.className).toContain('text-accent-600');
  });

  it('should highlight active Sessions tab when on /sessions', () => {
    mockPathname.mockReturnValue('/sessions');
    render(<GlobalMobileNav />);
    const sessionsLink = screen.getByText('Sessions').closest('a');
    expect(sessionsLink?.className).toContain('text-accent-600');
  });

  it('should highlight active Review tab when on /review', () => {
    mockPathname.mockReturnValue('/review');
    render(<GlobalMobileNav />);
    const reviewLink = screen.getByText('Review').closest('a');
    expect(reviewLink?.className).toContain('text-accent-600');
  });

  it('should highlight active More tab when on /more', () => {
    mockPathname.mockReturnValue('/more');
    render(<GlobalMobileNav />);
    const moreLink = screen.getByText('More').closest('a');
    expect(moreLink?.className).toContain('text-accent-600');
  });

  it('should have a nav element with data-testid', () => {
    render(<GlobalMobileNav />);
    expect(screen.getByTestId('global-mobile-nav')).toBeDefined();
  });

  it('should render as a fixed bottom bar', () => {
    render(<GlobalMobileNav />);
    const nav = screen.getByTestId('global-mobile-nav');
    expect(nav.className).toContain('fixed');
    expect(nav.className).toContain('bottom-0');
  });

  it('should apply a translucent backdrop-blur bar with an opaque fallback (Issue #1049)', () => {
    render(<GlobalMobileNav />);
    const cls = screen.getByTestId('global-mobile-nav').className;
    expect(cls).toContain('bg-background');
    expect(cls).toContain('supports-[backdrop-filter]:bg-background/80');
    expect(cls).toContain('backdrop-blur-md');
    expect(cls).toContain('border-border');
  });

  describe('i18n (Issue #1206)', () => {
    it('renders every tab label in Japanese under the ja locale', () => {
      intlLocale.current = 'ja';
      render(<GlobalMobileNav />);

      expect(screen.getByText('ホーム')).toBeDefined();
      expect(screen.getByText('チャット')).toBeDefined();
      expect(screen.getByText('セッション')).toBeDefined();
      expect(screen.getByText('レビュー')).toBeDefined();
      expect(screen.getByText('その他')).toBeDefined();
    });

    it('leaves no English tab label behind under the ja locale', () => {
      intlLocale.current = 'ja';
      render(<GlobalMobileNav />);

      for (const label of ['Home', 'Chat', 'Sessions', 'Review', 'More']) {
        expect(screen.queryByText(label), `"${label}" is still hardcoded English`).toBeNull();
      }
    });

    it('still omits Repositories under the ja locale', () => {
      intlLocale.current = 'ja';
      render(<GlobalMobileNav />);
      expect(screen.queryByText('リポジトリ')).toBeNull();
    });

    it('keeps hrefs and active state locale-independent', () => {
      intlLocale.current = 'ja';
      mockPathname.mockReturnValue('/sessions');
      render(<GlobalMobileNav />);

      const sessionsLink = screen.getByText('セッション').closest('a');
      expect(sessionsLink?.getAttribute('href')).toBe('/sessions');
      expect(sessionsLink?.className).toContain('text-accent-600');
    });
  });
});
