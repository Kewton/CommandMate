/**
 * The hand-off's units over the real page drawing the dialog again (Issue #4227 G-PR2 pr2e,
 * design `mem-ui-4227.md` §4.1.1; PM Claude pr2d P2-1, codex review-4227-pr2c P2-1).
 *
 * The real `WorktreeDetailRefactored` (G10: it draws the dialog in one place, outside its Loading
 * and its PC / phone branches), the real hook and the real `SessionHandoffDialog`, under `Shell`,
 * which draws the page under another parent per layout as `AppShell` does (the page is made anew
 * on a turn). A decide whose result is unknown:
 *
 * - PC ↔ phone (`useIsMobile` turns: a turn of the device, a change of width): the page and the
 *   dialog are new instances under the other parent; the unit stays and no second request is made.
 * - a switch of worktree whose detail is not yet read: the page draws its Loading and then B's
 *   page; G10: the dialog stays drawn over the Loading. The unit stays, shown as A's ("foreign"),
 *   and no request is made on B. B's read is held here so the Loading is seen.
 *
 * Positive control: `rule.perInstance` empties the store when the dialog is taken out (the
 * units back in the component's life, as before pr2e): the unit is lost on both (G10: the
 * Loading no longer takes the dialog out, so the second is the page made anew on B, as Next
 * keys it by its `[id]`).
 * Negative control: nothing held, the switch closes the hand-off.
 *
 * next-intl is the global echo mock: labels read as their keys.
 *
 * @vitest-environment jsdom
 */

import React, { useSyncExternalStore } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const env = vi.hoisted(() => ({ mobile: false, listeners: new Set<() => void>() }));
const rule = vi.hoisted(() => ({ perInstance: false }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/worktrees/wt-a',
  useSearchParams: () => new URLSearchParams(),
}));
// The width as the browser reports it: a change is told to every reader (the page is memoised,
// so it is redrawn by the change itself, as a turn of the device or a resize does).
vi.mock('@/hooks/useIsMobile', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useIsMobile: () =>
      useSyncExternalStore(
        (listener: () => void) => {
          env.listeners.add(listener);
          return () => env.listeners.delete(listener);
        },
        () => env.mobile
      ),
    MOBILE_BREAKPOINT: 768,
  };
});
vi.mock('@/contexts/SidebarContext', () => ({
  useSidebarContext: () => ({
    isOpen: true, width: 288, isMobileDrawerOpen: false, toggle: vi.fn(),
    setWidth: vi.fn(), openMobileDrawer: vi.fn(), closeMobileDrawer: vi.fn(),
  }),
  SidebarProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    groups: [], filteredGroups: [], allCommands: [], loading: false,
    error: null, filter: '', setFilter: vi.fn(), refresh: vi.fn(), isCatalogStale: false,
  }),
}));
vi.mock('@/components/error/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: () => <div data-testid="terminal-display" />,
}));
vi.mock('@/components/worktree/HistoryPane', () => ({
  HistoryPane: () => <div data-testid="history-pane" />,
  splitHistorySlotId: (idx: number) => `split-history-slot-${idx}`,
}));
vi.mock('@/hooks/useFileTabs', () => ({
  useFileTabs: () => [
    { tabs: [], activeIndex: null },
    { dispatch: vi.fn(), openFile: vi.fn(), closeTab: vi.fn(), activateTab: vi.fn(), onFileRenamed: vi.fn(), onFileDeleted: vi.fn(), moveToFront: vi.fn() },
  ],
}));
vi.mock('@/components/worktree/TerminalContainer', () => ({
  TerminalContainer: ({ terminal }: { terminal: React.ReactNode }) => <div data-testid="terminal-column">{terminal}</div>,
}));
vi.mock('@/components/worktree/FilePanelSplit', () => ({
  FilePanelSplit: ({ terminal }: { terminal: React.ReactNode }) => <>{terminal}</>,
}));
vi.mock('@/components/worktree/TerminalSplitContainer', async () => {
  const actual = await vi.importActual<typeof import('@/components/worktree/TerminalSplitContainer')>(
    '@/components/worktree/TerminalSplitContainer',
  );
  // Issue #4227 pr2c (B P2-1): the stub draws one pane that is not the active instance
  // (`codex-2`, split 1) through the page's own `renderPane`, so its End is the page's wiring.
  return {
    ...actual,
    TerminalSplitContainer: ({ renderPane }: { renderPane?: (args: Record<string, unknown>) => React.ReactNode }) => (
      <div data-testid="split-container">
        {renderPane?.({
          splitIndex: 1,
          cliToolId: 'codex',
          instanceId: 'codex-2',
          instance: undefined,
          availableInstances: [],
          onInstanceChange: () => undefined,
          onFocus: () => undefined,
          isFocused: false,
          onDropInstance: () => undefined,
          isMaximized: false,
          onToggleMaximize: () => undefined,
        })}
      </div>
    ),
  };
});
/**
 * Issue #4227 pr2c (B P2-1): the split pane's own End builds the target of the session it
 * shows (Issue #1171) and hands it to `onRequestSessionEnd`; the stub does the same with
 * its props.
 */
