/**
 * Unit tests for WorktreeCard next action display
 * Issue #600: UX refresh - WorktreeCard with getNextAction() integration
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

// Mock next-intl
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}));

// Mock date-fns
vi.mock('date-fns', () => ({
  formatDistanceToNow: () => '5 minutes ago',
}));

// Mock date-locale
vi.mock('@/lib/date-locale', () => ({
  getDateFnsLocale: () => undefined,
}));

// Mock api-client
vi.mock('@/lib/api-client', () => ({
  worktreeApi: {
    killSession: vi.fn(),
    toggleFavorite: vi.fn(),
    updateStatus: vi.fn(),
  },
  handleApiError: vi.fn(() => 'error'),
}));

import { WorktreeCard } from '@/components/worktree/WorktreeCard';
import type { Worktree } from '@/types/models';

function createWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'test-1',
    name: 'feature/test',
    path: '/path/to/worktree',
    repositoryName: 'my-repo',
    updatedAt: '2026-01-01T00:00:00Z',
    isSessionRunning: false,
    isWaitingForResponse: false,
    favorite: false,
    status: null,
    ...overrides,
  } as Worktree;
}

describe('WorktreeCard next action display', () => {
  it('should display nextAction when provided', () => {
    const wt = createWorktree({ nextAction: 'Running...' } as Partial<Worktree>);
    render(<WorktreeCard worktree={wt} />);
    expect(screen.getByTestId('worktree-card-next-action')).toBeDefined();
    expect(screen.getByTestId('worktree-card-next-action').textContent).toBe('Running...');
  });

  it('should display "Approve / Reject" for approval prompt', () => {
    const wt = createWorktree({ nextAction: 'Approve / Reject' } as Partial<Worktree>);
    render(<WorktreeCard worktree={wt} />);
    expect(screen.getByTestId('worktree-card-next-action').textContent).toBe('Approve / Reject');
  });

  it('should not render next action element when nextAction is not provided', () => {
    const wt = createWorktree();
    render(<WorktreeCard worktree={wt} />);
    expect(screen.queryByTestId('worktree-card-next-action')).toBeNull();
  });

  it('should display repository name', () => {
    const wt = createWorktree({ repositoryName: 'test-repo' });
    render(<WorktreeCard worktree={wt} />);
    expect(screen.getByTestId('worktree-card-repo-name')).toBeDefined();
    expect(screen.getByTestId('worktree-card-repo-name').textContent).toBe('test-repo');
  });
});
