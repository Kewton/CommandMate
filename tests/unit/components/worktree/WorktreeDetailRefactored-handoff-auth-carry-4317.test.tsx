/**
 * The session's expiry held over the pages (Issue #4317 PR1, `@/lib/handoff/page-registration`; the
 * pre-review `prereview-4317-reply.md` 2). A page made while the session is expired starts with its
 * own `isAuthExpired` false and draws its Loading; that false is not a recovery. The dialog stays
 * undrawn (unmounted, never hidden with `isOpen={false}`: the opening and its unit stay) until the
 * current page's authenticated read succeeds — then the same opening's dialog is drawn again and
 * nothing is made or sent again.
 *
 * Positive control (the code before #4317 PR1): the page made again during the expiry draws the
 * dialog over its Loading — the first case fails. Negative control: recovery on the same unit.
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
import { handoffRegistrySnapshot, resetHandoffRegistryForTests } from '@/lib/handoff/page-registration';
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
let detailHeld = false;
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
  detailHeld = false;
  resetHandoffRegistryForTests();
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
      if (match && rest === '' && detailHeld) {
        return new Promise<Response>((resolve) =>
          held.push(() => resolve(detailStatus === 401 ? jsonResponse({ error: 'unauthorized' }, 401) : jsonResponse(worktreeBody(worktree || A)))),
        );
      }
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

describe('[#4317 PR1] the expiry over the pages: a page made again is not a recovery', () => {
  it('expired, the page made again (its first read not answered yet): its Loading is drawn without the dialog, the opening stays', async () => {
    const { own, sending } = openingWithUnknownDecide();
    detailStatus = 401;
    const first = render(<Page id={A} />);
    await settle();
    expect(document.querySelector('[data-testid="worktree-detail-session-expired"]')).not.toBeNull();
    first.unmount();

    // The page made again: its own expiry starts false, and its read is held.
    detailHeld = true;
    render(<Page id={A} />);
    await settle();
    expect(document.querySelector('[data-testid="handoff-dialog"]')).toBeNull();
    expect(document.querySelector('[role="dialog"], [aria-modal="true"]')).toBeNull();
    expect(handoffStoreSnapshot().opening?.token).toBe(own.token);
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
    expect(handoffUnitsOf(A).pending).toBe(sending);
    expect(handoffRegistrySnapshot().authExpired).toBe(true);

    // Its read answers 401 again: still not drawn.
    await act(async () => {
      for (const release of held.splice(0)) release();
    });
    await settle();
    expect(document.querySelector('[data-testid="handoff-dialog"]')).toBeNull();
  });

  it('(negative control) expired, the page made again, its read succeeds: the same opening and unit are drawn again, nothing made or sent again', async () => {
    const { own, sending } = openingWithUnknownDecide();
    detailStatus = 401;
    const first = render(<Page id={A} />);
    await settle();
    first.unmount();

    detailHeld = true;
    detailStatus = 200;
    render(<Page id={A} />);
    await settle();
    expect(document.querySelector('[data-testid="handoff-dialog"]')).toBeNull();
    await act(async () => {
      for (const release of held.splice(0)) release();
    });
    await settle();
    await vi.waitFor(() => expect(document.querySelector('[data-testid="handoff-dialog"]')).not.toBeNull());
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
    expect(handoffStoreSnapshot().opening?.token).toBe(own.token);
    expect(handoffUnitsOf(A).pending).toBe(sending);
    expect(creates()).toHaveLength(0);
    expect(sends()).toHaveLength(0);
  });

  it('the old page’s answer after it was left does not recover the page come to', async () => {
    openingWithUnknownDecide();
    detailStatus = 401;
    const first = render(<Page id={A} />);
    await settle();
    // The old page's next read is held, the page is left, and its read answers 200 afterwards.
    detailHeld = true;
    detailStatus = 200;
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((done) => setTimeout(done, 50));
    });
    const oldReads = held.splice(0);
    expect(oldReads.length).toBeGreaterThan(0);
    first.unmount();
    detailStatus = 401;
    render(<Page id={A} />);
    await settle();
    detailStatus = 200;
    await act(async () => {
      for (const release of oldReads) release();
    });
    await settle();
    expect(document.querySelector('[data-testid="handoff-dialog"]')).toBeNull();
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
  });

  it('(再指示 2) the current page’s 401, then its Retry (back to the foreground): not drawn until the read succeeds, then the same opening and unit', async () => {
    const { own, sending } = openingWithUnknownDecide();
    detailStatus = 401;
    render(<Page id={A} />);
    await settle();
    expect(document.querySelector('[data-testid="worktree-detail-session-expired"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="handoff-dialog"]')).toBeNull();

    // The Retry clears the page's own expiry before its read, which is held: still not drawn.
    detailHeld = true;
    detailStatus = 200;
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((done) => setTimeout(done, 50));
    });
    expect(held.length).toBeGreaterThan(0);
    expect(document.querySelector('[data-testid="handoff-dialog"]')).toBeNull();
    expect(handoffRegistrySnapshot().authExpired).toBe(true);

    await act(async () => {
      for (const release of held.splice(0)) release();
    });
    await settle();
    await vi.waitFor(() => expect(document.querySelector('[data-testid="handoff-dialog"]')).not.toBeNull());
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
    expect(handoffStoreSnapshot().opening?.token).toBe(own.token);
    expect(handoffUnitsOf(A).pending).toBe(sending);
    expect(creates()).toHaveLength(0);
    expect(sends()).toHaveLength(0);
  });
});