vi.mock('@/components/worktree/TerminalSplitPaneContent', () => ({
  TerminalSplitPaneContent: ({
    cliToolId,
    instanceId,
    onRequestSessionEnd,
  }: {
    cliToolId: string;
    instanceId: string;
    onRequestSessionEnd?: (target: { cliToolId: string; instanceId: string; label: string }) => void;
  }) => (
    <button type="button" data-testid={`split-end-${instanceId}`} onClick={() => onRequestSessionEnd?.({ cliToolId, instanceId, label: 'Review agent' })}>
      end {instanceId}
    </button>
  ),
}));
vi.mock('@/components/worktree/FileTreeView', () => ({ FileTreeView: () => <div data-testid="file-tree-view" /> }));
vi.mock('@/components/worktree/GitPane', () => ({ GitPane: () => <div data-testid="git-pane" /> }));
vi.mock('@/components/worktree/VerificationPane', () => ({ VerificationPane: () => <div data-testid="verification-pane" /> }));

const { useTerminalPanePollingMock, useSplitMessagesMock } = vi.hoisted(() => ({
  useTerminalPanePollingMock: vi.fn(),
  useSplitMessagesMock: vi.fn(),
}));
vi.mock('@/hooks/useTerminalPanePolling', () => ({ useTerminalPanePolling: useTerminalPanePollingMock }));
vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: useSplitMessagesMock,
  SPLIT_MESSAGES_POLL_INTERVAL_MS: 5000,
}));

vi.mock('@/lib/handoff/close-rule', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/handoff/close-rule')>();
  return {
    ...actual,
    subscribeHandoffStore: (listener: () => void) => {
      const unsubscribe = actual.subscribeHandoffStore(listener);
      return () => {
        unsubscribe();
        if (rule.perInstance) actual.resetHandoffStoreForTests();
      };
    },
  };
});

import { WorktreeDetailRefactored } from '@/components/worktree/WorktreeDetailRefactored';
import { resetHandoffStoreForTests } from '@/lib/handoff/close-rule';
import { publishMemWriteLock } from '@/components/mem/mem-write-lock';

const A = 'wt-a';
const B = 'wt-b';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    url: 'http://localhost/api/worktrees',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

let posts: { worktree: string; path: string }[];
let decideLost: boolean;
let holdB: boolean;
let releaseB: (() => void) | null;

