/**
 * Unit tests for Review page stalled filter
 * Issue #600: UX refresh - Phase 3 stalled tab
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

// Mock next-intl
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

// Mock next/navigation
vi.mock('next/navigation', () => ({
  usePathname: () => '/review',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}));

// Mock AppShell
vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'app-shell' }, children),
}));

// Mock ReviewCard
vi.mock('@/components/review/ReviewCard', () => ({
  ReviewCard: ({ worktreeId, status, nextAction, children }: {
    worktreeId: string;
    status: string;
    nextAction: string;
    children?: React.ReactNode;
  }) => React.createElement('div', {
    'data-testid': `review-card-${worktreeId}`,
    'data-status': status,
  }, [nextAction, children]),
}));

// Mock SimpleMessageInput
vi.mock('@/components/review/SimpleMessageInput', () => ({
  SimpleMessageInput: () => React.createElement('div', { 'data-testid': 'simple-input' }),
}));

// Mock review-config
vi.mock('@/config/review-config', () => ({
  REVIEW_POLL_INTERVAL_MS: 60000, // Long interval to avoid interference
}));

// Mock fetch
const mockWorktrees = [
  {
    id: 'wt-done',
    name: 'feature/done',
    repositoryName: 'repo-1',
    status: 'done',
    reviewStatus: 'done',
    nextAction: 'Review completed',
    cliToolId: 'claude',
  },
  {
    id: 'wt-approval',
    name: 'feature/approval',
    repositoryName: 'repo-1',
    status: 'doing',
    reviewStatus: 'approval',
    nextAction: 'Approve / Reject',
    isWaitingForResponse: true,
    cliToolId: 'claude',
  },
  {
    id: 'wt-stalled',
    name: 'feature/stalled',
    repositoryName: 'repo-1',
    status: 'doing',
    reviewStatus: 'stalled',
    nextAction: 'Check stalled',
    isStalled: true,
    cliToolId: 'claude',
  },
  {
    id: 'wt-running',
    name: 'feature/running',
    repositoryName: 'repo-1',
    status: 'doing',
    reviewStatus: null,
    nextAction: 'Running...',
    cliToolId: 'claude',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ worktrees: mockWorktrees }),
  }) as unknown as typeof fetch;
});

import ReviewPage from '@/app/review/page';

describe('Review page stalled filter', () => {
  it('should render Stalled filter tab', async () => {
    render(React.createElement(ReviewPage));
    await waitFor(() => {
      expect(screen.getByTestId('review-filter-stalled')).toBeDefined();
    });
  });

  it('should show stalled worktrees when Stalled tab is active', async () => {
    render(React.createElement(ReviewPage));

    await waitFor(() => {
      expect(screen.getByTestId('review-list')).toBeDefined();
    });

    // Click stalled tab
    fireEvent.click(screen.getByTestId('review-filter-stalled'));

    await waitFor(() => {
      expect(screen.getByTestId('review-card-wt-stalled')).toBeDefined();
    });

    // Should not show done or approval worktrees
    expect(screen.queryByTestId('review-card-wt-done')).toBeNull();
    expect(screen.queryByTestId('review-card-wt-approval')).toBeNull();
    expect(screen.queryByTestId('review-card-wt-running')).toBeNull();
  });

  it('should fetch with include=review parameter', async () => {
    render(React.createElement(ReviewPage));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/worktrees?include=review');
    });
  });

  it('should show done worktrees by default', async () => {
    render(React.createElement(ReviewPage));

    await waitFor(() => {
      expect(screen.getByTestId('review-card-wt-done')).toBeDefined();
    });

    expect(screen.queryByTestId('review-card-wt-stalled')).toBeNull();
  });
});
