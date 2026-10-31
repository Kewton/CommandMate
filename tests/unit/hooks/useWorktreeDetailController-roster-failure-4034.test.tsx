/**
 * While the roster cannot be fetched, a saved `activeInstanceId` that the seed
 * does not display falls back to the seed's first — without touching the saved
 * value (Issue #4034, the failure side of #4013).
 *
 * #4013 made the reconcile wait for THIS worktree's roster. When that request
 * keeps failing the roster never lands, and a saved non-first instance
 * (`claude-cc`) stayed active although the screen shows only the seed.
 *
 * Positive: after STALE_BANNER_FAILURE_THRESHOLD failures in a row the active
 * instance is the seed's first and the saved value is still `claude-cc`; once
 * the roster lands, `claude-cc` is active again. Negative: a saved instance the
 * seed does display is left alone; fewer failures than the threshold change
 * nothing; a roster that arrives is reconciled as in #4013.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const nav = vi.hoisted(() => ({
  search: new URLSearchParams(),
  pathname: '/worktrees/wt-4034',
  router: { push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => nav.router,
  usePathname: () => nav.pathname,
  useSearchParams: () => nav.search,
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false, MOBILE_BREAKPOINT: 768 }));
vi.mock('@/contexts/SidebarContext', () => ({
  useSidebarContext: () => ({
    isOpen: true, width: 288, isMobileDrawerOpen: false,
    toggle: vi.fn(), setWidth: vi.fn(), openMobileDrawer: vi.fn(), closeMobileDrawer: vi.fn(),
  }),
}));
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({ useOptionalWorktreesCacheContext: () => null }));

import {
  useWorktreeDetailController,
  STALE_BANNER_FAILURE_THRESHOLD,
  DETAIL_LOAD_RETRY_DELAYS_MS,
} from '@/hooks/useWorktreeDetailController';

const WORKTREE_ID = 'wt-4034';
const STORAGE_KEY = `activeInstanceId-${WORKTREE_ID}`;
const ROSTER = [
  { id: 'claude', cliTool: 'claude', order: 0 },
  { id: 'codex', cliTool: 'codex', order: 1 },
  { id: 'claude-cc', cliTool: 'claude', alias: 'CC', order: 2 },
];

let detailOk = false;

function jsonResponse(body: unknown): Response {
  return {
    ok: true, status: 200, redirected: false,
    url: `http://localhost/api/worktrees/${WORKTREE_ID}`,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function installFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/messages')) return jsonResponse([]);
    if (url.includes('/current-output')) return jsonResponse({ isRunning: false });
    if (url.includes('/auto-yes')) return jsonResponse({ states: [] });
    if (!detailOk) throw new TypeError('Failed to fetch');
    return jsonResponse({
      id: WORKTREE_ID, name: 'feature/4034', path: '/repo/4034', repositoryPath: '/repo', repositoryName: 'Repo',
      selectedAgents: ['claude', 'codex'], agentInstances: ROSTER,
    });
  }));
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Time for the first load and the first `n` ladder retries to have failed. */
const LADDER_MS = DETAIL_LOAD_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0) + 1_000;

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  nav.search = new URLSearchParams();
  detailOk = false;
  installFetch();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useWorktreeDetailController — roster fetch keeps failing (Issue #4034)', () => {
  it('positive: falls back to the seed\'s first in state only, then returns to the saved id when the roster lands', async () => {
    expect(STALE_BANNER_FAILURE_THRESHOLD).toBeLessThanOrEqual(DETAIL_LOAD_RETRY_DELAYS_MS.length + 1);
    window.localStorage.setItem(STORAGE_KEY, 'claude-cc');
    const { result } = renderHook(() => useWorktreeDetailController({ worktreeId: WORKTREE_ID }));

    await advance(0);
    // One failure: nothing has changed yet.
    expect(result.current.rosterReady).toBe(false);
    expect(result.current.activeInstanceId).toBe('claude-cc');

    await advance(LADDER_MS);
    expect(result.current.rosterReady).toBe(false);
    expect(result.current.activeInstanceId).toBe('claude');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('claude-cc');

    detailOk = true;
    await advance(10_000);
    expect(result.current.rosterReady).toBe(true);
    expect(result.current.activeInstanceId).toBe('claude-cc');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('claude-cc');
  });

  it('negative: a saved id the seed does display is left alone', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'codex');
    const { result } = renderHook(() => useWorktreeDetailController({ worktreeId: WORKTREE_ID }));

    await advance(LADDER_MS);
    expect(result.current.rosterReady).toBe(false);
    expect(result.current.activeInstanceId).toBe('codex');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('codex');
  });

  it('negative: when the roster lands first, a saved id outside it is corrected as in #4013', async () => {
    detailOk = true;
    window.localStorage.setItem(STORAGE_KEY, 'claude-gone');
    const { result } = renderHook(() => useWorktreeDetailController({ worktreeId: WORKTREE_ID }));

    await advance(1_000);
    expect(result.current.rosterReady).toBe(true);
    expect(result.current.activeInstanceId).toBe('claude');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('claude');
  });
});
