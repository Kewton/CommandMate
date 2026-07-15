/**
 * Unit tests for SessionOverviewTile (Issue #1052).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { SessionOverviewTile } from '@/components/home/SessionOverviewTile';
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

describe('SessionOverviewTile', () => {
  it('renders the tile with running/waiting counts', () => {
    const worktrees = [
      createMockWorktree({ id: '1', isSessionRunning: true, isWaitingForResponse: true }),
      createMockWorktree({ id: '2', isSessionRunning: true, isWaitingForResponse: false }),
    ];
    render(<SessionOverviewTile worktrees={worktrees} />);
    expect(screen.getByTestId('session-overview-tile')).toBeDefined();
    expect(screen.getByTestId('running-count').textContent).toBe('2');
    expect(screen.getByTestId('waiting-count').textContent).toBe('1');
  });

  it('renders the recent sessions list with links', () => {
    const worktrees = [createMockWorktree({ id: 'wt-1' })];
    render(<SessionOverviewTile worktrees={worktrees} />);
    expect(screen.getByTestId('recent-session-wt-1').getAttribute('href')).toBe('/worktrees/wt-1');
  });

  it('shows an empty state and zero counts when there are no sessions', () => {
    render(<SessionOverviewTile worktrees={[]} />);
    expect(screen.getByTestId('running-count').textContent).toBe('0');
    expect(screen.getByTestId('waiting-count').textContent).toBe('0');
    expect(screen.getByTestId('recent-sessions-empty')).toBeDefined();
  });

  it('links "View all" to the sessions page', () => {
    render(<SessionOverviewTile worktrees={[]} />);
    expect(screen.getByTestId('session-overview-view-all').getAttribute('href')).toBe('/sessions');
  });

  it('renders stat/list skeletons with headings intact while loading (Issue #1118)', () => {
    render(<SessionOverviewTile worktrees={[]} isLoading />);
    expect(screen.getByTestId('home-session-summary-loading')).toBeDefined();
    expect(screen.getByTestId('recent-sessions-loading')).toBeDefined();
    // Chrome (headings, View all link) stays visible during loading
    expect(screen.getByText('Session Overview')).toBeDefined();
    expect(screen.getByTestId('session-overview-view-all')).toBeDefined();
    expect(screen.queryByTestId('running-count')).toBeNull();
    expect(screen.queryByTestId('recent-sessions-empty')).toBeNull();
  });
});
