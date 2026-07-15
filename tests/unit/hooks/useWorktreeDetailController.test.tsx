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
import { renderHook, waitFor, act } from '@testing-library/react';
import type { Worktree } from '@/types/models';
import type { SessionKillTarget } from '@/types/terminal-split-pane';
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

// ---------------------------------------------------------------------------
// Issue #1171: target-snapshot kill-session flow.
// ---------------------------------------------------------------------------

/** JSON response shaped for both raw fetch and the api-client fetchApi wrapper. */
function apiResponse(status: number, body: unknown) {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    redirected: false,
    url: '',
    headers: {
      get: (h: string) =>
        String(h).toLowerCase() === 'content-type' ? 'application/json' : null,
    },
    json: async () => body,
  };
}

/** Controller fetch mock: routes every endpoint the controller touches. */
function makeControllerFetch(
  opts: { killStatus?: number; onKill?: (url: string) => void; detail?: Worktree } = {},
) {
  const { killStatus = 200, onKill, detail = makeWorktree() } = opts;
  return (url: string) => {
    if (typeof url === 'string' && url.includes('/kill-session')) {
      onKill?.(url);
      const ok = killStatus >= 200 && killStatus < 300;
      return Promise.resolve(apiResponse(killStatus, ok ? { success: true, message: 'ok' } : { error: 'boom' }));
    }
    if (typeof url === 'string' && url.includes('/messages')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    if (typeof url === 'string' && url.includes('/current-output')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ isRunning: false }) });
    }
    if (typeof url === 'string' && url.includes('/auto-yes')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ instances: {} }) });
    }
    if (typeof url === 'string' && url.includes('/api/worktrees/')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(detail) });
    }
    return Promise.resolve({ ok: false, status: 404 });
  };
}

const SNAPSHOT: SessionKillTarget = { cliToolId: 'codex', instanceId: 'codex-2', label: 'Review agent' };

describe('useWorktreeDetailController — kill session (Issue #1171)', () => {
  beforeEach(() => {
    mockCache.current = makeCache([makeWorktree()]);
    mockFetch.mockReset();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts with no kill target and not pending', () => {
    mockFetch.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useWorktreeDetailController({ worktreeId: 'wt-1' }));
    expect(result.current.killTarget).toBeNull();
    expect(result.current.isKillPending).toBe(false);
  });

  it('openKillConfirm snapshots the target; it survives active-instance changes', () => {
    mockFetch.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useWorktreeDetailController({ worktreeId: 'wt-1' }));
    act(() => result.current.openKillConfirm(SNAPSHOT));
    expect(result.current.killTarget).toEqual(SNAPSHOT);
    // Changing the active instance must NOT re-derive / mutate the snapshot.
    act(() => result.current.setActiveInstanceId('claude'));
    expect(result.current.killTarget).toEqual(SNAPSHOT);
  });

  it('openActiveKillConfirm snapshots the active instance as the target', () => {
    mockFetch.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useWorktreeDetailController({ worktreeId: 'wt-1' }));
    act(() => result.current.openActiveKillConfirm());
    expect(result.current.killTarget).toEqual({
      cliToolId: result.current.activeCliTab,
      instanceId: result.current.activeInstanceId,
      label: expect.any(String),
    });
  });

  it('handleKillConfirm POSTs a kill scoped to the target and clears it on success', async () => {
    const killUrls: string[] = [];
    mockFetch.mockImplementation(makeControllerFetch({ onKill: (u) => killUrls.push(u) }));
    const { result } = renderHook(() => useWorktreeDetailController({ worktreeId: 'wt-1' }));
    act(() => result.current.openKillConfirm(SNAPSHOT));
    await act(async () => { await result.current.handleKillConfirm(); });

    expect(killUrls.length).toBe(1);
    const u = new URL(killUrls[0], 'http://localhost');
    expect(u.searchParams.get('cliTool')).toBe('codex');
    expect(u.searchParams.get('instance')).toBe('codex-2');
    expect(result.current.killTarget).toBeNull();
    expect(result.current.isKillPending).toBe(false);
  });

  it('does not double-submit while a kill POST is in flight', async () => {
    const killUrls: string[] = [];
    let resolveKill: (() => void) | undefined;
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/kill-session')) {
        killUrls.push(url);
        return new Promise((res) => {
          resolveKill = () => res(apiResponse(200, { success: true, message: 'ok' }));
        });
      }
      if (typeof url === 'string' && url.includes('/api/worktrees/')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(makeWorktree()) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
    const { result } = renderHook(() => useWorktreeDetailController({ worktreeId: 'wt-1' }));
    act(() => result.current.openKillConfirm(SNAPSHOT));

    // Two rapid confirms in the same tick — only the first must POST.
    await act(async () => {
      void result.current.handleKillConfirm();
      void result.current.handleKillConfirm();
      await Promise.resolve();
    });
    expect(killUrls.length).toBe(1);
    expect(result.current.isKillPending).toBe(true);

    await act(async () => { resolveKill?.(); await Promise.resolve(); });
    await waitFor(() => expect(result.current.killTarget).toBeNull());
    expect(result.current.isKillPending).toBe(false);
  });

  it('keeps the target on a non-2xx failure so the user can retry', async () => {
    mockFetch.mockImplementation(makeControllerFetch({ killStatus: 500 }));
    const { result } = renderHook(() => useWorktreeDetailController({ worktreeId: 'wt-1' }));
    act(() => result.current.openKillConfirm(SNAPSHOT));
    await act(async () => { await result.current.handleKillConfirm(); });
    // Target retained; not stuck pending.
    expect(result.current.killTarget).toEqual(SNAPSHOT);
    expect(result.current.isKillPending).toBe(false);
  });

  it('treats a 404 (session already ended) as achieved and clears the target', async () => {
    mockFetch.mockImplementation(makeControllerFetch({ killStatus: 404 }));
    const { result } = renderHook(() => useWorktreeDetailController({ worktreeId: 'wt-1' }));
    act(() => result.current.openKillConfirm(SNAPSHOT));
    await act(async () => { await result.current.handleKillConfirm(); });
    expect(result.current.killTarget).toBeNull();
    expect(result.current.isKillPending).toBe(false);
  });

  it('handleKillCancel clears the target', () => {
    mockFetch.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useWorktreeDetailController({ worktreeId: 'wt-1' }));
    act(() => result.current.openKillConfirm(SNAPSHOT));
    expect(result.current.killTarget).toEqual(SNAPSHOT);
    act(() => result.current.handleKillCancel());
    expect(result.current.killTarget).toBeNull();
  });

  it('handleKillCancel is a no-op while a kill POST is in flight (keeps target)', async () => {
    let resolveKill: (() => void) | undefined;
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/kill-session')) {
        return new Promise((res) => {
          resolveKill = () => res(apiResponse(200, { success: true, message: 'ok' }));
        });
      }
      if (typeof url === 'string' && url.includes('/api/worktrees/')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(makeWorktree()) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
    const { result } = renderHook(() => useWorktreeDetailController({ worktreeId: 'wt-1' }));
    act(() => result.current.openKillConfirm(SNAPSHOT));
    act(() => { void result.current.handleKillConfirm(); });
    expect(result.current.isKillPending).toBe(true);

    // Cancel while pending must NOT discard the target.
    act(() => result.current.handleKillCancel());
    expect(result.current.killTarget).toEqual(SNAPSHOT);

    await act(async () => { resolveKill?.(); await Promise.resolve(); });
    await waitFor(() => expect(result.current.killTarget).toBeNull());
  });
});