const request = () => ({
  id: 'r1',
  worktreeId: A,
  instanceId: 'claude',
  cliToolId: 'claude',
  branch: 'feat/x',
  detached: false,
  state: 'reviewing',
  sendState: 'sent',
  endForced: false,
  endToken: null,
  outcome: null,
  outcomeReason: null,
  agentDeadlineAt: '2026-11-10T00:05:00.000Z',
  extensions: 0,
  expiresAt: '2026-11-10T01:00:00.000Z',
  agentDoneAt: '2026-11-10T00:01:00.000Z',
  endedAt: null,
  agentTimedOut: false,
  version: 3,
});
const handoffView = () => ({
  ok: true,
  request: request(),
  proposals: [
    {
      id: 'p1', op: 'add', itemId: null, kind: 'note', baseVersion: null, revision: 1, fingerprint: 'fp-p1',
      state: 'proposed', stateReason: null, payload: { text: 'text of p1' }, current: null, appliedItemId: null, appliedVersion: null,
    },
  ],
  direct: [],
});
const worktreeBody = (id: string) => ({
  id,
  name: `feature/${id}`,
  path: `/tmp/${id}`,
  repositoryPath: '/tmp/repo',
  repositoryName: 'CommandMate',
  selectedAgents: ['claude'],
  agentInstances: [{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }],
  sessionStatusByCli: { claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false } },
  sessionStatusByInstance: { claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false } },
});

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState({}, '', `/worktrees/${A}`);
  env.mobile = false;
  rule.perInstance = false;
  posts = [];
  decideLost = true;
  holdB = false;
  releaseB = null;
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: '', realtimeSnippet: '', isRunning: true, isThinking: false,
      sessionStatus: 'ready', isSelectionListActive: false, isPagerActive: false,
      isUnclassifiedActive: false, composerText: '', attaching: false, autoScroll: true,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false },
    agentSession: { session: null, context: null, diff: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(),
  });
  useSplitMessagesMock.mockReturnValue({ messages: [], isLoading: false, refresh: vi.fn(() => Promise.resolve()) });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const u = String(input);
      const method = init?.method ?? 'GET';
      const match = /^\/api\/worktrees\/([^/?]+)([^?]*)/.exec(u);
      const worktree = match ? decodeURIComponent(match[1]) : '';
      const rest = match ? match[2] : u;
      if (method === 'POST') posts.push({ worktree, path: rest });
      if (rest === '/mem/mode') return jsonResponse({ ok: true, mode: 'on', features: { popup: true } });
      if (rest === '/kill-session') return jsonResponse({ success: true, message: 'ok' });
      if (rest === '/send') return jsonResponse({ id: 'm1' }, 201);
      if (rest === '/mem/handoff/requests' && method === 'POST') {
        if (worktree !== A) return jsonResponse({ ok: false, code: 'session_unknown' }, 409);
        return jsonResponse({ ...handoffView(), text: 'the request text' }, 201);
      }
      if (rest.startsWith('/mem/handoff/requests/r1')) {
        if (rest.endsWith('/decide') && decideLost) throw new TypeError('Failed to fetch');
        return jsonResponse(handoffView());
      }
      if (rest.startsWith('/mem')) return jsonResponse({ ok: true, items: [] });
      if (u.includes('/current-output')) {
        return jsonResponse({ isRunning: true, fullOutput: '', realtimeSnippet: '', thinking: false, isPromptWaiting: false, promptData: null });
      }
      if (u.includes('/messages')) return jsonResponse([]);
      if (worktree === B && rest === '' && holdB) await new Promise<void>((resolve) => (releaseB = resolve));
      return jsonResponse(worktreeBody(worktree || A));
    }),
  );
});

