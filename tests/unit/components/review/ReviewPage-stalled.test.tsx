/**
 * Unit tests for Review page filters (In Review / Approval / Stalled)
 * Issue #600: UX refresh
 * Issue #607: Updated for page-level tab shell (ReviewTab extraction)
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
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) =>
    React.createElement('a', { href, ...props }, children),
}));

// Mock AppShell
vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'app-shell' }, children),
}));

// Mock review-config
vi.mock('@/config/review-config', () => ({
  REVIEW_POLL_INTERVAL_MS: 60000,
  SUMMARY_GENERATION_TIMEOUT_MS: 60000,
  SUMMARY_ALLOWED_TOOLS: ['claude', 'codex', 'copilot'],
}));

// Mock status-colors
vi.mock('@/config/status-colors', () => ({
  SIDEBAR_STATUS_CONFIG: {
    idle: { type: 'dot', className: 'bg-gray-400', label: 'Idle' },
    ready: { type: 'dot', className: 'bg-cyan-500', label: 'Ready' },
    running: { type: 'spinner', className: 'border-green-500', label: 'Running' },
    waiting: { type: 'dot', className: 'bg-yellow-500', label: 'Waiting' },
    generating: { type: 'spinner', className: 'border-blue-500', label: 'Generating' },
  },
}));

const mockWorktrees = [
  {
    id: 'wt-in-review',
    name: 'feature/in-review',
    repositoryName: 'repo-1',
    status: 'in_review',
    cliToolId: 'claude',
    selectedAgents: ['claude'],
  },
  {
    id: 'wt-approval',
    name: 'feature/approval',
    repositoryName: 'repo-1',
    status: 'in_progress',
    isWaitingForResponse: true,
    cliToolId: 'claude',
    selectedAgents: ['claude'],
  },
  {
    id: 'wt-stalled',
    name: 'feature/stalled',
    repositoryName: 'repo-1',
    status: 'in_progress',
    isStalled: true,
    cliToolId: 'claude',
    selectedAgents: ['claude'],
  },
  {
    id: 'wt-running',
    name: 'feature/running',
    repositoryName: 'repo-1',
    status: 'in_progress',
    cliToolId: 'claude',
    selectedAgents: ['claude'],
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

describe('Review page filters', () => {
  it('should render page-level tabs (Review / Report)', async () => {
    render(React.createElement(ReviewPage));
    await waitFor(() => {
      expect(screen.getByTestId('page-tab-review')).toBeDefined();
      expect(screen.getByTestId('page-tab-report')).toBeDefined();
    });
  });

  it('should render all three filter tabs in Review tab', async () => {
    render(React.createElement(ReviewPage));
    await waitFor(() => {
      expect(screen.getByTestId('review-filter-in_review')).toBeDefined();
      expect(screen.getByTestId('review-filter-approval')).toBeDefined();
      expect(screen.getByTestId('review-filter-stalled')).toBeDefined();
    });
  });

  it('should show in_review worktrees by default', async () => {
    render(React.createElement(ReviewPage));

    await waitFor(() => {
      expect(screen.getByTestId('review-item-wt-in-review')).toBeDefined();
    });

    expect(screen.queryByTestId('review-item-wt-approval')).toBeNull();
    expect(screen.queryByTestId('review-item-wt-stalled')).toBeNull();
  });

  it('should show approval worktrees when Approval tab is active', async () => {
    render(React.createElement(ReviewPage));

    await waitFor(() => {
      expect(screen.getByTestId('review-list')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('review-filter-approval'));

    await waitFor(() => {
      expect(screen.getByTestId('review-item-wt-approval')).toBeDefined();
    });

    expect(screen.queryByTestId('review-item-wt-in-review')).toBeNull();
    expect(screen.queryByTestId('review-item-wt-stalled')).toBeNull();
  });

  it('should show stalled worktrees when Stalled tab is active', async () => {
    render(React.createElement(ReviewPage));

    await waitFor(() => {
      expect(screen.getByTestId('review-list')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('review-filter-stalled'));

    await waitFor(() => {
      expect(screen.getByTestId('review-item-wt-stalled')).toBeDefined();
    });

    expect(screen.queryByTestId('review-item-wt-in-review')).toBeNull();
    expect(screen.queryByTestId('review-item-wt-approval')).toBeNull();
  });

  it('should fetch with include=review parameter', async () => {
    render(React.createElement(ReviewPage));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/worktrees?include=review');
    });
  });
});
