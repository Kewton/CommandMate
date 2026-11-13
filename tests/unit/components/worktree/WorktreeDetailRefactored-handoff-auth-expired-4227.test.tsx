/**
 * G10b (Issue #4227 G-PR4; codex P2-1): while the session is expired (a read answered 401) the page
 * shows its re-login notice. The hand-off dialog, kept over the Loading by G10, must not be drawn
 * then: its modal would cover the re-login button and hold the focus, and a decide whose result is
 * unknown refuses to close. The opening and its unit stay in the store; once a read succeeds
 * again ON THE SAME PAGE, the same unit's dialog is drawn again (nothing is made or sent again).
 *
 * Scope of the guarantee (G10c, codex-2 P2-1 (b)): "the same page, the session comes back" only.
 * The re-login button is a HARD navigation (`window.location.href = '/login'`), after which the
 * page and the in-memory hand-off store are built anew, so the unit does not survive it. That is
 * the same before G10 (fd2f4a589): the store has no persistence. Keeping the unit across a hard
 * navigation is a new requirement (recorded on #4289), not something G10 took away.
 *
 * Controls: (1) 401 → the notice's button is reachable, no dialog / modal in the document;
 * (2) the session comes back on the same page (a read succeeds): the dialog of the same opening and unit is back;
 * (3) the unit (an unknown decide) is in the store throughout, and the dialog back is the unit's;
 * (4) the re-login button's hard navigation: the in-memory store is empty afterwards (unchanged by G10).
 * Negative control: with the session healthy the dialog is drawn (G10's own cases stay).
 * Positive control (the code before G10b): the dialog was drawn over the notice (case 1 fails).
 *
 * @vitest-environment jsdom
 */

import React, { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';

const trace = vi.hoisted(() => ({
  phase: '',
  renders: [] as { phase: string; id: string; target: string | null; loading: boolean }[],
  commits: [] as { phase: string; dialog: boolean; foreign: boolean }[],
  cacheHit: false,
}));

// Issue #4317 PR2: the path follows the page drawn (the dialog's host reads the detail route from it).
const nav = vi.hoisted(() => ({ path: '/worktrees/wt-a' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => nav.path,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false, MOBILE_BREAKPOINT: 768 }));
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
vi.mock('@/components/worktree/TerminalDisplay', () => ({ TerminalDisplay: () => <div data-testid="terminal-display" /> }));
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
  return { ...actual, TerminalSplitContainer: () => <div data-testid="split-container" /> };
});
vi.mock('@/components/worktree/FileTreeView', () => ({ FileTreeView: () => <div data-testid="file-tree-view" /> }));
vi.mock('@/components/worktree/GitPane', () => ({ GitPane: () => <div data-testid="git-pane" /> }));
vi.mock('@/components/worktree/VerificationPane', () => ({ VerificationPane: () => <div data-testid="verification-pane" /> }));

const { useTerminalPanePollingMock, useSplitMessagesMock } = vi.hoisted(() => ({
  useTerminalPanePollingMock: vi.fn(),
  useSplitMessagesMock: vi.fn(),
}));
vi.mock('@/hooks/useTerminalPanePolling', () => ({ useTerminalPanePolling: useTerminalPanePollingMock }));
vi.mock('@/hooks/useSplitMessages', () => ({ useSplitMessages: useSplitMessagesMock, SPLIT_MESSAGES_POLL_INTERVAL_MS: 5000 }));

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

// (a) a cache hit: the list already holds the worktree, the page draws without its Loading.
// (b) a cache miss: the page's Loading until its first read (held here) answers.
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () =>
    trace.cacheHit
      ? { worktrees: [worktreeBody('wt-a'), worktreeBody('wt-b')], repositories: [], isLoading: false, error: null, refresh: vi.fn() }
      : null,
}));

// The real controller; each render's worktree, target and loading are written down.
vi.mock('@/hooks/useWorktreeDetailController', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useWorktreeDetailController')>();
  return {
    ...actual,
    useWorktreeDetailController: (args: { worktreeId: string }) => {
      const controller = actual.useWorktreeDetailController(args);
      trace.renders.push({
        phase: trace.phase,
        id: args.worktreeId,
        target: controller.handoffTarget?.instanceId ?? null,
        loading: controller.loading,
      });
      return controller;
    },
  };
});

