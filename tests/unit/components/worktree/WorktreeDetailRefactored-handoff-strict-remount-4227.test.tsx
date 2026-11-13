/**
 * G10 (Issue #4227 G-PR4; the UAT of G-PR3, 差し戻し 4): on the dev server (React StrictMode) the
 * hand-off dialog waiting for the agent (no unit) was gone for 0.1〜1 s after a switch of worktree
 * and back. Next keys the page by its `[id]`, so A → B → A makes the page — the real
 * `WorktreeDetailRefactored`, its real controller and the real `SessionHandoffDialog` — anew.
 *
 * Two gaps, both closed by G10:
 * - the controller's target started at null and was set by an effect, so the page's first commit
 *   had no dialog;
 * - the page's Loading (a cache miss, its first read held here by a deferred promise) returned
 *   the Loading alone, without the dialog.
 *
 * Recorded per case: every render of the controller (its worktree, target and loading) and, at
 * every commit of the page (a `Profiler`'s `onRender`, called in the commit after the DOM is
 * written), whether the dialog is in the document.
 *
 * Positive control (the code before G10): the cases "back on A" fail — A's first render has no
 * target, and with the first read held no commit has the dialog.
 * Negative controls: on B, A's opening without a unit is not taken back (the takeBack rule is
 * unchanged); the opening is the same and nothing is made or sent again.
 *
 * @vitest-environment jsdom
 */

import React, { Profiler, StrictMode } from 'react';
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
const B = 'wt-b';
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
      // The page's first read of the worktree (its detail) is held: deferred until the test ends.
      if (match && rest === '') await new Promise<void>((resolve) => held.push(resolve));
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

/** A's opening waiting for the agent: made, its text sent (the dialog's ① done before A → B). */
function awaitingOnA() {
  const opening = beginHandoffOpening(A, TARGET);
  patchHandoffOpening(opening.token, { created: 'done', view: awaitingView() as unknown as HandoffReadResponse, text: 'the request text' });
  return opening;
}

/** The page as Next draws it: keyed by its `[id]`, under StrictMode (dev, `reactStrictMode: true`). */
function Page({ id }: { id: string }) {
  nav.path = `/worktrees/${id}`;
  return (
    <StrictMode>
      <Profiler
        id="page"
        onRender={() => {
          trace.commits.push({
            phase: trace.phase,
            dialog: document.querySelector('[data-testid="handoff-dialog"]') !== null,
            foreign: document.querySelector('[data-testid="handoff-foreign"]') !== null,
          });
        }}
      >
        <WorktreeDetailRefactored key={id} worktreeId={id} />
        <HandoffDialogHost />
      </Profiler>
    </StrictMode>
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });
}

/** key=A → key=B → key=A; nothing is released meanwhile (a cache miss stays in its Loading). */
async function aThenBThenA(): Promise<void> {
  trace.phase = 'A1';
  const view = render(<Page id={A} />);
  await settle();
  trace.phase = 'B';
  view.rerender(<Page id={B} />);
  await settle();
  trace.phase = 'A2';
  view.rerender(<Page id={A} />);
  await settle();
}

const rendersOf = (phase: string) => trace.renders.filter((r) => r.phase === phase);
const commitsOf = (phase: string) => trace.commits.filter((c) => c.phase === phase);
const creates = () => posts.filter((post) => post.path === '/mem/handoff/requests');
const sends = () => posts.filter((post) => post.path === '/send');

describe.each([
  ['(a) a cache hit', true],
  ['(b) a cache miss, the first read held', false],
])('[#4227 G10] StrictMode, the page made anew A → B → A: %s', (_name, cacheHit) => {
  beforeEach(() => {
    trace.cacheHit = cacheHit;
  });

  it('waiting for the agent (no unit): back on A, every render has the target and every commit the dialog', async () => {
    const own = awaitingOnA();
    await aThenBThenA();

    const back = rendersOf('A2');
    expect(back.length).toBeGreaterThan(0);
    expect(back.every((r) => r.id === A && r.loading === !cacheHit)).toBe(true);
    expect(back.map((r) => r.target)).toEqual(back.map(() => 'claude'));
    expect(commitsOf('A2').length).toBeGreaterThan(0);
    expect(commitsOf('A2').map((c) => c.dialog)).toEqual(commitsOf('A2').map(() => true));
    // The first mount on A draws it from its first commit too.
    expect(commitsOf('A1').map((c) => c.dialog)).toEqual(commitsOf('A1').map(() => true));

    // (negative control) on B, A's opening without a unit is not taken back (the rule unchanged).
    expect(rendersOf('B').every((r) => r.id === B && r.target === null)).toBe(true);
    expect(commitsOf('B').every((c) => !c.dialog)).toBe(true);

    // The same opening, still open; nothing made or sent again.
    expect(handoffStoreSnapshot().opening?.token).toBe(own.token);
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
    expect(creates()).toHaveLength(0);
    expect(sends()).toHaveLength(0);
  });

  it('a decide whose result is unknown: on B it is A’s (foreign) in every commit, back on A its own in every commit', async () => {
    const own = awaitingOnA();
    const sending = startHandoffDecide({ worktreeId: A, requestId: 'r1', ifVersion: 1, decisions: [] });
    expect(sending).not.toBeNull();
    settleHandoffDecide(sending!, 'unknown');
    await aThenBThenA();

    expect(rendersOf('B').map((r) => r.target)).toEqual(rendersOf('B').map(() => 'claude'));
    expect(commitsOf('B').map((c) => c.dialog && c.foreign)).toEqual(commitsOf('B').map(() => true));
    expect(rendersOf('A2').map((r) => r.target)).toEqual(rendersOf('A2').map(() => 'claude'));
    expect(commitsOf('A2').map((c) => c.dialog && !c.foreign)).toEqual(commitsOf('A2').map(() => true));

    expect(handoffStoreSnapshot().opening?.token).toBe(own.token);
    expect(handoffUnitsOf(A).pending).toBe(sending);
    expect(creates()).toHaveLength(0);
    expect(sends()).toHaveLength(0);
    expect(posts.filter((post) => post.worktree === B)).toHaveLength(0);
  });
});
