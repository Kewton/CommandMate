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

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => true, MOBILE_BREAKPOINT: 768 }));

const mockRefresh = vi.fn();
let mockWorktrees: Array<Record<string, unknown>> = [];
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useWorktreesCacheContext: () => ({
    worktrees: mockWorktrees,
    repositories: [],
    isLoading: false,
    error: null,
    refresh: mockRefresh,
  }),
}));

import SessionsPage from '@/app/sessions/page';



beforeEach(() => {
  mockRefresh.mockClear();
  mockWorktrees = [
    { id: '1', name: 'feature/1-a', path: '/tmp/1', repositoryPath: '/tmp/r', repositoryName: 'R', selectedAgents: ['claude'], sessionStatusByCli: {} },
  ];
});
afterEach(() => cleanup());

describe('[#4386] mobile filter sheet vs pull-to-refresh', () => {
  it('is drawn outside the pull-to-refresh gesture area', () => {
    render(<SessionsPage />);
    fireEvent.click(screen.getByTestId('sessions-filter-button'));
    const sheet = screen.getByTestId('sessions-filter-sheet');
    expect(sheet.closest('[data-testid="pull-to-refresh"]')).toBeNull();
    expect(sheet.parentElement).toBe(document.body);
  });

  it('a downward drag inside the sheet does not start a refresh', () => {
    render(<SessionsPage />);
    fireEvent.click(screen.getByTestId('sessions-filter-button'));
    const sheet = screen.getByTestId('sessions-filter-sheet');
    fireEvent.touchStart(sheet, { touches: [{ clientY: 0 }] });
    fireEvent.touchMove(sheet, { touches: [{ clientY: 300 }] });
    fireEvent.touchEnd(sheet);
    expect(mockRefresh).not.toHaveBeenCalled();
    const content = screen.getByTestId('pull-to-refresh').firstElementChild?.nextElementSibling as HTMLElement;
    expect(content.style.transform).toBe('');
  });
});