import { WorktreeDetailRefactored } from '@/components/worktree/WorktreeDetailRefactored';
// Issue #4317 PR2: the dialog's one host is beside the shell (`AppShellGate`), outside the page Next
// keys by its `[id]`; drawn here beside the keyed page as the root layout does.
import { HandoffDialogHost } from '@/components/mem/HandoffDialogHost';
import {
  beginHandoffOpening,
  handoffStoreSnapshot,
  handoffUnitsOf,
  patchHandoffOpening,
  resetHandoffStoreForTests,
  settleHandoffDecide,
  startHandoffDecide,
} from '@/lib/handoff/close-rule';
import type { HandoffReadResponse } from '@/lib/handoff/types';

const A = 'wt-a';
const TARGET = { cliToolId: 'claude' as const, instanceId: 'claude', label: 'Claude' };

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

const awaitingView = () => ({
  ok: true,
  request: {
    id: 'r1', worktreeId: A, instanceId: 'claude', cliToolId: 'claude', branch: 'feat/x', detached: false,
    state: 'awaiting_agent', sendState: 'sent', endForced: false, endToken: null, outcome: null, outcomeReason: null,
    agentDeadlineAt: '2026-11-10T00:05:00.000Z', extensions: 0, expiresAt: '2026-11-10T01:00:00.000Z',
    agentDoneAt: null, endedAt: null, agentTimedOut: false, version: 1,
  },
  proposals: [],
  direct: [],
});

let detailStatus = 200;
let posts: { worktree: string; path: string }[];
let held: (() => void)[];

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState({}, '', `/worktrees/${A}`);
  resetHandoffStoreForTests();
  trace.phase = '';
  trace.renders = [];
  trace.commits = [];
  trace.cacheHit = false;
  detailStatus = 200;
  posts = [];
  held = [];
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
      if (rest.startsWith('/mem/handoff/requests')) return jsonResponse(awaitingView());
      if (rest.startsWith('/mem')) return jsonResponse({ ok: true, items: [] });
      if (u.includes('/current-output')) {
        return jsonResponse({ isRunning: true, fullOutput: '', realtimeSnippet: '', thinking: false, isPromptWaiting: false, promptData: null });
      }
      if (u.includes('/messages')) return jsonResponse([]);
      // The page's read of the worktree (its detail) answers 401 while `detailStatus` says so.
      if (match && rest === '' && detailStatus === 401) return jsonResponse({ error: 'unauthorized' }, 401);
      return jsonResponse(worktreeBody(worktree || A));
    }),
  );
});

afterEach(async () => {
  await act(async () => {
    for (const release of held.splice(0)) release();
  });
  resetHandoffStoreForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

/** The page as Next draws it (StrictMode, keyed by its `[id]`), no Profiler. */
function Page({ id }: { id: string }) {
  nav.path = `/worktrees/${id}`;
  return (
    <StrictMode>
      <WorktreeDetailRefactored key={id} worktreeId={id} />
      <HandoffDialogHost />
    </StrictMode>
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });
}

/** The page recovering by itself: the tab comes back to the foreground and the reads run again. */
async function recover(): Promise<void> {
  detailStatus = 200;
  await act(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((done) => setTimeout(done, 50));
  });
  await settle();
}

const creates = () => posts.filter((post) => post.path === '/mem/handoff/requests');
const sends = () => posts.filter((post) => post.path === '/send');

/** A's opening waiting for the agent with a decide whose result is unknown (a close is refused). */
function openingWithUnknownDecide() {
  const own = beginHandoffOpening(A, TARGET);
  patchHandoffOpening(own.token, { created: 'done', view: awaitingView() as unknown as HandoffReadResponse, text: 'the request text' });
  const sending = startHandoffDecide({ worktreeId: A, requestId: 'r1', ifVersion: 1, decisions: [] });
  expect(sending).not.toBeNull();
  settleHandoffDecide(sending!, 'unknown');
  return { own, sending: sending! };
}

