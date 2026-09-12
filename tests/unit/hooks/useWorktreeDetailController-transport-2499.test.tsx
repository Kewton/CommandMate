/**
 * The detail screen's polls get a deadline, and #2498's counter keeps its
 * meaning (Issue #2499).
 *
 * #2498 taught this hook to survive a *failing* poll: three consecutive
 * failures raise the stale banner, and the loop keeps running so recovery needs
 * no user action. But every one of its tests fails the poll by rejecting, and a
 * request that rejects was never the hard case. The hard case is the one this
 * Issue is named for — a request that neither resolves nor rejects, which
 * `fetch()` will wait on forever. Against that, #2498's machinery was inert:
 * the counter never incremented, the banner never appeared, and the screen sat
 * silently stale with nothing to show it.
 *
 * These tests pin the join between the two Issues:
 *  - a hung poll now *fails*, on the clock, which is what makes #2498's
 *    counter reachable at all;
 *  - one poll is still exactly one request, because the counter counts polls
 *    and a transport-level retry ladder underneath it would make three failures
 *    mean nine requests and most of a minute.
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
  usePathname: () => '/worktrees/wt-2499',
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
  STALE_BANNER_FAILURE_THRESHOLD,
} from '@/hooks/useWorktreeDetailController';
import { API_POLL_TIMEOUT_MS } from '@/config/api-timeout-config';
import { __resetApiReachabilityReporting } from '@/lib/api-client';

const WORKTREE_ID = 'wt-2499';

/** Idle cadence of the detail poll (no CLI reported as running below). */
const IDLE_POLL_MS = 5000;

/** The detail endpoint, as distinct from the three sibling polls. */
const DETAIL_URL = `/api/worktrees/${WORKTREE_ID}`;

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: WORKTREE_ID,
    name: 'feature/2499',
    path: '/tmp/wt',
    repositoryPath: '/tmp/repo',
    repositoryName: 'CommandMate',
    ...overrides,
  } as Worktree;
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    url: `http://localhost${DETAIL_URL}`,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: () => Promise.resolve(body),
  };
}

/** How the polls behave: answer, hang forever, or reject at the transport. */
type Mode = 'ok' | 'hang' | 'reject';

const mockFetch = vi.fn();
let mode: Mode = 'ok';

function installFetch(): void {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (mode === 'reject') return Promise.reject(new TypeError('Failed to fetch'));
    if (mode === 'hang') {
      // A connection that is nominally open and moving no bytes. It settles
      // only when something aborts it — which before this Issue was nothing.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }
    if (typeof url === 'string' && url.includes('/messages')) return Promise.resolve(jsonResponse([]));
    if (typeof url === 'string' && url.includes('/current-output')) {
      return Promise.resolve(jsonResponse({ isRunning: false }));
    }
    if (typeof url === 'string' && url.includes('/auto-yes')) {
      return Promise.resolve(jsonResponse({ instances: {} }));
    }
    return Promise.resolve(jsonResponse(makeWorktree()));
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Let the mount-time load settle without moving the clock past a poll tick. */
async function settle(): Promise<void> {
  await advance(0);
}

function detailCalls(): unknown[][] {
  return mockFetch.mock.calls.filter(
    (call) => typeof call[0] === 'string' && (call[0] as string).endsWith(DETAIL_URL),
  );
}

function renderController() {
  return renderHook(() => useWorktreeDetailController({ worktreeId: WORKTREE_ID }));
}

beforeEach(() => {
  vi.useFakeTimers();
  mockCache.current = null;
  mode = 'ok';
  mockFetch.mockReset();
  installFetch();
  global.fetch = mockFetch as unknown as typeof fetch;
  window.localStorage.clear();
  __resetApiReachabilityReporting();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('[#2499] the detail polls go through the shared transport', () => {
  it('hands every poll an AbortSignal, so a stalled one can be cancelled', async () => {
    renderController();
    await settle();

    const calls = detailCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect((call[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('cuts a hung poll off at the polling budget, not before and not never', async () => {
    const { result } = renderController();
    await settle();
    expect(result.current.worktree?.name).toBe('feature/2499');

    mode = 'hang';
    await advance(IDLE_POLL_MS);
    const hung = detailCalls().at(-1)![1] as RequestInit;
    const signal = hung.signal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);

    // Not cut off early: a 2G-class link can legitimately be this slow, and a
    // deadline that fires under it would break polls that were going to work.
    await advance(API_POLL_TIMEOUT_MS - 1);
    expect(signal.aborted).toBe(false);

    // And cut off at all, which is the thing that did not happen before: the
    // request used to sit there holding a connection for the life of the tab.
    await advance(2);
    expect(signal.aborted).toBe(true);
  });

  it('lets a run of hung polls raise the stale banner #2498 specified', async () => {
    const { result } = renderController();
    await settle();

    mode = 'hang';
    // Before this Issue, a hung poll never settled, so the failure counter
    // never incremented and this banner was unreachable on exactly the network
    // it was written for.
    await advance((API_POLL_TIMEOUT_MS + IDLE_POLL_MS) * STALE_BANNER_FAILURE_THRESHOLD);

    expect(result.current.isReconnecting).toBe(true);
    // Stale, not broken: the loaded screen — and the composer draft in it —
    // stays mounted.
    expect(result.current.error).toBeNull();
    expect(result.current.worktree?.name).toBe('feature/2499');
  });

  it('recovers on its own once the polls answer again', async () => {
    const { result } = renderController();
    await settle();

    mode = 'hang';
    await advance((API_POLL_TIMEOUT_MS + IDLE_POLL_MS) * STALE_BANNER_FAILURE_THRESHOLD);
    expect(result.current.isReconnecting).toBe(true);

    mode = 'ok';
    await advance(IDLE_POLL_MS);

    expect(result.current.isReconnecting).toBe(false);
  });

  it('keeps one poll equal to one request, so the counter counts what it says', async () => {
    const { result } = renderController();
    await settle();
    const baseline = detailCalls().length;

    mode = 'reject';
    for (let i = 1; i <= STALE_BANNER_FAILURE_THRESHOLD; i++) {
      await advance(IDLE_POLL_MS);
    }

    // Exactly one request per tick: the transport's own retry ladder is turned
    // off here (`retries: 0`). With it on, three failed polls would be nine
    // requests and the banner would trail the outage by tens of seconds.
    expect(detailCalls().length - baseline).toBe(STALE_BANNER_FAILURE_THRESHOLD);
    expect(result.current.isReconnecting).toBe(true);
  });

  it('still counts a blip as one failure and forgets it after a success', async () => {
    const { result } = renderController();
    await settle();

    mode = 'reject';
    await advance(IDLE_POLL_MS * 2);
    mode = 'ok';
    await advance(IDLE_POLL_MS);
    mode = 'reject';
    await advance(IDLE_POLL_MS * 2);

    // #2498's "two isolated blips never add up" still holds with the transport
    // underneath: four failures, never three in a row.
    expect(result.current.isReconnecting).toBe(false);
  });
});
