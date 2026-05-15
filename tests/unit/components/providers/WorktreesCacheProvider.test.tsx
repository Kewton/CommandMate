/**
 * Tests for WorktreesCacheProvider Context API.
 *
 * Issue #709: Eliminate duplicate `useWorktreesCache` instances by exposing
 * the cache via React Context. The Sessions page (and any future consumer)
 * must consume the cache through `useWorktreesCacheContext()` instead of
 * calling `useWorktreesCache()` directly, ensuring a single polling source.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import type { Worktree } from '@/types/models';
import type { RepositorySummary } from '@/lib/api-client';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/**
 * Stable mock object returned by useWorktreesCache. Tests mutate the fields
 * on this object so the Provider receives the latest values on each render.
 */
const mockRefresh = vi.fn().mockResolvedValue(undefined);
const mockCacheState: {
  worktrees: Worktree[];
  repositories: RepositorySummary[];
  isLoading: boolean;
  error: Error | null;
  refresh: typeof mockRefresh;
} = {
  worktrees: [],
  repositories: [],
  isLoading: false,
  error: null,
  refresh: mockRefresh,
};

vi.mock('@/hooks/useWorktreesCache', () => ({
  useWorktreesCache: () => mockCacheState,
}));

// Avoid pulling the full WorktreeSelectionProvider chain into the test —
// it is exercised by its own suite. The provider just needs to render
// children.
vi.mock('@/contexts/WorktreeSelectionContext', () => ({
  WorktreeSelectionProvider: ({ children }: { children: React.ReactNode }) =>
    React.createElement(
      'div',
      { 'data-testid': 'worktree-selection-provider' },
      children
    ),
}));

// Import after mocks are registered.
import {
  WorktreesCacheProvider,
  useWorktreesCacheContext,
} from '@/components/providers/WorktreesCacheProvider';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    name: 'feature/test',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
    ...overrides,
  } as Worktree;
}

function makeRepository(overrides: Partial<RepositorySummary> = {}): RepositorySummary {
  return {
    id: 'repo-1',
    path: '/path/to/repo',
    name: 'MyRepo',
    worktreeCount: 1,
    visible: true,
    enabled: true,
    ...overrides,
  };
}

/** Consumer that surfaces the context values via data-testids. */
function ContextConsumer() {
  const ctx = useWorktreesCacheContext();
  return (
    <div>
      <span data-testid="cache-worktree-count">{ctx.worktrees.length}</span>
      <span data-testid="cache-repository-count">{ctx.repositories.length}</span>
      <span data-testid="cache-is-loading">{String(ctx.isLoading)}</span>
      <span data-testid="cache-error">{ctx.error ? ctx.error.message : 'null'}</span>
      <button
        type="button"
        data-testid="cache-refresh"
        onClick={() => {
          void ctx.refresh();
        }}
      >
        refresh
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorktreesCacheProvider', () => {
  beforeEach(() => {
    mockCacheState.worktrees = [];
    mockCacheState.repositories = [];
    mockCacheState.isLoading = false;
    mockCacheState.error = null;
    mockCacheState.refresh = mockRefresh;
    mockRefresh.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes the cached worktrees / repositories / isLoading / error / refresh via context', () => {
    mockCacheState.worktrees = [
      makeWorktree({ id: 'wt-a' }),
      makeWorktree({ id: 'wt-b', name: 'feature/b' }),
    ];
    mockCacheState.repositories = [makeRepository({ id: 'repo-a' })];
    mockCacheState.isLoading = false;
    mockCacheState.error = null;

    render(
      <WorktreesCacheProvider>
        <ContextConsumer />
      </WorktreesCacheProvider>
    );

    expect(screen.getByTestId('cache-worktree-count').textContent).toBe('2');
    expect(screen.getByTestId('cache-repository-count').textContent).toBe('1');
    expect(screen.getByTestId('cache-is-loading').textContent).toBe('false');
    expect(screen.getByTestId('cache-error').textContent).toBe('null');
  });

  it('propagates loading state from useWorktreesCache', () => {
    mockCacheState.isLoading = true;

    render(
      <WorktreesCacheProvider>
        <ContextConsumer />
      </WorktreesCacheProvider>
    );

    expect(screen.getByTestId('cache-is-loading').textContent).toBe('true');
  });

  it('propagates error state from useWorktreesCache', () => {
    mockCacheState.error = new Error('boom');

    render(
      <WorktreesCacheProvider>
        <ContextConsumer />
      </WorktreesCacheProvider>
    );

    expect(screen.getByTestId('cache-error').textContent).toBe('boom');
  });

  it('forwards refresh() invocations from consumers to the underlying hook', () => {
    render(
      <WorktreesCacheProvider>
        <ContextConsumer />
      </WorktreesCacheProvider>
    );

    screen.getByTestId('cache-refresh').click();

    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('throws a descriptive error when useWorktreesCacheContext is called outside the Provider', () => {
    // Silence the expected React error boundary console output for this case.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => render(<ContextConsumer />)).toThrowError(
      /useWorktreesCacheContext must be used within a WorktreesCacheProvider/
    );

    errorSpy.mockRestore();
  });
});
