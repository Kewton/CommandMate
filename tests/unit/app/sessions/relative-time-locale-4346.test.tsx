/**
 * Issue #4346 (3): /sessions relative time follows the UI locale.
 * `ja` used to show the English compact form ("8m ago").
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

let mockWorktrees: Array<Record<string, unknown>> = [];

vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useWorktreesCacheContext: () => ({
    worktrees: mockWorktrees,
    repositories: [],
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

import SessionsPage from '@/app/sessions/page';

const NOW = new Date('2026-11-13T12:00:00Z');

function worktreeSentAgo(ms: number) {
  return {
    id: 'wt-1',
    name: 'feature/test',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
    selectedAgents: ['claude'],
    lastUserMessage: 'hello',
    lastUserMessageAt: new Date(NOW.getTime() - ms).toISOString(),
  };
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('Sessions relative time locale (Issue #4346)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    locale.current = 'en';
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const cases: Array<[string, number, string, string]> = [
    ['now', 10_000, 'now', 'たった今'],
    ['minutes', 8 * MIN, '8m ago', '8分前'],
    ['hours', 5 * HOUR, '5h ago', '5時間前'],
    ['days', 3 * DAY, '3d ago', '3日前'],
    ['weeks', 14 * DAY, '2w ago', '2週間前'],
    ['months', 60 * DAY, '2mo ago', '2か月前'],
    ['years', 800 * DAY, '2y ago', '2年前'],
  ];

  it.each(cases)('ja %s is Japanese', (_n, ms, _en, ja) => {
    locale.current = 'ja';
    mockWorktrees = [worktreeSentAgo(ms)];
    render(<SessionsPage />);
    expect(screen.getByTestId('session-time-wt-1')).toHaveTextContent(ja);
  });

  it.each(cases)('en %s keeps the English compact form (negative control)', (_n, ms, en) => {
    mockWorktrees = [worktreeSentAgo(ms)];
    render(<SessionsPage />);
    expect(screen.getByTestId('session-time-wt-1').textContent).toBe(en);
  });
});
