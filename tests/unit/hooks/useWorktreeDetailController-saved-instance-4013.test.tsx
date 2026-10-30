/**
 * The saved `activeInstanceId` survives the roster's arrival (Issue #4013).
 *
 * Until THIS worktree's roster lands, the controller only holds the default
 * seed (primary instances such as `claude`). The reconcile effect that falls
 * back to the first displayed instance must not run against that seed: it
 * would treat a saved non-first instance (`claude-cc`) as gone, switch to the
 * first one, and overwrite the saved value with it.
 *
 * Positive: a saved instance that is in the roster is still active (and still
 * saved) once the roster has arrived, on the phone and on the PC.
 * Negative: a saved instance that is NOT in the roster (deleted / renamed) is
 * still corrected to the first instance, as before.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const nav = vi.hoisted(() => ({
  search: new URLSearchParams(),
  pathname: '/worktrees/wt-4013',
  router: { push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => nav.router,
  usePathname: () => nav.pathname,
  useSearchParams: () => nav.search,
}));

const mobile = vi.hoisted(() => ({ current: true }));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => mobile.current, MOBILE_BREAKPOINT: 768 }));

vi.mock('@/contexts/SidebarContext', () => ({
  useSidebarContext: () => ({
    isOpen: true, width: 288, isMobileDrawerOpen: false,
    toggle: vi.fn(), setWidth: vi.fn(), openMobileDrawer: vi.fn(), closeMobileDrawer: vi.fn(),
  }),
}));
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({ useOptionalWorktreesCacheContext: () => null }));

import { useWorktreeDetailController } from '@/hooks/useWorktreeDetailController';

const WORKTREE_ID = 'wt-4013';
const STORAGE_KEY = `activeInstanceId-${WORKTREE_ID}`;
const ROSTER = [
  { id: 'claude', cliTool: 'claude', order: 0 },
  { id: 'codex', cliTool: 'codex', order: 1 },
  { id: 'claude-cc', cliTool: 'claude', alias: 'CC', order: 2 },
];

function jsonResponse(body: unknown): Response {
  return {
    ok: true, status: 200, redirected: false,
    url: `http://localhost/api/worktrees/${WORKTREE_ID}`,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** Keeps the detail request (which carries the roster) pending until `release()`. */
function stubFetch() {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/messages')) return jsonResponse([]);
    if (url.includes('/current-output')) return jsonResponse({ isRunning: false });
    if (url.includes('/auto-yes')) return jsonResponse({ states: [] });
    await gate;
    return jsonResponse({
      id: WORKTREE_ID, name: 'feature/4013', path: '/repo/4013', repositoryPath: '/repo', repositoryName: 'Repo',
      selectedAgents: ['claude', 'codex'], agentInstances: ROSTER,
    });
  }));
  return { release: () => release() };
}

async function mountAndLandRoster() {
  const { release } = stubFetch();
  const { result } = renderHook(() => useWorktreeDetailController({ worktreeId: WORKTREE_ID }));

  // Before the roster: only the default seed is displayed.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(result.current.rosterReady).toBe(false);
  const beforeRoster = {
    activeInstanceId: result.current.activeInstanceId,
    saved: window.localStorage.getItem(STORAGE_KEY),
  };

  await act(async () => {
    release();
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(result.current.rosterReady).toBe(true);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  return { result, beforeRoster };
}

beforeEach(() => {
  window.localStorage.clear();
  nav.search = new URLSearchParams();
  nav.router.replace.mockClear();
  mobile.current = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useWorktreeDetailController — saved activeInstanceId vs. roster arrival (Issue #4013)', () => {
  it('keeps a saved non-first instance on the phone until and after the roster lands', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'claude-cc');
    const { result, beforeRoster } = await mountAndLandRoster();

    expect(beforeRoster).toEqual({ activeInstanceId: 'claude-cc', saved: 'claude-cc' });
    expect(result.current.visibleInstanceIds).toContain('claude-cc');
    expect(result.current.activeInstanceId).toBe('claude-cc');
    expect(result.current.activeCliTab).toBe('claude');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('claude-cc');
  });

  it('keeps a saved non-first instance on the PC as well', async () => {
    mobile.current = false;
    window.localStorage.setItem(STORAGE_KEY, 'claude-cc');
    const { result } = await mountAndLandRoster();

    expect(result.current.activeInstanceId).toBe('claude-cc');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('claude-cc');
  });

  it('still corrects a saved instance that is not in the roster to the first one (negative control)', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'claude-gone');
    const { result } = await mountAndLandRoster();

    expect(result.current.activeInstanceId).toBe('claude');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('claude');
  });

  it('still corrects to the first visible instance when the saved one is hidden on this phone', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'claude-cc');
    window.localStorage.setItem(
      `commandmate:worktree:mobileInstances:${WORKTREE_ID}`,
      JSON.stringify(['codex']),
    );
    const { result } = await mountAndLandRoster();

    expect(result.current.activeInstanceId).toBe('codex');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('codex');
  });
});
