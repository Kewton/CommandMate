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

import { GlobalMobileNav } from '@/components/mobile/GlobalMobileNav';

describe('GlobalMobileNav', () => {
  beforeEach(() => {
    mockPathname.mockReturnValue('/');
    mockRouterPush.mockClear();
  });

  it('should render 4 tabs: Home, Sessions, Review/Report, More', () => {
    render(<GlobalMobileNav />);
    expect(screen.getByText('Home')).toBeDefined();
    expect(screen.getByText('Sessions')).toBeDefined();
    expect(screen.getByText('Review/Report')).toBeDefined();
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
    const sessionsLink = screen.getByText('Sessions').closest('a');
    const reviewLink = screen.getByText('Review/Report').closest('a');
    const moreLink = screen.getByText('More').closest('a');

    expect(homeLink?.getAttribute('href')).toBe('/');
    expect(sessionsLink?.getAttribute('href')).toBe('/sessions');
    expect(reviewLink?.getAttribute('href')).toBe('/review');
    expect(moreLink?.getAttribute('href')).toBe('/more');
  });

  it('should highlight active Home tab when on /', () => {
    mockPathname.mockReturnValue('/');
    render(<GlobalMobileNav />);
    const homeLink = screen.getByText('Home').closest('a');
    expect(homeLink?.className).toContain('text-cyan-600');
  });

  it('should highlight active Sessions tab when on /sessions', () => {
    mockPathname.mockReturnValue('/sessions');
    render(<GlobalMobileNav />);
    const sessionsLink = screen.getByText('Sessions').closest('a');
    expect(sessionsLink?.className).toContain('text-cyan-600');
  });

  it('should highlight active Review/Report tab when on /review', () => {
    mockPathname.mockReturnValue('/review');
    render(<GlobalMobileNav />);
    const reviewLink = screen.getByText('Review/Report').closest('a');
    expect(reviewLink?.className).toContain('text-cyan-600');
  });

  it('should highlight active More tab when on /more', () => {
    mockPathname.mockReturnValue('/more');
    render(<GlobalMobileNav />);
    const moreLink = screen.getByText('More').closest('a');
    expect(moreLink?.className).toContain('text-cyan-600');
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
});
