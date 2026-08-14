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

  // Issue #1197: the empty copy must resolve through next-intl, not be inlined.
  it('renders the empty state copy via a translation key', () => {
    render(<RecentSessionsList worktrees={[]} />);
    expect(screen.getByTestId('recent-sessions-empty').textContent).toBe(
      'home.recentSessions.empty'
    );
  });

  // Issue #1199: an empty list always means zero repositories, so the CTA points
  // at the only productive next action.
  it('offers a CTA to register a repository from the empty state', () => {
    render(<RecentSessionsList worktrees={[]} />);
    const cta = screen.getByTestId('recent-sessions-cta');
    expect(cta.getAttribute('href')).toBe('/repositories');
    expect(cta.textContent).toBe('home.recentSessions.cta');
  });

  it('does not render the CTA once sessions exist', () => {
    render(<RecentSessionsList worktrees={[createMockWorktree()]} />);
    expect(screen.queryByTestId('recent-sessions-cta')).toBeNull();
  });

  it('does not render the CTA while loading', () => {
    render(<RecentSessionsList worktrees={[]} isLoading />);
    expect(screen.queryByTestId('recent-sessions-cta')).toBeNull();
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

  it('renders limit-many skeleton rows instead of the empty state while loading (Issue #1118)', () => {
    render(<RecentSessionsList worktrees={[]} isLoading />);
    const loading = screen.getByTestId('recent-sessions-loading');
    expect(loading.querySelectorAll('li')).toHaveLength(5);
    expect(loading.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('recent-sessions-empty')).toBeNull();
  });

  it('swaps skeletons for real rows once loaded (Issue #1118)', () => {
    const worktrees = [createMockWorktree({ id: 'wt-1' })];
    render(<RecentSessionsList worktrees={worktrees} isLoading={false} />);
    expect(screen.queryByTestId('recent-sessions-loading')).toBeNull();
    expect(screen.getByTestId('recent-session-wt-1')).toBeDefined();
  });

  // ==========================================================================
  // Issue #1787: the dot is the shared StatusDot primitive, not a class string
  // ==========================================================================

  describe('status dot (Issue #1787)', () => {
    it('renders a waiting session with the shared attention pulse, not a static dot', () => {
      render(
        <RecentSessionsList
          worktrees={[
            createMockWorktree({ id: 'w', isSessionRunning: true, isWaitingForResponse: true }),
          ]}
        />
      );
      const dot = screen.getByTestId('recent-status-dot-w');
      expect(dot.className).toContain('bg-warning');
      expect(dot.className).toContain('animate-status-attention');
      // Motion-independent ring, so reduce-motion still separates it from ready.
      expect(dot.className).toContain('ring-warning');
    });

    it('grades a terminal-only wait down to the medium tier', () => {
      render(
        <RecentSessionsList
          worktrees={[
            createMockWorktree({
              id: 'w',
              isSessionRunning: true,
              isWaitingForResponse: true,
              sessionStatusByInstance: {
                claude: {
                  isRunning: true,
                  isWaitingForResponse: true,
                  isProcessing: false,
                  waitingKind: 'menu',
                },
              },
            }),
          ]}
        />
      );
      const dot = screen.getByTestId('recent-status-dot-w');
      expect(dot.className).toContain('animate-status-glow');
      expect(dot.className).not.toContain('animate-status-attention');
    });

    it.each([
      ['processing', { isSessionRunning: true, isProcessing: true }, 'bg-success', 'animate-status-glow'],
      ['idle', {}, 'bg-muted-foreground', null],
    ] as const)('renders a %s session through the primitive', (_name, flags, color, animation) => {
      render(<RecentSessionsList worktrees={[createMockWorktree({ id: 'w', ...flags })]} />);
      const dot = screen.getByTestId('recent-status-dot-w');
      expect(dot.className).toContain(color);
      if (animation) {
        expect(dot.className).toContain(animation);
      } else {
        expect(dot.className).not.toContain('animate-status');
      }
    });

    // A running-but-not-processing session is `ready`: the old hand-rolled dot
    // used the same green, so this pins that the migration did not upgrade an
    // idle-at-the-prompt session into a glowing "busy" one.
    it('keeps a session sitting at its prompt as a static ready dot', () => {
      render(
        <RecentSessionsList
          worktrees={[createMockWorktree({ id: 'w', isSessionRunning: true })]}
        />
      );
      const dot = screen.getByTestId('recent-status-dot-w');
      expect(dot.className).toContain('bg-success');
      expect(dot.className).not.toContain('animate-status');
    });

    // Guards the testid collision that would break the row selectors.
    it('keeps the dot out of the `recent-session-` testid namespace', () => {
      render(<RecentSessionsList worktrees={[createMockWorktree({ id: 'w' })]} />);
      expect(screen.getAllByTestId(/^recent-session-/)).toHaveLength(1);
    });
  });
});
