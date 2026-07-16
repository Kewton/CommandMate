/**
 * Real-dictionary i18n tests for the Review page (/review) — Issue #1305.
 *
 * Backed by the real dictionaries (not the global passthrough mock in
 * tests/setup.ts) so that deleting a key from locales/<locale>/review.json fails
 * these tests rather than silently echoing the key (Issue #1197/#1273).
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

vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'app-shell' }, children),
}));

// The tab bodies own their own data fetching; this page-level shell test only
// covers the heading and the tab triggers.
vi.mock('@/components/review/ReviewTab', () => ({
  default: () => React.createElement('div', { 'data-testid': 'review-tab-body' }),
}));
vi.mock('@/components/review/ReportTab', () => ({
  default: () => React.createElement('div', { 'data-testid': 'report-tab-body' }),
}));
vi.mock('@/components/review/TemplateTab', () => ({
  default: () => React.createElement('div', { 'data-testid': 'template-tab-body' }),
}));

import ReviewPage from '@/app/review/page';

beforeEach(() => {
  locale.current = 'en';
  vi.clearAllMocks();
});

describe('Review page i18n (Issue #1305)', () => {
  describe('en — wording matches the pre-migration literals byte-for-byte', () => {
    it('renders the heading and description from the dictionary', () => {
      render(<ReviewPage />);

      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Review');
      expect(screen.getByText('Worktrees that need your attention.')).toBeInTheDocument();
    });

    it('renders all three tab labels', () => {
      render(<ReviewPage />);

      expect(screen.getByTestId('page-tab-review')).toHaveTextContent('Review');
      expect(screen.getByTestId('page-tab-report')).toHaveTextContent('Report');
      expect(screen.getByTestId('page-tab-template')).toHaveTextContent('Template');
    });
  });

  describe('ja — copy is translated, not pinned to English', () => {
    beforeEach(() => {
      locale.current = 'ja';
    });

    it('translates the heading and description', () => {
      render(<ReviewPage />);

      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('レビュー');
      expect(screen.queryByText('Worktrees that need your attention.')).toBeNull();
    });

    it('translates the tab labels', () => {
      render(<ReviewPage />);

      expect(screen.getByTestId('page-tab-review')).toHaveTextContent('レビュー');
      expect(screen.getByTestId('page-tab-report')).toHaveTextContent('レポート');
      expect(screen.getByTestId('page-tab-template')).toHaveTextContent('テンプレート');
    });
  });
});
