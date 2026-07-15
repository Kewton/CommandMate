/**
 * @vitest-environment jsdom
 *
 * Issue #1199: Home page wiring.
 *
 * Home had no page-level test, so nothing pinned the checklist's placement or
 * the promise that it costs no extra request. Both are asserted here.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const mockRefresh = vi.fn();
let mockWorktrees: unknown[] = [];
let mockRepositories: unknown[] = [];
let mockIsLoading = false;
let mockError: Error | null = null;

vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useWorktreesCacheContext: () => ({
    worktrees: mockWorktrees,
    repositories: mockRepositories,
    isLoading: mockIsLoading,
    error: mockError,
    refresh: mockRefresh,
  }),
}));

vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: React.ComponentProps<'a'>) => (
    <a href={href as string} {...rest}>
      {children}
    </a>
  ),
}));

// TodoWidget owns its own fetches; they are not what this file is about.
vi.mock('@/components/home/TodoWidget', () => ({
  TodoWidget: () => <div data-testid="todo-widget" />,
}));

const listSpy = vi.fn();
vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    repositoryApi: { list: listSpy },
  };
});

import Home from '@/app/page';

const REPO = { path: '/repo', name: 'repo', worktreeCount: 1, visible: true, enabled: true };
const WORKTREE = { id: 'wt-1', name: 'main', path: '/repo', repositoryPath: '/repo', repositoryName: 'repo' };

beforeEach(() => {
  localStorage.clear();
  mockWorktrees = [];
  mockRepositories = [];
  mockIsLoading = false;
  mockError = null;
  listSpy.mockClear();
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no fetch expected'))));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Home page — onboarding wiring (Issue #1199)', () => {
  it('renders the checklist above the bento grid for a new user', () => {
    render(<Home />);

    const checklist = screen.getByTestId('onboarding-checklist');
    const grid = screen.getByTestId('home-bento-grid');
    // Node.compareDocumentPosition: 4 === grid follows checklist.
    expect(checklist.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('hides the checklist for a user who already sent a message', () => {
    mockWorktrees = [{ ...WORKTREE, lastUserMessageAt: '2026-07-15T10:00:00.000Z' }];
    mockRepositories = [REPO];

    render(<Home />);

    expect(screen.queryByTestId('onboarding-checklist')).toBeNull();
    expect(screen.getByTestId('home-bento-grid')).toBeInTheDocument();
  });

  it('passes repositories through, so step 1 reflects the cache', () => {
    mockWorktrees = [WORKTREE];
    mockRepositories = [REPO];

    render(<Home />);

    expect(screen.getByTestId('onboarding-step-registerRepository')).toHaveAttribute(
      'data-complete',
      'true'
    );
  });

  it('costs no extra request — the cache already carries repositories', () => {
    render(<Home />);

    expect(listSpy).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('hides the checklist while the cache is doing its first load', () => {
    mockIsLoading = true;

    render(<Home />);

    expect(screen.queryByTestId('onboarding-checklist')).toBeNull();
  });

  it('hides the checklist when the worktrees fetch failed', () => {
    mockError = new Error('boom');

    render(<Home />);

    expect(screen.queryByTestId('onboarding-checklist')).toBeNull();
  });
});
