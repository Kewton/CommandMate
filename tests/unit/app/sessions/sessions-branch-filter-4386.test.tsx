/**
 * /sessions branch filter (Issue #4386).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
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

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false, MOBILE_BREAKPOINT: 768 }));

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


const row = (id: string, name: string, current?: string) => ({
  id, name, path: `/tmp/${id}`, repositoryPath: '/tmp/repo', repositoryName: 'Repo',
  selectedAgents: ['claude'], sessionStatusByCli: {},
  ...(current ? { gitStatus: { currentBranch: current } } : {}),
});

beforeEach(() => {
  mockWorktrees = [row('1', 'feature/1-a'), row('2', 'main'), row('3', 'other', 'feature/3-c')];
});
afterEach(() => cleanup());

function open() {
  render(<SessionsPage />);
  fireEvent.click(screen.getByTestId('sessions-filter-button'));
  return screen.getByTestId('sessions-branch-filter');
}

describe('[#4386] /sessions branch filter', () => {
  it('keeps only matching worktrees and shows the count', () => {
    const input = open();
    fireEvent.change(input, { target: { value: '^feature/' } });
    expect(screen.getByTestId('sessions-filter-count')).toHaveTextContent('1');
    expect(screen.queryByText('main')).toBeNull();
    expect(screen.getByText('feature/1-a')).toBeTruthy();
  });
  it('invalid regex keeps all and shows the error', () => {
    const input = open();
    fireEvent.change(input, { target: { value: '(' } });
    expect(screen.getByTestId('sessions-branch-filter-error')).toBeTruthy();
    expect(screen.getByText('main')).toBeTruthy();
    expect(screen.queryByTestId('sessions-filter-count')).toBeNull();
  });
  it('combines with the text filter', () => {
    const input = open();
    fireEvent.change(input, { target: { value: '^feature/' } });
    fireEvent.change(screen.getByTestId('sessions-filter'), { target: { value: '1-a' } });
    expect(screen.getByText('feature/1-a')).toBeTruthy();
    expect(screen.queryByText('other')).toBeNull();
  });
  it('clear restores everything', () => {
    const input = open();
    fireEvent.change(input, { target: { value: '^feature/' } });
    fireEvent.click(screen.getByTestId('sessions-filter-clear'));
    expect(screen.getByText('main')).toBeTruthy();
    expect(screen.queryByTestId('sessions-filter-count')).toBeNull();
  });
});