describe('[#4227 G10b] an expired session: the re-login comes before the hand-off dialog', () => {
  beforeEach(() => {
    trace.cacheHit = false;
  });

  it('401 → the re-login notice is reached: its button is in the document and no dialog or modal covers it (no focus trap)', async () => {
    openingWithUnknownDecide();
    detailStatus = 401;
    render(<Page id={A} />);
    await settle();

    const notice = document.querySelector('[data-testid="worktree-detail-session-expired"]');
    expect(notice).not.toBeNull();
    const button = document.querySelector('[data-testid="worktree-detail-relogin"]') as HTMLElement;
    expect(button).not.toBeNull();
    expect(document.querySelector('[data-testid="handoff-dialog"]')).toBeNull();
    expect(document.querySelector('[role="dialog"], [aria-modal="true"]')).toBeNull();
    // Nothing is inert or hidden around the button, and it takes the focus.
    expect(button.closest('[inert], [aria-hidden="true"]')).toBeNull();
    button.focus();
    expect(document.activeElement).toBe(button);
  });

  it('after the session comes back on the same page (a read succeeds) the dialog of the same unit is drawn again, and nothing is made or sent again', async () => {
    const { own } = openingWithUnknownDecide();
    detailStatus = 401;
    render(<Page id={A} />);
    await settle();
    expect(document.querySelector('[data-testid="handoff-dialog"]')).toBeNull();

    await recover();
    expect(document.querySelector('[data-testid="worktree-detail-session-expired"]')).toBeNull();
    expect(document.querySelector('[data-testid="handoff-dialog"]')).not.toBeNull();
    // It is A's own opening (not foreign) and the same one.
    expect(document.querySelector('[data-testid="handoff-foreign"]')).toBeNull();
    expect(handoffStoreSnapshot().opening?.token).toBe(own.token);
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
    expect(creates()).toHaveLength(0);
    expect(sends()).toHaveLength(0);
  });

  it('the unit is not lost while the session is expired on the same page, and the dialog back holds it (a close is still refused)', async () => {
    const { own, sending } = openingWithUnknownDecide();
    detailStatus = 401;
    render(<Page id={A} />);
    await settle();
    expect(handoffUnitsOf(A).pending).toBe(sending);
    expect(handoffStoreSnapshot().opening?.token).toBe(own.token);
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);

    await recover();
    expect(handoffUnitsOf(A).pending).toBe(sending);
    expect(document.querySelector('[data-testid="handoff-dialog"]')).not.toBeNull();
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
  });

  it('(hard navigation) the re-login button navigates away for real, and the in-memory store of the next page is empty: the unit does not survive it (the same before G10)', async () => {
    const { own } = openingWithUnknownDecide();
    detailStatus = 401;
    const loc = { href: '/worktrees/wt-a' };
    vi.stubGlobal('location', loc);
    render(<Page id={A} />);
    await settle();
    const button = document.querySelector('[data-testid="worktree-detail-relogin"]') as HTMLElement;
    expect(button).not.toBeNull();
    await act(async () => {
      button.click();
    });
    // The click assigned `location.href`: a hard navigation (not router.push).
    expect(loc.href).toBe('/login');
    expect(handoffStoreSnapshot().opening?.token).toBe(own.token);

    // What the browser does with a hard navigation: every module is loaded anew. The next page's store is empty.
    vi.resetModules();
    const fresh = await import('@/lib/handoff/close-rule');
    expect(fresh.handoffStoreSnapshot().opening).toBeNull();
    expect(fresh.handoffUnitsOf(A).pending).toBeNull();
  });

  it('(negative control) a healthy session draws the dialog as before', async () => {
    openingWithUnknownDecide();
    render(<Page id={A} />);
    await settle();
    expect(document.querySelector('[data-testid="worktree-detail-session-expired"]')).toBeNull();
    expect(document.querySelector('[data-testid="handoff-dialog"]')).not.toBeNull();
  });
});
