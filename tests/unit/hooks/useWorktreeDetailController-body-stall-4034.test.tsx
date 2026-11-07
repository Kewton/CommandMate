/**
 * The detail screen gets out of a stalled body on its own (Issue #4034).
 *
 * The poll's `setInterval` starts only after the initial load, and the initial
 * load awaits all its fetches: a body that stopped there left `loading` true and
 * no poll running, for good. Fixing only the read would be no use if the failure
 * did not reach the existing catch and clear that gate, so this drives the whole
 * way: stalled body → catch → gate clears → the next tick requests again →
 * the screen recovers.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-4034',
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

vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => null,
}));

import { useWorktreeDetailController } from '@/hooks/useWorktreeDetailController';
import { API_POLL_TIMEOUT_MS } from '@/config/api-timeout-config';
import { __resetApiReachabilityReporting } from '@/lib/api-client';

const WORKTREE_ID = 'wt-4034';
const DETAIL_URL = `/api/worktrees/${WORKTREE_ID}`;
const IDLE_POLL_MS = 5000;
const headers = { 'content-type': 'application/json' };

const mockFetch = vi.fn();
let stallBodies = true;

function respond(payload: unknown, status = 200): Response {
  if (stallBodies) return new Response(new ReadableStream<Uint8Array>(), { status, headers });
  return new Response(JSON.stringify(payload), { status, headers });
}

function detailCalls(): number {
  return mockFetch.mock.calls.filter(([url]) => (url as string).endsWith(DETAIL_URL)).length;
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  stallBodies = true;
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes('/messages')) return respond([]);
    if (url.includes('/current-output')) return respond({ isRunning: false });
    if (url.includes('/auto-yes')) return respond({ instances: {} });
    return respond({ id: WORKTREE_ID, name: 'feature/4034', path: '/tmp/wt', repositoryPath: '/tmp/repo' });
  });
  global.fetch = mockFetch as unknown as typeof fetch;
  window.localStorage.clear();
  __resetApiReachabilityReporting();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('[#4034] useWorktreeDetailController — every body stalls on the first load', () => {
  it('fails into the existing catch, ends `loading`, polls again, and recovers', async () => {
    const { result } = renderHook(() => useWorktreeDetailController({ worktreeId: WORKTREE_ID }));

    await advance(API_POLL_TIMEOUT_MS - 1);
    expect(result.current.loading).toBe(true);

    await advance(1);
    // Reached the catch: the first-load branch sets the error with the client's own words.
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toContain('timed out');

    stallBodies = false;
    const before = detailCalls();
    await advance(IDLE_POLL_MS + 1);
    expect(detailCalls()).toBeGreaterThan(before);
    expect(result.current.worktree?.name).toBe('feature/4034');
    expect(result.current.error).toBeNull();
  });
});
