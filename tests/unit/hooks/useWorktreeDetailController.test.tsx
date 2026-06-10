/**
 * Unit tests for useWorktreeDetailController cache-priming (Issue #839).
 *
 * Verifies the stale-while-revalidate behavior that eliminates the
 * "Loading worktree info..." flash:
 *  - cache hit  -> `worktree` is seeded from the list cache and `loading`
 *                  starts false (screen renders immediately, no flash)
 *  - cache miss -> `worktree` stays null and `loading` starts true
 *                  (previous loading-first behavior preserved, no regression)
 *  - background fetch overwrites the seeded value with the fresh detail payload
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { Worktree } from '@/types/models';
import type { UseWorktreesCacheReturn } from '@/hooks/useWorktreesCache';

// ---------------------------------------------------------------------------
// Mocks for provider-dependent hooks so the controller can run under
// renderHook without the full app provider tree. next-intl is mocked globally
// in tests/setup.ts.
// ---------------------------------------------------------------------------

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-1',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
  MOBILE_BREAKPOINT: 768,
}));

vi.mock('@/contexts/SidebarContext', () => ({
  useSidebarContext: () => ({
    isOpen: true,
    width: 288,
    isMobileDrawerOpen: false,
    toggle: vi.fn(),
    setWidth: vi.fn(),
    openMobileDrawer: vi.fn(),
    closeMobileDrawer: vi.fn(),
  }),
}));

vi.mock('@/hooks/useUpdateCheck', () => ({
  useUpdateCheck: () => ({ data: null, loading: false, error: null }),
}));

// Controllable cache context: each test assigns the desired snapshot (or null).
const mockCache: { current: UseWorktreesCacheReturn | null } = { current: null };
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => mockCache.current,
}));

import { useWorktreeDetailController } from '@/hooks/useWorktreeDetailController';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    name: 'feature/cached',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
    ...overrides,
  } as Worktree;
}

function makeCache(worktrees: Worktree[]): UseWorktreesCacheReturn {
  return {
    worktrees,
    repositories: [],
    isLoading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  };
}

const mockFetch = vi.fn();

/** Build a fetch implementation whose detail endpoint returns `detail`. */
function fetchReturning(detail: Worktree) {
  return (url: string) => {
    if (url.includes('/messages')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    if (url.includes('/current-output')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ isRunning: false }),
      });
    }
    if (url.includes('/api/worktrees/')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(detail) });
    }
    return Promise.resolve({ ok: false, status: 404 });
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useWorktreeDetailController — cache priming (Issue #839)', () => {
  beforeEach(() => {
    mockCache.current = null;
    mockFetch.mockReset();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('cache hit: seeds worktree from cache and starts with loading=false (no flash)', () => {
    const cached = makeWorktree({ id: 'wt-1', name: 'feature/cached' });
    mockCache.current = makeCache([cached]);
    // Detail fetch never resolves during this synchronous assertion window.
    mockFetch.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() =>
      useWorktreeDetailController({ worktreeId: 'wt-1' })
    );

    // Seeded synchronously from cache — the detail screen has real data to show
    // immediately, so neither the full-screen loader nor "Loading worktree
    // info..." (gated on !worktree) ever appears.
    expect(result.current.worktree).toEqual(cached);
    expect(result.current.loading).toBe(false);
  });

  it('cache miss (worktree not in cached list): worktree=null, loading=true', () => {
    mockCache.current = makeCache([makeWorktree({ id: 'other' })]);
    mockFetch.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() =>
      useWorktreeDetailController({ worktreeId: 'wt-1' })
    );

    expect(result.current.worktree).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it('no provider (cache=null): falls back to cache-miss path', () => {
    mockCache.current = null;
    mockFetch.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() =>
      useWorktreeDetailController({ worktreeId: 'wt-1' })
    );

    expect(result.current.worktree).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it('background fetch overwrites the cached value with fresh detail data', async () => {
    const cached = makeWorktree({ id: 'wt-1', name: 'feature/cached' });
    const fresh = makeWorktree({ id: 'wt-1', name: 'feature/fresh', description: 'full' });
    mockCache.current = makeCache([cached]);
    mockFetch.mockImplementation(fetchReturning(fresh));

    const { result } = renderHook(() =>
      useWorktreeDetailController({ worktreeId: 'wt-1' })
    );

    // Initially the cached (stale) value.
    expect(result.current.worktree?.name).toBe('feature/cached');

    // After the background revalidation resolves, fresh > cached.
    await waitFor(() => {
      expect(result.current.worktree?.name).toBe('feature/fresh');
    });
    expect(result.current.worktree?.description).toBe('full');
    expect(result.current.loading).toBe(false);
  });
});
