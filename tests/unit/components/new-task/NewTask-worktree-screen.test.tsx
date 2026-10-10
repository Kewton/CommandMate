/**
 * New task from the worktree screen, end to end inside the client
 * (Issue #3511).
 *
 * The real `WorktreeDetailRefactored` (PC layout, only the split container
 * replaced by a probe — the same seam #2656's suite uses) under the provider
 * AppShell mounts, with the real dialog host:
 *
 * 1. Mod+Shift+O on this screen opens the dialog on this worktree and the agent
 *    selected here (`useNewTaskScreenTarget`).
 * 2. Sending navigates to `/worktrees/<id>?instance=<sent>`.
 * 3. That URL, fed back into the screen, selects the sent instance — the
 *    `?instance=` path the sessions list uses (#2656) — on the PC and on the
 *    phone.
 *
 * `useSearchParams` is a subscribable store so `router.push` re-renders the
 * memo'd screen the way a real navigation does.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

const { nav, mobileStore } = vi.hoisted(() => {
  const navListeners = new Set<() => void>();
  const mobileListeners = new Set<() => void>();
  let mobile = false;
  const nav = {
    search: new URLSearchParams(),
    push: vi.fn((href: string) => {
      const query = href.includes('?') ? href.slice(href.indexOf('?') + 1) : '';
      nav.search = new URLSearchParams(query);
      navListeners.forEach((listener) => listener());
    }),
    replace: vi.fn((href: string) => {
      const query = href.includes('?') ? href.slice(href.indexOf('?') + 1) : '';
      nav.search = new URLSearchParams(query);
      navListeners.forEach((listener) => listener());
    }),
    subscribe: (listener: () => void) => {
      navListeners.add(listener);
      return () => {
        navListeners.delete(listener);
      };
    },
  };
  return {
    nav,
    mobileStore: {
      get: () => mobile,
      set: (next: boolean) => {
        mobile = next;
        mobileListeners.forEach((listener) => listener());
      },
      subscribe: (listener: () => void) => {
        mobileListeners.add(listener);
        return () => {
          mobileListeners.delete(listener);
        };
      },
    },
  };
});

vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useRouter: () => ({
      push: nav.push,
      back: vi.fn(),
      forward: vi.fn(),
      refresh: vi.fn(),
      replace: nav.replace,
      prefetch: vi.fn(),
    }),
    usePathname: () => '/worktrees/wt-3511-screen',
    useSearchParams: () => useSyncExternalStore(nav.subscribe, () => nav.search, () => nav.search),
  };
});

vi.mock('@/hooks/useIsMobile', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useIsMobile: () => useSyncExternalStore(mobileStore.subscribe, mobileStore.get, mobileStore.get),
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
import { NewTaskProvider } from '@/contexts/NewTaskContext';
import { NewTaskDialogHost } from '@/components/new-task/NewTaskDialogHost';
import { ToastProvider } from '@/components/common/Toast';
import { RECENT_TARGETS_STORAGE_KEY } from '@/lib/new-task/recent-targets';
import { jsonResponse } from '../../lib/new-task/new-task-fixtures';

const WORKTREE_ID = 'wt-3511-screen';

const WORKTREE = {
  id: WORKTREE_ID,
  name: 'feature/new-task',
  path: '/repo/new-task',
  repositoryPath: '/repo',
  repositoryName: 'Repo',
  cliToolId: 'claude',
  selectedAgents: ['claude', 'codex'],
  agentInstances: [
    { id: 'claude', cliTool: 'claude', alias: '', order: 0 },
    { id: 'codex', cliTool: 'codex', alias: '', order: 1 },
  ],
  sessionStatusByInstance: {
    claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
  },
  autoYesByInstance: {},
};

const sendBodies: unknown[] = [];

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
  nav.search = new URLSearchParams();
  nav.push.mockClear();
  nav.replace.mockClear();
  sendBodies.length = 0;
  mobileStore.set(false);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = typeof url === 'string' ? url.split('?')[0] : '';
      if (path === '/api/worktrees') {
        return jsonResponse({ worktrees: [WORKTREE], repositories: [] });
      }
      if (path === `/api/worktrees/${WORKTREE_ID}`) return jsonResponse(WORKTREE);
      if (path === `/api/worktrees/${WORKTREE_ID}/send`) {
        sendBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ id: 'm1' }, 201);
      }
      if (path.endsWith('/messages')) return jsonResponse([]);
      return jsonResponse({ items: [] });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/');
});

function renderScreen() {
  return render(
    <ToastProvider>
      <NewTaskProvider>
        <WorktreeDetailRefactored worktreeId={WORKTREE_ID} />
        <NewTaskDialogHost />
      </NewTaskProvider>
    </ToastProvider>,
  );
}

async function selectInstanceViaQuery(instanceId: string) {
  await act(async () => {
    nav.push(`/worktrees/${WORKTREE_ID}?instance=${instanceId}`);
  });
  await waitFor(() =>
    expect(screen.getByTestId('split-container-probe')).toHaveAttribute('data-instance', instanceId),
  );
  // The screen removes the parameter once applied.
  await waitFor(() => expect(nav.search.get('instance')).toBeNull());
}

describe('[#3511] New task on the worktree screen', () => {
  it('opens on this worktree and the selected agent, and lands the send on that instance', async () => {
    renderScreen();
    await screen.findByTestId('split-container-probe');
    await selectInstanceViaQuery('codex');
    nav.push.mockClear();

    fireEvent.keyDown(window, { key: 'O', code: 'KeyO', ctrlKey: true, shiftKey: true });
    const textarea = await screen.findByTestId('new-task-message');
    expect(screen.getByTestId('new-task-branch')).toHaveValue(WORKTREE_ID);
    expect(screen.getByTestId('new-task-agent')).toHaveValue('codex');
    // codex is stopped here: the dialog says it will be started.
    expect(screen.getByTestId('new-task-will-start')).toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: 'Fix the flaky test' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith(`/worktrees/${WORKTREE_ID}?instance=codex`));
    expect(sendBodies).toEqual([{ content: 'Fix the flaky test', cliToolId: 'codex', instanceId: 'codex' }]);
    await waitFor(() => expect(screen.queryByTestId('new-task-dialog')).toBeNull());
    // The pushed URL selects the sent instance (a fresh request token).
    await waitFor(() =>
      expect(screen.getByTestId('split-container-probe')).toHaveAttribute('data-token', '2'),
    );
    expect(screen.getByTestId('split-container-probe')).toHaveAttribute('data-instance', 'codex');
  });

  it('sends to another agent of this branch and selects that one', async () => {
    renderScreen();
    await screen.findByTestId('split-container-probe');
    await selectInstanceViaQuery('codex');

    fireEvent.keyDown(window, { key: 'O', metaKey: true, shiftKey: true });
    const textarea = await screen.findByTestId('new-task-message');
    fireEvent.change(screen.getByTestId('new-task-agent'), { target: { value: 'claude' } });
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('new-task-send'));

    await waitFor(() =>
      expect(screen.getByTestId('split-container-probe')).toHaveAttribute('data-instance', 'claude'),
    );
    expect(nav.push).toHaveBeenCalledWith(`/worktrees/${WORKTREE_ID}?instance=claude`);
  });

  it('on the phone, the pushed URL makes the sent instance the active one', async () => {
    mobileStore.set(true);
    renderScreen();

    fireEvent.keyDown(window, { key: 'O', metaKey: true, shiftKey: true });
    const textarea = await screen.findByTestId('new-task-message');
    await waitFor(() => expect(screen.getByTestId('new-task-branch')).toHaveValue(WORKTREE_ID));
    fireEvent.change(screen.getByTestId('new-task-agent'), { target: { value: 'codex' } });
    fireEvent.change(textarea, { target: { value: 'from the phone' } });
    fireEvent.click(screen.getByTestId('new-task-send'));

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith(`/worktrees/${WORKTREE_ID}?instance=codex`));
    // The phone handles `?instance=` by selecting it, then drops the parameter.
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith(`/worktrees/${WORKTREE_ID}`, { scroll: false }));

    // Re-open: the screen now reports codex as its selected agent. The
    // recorded destination is dropped so only the screen can say so.
    window.localStorage.removeItem(RECENT_TARGETS_STORAGE_KEY);
    fireEvent.keyDown(window, { key: 'O', metaKey: true, shiftKey: true });
    await screen.findByTestId('new-task-message');
    await waitFor(() => expect(screen.getByTestId('new-task-agent')).toHaveValue('codex'));
  });
});
