/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for Header component
 * Issue #600: UX refresh - PC 5-screen horizontal navigation
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

// Mock next-themes so the header-mounted ThemeToggle (Issue #1071) renders deterministically
vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }),
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

  it('should render 5 navigation links: Home, Sessions, Repos, Review/Report, More', () => {
    render(<Header />);
    expect(screen.getByText('Home')).toBeDefined();
    expect(screen.getByText('Sessions')).toBeDefined();
    expect(screen.getByText('Repos')).toBeDefined();
    expect(screen.getByText('Review/Report')).toBeDefined();
    expect(screen.getByText('More')).toBeDefined();
  });

  it('should have correct hrefs for navigation links', () => {
    render(<Header />);
    const homeLink = screen.getByText('Home').closest('a');
    const sessionsLink = screen.getByText('Sessions').closest('a');
    const reposLink = screen.getByText('Repos').closest('a');
    const reviewLink = screen.getByText('Review/Report').closest('a');
    const moreLink = screen.getByText('More').closest('a');

    expect(homeLink?.getAttribute('href')).toBe('/');
    expect(sessionsLink?.getAttribute('href')).toBe('/sessions');
    expect(reposLink?.getAttribute('href')).toBe('/repositories');
    expect(reviewLink?.getAttribute('href')).toBe('/review');
    expect(moreLink?.getAttribute('href')).toBe('/more');
  });

  it('should highlight the active Home link when on /', () => {
    mockPathname.mockReturnValue('/');
    render(<Header />);
    const homeLink = screen.getByText('Home').closest('a');
    expect(homeLink?.className).toContain('text-accent-600');
  });

  it('should highlight the active Sessions link when on /sessions', () => {
    mockPathname.mockReturnValue('/sessions');
    render(<Header />);
    const sessionsLink = screen.getByText('Sessions').closest('a');
    expect(sessionsLink?.className).toContain('text-accent-600');
  });

  it('should highlight the active Review/Report link when on /review', () => {
    mockPathname.mockReturnValue('/review');
    render(<Header />);
    const reviewLink = screen.getByText('Review/Report').closest('a');
    expect(reviewLink?.className).toContain('text-accent-600');
  });

  it('should still render GitHub link', () => {
    render(<Header />);
    const githubLink = screen.getByText('GitHub').closest('a');
    expect(githubLink).toBeDefined();
    expect(githubLink?.getAttribute('href')).toContain('github.com');
    expect(githubLink?.getAttribute('target')).toBe('_blank');
  });

  it('should have nav element with role navigation', () => {
    render(<Header />);
    const nav = screen.getByRole('navigation');
    expect(nav).toBeDefined();
  });

  it('should render the ThemeToggle in the header (Issue #1071)', () => {
    render(<Header />);
    expect(screen.getByTestId('theme-toggle')).toBeInTheDocument();
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
    it('renders every nav label in Japanese under the ja locale', () => {
      intlLocale.current = 'ja';
      render(<Header />);

      expect(screen.getByText('ホーム')).toBeDefined();
      expect(screen.getByText('チャット')).toBeDefined();
      expect(screen.getByText('セッション')).toBeDefined();
      expect(screen.getByText('リポジトリ')).toBeDefined();
      expect(screen.getByText('レビュー/レポート')).toBeDefined();
      expect(screen.getByText('その他')).toBeDefined();
    });

    it('leaves no English nav label behind under the ja locale', () => {
      intlLocale.current = 'ja';
      render(<Header />);

      for (const label of ['Home', 'Chat', 'Sessions', 'Repos', 'Review/Report', 'More']) {
        expect(screen.queryByText(label), `"${label}" is still hardcoded English`).toBeNull();
      }
    });

    it('keeps hrefs and active state locale-independent', () => {
      intlLocale.current = 'ja';
      mockPathname.mockReturnValue('/repositories');
      render(<Header />);

      const reposLink = screen.getByText('リポジトリ').closest('a');
      expect(reposLink?.getAttribute('href')).toBe('/repositories');
      expect(reposLink?.className).toContain('text-accent-600');
      expect(reposLink?.getAttribute('aria-current')).toBe('page');
    });
  });
});