afterEach(() => {
  releaseB?.();
  publishMemWriteLock('mem-items', null);
  resetHandoffStoreForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

/**
 * The page as `AppShell` draws it: under another parent for PC and phone, so a turn makes the page
 * anew. `pageKey` stands for Next's key of the page by its `[id]`.
 */
function Shell({ id, pageKey }: { id: string; pageKey?: string }) {
  const mobile = useSyncExternalStore(
    (listener: () => void) => {
      env.listeners.add(listener);
      return () => env.listeners.delete(listener);
    },
    () => env.mobile
  );
  const page = <WorktreeDetailRefactored key={pageKey} worktreeId={id} />;
  return mobile ? <div data-testid="shell-phone">{page}</div> : <section data-testid="shell-pc">{page}</section>;
}

/** The width falls under the breakpoint (a turn of the device, a resize). */
function turnToPhone(): void {
  act(() => {
    env.mobile = true;
    for (const listener of [...env.listeners]) listener();
  });
}

const creates = () => posts.filter((post) => post.path === '/mem/handoff/requests');

/** A's page, its End, the hand-off, and (if `unknown`) a decide whose result is unknown. */
async function openOnA(unknown: boolean) {
  const view = render(<Shell id={A} />);
  fireEvent.click(await screen.findByTestId('desktop-kill-session'));
  fireEvent.click(await screen.findByTestId('handoff-approve-p1'));
  if (unknown) {
    fireEvent.click(screen.getByTestId('handoff-confirm'));
    await screen.findByTestId('handoff-pending');
  }
  return view;
}

describe('[#4227 pr2e] the real page draws the dialog again: the unit stays', () => {
  it('PC → phone while unknown: a new instance in the phone branch, the unit kept, one request', async () => {
    await openOnA(true);
    expect(screen.getByTestId('handoff-dialog')).toHaveAttribute('data-layout', 'desktop');
    turnToPhone();
    await waitFor(() => expect(screen.getByTestId('handoff-dialog')).toHaveAttribute('data-layout', 'mobile'));
    expect(screen.queryByTestId('desktop-kill-session')).toBeNull();
    expect(screen.getByTestId('handoff-pending')).toBeTruthy();
    expect(screen.getByTestId('handoff-pending-resend')).not.toBeDisabled();
    expect(creates()).toHaveLength(1);
  });

  it('a switch to B through the Loading (B’s read held) while unknown: kept as A’s, no request on B', async () => {
    const view = await openOnA(true);
    holdB = true;
    view.rerender(<Shell id={B} />);
    await waitFor(() => expect(releaseB).not.toBeNull());
    // G10: the Loading no longer takes the dialog out — it is drawn, as A's, while B is read.
    await waitFor(() => expect(screen.queryByTestId('desktop-kill-session')).toBeNull());
    expect(screen.getByTestId('handoff-dialog')).toBeTruthy();
    expect(screen.getByTestId('handoff-foreign')).toBeTruthy();
    await act(async () => releaseB?.());
    expect(await screen.findByTestId('handoff-foreign')).toBeTruthy();
    expect(screen.getByTestId('handoff-pending')).toBeTruthy();
    expect(screen.getByTestId('handoff-pending-elsewhere')).toBeTruthy();
    expect(creates()).toHaveLength(1);
    expect(posts.filter((post) => post.worktree === B && post.path.startsWith('/mem/handoff'))).toHaveLength(0);
  });

  it('(negative control) nothing held: the switch through the Loading closes the hand-off', async () => {
    const view = await openOnA(false);
    holdB = true;
    view.rerender(<Shell id={B} />);
    await waitFor(() => expect(releaseB).not.toBeNull());
    await act(async () => releaseB?.());
    await screen.findByTestId('desktop-kill-session');
    expect(screen.queryByTestId('handoff-dialog')).toBeNull();
    expect(creates()).toHaveLength(1);
  });

  it('(positive control) the units in the component’s life: PC → phone loses the unit and makes a second request', async () => {
    await openOnA(true);
    rule.perInstance = true;
    turnToPhone();
    await waitFor(() => expect(creates()).toHaveLength(2));
    expect(screen.queryByTestId('handoff-pending')).toBeNull();
  });

  it('(positive control) the units in the component’s life: the Loading loses the unit; B gets a request of its own', async () => {
    const view = await openOnA(true);
    rule.perInstance = true;
    holdB = true;
    view.rerender(<Shell id={B} pageKey={B} />);
    await waitFor(() => expect(releaseB).not.toBeNull());
    await act(async () => releaseB?.());
    await waitFor(() => expect(posts.filter((post) => post.worktree === B && post.path === '/mem/handoff/requests')).toHaveLength(1));
    expect(screen.queryByTestId('handoff-pending')).toBeNull();
  });
});
