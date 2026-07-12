/**
 * Unit tests for HomeQuickActions (Issue #1052).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { HomeQuickActions } from '@/components/home/HomeQuickActions';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

describe('HomeQuickActions', () => {
  it('renders all five quick actions', () => {
    render(<HomeQuickActions />);
    expect(screen.getByTestId('home-quick-actions')).toBeDefined();
    for (const key of ['chat', 'sessions', 'repositories', 'review', 'more']) {
      expect(screen.getByTestId(`quick-action-${key}`)).toBeDefined();
    }
  });

  it('points each action to the correct route', () => {
    render(<HomeQuickActions />);
    const expected: Record<string, string> = {
      chat: '/chat',
      sessions: '/sessions',
      repositories: '/repositories',
      review: '/review',
      more: '/more',
    };
    for (const [key, href] of Object.entries(expected)) {
      expect(screen.getByTestId(`quick-action-${key}`).getAttribute('href')).toBe(href);
    }
  });
});
