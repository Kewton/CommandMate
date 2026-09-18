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

// Issue #2642: the branch-drawer button only exists under a SidebarProvider.
// Default to "no provider" so every pre-existing test keeps describing the bar
// without it; the dedicated describe below opts in.
const sidebarMock = vi.hoisted(() => ({
  value: null as null | { isMobileDrawerOpen: boolean; openMobileDrawer: () => void },
}));
vi.mock('@/contexts/SidebarContext', () => ({
  useOptionalSidebarContext: () => sidebarMock.value,
}));

import { GlobalMobileNav } from '@/components/mobile/GlobalMobileNav';

describe('GlobalMobileNav', () => {
  beforeEach(() => {
    mockPathname.mockReturnValue('/');
    mockRouterPush.mockClear();
    intlLocale.current = 'en';
    sidebarMock.value = null;
  });

  it('should render 3 tabs: Sessions, Review, Settings', () => {
    render(<GlobalMobileNav />);
    expect(screen.getByText('Sessions')).toBeDefined();
    expect(screen.getByText('Review')).toBeDefined();
    expect(screen.getByText('Settings')).toBeDefined();
    expect(screen.queryByText('Home')).toBeNull();
    expect(screen.queryByText('Chat')).toBeNull();
  });

  it('should NOT render Repositories tab (it is under More)', () => {
    render(<GlobalMobileNav />);
    expect(screen.queryByText('Repos')).toBeNull();
    expect(screen.queryByText('Repositories')).toBeNull();
  });

  it('should have correct hrefs for tabs', () => {
    const { container } = render(<GlobalMobileNav />);
    const sessionsLink = screen.getByText('Sessions').closest('a');
    const reviewLink = screen.getByText('Review').closest('a');
    const moreLink = screen.getByText('Settings').closest('a');

    expect(sessionsLink?.getAttribute('href')).toBe('/sessions');
    expect(reviewLink?.getAttribute('href')).toBe('/review');
    expect(moreLink?.getAttribute('href')).toBe('/more');
    expect(container.querySelector('a[href="/"]')).toBeNull();
    expect(container.querySelector('a[href="/chat"]')).toBeNull();
  });

  it('marks no tab active on / (Issue #2642)', () => {
    mockPathname.mockReturnValue('/');
    const { container } = render(<GlobalMobileNav />);
    for (const link of Array.from(container.querySelectorAll('a'))) {
      expect(link.className).not.toContain('text-accent-600');
    }
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

  it('should highlight active Settings tab when on /more', () => {
    mockPathname.mockReturnValue('/more');
    render(<GlobalMobileNav />);
    const moreLink = screen.getByText('Settings').closest('a');
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

  // Issue #1211: ja labels wrapped to 2 lines at 320px, colliding with the h-14 bar.
  // These assert the class string only — jsdom does not lay out text, so it cannot
  // observe wrapping (getBoundingClientRect always returns 0). The no-wrap behaviour
  // itself was measured in a real browser (ja @320px/@280px, all labels on one line);
  // these tests exist purely to catch the class being dropped later.
  describe('label wrapping (Issue #1211)', () => {
    it.each([
      ['en', ['Sessions', 'Review', 'Settings']],
      ['ja', ['セッション', 'レビュー', '設定']],
    ] as const)('keeps every %s tab label on one line', (locale, labels) => {
      intlLocale.current = locale;
      render(<GlobalMobileNav />);

      for (const label of labels) {
        expect(
          screen.getByText(label).className,
          `"${label}" may wrap to a second line`
        ).toContain('whitespace-nowrap');
      }
    });

    it.each(['en', 'ja'] as const)(
      'keeps the command palette trigger label on one line under %s',
      (locale) => {
        intlLocale.current = locale;
        render(<GlobalMobileNav />);

        const span = screen.getByTestId('mobile-command-palette-trigger').querySelector('span');
        expect(span?.className).toContain('whitespace-nowrap');
      }
    );

    it('does not change the bar height or slot layout', () => {
      render(<GlobalMobileNav />);

      expect(screen.getByTestId('global-mobile-nav').querySelector('div')?.className).toContain('h-14');
      expect(screen.getByText('Sessions').closest('a')?.className).toContain('flex-1');
      expect(screen.getByText('Sessions').closest('a')?.className).toContain('text-xs');
    });
  });

  describe('i18n (Issue #1206)', () => {
    it('renders every tab label in Japanese under the ja locale', () => {
      intlLocale.current = 'ja';
      render(<GlobalMobileNav />);

      expect(screen.getByText('セッション')).toBeDefined();
      expect(screen.getByText('レビュー')).toBeDefined();
      expect(screen.getByText('設定')).toBeDefined();
    });

    it('leaves no English tab label behind under the ja locale', () => {
      intlLocale.current = 'ja';
      render(<GlobalMobileNav />);

      for (const label of ['Sessions', 'Review', 'Settings']) {
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

  describe('branch drawer button (Issue #2642)', () => {
    it('renders the branch button as the first slot of the bar', () => {
      sidebarMock.value = { isMobileDrawerOpen: false, openMobileDrawer: vi.fn() };
      render(<GlobalMobileNav />);

      const button = screen.getByTestId('mobile-nav-open-sidebar');
      expect(button).toBeDefined();
      expect(screen.getByTestId('global-mobile-nav').querySelector('div')!.firstElementChild).toBe(button);
      expect(button.getAttribute('type')).toBe('button');
    });

    it('labels the button "Branches" in en and "ブランチ" in ja, on one line', () => {
      sidebarMock.value = { isMobileDrawerOpen: false, openMobileDrawer: vi.fn() };
      const { unmount } = render(<GlobalMobileNav />);
      expect(screen.getByTestId('mobile-nav-open-sidebar').textContent).toContain('Branches');
      expect(
        screen.getByTestId('mobile-nav-open-sidebar').querySelector('span')?.className
      ).toContain('whitespace-nowrap');
      unmount();

      intlLocale.current = 'ja';
      render(<GlobalMobileNav />);
      expect(screen.getByTestId('mobile-nav-open-sidebar').textContent).toContain('ブランチ');
      expect(
        screen.getByTestId('mobile-nav-open-sidebar').querySelector('span')?.className
      ).toContain('whitespace-nowrap');
    });

    it('matches the other slots and shows the menu icon', () => {
      sidebarMock.value = { isMobileDrawerOpen: false, openMobileDrawer: vi.fn() };
      render(<GlobalMobileNav />);

      const button = screen.getByTestId('mobile-nav-open-sidebar');
      expect(button.className).toContain('flex-1');
      expect(button.className).toContain('text-xs');
      expect(button.querySelector('svg.lucide-menu')).not.toBeNull();
    });

    it('opens the mobile drawer on click', () => {
      const openMobileDrawer = vi.fn();
      sidebarMock.value = { isMobileDrawerOpen: false, openMobileDrawer };
      render(<GlobalMobileNav />);

      fireEvent.click(screen.getByTestId('mobile-nav-open-sidebar'));
      expect(openMobileDrawer).toHaveBeenCalledTimes(1);
    });

    it('omits only the button when there is no SidebarProvider', () => {
      sidebarMock.value = null;
      render(<GlobalMobileNav />);

      expect(screen.queryByTestId('mobile-nav-open-sidebar')).toBeNull();
      expect(screen.getByTestId('global-mobile-nav')).toBeDefined();
    });

    it('does not render the bar while the drawer is open', () => {
      sidebarMock.value = { isMobileDrawerOpen: true, openMobileDrawer: vi.fn() };
      render(<GlobalMobileNav />);

      expect(screen.queryByTestId('global-mobile-nav')).toBeNull();
    });
  });
});
