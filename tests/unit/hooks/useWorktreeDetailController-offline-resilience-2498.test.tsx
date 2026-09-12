/**
 * The detail screen survives a phone losing signal (Issue #2498).
 *
 * Before this Issue every failure `fetchWorktree()` saw was the same failure:
 * `setError(message)`, which swapped the whole screen for `ErrorDisplay` and —
 * because the poll effect was gated on `if (loading || error) return` — stopped
 * the only loop that could have noticed the signal coming back. One dropped
 * tick in a tunnel was therefore permanent, and the composer draft went with
 * the unmounted tree.
 *
 * These tests pin the three verdicts that replaced that one:
 *  - a poll that fails while a worktree is on screen is *stale*, not broken;
 *  - a FIRST load that produced nothing is still an error with a Retry button,
 *    but now also retries itself on a bounded ladder;
 *  - a session that expired is a *re-login*, never the SyntaxError from
 *    parsing the /login HTML.
 *
 * The poll is driven with fake timers rather than stubbed, because "the loop
 * kept running" is the fix — a test that called the fetcher directly would pass
 * against the very code this Issue removed.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Worktree } from '@/types/models';
import type { UseWorktreesCacheReturn } from '@/hooks/useWorktreesCache';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-2498',
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

const mockCache: { current: UseWorktreesCacheReturn | null } = { current: null };
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => mockCache.current,
}));

import {
  useWorktreeDetailController,
  DETAIL_LOAD_RETRY_DELAYS_MS,
  STALE_BANNER_FAILURE_THRESHOLD,
} from '@/hooks/useWorktreeDetailController';

const WORKTREE_ID = 'wt-2498';

/** Idle cadence of the detail poll (no CLI reported as running below). */
const IDLE_POLL_MS = 5000;

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: WORKTREE_ID,
    name: 'feature/2498',
    path: '/tmp/wt',
    repositoryPath: '/tmp/repo',
    repositoryName: 'CommandMate',
    ...overrides,
  } as Worktree;
}

/** A JSON response shaped like the real one (headers included, not redirected). */
function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    url: `http://localhost/api/worktrees/${WORKTREE_ID}`,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: () => Promise.resolve(body),
  };
}

/**
 * The /login page the auth middleware's 307 lands on: status 200, HTML body,
 * `redirected: true`. `json()` rejects exactly the way the real one does — the
 * "Unexpected token" the user used to be shown.
 */
function loginRedirectResponse() {
  return {
    ok: true,
    status: 200,
    redirected: true,
    url: 'http://localhost/login',
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'text/html' : null) },
    json: () => Promise.reject(new SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON")),
  };
}

/** Router state for the fetch stub: healthy, offline, or unauthenticated. */
type Mode = 'ok' | 'offline' | 'login-redirect' | 'unauthorized';

const mockFetch = vi.fn();
let mode: Mode = 'ok';
let detail: Worktree = makeWorktree();

