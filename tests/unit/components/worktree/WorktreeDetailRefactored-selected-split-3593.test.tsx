/**
 * The seam for the selected split (Issue #3593).
 *
 * The header's current session, End and Auto Yes must act on one value: the
 * session the selected split shows. `TerminalSplitContainer` publishes the
 * selection (its own suite pins that); this pins the wiring above it —
 * `WorktreeDetailDesktop` makes it the active instance, which is what the
 * header draws as the current session, what End snapshots as its target and
 * what the controller's Auto Yes state reads. The real PC layout is rendered
 * and only the split container is replaced by a probe that publishes a
 * selection on demand.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

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
  usePathname: () => '/worktrees/wt-3593-seam',
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

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

// The only stand-in: a split container whose selection the test drives.
vi.mock('@/components/worktree/TerminalSplitContainer', () => ({
  TerminalSplitContainer: ({
    onSelectedSplitChange,
  }: {
    onSelectedSplitChange?: (selection: {
      index: number;
      instanceId: string;
      splitInstanceIds: string[];
    }) => void;
  }) => (
    <div data-testid="split-container-probe">
      <button
        type="button"
        data-testid="probe-select-split-1"
        onClick={() =>
          onSelectedSplitChange?.({ index: 0, instanceId: 'claude', splitInstanceIds: ['claude', 'codex'] })
        }
      />
      <button
        type="button"
        data-testid="probe-select-split-2"
        onClick={() =>
          onSelectedSplitChange?.({ index: 1, instanceId: 'codex', splitInstanceIds: ['claude', 'codex'] })
        }
      />
    </div>
  ),
}));

import { WorktreeDetailRefactored } from '@/components/worktree/WorktreeDetailRefactored';

const WORKTREE_ID = 'wt-3593-seam';
const RUNNING = { isRunning: true, isWaitingForResponse: false, isProcessing: true };

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
  name: 'feature/3593-seam',
  path: '/repo/3593-seam',
  repositoryPath: '/repo',
  repositoryName: 'Repo',
  selectedAgents: ['claude', 'codex'],
  agentInstances: [
    { id: 'claude', cliTool: 'claude', order: 0 },
    { id: 'codex', cliTool: 'codex', order: 1 },
  ],
  sessionStatusByCli: { claude: RUNNING, codex: RUNNING },
  sessionStatusByInstance: { claude: RUNNING, codex: RUNNING },
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

const currentSession = () => document.querySelector('[data-session-current]');

describe('[#3593] the selected split is the current session, End and Auto Yes', () => {
  it('switching the selected split swaps the current session and the End target with it', async () => {
    render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);
    await screen.findByTestId('split-container-probe');

    fireEvent.click(screen.getByTestId('probe-select-split-1'));
    await waitFor(() =>
      expect(currentSession()?.getAttribute('data-testid')).toBe('desktop-agent-status-claude'),
    );

    fireEvent.click(screen.getByTestId('probe-select-split-2'));
    await waitFor(() =>
      expect(currentSession()?.getAttribute('data-testid')).toBe('desktop-agent-status-codex'),
    );
    // Auto Yes (and every active-instance read) follows: the controller's
    // active instance is the selected split's.
    expect(window.localStorage.getItem(`activeInstanceId-${WORKTREE_ID}`)).toBe('codex');
    // The other session is listed, named with the split it is in.
    expect(screen.getByTestId('desktop-session-split-claude').textContent).toBe('Split 1');

    // End acts on the same session.
    fireEvent.click(await screen.findByTestId('desktop-kill-session'));
    expect(await screen.findByText('End Codex session?')).toBeInTheDocument();
  });

  it('negative control: back to split 1, everything points at claude again', async () => {
    render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);
    await screen.findByTestId('split-container-probe');

    fireEvent.click(screen.getByTestId('probe-select-split-2'));
    await waitFor(() =>
      expect(currentSession()?.getAttribute('data-testid')).toBe('desktop-agent-status-codex'),
    );
    fireEvent.click(screen.getByTestId('probe-select-split-1'));
    await waitFor(() =>
      expect(currentSession()?.getAttribute('data-testid')).toBe('desktop-agent-status-claude'),
    );
    expect(window.localStorage.getItem(`activeInstanceId-${WORKTREE_ID}`)).toBe('claude');
    fireEvent.click(await screen.findByTestId('desktop-kill-session'));
    expect(await screen.findByText('End Claude session?')).toBeInTheDocument();
  });
});
