/**
 * `?instance=<id>` handling in the worktree detail controller (Issue #2656).
 *
 * The sidebar's sessions view hands the screen an instance through the URL.
 * What matters here is the timing and the clean-up: the parameter must not be
 * applied before THIS worktree's roster has landed (before that the roster is
 * the default seed and an alias like `claude-2` would look unknown), it must be
 * applied exactly once per URL, and it must be removed again without taking the
 * other query parameters with it.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const nav = vi.hoisted(() => ({
  search: new URLSearchParams(),
  pathname: '/worktrees/wt-s3',
  router: { push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => nav.router,
  usePathname: () => nav.pathname,
  useSearchParams: () => nav.search,
}));

const mobile = vi.hoisted(() => ({ current: false }));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => mobile.current, MOBILE_BREAKPOINT: 768 }));

vi.mock('@/contexts/SidebarContext', () => ({
  useSidebarContext: () => ({
    isOpen: true, width: 288, isMobileDrawerOpen: false,
    toggle: vi.fn(), setWidth: vi.fn(), openMobileDrawer: vi.fn(), closeMobileDrawer: vi.fn(),
  }),
}));
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({ useOptionalWorktreesCacheContext: () => null }));

import { useWorktreeDetailController } from '@/hooks/useWorktreeDetailController';

const WORKTREE_ID = 'wt-s3';
const ROSTER = [
  { id: 'claude', cliTool: 'claude', order: 0 },
  { id: 'codex', cliTool: 'codex', order: 1 },
  { id: 'claude-2', cliTool: 'claude', alias: 'Review', order: 2 },
];

function jsonResponse(body: unknown): Response {
  return {
    ok: true, status: 200, redirected: false,
    url: `http://localhost/api/worktrees/${WORKTREE_ID}`,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** `hold` keeps the detail request pending until `release()` is called. */
function stubFetch({ hold = false } = {}) {
  let release: () => void = () => {};
  const gate = hold ? new Promise<void>((r) => { release = r; }) : Promise.resolve();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/messages')) return jsonResponse([]);
    if (url.includes('/current-output')) return jsonResponse({ isRunning: false });
    if (url.includes('/auto-yes')) return jsonResponse({ states: [] });
    await gate;
    return jsonResponse({
      id: WORKTREE_ID, name: 'feature/s3', path: '/repo/s3', repositoryPath: '/repo', repositoryName: 'Repo',
      selectedAgents: ['claude', 'codex'], agentInstances: ROSTER,
    });
  }));
  return { release: () => release() };
}

function mount() {
  return renderHook(() => useWorktreeDetailController({ worktreeId: WORKTREE_ID })).result;
}

