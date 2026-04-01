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
}));

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ href, children, className, ...props }: { href: string; children: React.ReactNode; className?: string; [key: string]: unknown }) => (
    <a href={href} className={className} {...props}>{children}</a>
  ),
}));

import { Header } from '@/components/layout/Header';

describe('Header', () => {
  beforeEach(() => {
    mockPathname.mockReturnValue('/');
  });

  it('should render the logo and title', () => {
    render(<Header />);
    expect(screen.getByText('CommandMate')).toBeDefined();
  });

  it('should render custom title', () => {
    render(<Header title="MyApp" />);
    expect(screen.getByText('MyApp')).toBeDefined();
  });

  it('should render 5 navigation links: Home, Sessions, Repos, Review, More', () => {
    render(<Header />);
    expect(screen.getByText('Home')).toBeDefined();
    expect(screen.getByText('Sessions')).toBeDefined();
    expect(screen.getByText('Repos')).toBeDefined();
    expect(screen.getByText('Review')).toBeDefined();
    expect(screen.getByText('More')).toBeDefined();
  });

  it('should have correct hrefs for navigation links', () => {
    render(<Header />);
    const homeLink = screen.getByText('Home').closest('a');
    const sessionsLink = screen.getByText('Sessions').closest('a');
    const reposLink = screen.getByText('Repos').closest('a');
    const reviewLink = screen.getByText('Review').closest('a');
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
    expect(homeLink?.className).toContain('text-cyan-600');
  });

  it('should highlight the active Sessions link when on /sessions', () => {
    mockPathname.mockReturnValue('/sessions');
    render(<Header />);
    const sessionsLink = screen.getByText('Sessions').closest('a');
    expect(sessionsLink?.className).toContain('text-cyan-600');
  });

  it('should highlight the active Review link when on /review', () => {
    mockPathname.mockReturnValue('/review');
    render(<Header />);
    const reviewLink = screen.getByText('Review').closest('a');
    expect(reviewLink?.className).toContain('text-cyan-600');
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
});
