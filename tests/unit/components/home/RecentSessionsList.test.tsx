/**
 * Unit tests for RecentSessionsList (Issue #1052).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { RecentSessionsList } from '@/components/home/RecentSessionsList';
import type { Worktree } from '@/types/models';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

function createMockWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'test-id',
    name: 'test',
    path: '/test',
    repositoryPath: '/repo',
    repositoryName: 'TestRepo',
    ...overrides,
  };
}

describe('RecentSessionsList', () => {
  it('renders empty state when there are no worktrees', () => {
    render(<RecentSessionsList worktrees={[]} />);
    expect(screen.getByTestId('recent-sessions-empty')).toBeDefined();
    expect(screen.queryByTestId('recent-sessions')).toBeNull();
  });

  it('links each recent session to its worktree detail page', () => {
    const worktrees = [
      createMockWorktree({ id: 'wt-1', name: 'feature/a' }),
      createMockWorktree({ id: 'wt-2', name: 'feature/b' }),
    ];
    render(<RecentSessionsList worktrees={worktrees} />);
    const link1 = screen.getByTestId('recent-session-wt-1');
    const link2 = screen.getByTestId('recent-session-wt-2');
    expect(link1.getAttribute('href')).toBe('/worktrees/wt-1');
    expect(link2.getAttribute('href')).toBe('/worktrees/wt-2');
  });

  it('sorts by recency (newest first) using lastUserMessageAt', () => {
    const worktrees = [
      createMockWorktree({ id: 'old', lastUserMessageAt: new Date('2026-01-01T00:00:00Z') }),
      createMockWorktree({ id: 'new', lastUserMessageAt: new Date('2026-06-01T00:00:00Z') }),
      createMockWorktree({ id: 'mid', lastUserMessageAt: new Date('2026-03-01T00:00:00Z') }),
    ];
    render(<RecentSessionsList worktrees={worktrees} />);
    const items = screen.getAllByTestId(/^recent-session-/);
    expect(items.map((el) => el.getAttribute('href'))).toEqual([
      '/worktrees/new',
      '/worktrees/mid',
      '/worktrees/old',
    ]);
  });

  it('caps the number of sessions to the given limit', () => {
    const worktrees = Array.from({ length: 8 }, (_, i) =>
      createMockWorktree({ id: `wt-${i}`, lastUserMessageAt: new Date(2026, 0, i + 1) }),
    );
    render(<RecentSessionsList worktrees={worktrees} limit={3} />);
    expect(screen.getAllByTestId(/^recent-session-/)).toHaveLength(3);
  });

  it('defaults the limit to 5', () => {
    const worktrees = Array.from({ length: 8 }, (_, i) =>
      createMockWorktree({ id: `wt-${i}`, lastUserMessageAt: new Date(2026, 0, i + 1) }),
    );
    render(<RecentSessionsList worktrees={worktrees} />);
    expect(screen.getAllByTestId(/^recent-session-/)).toHaveLength(5);
  });
});