function installFetch(): void {
  mockFetch.mockImplementation((url: string) => {
    if (mode === 'offline') {
      // What a phone with no signal actually produces.
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    if (typeof url === 'string' && url.includes(`/api/worktrees/${WORKTREE_ID}`) && !url.includes('/messages')
        && !url.includes('/current-output') && !url.includes('/auto-yes')) {
      if (mode === 'login-redirect') return Promise.resolve(loginRedirectResponse());
      if (mode === 'unauthorized') return Promise.resolve(jsonResponse({ error: 'Unauthorized' }, 401));
      return Promise.resolve(jsonResponse(detail));
    }
    if (typeof url === 'string' && url.includes('/messages')) {
      return Promise.resolve(jsonResponse([]));
    }
    if (typeof url === 'string' && url.includes('/current-output')) {
      return Promise.resolve(jsonResponse({ isRunning: false }));
    }
    if (typeof url === 'string' && url.includes('/auto-yes')) {
      return Promise.resolve(jsonResponse({ instances: {} }));
    }
    return Promise.resolve(jsonResponse({}, 404));
  });
}

/** Advance timers AND drain the promise chain each fired timer starts. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Let the mount-time load settle without moving the clock past a poll tick. */
async function settle(): Promise<void> {
  await advance(0);
}

function renderController() {
  return renderHook(() => useWorktreeDetailController({ worktreeId: WORKTREE_ID }));
}

beforeEach(() => {
  vi.useFakeTimers();
  mockCache.current = null;
  mode = 'ok';
  detail = makeWorktree();
  mockFetch.mockReset();
  installFetch();
  global.fetch = mockFetch as unknown as typeof fetch;
  window.localStorage.clear();
  // The failure paths log; the assertions are on state, not on the console.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// A poll that fails while the screen already holds a worktree
// ---------------------------------------------------------------------------

describe('[#2498] a failing poll leaves the loaded screen standing', () => {
  it('does not raise `error` — the screen is stale, not broken', async () => {
    const { result } = renderController();
    await settle();
    expect(result.current.worktree?.name).toBe('feature/2498');

    mode = 'offline';
    await advance(IDLE_POLL_MS);

    // The pre-#2498 behavior was `setError(err.message)` here, which is what
    // swapped the whole screen for ErrorDisplay.
    expect(result.current.error).toBeNull();
    // And the worktree the screen renders from is untouched.
    expect(result.current.worktree?.name).toBe('feature/2498');
  });

  it('stays quiet for a blip and only announces after N consecutive failures', async () => {
    const { result } = renderController();
    await settle();

    mode = 'offline';
    for (let i = 1; i < STALE_BANNER_FAILURE_THRESHOLD; i++) {
      await advance(IDLE_POLL_MS);
      expect(result.current.isReconnecting).toBe(false);
    }

    await advance(IDLE_POLL_MS);
    expect(result.current.isReconnecting).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('recovers with no user action once the signal returns', async () => {
    const { result } = renderController();
    await settle();

    mode = 'offline';
    await advance(IDLE_POLL_MS * STALE_BANNER_FAILURE_THRESHOLD);
    expect(result.current.isReconnecting).toBe(true);

    // Nothing is pressed. The poll was never stopped, so the next tick after
    // the network returns is the whole recovery.
    mode = 'ok';
    detail = makeWorktree({ name: 'feature/2498-updated' });
    await advance(IDLE_POLL_MS);

    expect(result.current.isReconnecting).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.worktree?.name).toBe('feature/2498-updated');
  });

  it('keeps counting from zero after a success, so two isolated blips never add up', async () => {
    const { result } = renderController();
    await settle();

    mode = 'offline';
    await advance(IDLE_POLL_MS * 2);
    mode = 'ok';
    await advance(IDLE_POLL_MS);
    mode = 'offline';
    await advance(IDLE_POLL_MS * 2);

    // Four failures in total, but never three in a row.
    expect(result.current.isReconnecting).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A first load that produced nothing
// ---------------------------------------------------------------------------

describe('[#2498] a failed FIRST load still shows the error card', () => {
  it('raises `error` when there is no worktree to fall back on', async () => {
    mode = 'offline';
    const { result } = renderController();
    await settle();

    expect(result.current.worktree).toBeNull();
    expect(result.current.error).not.toBeNull();
    expect(result.current.loading).toBe(false);
    expect(typeof result.current.handleRetry).toBe('function');
  });

  it('retries itself on the backoff ladder before the poll would come round', async () => {
    mode = 'offline';
    const { result } = renderController();
    await settle();
    expect(result.current.error).not.toBeNull();

    mode = 'ok';
    // The first rung (2s) lands well before the 5s poll tick, so a screen
    // opened during a blip comes back without the user finding the button.
    await advance(DETAIL_LOAD_RETRY_DELAYS_MS[0]);

    expect(result.current.error).toBeNull();
    expect(result.current.worktree?.name).toBe('feature/2498');
  });

  it('keeps polling through the error, so recovery outlives the ladder', async () => {
    mode = 'offline';
    const { result } = renderController();
    await settle();

    // Burn well past the whole ladder (2s + 5s + 10s) while still offline:
    // every rung is spent and no retry timer is left armed.
    await advance(20_000);
    expect(result.current.error).not.toBeNull();

    mode = 'ok';
    await advance(IDLE_POLL_MS);

    // Only the poll effect can have done this — the pre-#2498 `if (loading ||
    // error) return` had stopped it at the first failure.
    expect(result.current.error).toBeNull();
    expect(result.current.worktree?.name).toBe('feature/2498');
  });
});

// ---------------------------------------------------------------------------
// An expired session
// ---------------------------------------------------------------------------

describe('[#2498] an expired session is a re-login, not an error', () => {
  it('routes the /login redirect to the re-login branch instead of a parse failure', async () => {
    mode = 'login-redirect';
    const { result } = renderController();
    await settle();

    expect(result.current.isAuthExpired).toBe(true);
    // The SyntaxError from `response.json()` on the /login HTML never surfaces.
    expect(result.current.error).toBeNull();
    expect(typeof result.current.handleReLogin).toBe('function');
  });

  it('treats a bare 401 the same way', async () => {
    mode = 'unauthorized';
    const { result } = renderController();
    await settle();

    expect(result.current.isAuthExpired).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.isReconnecting).toBe(false);
  });

  it('clears itself when the user logs back in elsewhere', async () => {
    mode = 'unauthorized';
    const { result } = renderController();
    await settle();
    expect(result.current.isAuthExpired).toBe(true);

    mode = 'ok';
    await advance(IDLE_POLL_MS);

    expect(result.current.isAuthExpired).toBe(false);
    expect(result.current.worktree?.name).toBe('feature/2498');
  });
});
