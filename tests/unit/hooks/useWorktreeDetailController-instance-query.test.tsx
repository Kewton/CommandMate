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

// Issue #4484: the toasts the controller raises, and their real (en) wording.
const toast = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('@/components/common/Toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/common/Toast')>();
  return {
    ...actual,
    useToast: () => ({ toasts: [], showToast: toast.show, removeToast: vi.fn(), clearToasts: vi.fn() }),
  };
});
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

import { useWorktreeDetailController, INSTANCE_QUERY_GRACE_MS } from '@/hooks/useWorktreeDetailController';

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

/**
 * `hold` keeps the detail request pending until `release()` is called.
 * Issue #4484: `rosters` answers one roster per detail request (the last repeats).
 */
function stubFetch({ hold = false, rosters = [ROSTER] as Array<typeof ROSTER> } = {}) {
  let release: () => void = () => {};
  const gate = hold ? new Promise<void>((r) => { release = r; }) : Promise.resolve();
  let detailCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/messages')) return jsonResponse([]);
    if (url.includes('/current-output')) return jsonResponse({ isRunning: false });
    if (url.includes('/auto-yes')) return jsonResponse({ states: [] });
    await gate;
    const roster = rosters[Math.min(detailCalls, rosters.length - 1)];
    detailCalls += 1;
    const id = String(url).split('?')[0].split('/').pop();
    return jsonResponse({
      id, name: 'feature/s3', path: '/repo/s3', repositoryPath: '/repo', repositoryName: 'Repo',
      selectedAgents: ['claude', 'codex'], agentInstances: roster,
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
  toast.show.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
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
    // Issue #4484: no longer silent — the id is looked for during the grace
    // (a later roster may bring it), then the screen says so, naming what it
    // shows. The selection is left alone throughout.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch();
    nav.search = new URLSearchParams('instance=codex-9');
    const result = mount();

    await waitFor(() => {
      expect(nav.router.replace).toHaveBeenCalledTimes(1);
    });
    expect(nav.router.replace).toHaveBeenCalledWith('/worktrees/wt-s3', { scroll: false });
    expect(result.current.instanceSelectionRequest).toBeNull();
    expect(result.current.activeInstanceId).toBe('claude');
    expect(toast.show).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(INSTANCE_QUERY_GRACE_MS + 100);
    });
    expect(toast.show).toHaveBeenCalledTimes(1);
    expect(toast.show).toHaveBeenCalledWith(
      "codex-9 is not one of this worktree's agents. Showing Claude instead.",
      'warning',
    );
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

describe('useWorktreeDetailController — ?instance= waits until applied or ended (Issue #4484)', () => {
  const WITHOUT_ALIAS = ROSTER.slice(0, 2);

  async function advance(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it('an id missing from the first roster is applied when a later roster within the grace brings it, without a toast', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch({ rosters: [WITHOUT_ALIAS, ROSTER] });
    nav.search = new URLSearchParams('instance=claude-2');
    const result = mount();

    await waitFor(() => expect(nav.router.replace).toHaveBeenCalledTimes(1));
    expect(result.current.instanceSelectionRequest).toBeNull();
    expect(result.current.activeInstanceId).toBe('claude');

    await advance(5_500); // the next idle poll brings claude-2
    await waitFor(() => {
      expect(result.current.instanceSelectionRequest).toEqual({ instanceId: 'claude-2', token: 1 });
    });
    expect(result.current.activeInstanceId).toBe('claude-2');
    act(() => result.current.acknowledgeInstanceSelection(1, 'applied', 'claude-2'));
    await advance(INSTANCE_QUERY_GRACE_MS);
    expect(toast.show).not.toHaveBeenCalled();
    expect(result.current.instanceSelectionRequest).toBeNull();
  });

  it('a refusal from the PC layout ends the request with a toast naming what the split still shows', async () => {
    stubFetch();
    nav.search = new URLSearchParams('instance=claude-2');
    const result = mount();
    await waitFor(() => {
      expect(result.current.instanceSelectionRequest).toEqual({ instanceId: 'claude-2', token: 1 });
    });
    act(() => result.current.acknowledgeInstanceSelection(1, 'refused', 'codex'));
    expect(result.current.instanceSelectionRequest).toBeNull();
    expect(toast.show).toHaveBeenCalledWith('Could not show claude-2. Messages still go to Codex.', 'warning');
  });

  it('the phone says so too for an id outside the roster', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mobile.current = true;
    stubFetch();
    nav.search = new URLSearchParams('instance=codex-9');
    const result = mount();
    await waitFor(() => expect(nav.router.replace).toHaveBeenCalledTimes(1));
    await advance(INSTANCE_QUERY_GRACE_MS + 100);
    expect(toast.show).toHaveBeenCalledWith(
      "codex-9 is not one of this worktree's agents. Showing Claude instead.",
      'warning',
    );
    expect(result.current.activeInstanceId).toBe('claude');
  });

  it('a manual pick ends a waiting request: the id arriving later changes nothing and nothing is said', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch({ rosters: [WITHOUT_ALIAS, ROSTER] });
    nav.search = new URLSearchParams('instance=claude-2');
    const result = mount();
    await waitFor(() => expect(nav.router.replace).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.cancelInstanceSelectionRequest();
      result.current.setActiveInstanceId('codex');
    });
    await advance(INSTANCE_QUERY_GRACE_MS + 1_000);
    expect(result.current.instanceSelectionRequest).toBeNull();
    expect(result.current.activeInstanceId).toBe('codex');
    expect(toast.show).not.toHaveBeenCalled();
  });

  it('leaving the worktree ends a waiting request: the next worktree\'s same id is not selected and nothing is said', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch({ rosters: [WITHOUT_ALIAS, ROSTER] });
    nav.search = new URLSearchParams('instance=claude-2');
    const { result, rerender } = renderHook(
      ({ id }) => useWorktreeDetailController({ worktreeId: id }),
      { initialProps: { id: WORKTREE_ID } },
    );
    await waitFor(() => expect(nav.router.replace).toHaveBeenCalledTimes(1));
    nav.search = new URLSearchParams();
    nav.pathname = '/worktrees/wt-s3-other';
    rerender({ id: 'wt-s3-other' });
    await waitFor(() => expect(result.current.rosterReady).toBe(true));
    await advance(INSTANCE_QUERY_GRACE_MS + 1_000);
    expect(result.current.instanceSelectionRequest).toBeNull();
    expect(result.current.activeInstanceId).not.toBe('claude-2');
    expect(toast.show).not.toHaveBeenCalled();
  });
});
