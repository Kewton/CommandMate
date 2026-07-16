/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for HomeSessionSummary component
 * Issue #600: UX refresh - Home screen session summary
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { HomeSessionSummary } from '@/components/home/HomeSessionSummary';
import type { Worktree } from '@/types/models';

// Issue #1274: this component's wording resolves through the `home` namespace.
// Back it with the real dictionary so the English assertions prove the keys
// exist rather than echoing the global mock.
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

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

describe('HomeSessionSummary', () => {
  it('should render running count', () => {
    const worktrees = [
      createMockWorktree({ id: '1', isSessionRunning: true, isWaitingForResponse: false }),
      createMockWorktree({ id: '2', isSessionRunning: true, isWaitingForResponse: false }),
      createMockWorktree({ id: '3', isSessionRunning: false }),
    ];
    render(<HomeSessionSummary worktrees={worktrees} />);
    expect(screen.getByTestId('running-count').textContent).toBe('2');
  });

  it('should render waiting count', () => {
    const worktrees = [
      createMockWorktree({ id: '1', isSessionRunning: true, isWaitingForResponse: true }),
      createMockWorktree({ id: '2', isSessionRunning: true, isWaitingForResponse: false }),
    ];
    render(<HomeSessionSummary worktrees={worktrees} />);
    expect(screen.getByTestId('waiting-count').textContent).toBe('1');
  });

  it('should show zero counts when no worktrees', () => {
    render(<HomeSessionSummary worktrees={[]} />);
    expect(screen.getByTestId('running-count').textContent).toBe('0');
    expect(screen.getByTestId('waiting-count').textContent).toBe('0');
  });

  it('should display Running and Waiting labels', () => {
    render(<HomeSessionSummary worktrees={[]} />);
    expect(screen.getByText('Running')).toBeDefined();
    expect(screen.getByText('Waiting')).toBeDefined();
  });

  it('should apply tabular-nums to the count elements (Issue #1072)', () => {
    render(<HomeSessionSummary worktrees={[]} />);
    expect(screen.getByTestId('running-count').className).toContain('tabular-nums');
    expect(screen.getByTestId('waiting-count').className).toContain('tabular-nums');
  });

  it('should mute the count color when the count is zero (Issue #1072)', () => {
    render(
      <HomeSessionSummary
        worktrees={[
          createMockWorktree({ id: '1', isSessionRunning: true, isWaitingForResponse: false }),
        ]}
      />,
    );
    // running > 0 → foreground; waiting == 0 → muted
    expect(screen.getByTestId('running-count').className).toContain('text-foreground');
    expect(screen.getByTestId('waiting-count').className).toContain('text-muted-foreground');
  });

  it('renders two skeleton stat boxes instead of counts while loading (Issue #1118)', () => {
    render(<HomeSessionSummary worktrees={[]} isLoading />);
    const loading = screen.getByTestId('home-session-summary-loading');
    expect(loading.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('running-count')).toBeNull();
    expect(screen.queryByTestId('waiting-count')).toBeNull();
  });

  it('shows real counts once isLoading is false (Issue #1118)', () => {
    render(<HomeSessionSummary worktrees={[]} isLoading={false} />);
    expect(screen.queryByTestId('home-session-summary-loading')).toBeNull();
    expect(screen.getByTestId('running-count').textContent).toBe('0');
  });
});
