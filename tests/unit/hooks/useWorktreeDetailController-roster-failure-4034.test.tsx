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
/** A detail answer that carries no roster (older server / partial body). */
let detailWithoutRoster = false;

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
      selectedAgents: ['claude', 'codex'], ...(detailWithoutRoster ? {} : { agentInstances: ROSTER }),
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
  detailWithoutRoster = false;
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

  it('positive: a saved id the roster lacks is corrected in storage too once the roster lands (after the fallback)', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'claude-gone');
    const { result } = renderHook(() => useWorktreeDetailController({ worktreeId: WORKTREE_ID }));

    await advance(LADDER_MS);
    expect(result.current.activeInstanceId).toBe('claude');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('claude-gone');

    detailOk = true;
    await advance(10_000);
    expect(result.current.rosterReady).toBe(true);
    expect(result.current.activeInstanceId).toBe('claude');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('claude');
  });

  it('positive: the fallback does not overwrite the saved activeCliTab', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'claude-cc');
    window.localStorage.setItem(`activeCliTab-${WORKTREE_ID}`, 'codex');
    const { result } = renderHook(() => useWorktreeDetailController({ worktreeId: WORKTREE_ID }));

    await advance(LADDER_MS);
    expect(result.current.activeInstanceId).toBe('claude');
    expect(result.current.activeCliTab).toBe('claude');
    expect(window.localStorage.getItem(`activeCliTab-${WORKTREE_ID}`)).toBe('codex');
  });

  it('positive: switching worktrees drops the failure verdict, so a stand-in is not forced on the way back', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'claude-cc');
    const { result, rerender } = renderHook(
      ({ id }) => useWorktreeDetailController({ worktreeId: id }),
      { initialProps: { id: WORKTREE_ID } },
    );
    await advance(LADDER_MS);
    expect(result.current.activeInstanceId).toBe('claude');

    rerender({ id: 'wt-other' });
    await advance(0);
    rerender({ id: WORKTREE_ID });
    await advance(0);
    // One fresh failure only: a leftover verdict would push this back to the seed's first.
    act(() => result.current.setActiveInstanceId('claude-cc'));
    await advance(0);
    expect(result.current.activeInstanceId).toBe('claude-cc');
  });

  it('positive: a successful detail fetch clears the verdict even when it carries no roster', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'claude-cc');
    const { result } = renderHook(() => useWorktreeDetailController({ worktreeId: WORKTREE_ID }));
    await advance(LADDER_MS);
    expect(result.current.activeInstanceId).toBe('claude');

    detailOk = true;
    detailWithoutRoster = true;
    await advance(10_000);
    // No roster arrived, but the fetch works again: the seed is no longer a failure fallback.
    expect(result.current.rosterReady).toBe(false);
    act(() => result.current.setActiveInstanceId('claude-cc'));
    await advance(0);
    expect(result.current.activeInstanceId).toBe('claude-cc');
  });
});