beforeEach(() => {
  window.localStorage.clear();
  nav.search = new URLSearchParams();
  nav.pathname = `/worktrees/${WORKTREE_ID}`;
  nav.router.replace.mockClear();
  mobile.current = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useWorktreeDetailController — ?instance= (Issue #2656)', () => {
  it('selects an alias instance from the roster and strips the parameter', async () => {
    stubFetch();
    nav.search = new URLSearchParams('instance=claude-2');
    const result = mount();

    await waitFor(() => {
      expect(result.current.rosterReady).toBe(true);
    });
    await waitFor(() => {
      expect(result.current.activeInstanceId).toBe('claude-2');
    });
    expect(result.current.activeCliTab).toBe('claude');
    expect(result.current.instanceSelectionRequest).toEqual({ instanceId: 'claude-2', token: 1 });
    expect(nav.router.replace).toHaveBeenCalledTimes(1);
    expect(nav.router.replace).toHaveBeenCalledWith('/worktrees/wt-s3', { scroll: false });
    expect(window.localStorage.getItem('activeInstanceId-wt-s3')).toBe('claude-2');
  });

  it('keeps the other query parameters when it removes `instance`', async () => {
    stubFetch();
    nav.search = new URLSearchParams('pane=files&instance=codex&view=chat');
    const result = mount();

    await waitFor(() => {
      expect(result.current.activeInstanceId).toBe('codex');
    });
    expect(nav.router.replace).toHaveBeenCalledWith('/worktrees/wt-s3?pane=files&view=chat', {
      scroll: false,
    });
  });

  it('waits for this worktree\'s roster before applying anything', async () => {
    const { release } = stubFetch({ hold: true });
    nav.search = new URLSearchParams('instance=claude-2');
    const result = mount();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(result.current.rosterReady).toBe(false);
    expect(result.current.instanceSelectionRequest).toBeNull();
    expect(nav.router.replace).not.toHaveBeenCalled();

    await act(async () => {
      release();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.activeInstanceId).toBe('claude-2');
    });
    expect(nav.router.replace).toHaveBeenCalledTimes(1);
  });

  it('leaves the selection alone for an id outside the roster', async () => {
    stubFetch();
    nav.search = new URLSearchParams('instance=codex-9');
    const result = mount();

    await waitFor(() => {
      expect(nav.router.replace).toHaveBeenCalledTimes(1);
    });
    expect(nav.router.replace).toHaveBeenCalledWith('/worktrees/wt-s3', { scroll: false });
    expect(result.current.instanceSelectionRequest).toBeNull();
    expect(result.current.activeInstanceId).toBe('claude');
  });

  it('does nothing at all without the parameter', async () => {
    stubFetch();
    const result = mount();

    await waitFor(() => {
      expect(result.current.rosterReady).toBe(true);
    });
    expect(nav.router.replace).not.toHaveBeenCalled();
    expect(result.current.instanceSelectionRequest).toBeNull();
  });

  it('applies the same row again after the parameter has gone and come back', async () => {
    stubFetch();
    nav.search = new URLSearchParams('instance=codex');
    const { result, rerender } = renderHook(() =>
      useWorktreeDetailController({ worktreeId: WORKTREE_ID })
    );

    await waitFor(() => {
      expect(result.current.instanceSelectionRequest).toEqual({ instanceId: 'codex', token: 1 });
    });

    // The replace has landed: the parameter is gone from the URL.
    nav.search = new URLSearchParams();
    rerender();
    act(() => {
      result.current.setActiveInstanceId('claude');
    });

    // The same row is clicked again.
    nav.search = new URLSearchParams('instance=codex');
    rerender();

    await waitFor(() => {
      expect(result.current.instanceSelectionRequest).toEqual({ instanceId: 'codex', token: 2 });
    });
    expect(result.current.activeInstanceId).toBe('codex');
    expect(nav.router.replace).toHaveBeenCalledTimes(2);
  });

  it('makes the instance visible first on the phone, and leaves no PC request', async () => {
    mobile.current = true;
    window.localStorage.setItem(
      'commandmate:worktree:mobileInstances:wt-s3',
      JSON.stringify(['claude'])
    );
    stubFetch();
    nav.search = new URLSearchParams('instance=codex');
    const result = mount();

    await waitFor(() => {
      expect(result.current.activeInstanceId).toBe('codex');
    });
    expect(result.current.visibleInstanceIds).toEqual(['claude', 'codex']);
    expect(result.current.instanceSelectionRequest).toBeNull();

    // The reconcile effect must not pull the selection back to the first tab.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(result.current.activeInstanceId).toBe('codex');
  });

  it('clears the request only for the matching token', async () => {
    stubFetch();
    nav.search = new URLSearchParams('instance=claude-2');
    const { result, rerender } = renderHook(() =>
      useWorktreeDetailController({ worktreeId: WORKTREE_ID })
    );

    await waitFor(() => {
      expect(result.current.instanceSelectionRequest).toEqual({ instanceId: 'claude-2', token: 1 });
    });
    act(() => {
      result.current.acknowledgeInstanceSelection(1);
    });
    expect(result.current.instanceSelectionRequest).toBeNull();

    // A second request (token 2) must survive an acknowledgement of token 1.
    nav.search = new URLSearchParams();
    rerender();
    nav.search = new URLSearchParams('instance=codex');
    rerender();
    await waitFor(() => {
      expect(result.current.instanceSelectionRequest).toEqual({ instanceId: 'codex', token: 2 });
    });
    act(() => {
      result.current.acknowledgeInstanceSelection(1);
    });
    expect(result.current.instanceSelectionRequest).toEqual({ instanceId: 'codex', token: 2 });
  });
});
