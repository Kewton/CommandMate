/**
 * Real-dictionary i18n tests for the Sessions page (/sessions) — Issue #1305.
 *
 * The existing SessionsPage.test.tsx asserts on data-testid only and runs under
 * the global passthrough mock from tests/setup.ts, so it stayed green both
 * before and after this migration — it cannot see whether a label resolves to
 * real copy. These tests back next-intl with the real dictionaries so that
 * deleting a key from locales/<locale>/*.json fails them (Issue #1197/#1273).
 *
 * Both locales are exercised: `en` proves the migrated wording is byte-identical
 * to the pre-migration literals, `ja` proves an English user's copy is not
 * pinned into the Japanese UI (and vice versa).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

const locale = vi.hoisted(() => ({ current: 'en' }));

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => locale.current);
});

vi.mock('next/navigation', () => ({
  usePathname: () => '/sessions',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) =>
    React.createElement('a', { href, ...props }, children),
}));

vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'app-shell' }, children),
}));

vi.mock('@/lib/date-utils', () => ({
  formatRelativeTime: () => '2 hours ago',
  formatRelativeTimeShort: () => '2h ago',
}));

let mockWorktrees: Array<Record<string, unknown>> = [];
let mockIsLoading = false;
let mockError: Error | null = null;

vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useWorktreesCacheContext: () => ({
    worktrees: mockWorktrees,
    repositories: [],
    isLoading: mockIsLoading,
    error: mockError,
    refresh: vi.fn(),
  }),
}));

import SessionsPage from '@/app/sessions/page';

function createWorktree(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wt-1',
    name: 'feature/test',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
    selectedAgents: ['claude'],
    ...overrides,
  };
}

beforeEach(() => {
  locale.current = 'en';
  mockWorktrees = [];
  mockIsLoading = false;
  mockError = null;
  vi.clearAllMocks();
});

describe('Sessions page i18n (Issue #1305)', () => {
  describe('en — wording matches the pre-migration literals byte-for-byte', () => {
    it('renders the page heading and description from the dictionary', () => {
      render(<SessionsPage />);

      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Sessions');
      expect(screen.getByText('All worktree sessions across repositories.')).toBeInTheDocument();
    });

    it('renders the filter placeholder and aria-label', () => {
      render(<SessionsPage />);

      const filter = screen.getByTestId('sessions-filter');
      expect(filter).toHaveAttribute('placeholder', 'Filter by name or repository...');
      expect(filter).toHaveAttribute('aria-label', 'Filter sessions by name or repository');
    });

    it('renders the sort control labels', () => {
      render(<SessionsPage />);

      expect(screen.getByTestId('sessions-sort-select')).toHaveAttribute('aria-label', 'Sort by');
      // Default sort is `lastSent`, whose trigger renders the selected label.
      expect(screen.getByTestId('sessions-sort-direction')).toHaveAttribute(
        'aria-label',
        'Sort descending'
      );
    });

    it('renders the empty state', () => {
      render(<SessionsPage />);

      expect(screen.getByTestId('sessions-empty')).toHaveTextContent('No sessions yet.');
    });

    it('renders the loading aria-label', () => {
      mockIsLoading = true;
      render(<SessionsPage />);

      expect(screen.getByTestId('sessions-loading')).toHaveAttribute(
        'aria-label',
        'Loading sessions'
      );
    });

    it('interpolates the blocking load error', () => {
      mockError = new Error('boom');
      render(<SessionsPage />);

      expect(screen.getByTestId('sessions-error')).toHaveTextContent(
        'Failed to load sessions: boom'
      );
    });

    it('interpolates the non-blocking refresh error banner', () => {
      mockWorktrees = [createWorktree()];
      mockError = new Error('boom');
      render(<SessionsPage />);

      expect(screen.getByTestId('sessions-error-banner')).toHaveTextContent(
        'Failed to refresh sessions: boom'
      );
    });

    it('renders the worktree lifecycle status badge from worktree.worktreeStatus.*', () => {
      mockWorktrees = [createWorktree({ id: 'wt-st', status: 'in_progress' })];
      render(<SessionsPage />);

      expect(screen.getByTestId('session-item-wt-st')).toHaveTextContent('In Progress');
    });
  });

  describe('ja — copy is translated, not pinned to English', () => {
    beforeEach(() => {
      locale.current = 'ja';
    });

    it('translates the page heading and description', () => {
      render(<SessionsPage />);

      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('セッション');
      expect(screen.queryByText('All worktree sessions across repositories.')).toBeNull();
    });

    it('translates the filter placeholder and empty state', () => {
      render(<SessionsPage />);

      expect(screen.getByTestId('sessions-filter')).toHaveAttribute(
        'placeholder',
        '名前またはリポジトリで絞り込み...'
      );
      expect(screen.getByTestId('sessions-empty')).toHaveTextContent('セッションがまだありません。');
    });

    it('translates the lifecycle status badge', () => {
      mockWorktrees = [createWorktree({ id: 'wt-st', status: 'in_progress' })];
      render(<SessionsPage />);

      const item = screen.getByTestId('session-item-wt-st');
      expect(item).toHaveTextContent('作業中');
      expect(item).not.toHaveTextContent('In Progress');
    });

    it('translates the interpolated load error while keeping the raw message', () => {
      mockError = new Error('boom');
      render(<SessionsPage />);

      expect(screen.getByTestId('sessions-error')).toHaveTextContent(
        'セッションの読み込みに失敗しました: boom'
      );
    });
  });

  describe('unknown lifecycle status falls back to the raw value', () => {
    it('does not throw on a status with no dictionary key', () => {
      mockWorktrees = [createWorktree({ id: 'wt-unk', status: 'archived' })];
      render(<SessionsPage />);

      expect(screen.getByTestId('session-item-wt-unk')).toHaveTextContent('archived');
    });
  });
});
