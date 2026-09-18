/**
 * The seam for `?instance=` (Issue #2656).
 *
 * The controller's own suite proves it produces a token-stamped
 * `instanceSelectionRequest`, and `TerminalSplitContainer` already owns where a
 * header selection lands (Issue #1152). What neither covers is the wiring in
 * between: `WorktreeDetailRefactored` → `WorktreeDetailDesktop` → the split
 * container. Drop either prop and every other suite stays green, so the real PC
 * layout is rendered here and only the split container is replaced by a probe.
 *
 * `WorktreeDetailRefactored` is `memo`'d over a single `worktreeId`, so a
 * `rerender()` with the same prop is a no-op. The `useIsMobile` mock is
 * therefore a real subscribable store: flipping it is what re-renders the
 * screen, exactly as the resize listener does in the browser.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';

const { nav, mobileStore } = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let mobile = false;
  return {
    nav: {
      search: new URLSearchParams(),
      replace: vi.fn(),
    },
    mobileStore: {
      get: () => mobile,
      set: (next: boolean) => {
        mobile = next;
        listeners.forEach((listener) => listener());
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: nav.replace,
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-s3-seam',
  useSearchParams: () => nav.search,
}));

vi.mock('@/hooks/useIsMobile', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useIsMobile: () =>
      useSyncExternalStore(mobileStore.subscribe, mobileStore.get, mobileStore.get),
    MOBILE_BREAKPOINT: 768,
  };
});

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
  SidebarProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    groups: [],
    filteredGroups: [],
    allCommands: [],
    loading: false,
    error: null,
    filter: '',
    setFilter: vi.fn(),
    refresh: vi.fn(),
    isCatalogStale: false,
  }),
}));

vi.mock('@/components/error/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// The only stand-in: what the split container was handed, as attributes.
vi.mock('@/components/worktree/TerminalSplitContainer', () => ({
  TerminalSplitContainer: ({
    headerInstanceSelection,
  }: {
    headerInstanceSelection?: { instanceId: string; token: number } | null;
  }) => (
    <div
      data-testid="split-container-probe"
      data-instance={headerInstanceSelection?.instanceId ?? ''}
      data-token={headerInstanceSelection?.token ?? 0}
    />
  ),
}));

import { WorktreeDetailRefactored } from '@/components/worktree/WorktreeDetailRefactored';

const WORKTREE_ID = 'wt-s3-seam';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    redirected: false,
    url: `http://localhost/api/worktrees/${WORKTREE_ID}`,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const WORKTREE_DETAIL = {
  id: WORKTREE_ID,
  name: 'feature/s3-seam',
  path: '/repo/s3-seam',
  repositoryPath: '/repo',
  repositoryName: 'Repo',
  selectedAgents: ['claude', 'codex'],
  agentInstances: [
    { id: 'claude', cliTool: 'claude', order: 0 },
    { id: 'codex', cliTool: 'codex', order: 1 },
  ],
};

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
  nav.search = new URLSearchParams();
  nav.replace.mockClear();
  mobileStore.set(false);
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const path = typeof url === 'string' ? url.split('?')[0] : '';
      // Only the detail endpoint itself gets the worktree payload: a file tree
      // or history request that received it would throw while rendering.
      if (path === `/api/worktrees/${WORKTREE_ID}`) {
        return Promise.resolve(jsonResponse(WORKTREE_DETAIL));
      }
      if (path.endsWith('/messages')) return Promise.resolve(jsonResponse([]));
      return Promise.resolve(jsonResponse({ items: [] }));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('[#2656] WorktreeDetailRefactored routes ?instance= into the split', () => {
  it('hands the split container the instance from the query', async () => {
    nav.search = new URLSearchParams('instance=codex');
    render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);

    const probe = await screen.findByTestId('split-container-probe');
    await waitFor(() => expect(probe).toHaveAttribute('data-instance', 'codex'));
    expect(probe).toHaveAttribute('data-token', '1');
    await waitFor(() =>
      expect(nav.replace).toHaveBeenCalledWith(`/worktrees/${WORKTREE_ID}`, { scroll: false }),
    );
  });

  it('does nothing without the query', async () => {
    render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);

    const probe = await screen.findByTestId('split-container-probe');
    await new Promise((r) => setTimeout(r, 50));
    expect(probe).toHaveAttribute('data-instance', '');
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('does not re-apply an acknowledged request when the PC layout is re-created', async () => {
    nav.search = new URLSearchParams('instance=codex');
    render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);

    await waitFor(() =>
      expect(screen.getByTestId('split-container-probe')).toHaveAttribute('data-instance', 'codex'),
    );

    // The replace has landed: the query is gone.
    nav.search = new URLSearchParams();

    // Narrow to the phone (the PC layout unmounts), then widen again.
    await act(async () => {
      mobileStore.set(true);
    });
    expect(screen.queryByTestId('split-container-probe')).toBeNull();
    await act(async () => {
      mobileStore.set(false);
    });

    const probe = await screen.findByTestId('split-container-probe');
    await new Promise((r) => setTimeout(r, 50));
    expect(probe).toHaveAttribute('data-instance', '');
  });
});
