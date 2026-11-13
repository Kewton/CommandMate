/**
 * Issue #4345 1c: the real worktree page (`WorktreeDetailRefactored`) hands its registration holder
 * to what it draws (`HandoffPageOwnerContext`), on the PC and the phone alike, and the phone's own
 * decision answer (`/respond` from the prompt sheet) reports its 401 through the gateway under it.
 * Drawn with the one host (`HandoffDialogHost`), so the dialog's hiding and its return are seen.
 *
 * Positive controls (red before 1c: no holder was handed down; the phone's `/respond` reported
 * nothing): the holder the split / phone surfaces read is the page's current registration; the
 * sheet's `/respond` answering 401 expires the session, the host draws nothing, the opening stays,
 * and the page's next detail read's success brings it back.
 * Negative controls: a 403 of the same answer leaves the session as it is and the sheet still
 * says it was not answered (the existing toast path: the sheet stays up).
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { getMobileSurfaceModeStorageKey } from '@/config/surface-mode-config';

const W = 'wt-4345';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/worktrees/wt-4345',
  useSearchParams: () => new URLSearchParams(),
}));
const { mobile } = vi.hoisted(() => ({ mobile: { current: true } }));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => mobile.current, MOBILE_BREAKPOINT: 768 }));
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
vi.mock('@/hooks/useFileTabs', () => ({
  useFileTabs: () => [
    { tabs: [], activeIndex: null },
    { dispatch: vi.fn(), openFile: vi.fn().mockReturnValue('opened'), closeTab: vi.fn(), activateTab: vi.fn(), onFileRenamed: vi.fn(), onFileDeleted: vi.fn(), moveToFront: vi.fn() },
  ],
}));
vi.mock('@/components/error/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/worktree/TerminalDisplay', () => ({ TerminalDisplay: () => <div data-testid="terminal-display" /> }));
vi.mock('@/components/worktree/FileTreeView', () => ({ FileTreeView: () => <div data-testid="file-tree-view" /> }));
vi.mock('@/components/worktree/HistoryPane', () => ({
  HistoryPane: () => <div data-testid="history-pane" />,
  splitHistorySlotId: (idx: number) => `split-history-slot-${idx}`,
}));
vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: () => <div data-testid="chat-transcript"><div data-testid="chat-transcript-scroll-container" /></div>,
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));
vi.mock('@/components/worktree/NavigationButtons', () => ({ NavigationButtons: () => <div data-testid="navigation-buttons" /> }));

// The split's and the phone's own pollers, standing in: each render writes down the holder it reads.
const { owners, useTerminalPanePollingMock, useSplitMessagesMock } = vi.hoisted(() => ({
  owners: [] as unknown[],
  useTerminalPanePollingMock: vi.fn(),
  useSplitMessagesMock: vi.fn(),
}));
vi.mock('@/hooks/useTerminalPanePolling', () => ({ useTerminalPanePolling: useTerminalPanePollingMock }));
vi.mock('@/hooks/useSplitMessages', () => ({ useSplitMessages: useSplitMessagesMock, SPLIT_MESSAGES_POLL_INTERVAL_MS: 5000 }));

import { WorktreeDetailRefactored } from '@/components/worktree/WorktreeDetailRefactored';
import { HandoffDialogHost } from '@/components/mem/HandoffDialogHost';
import { useHandoffPageOwner } from '@/hooks/useHandoffPageOwner';
import { beginHandoffOpening, handoffStoreSnapshot, patchHandoffOpening, resetHandoffStoreForTests, type HandoffOpeningToken } from '@/lib/handoff/close-rule';
import { currentHandoffPage, handoffRegistrySnapshot, resetHandoffRegistryForTests } from '@/lib/handoff/page-registration';
import type { HandoffReadResponse } from '@/lib/handoff/types';

const DECISION_ID = 'per_0000000000000000000000000';
let respondStatus: number;
let respondCalls: number;
let detailQueued: boolean;
let detailQueue: Array<() => void>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const readView = {
  ok: true,
  request: {
    id: 'r1', worktreeId: W, instanceId: 'claude', cliToolId: 'claude', branch: 'feat/x', detached: false,
    state: 'awaiting_agent', sendState: 'sent', endForced: false, endToken: null, outcome: null, outcomeReason: null,
    agentDeadlineAt: '2026-11-10T00:05:00.000Z', extensions: 0, expiresAt: '2026-11-10T01:00:00.000Z',
    agentDoneAt: null, endedAt: null, agentTimedOut: false, version: 1,
  },
  proposals: [],
  direct: [],
};
const detailBody = {
  id: W, name: 'feature/4345', path: '/tmp/wt', repositoryPath: '/tmp/repo', repositoryName: 'CommandMate',
  selectedAgents: ['claude', 'codex'],
  agentInstances: [
    { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
    { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 },
  ],
  sessionStatusByCli: { claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false } },
  sessionStatusByInstance: { claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false } },
};

function installFetch(): void {
  global.fetch = vi.fn(async (input: unknown) => {
    const u = String(input);
    if (u.includes('/mem/mode')) return jsonResponse({ ok: true, mode: 'on', features: { popup: true } });
    if (u.includes('/mem/handoff/requests/r1')) return jsonResponse(readView);
    if (u.endsWith('/respond')) {
      respondCalls += 1;
      return respondStatus === 200 ? jsonResponse({ success: true }) : jsonResponse({ error: 'x' }, respondStatus);
    }
    if (u.includes('/current-output')) {
      return jsonResponse({
        isRunning: true, fullOutput: 'row', realtimeSnippet: 'row', thinking: false, sessionStatus: 'ready',
        isSelectionListActive: false, isPagerActive: false, isUnclassifiedActive: false,
        isPromptWaiting: true,
        promptData: {
          type: 'multiple_choice', question: 'Allow?', status: 'pending', decisionId: DECISION_ID,
          options: [{ number: 1, label: 'Allow once', isDefault: true }, { number: 2, label: 'Reject', isDefault: false }],
        },
      });
    }
    if (u.includes('/auto-yes')) return jsonResponse({ instances: {} });
    if (u.includes('/messages')) return jsonResponse([]);
    if (u.includes('/tasks')) return jsonResponse({ tasks: [] });
    if (u.includes('/verify/runs')) return jsonResponse({ runs: [] });
    if (u === `/api/worktrees/${W}` && detailQueued) {
      return new Promise<Response>((resolve) => detailQueue.push(() => resolve(jsonResponse(detailBody))));
    }
    if (u === `/api/worktrees/${W}`) return jsonResponse(detailBody);
    return jsonResponse({});
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  mobile.current = true;
  owners.length = 0;
  respondStatus = 200;
  respondCalls = 0;
  detailQueued = false;
  detailQueue = [];
  resetHandoffRegistryForTests();
  resetHandoffStoreForTests();
  window.localStorage.clear();
  window.localStorage.setItem(getMobileSurfaceModeStorageKey(W), 'chat');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  useTerminalPanePollingMock.mockImplementation(() => {
    owners.push(useHandoffPageOwner().current);
    return {
      terminal: {
        output: 'row', realtimeSnippet: 'row', isRunning: true, isThinking: false, sessionStatus: 'ready',
        isSelectionListActive: false, isPagerActive: false, isUnclassifiedActive: false, composerText: '', attaching: false, autoScroll: true,
      },
      prompt: { visible: false, data: null, messageId: null, answering: false },
      agentSession: { session: null, context: null, diff: null },
      setAutoScroll: vi.fn(), setPromptAnswering: vi.fn(), clearPrompt: vi.fn(), refresh: vi.fn(),
    };
  });
  useSplitMessagesMock.mockImplementation(() => {
    owners.push(useHandoffPageOwner().current);
    return { messages: [], isLoading: false, refresh: vi.fn(() => Promise.resolve()) };
  });
  installFetch();
});
afterEach(() => {
  for (const release of detailQueue.splice(0)) release();
  cleanup();
  vi.restoreAllMocks();
  resetHandoffStoreForTests();
  resetHandoffRegistryForTests();
});

const dialog = () => document.querySelector('[data-testid="handoff-dialog"]');
const settle = () => act(async () => new Promise((done) => setTimeout(done, 0)));

function openingOfW(): HandoffOpeningToken {
  const own = beginHandoffOpening(W, { cliToolId: 'claude', instanceId: 'claude', label: 'Claude' });
  patchHandoffOpening(own.token, { created: 'done', view: readView as unknown as HandoffReadResponse, text: 'the request text' });
  return own.token;
}

async function renderPage(): Promise<void> {
  render(
    <>
      <WorktreeDetailRefactored worktreeId={W} />
      <HandoffDialogHost />
    </>,
  );
  await waitFor(() => expect(currentHandoffPage()).not.toBeNull());
  await waitFor(() => expect(owners.length).toBeGreaterThan(0));
  await settle();
}

async function answerOnSheet(): Promise<void> {
  const sheet = await screen.findByTestId('mobile-prompt-sheet');
  await waitFor(() => expect(within(sheet).getByRole('button', { name: 'prompt.submit' })).toBeEnabled());
  fireEvent.click(within(sheet).getByRole('button', { name: 'prompt.submit' }));
  await waitFor(() => expect(respondCalls).toBeGreaterThan(0));
  await settle();
}

describe('[#4345 1c] the page hands its registration holder to what it draws', () => {
  it.each([['the phone', true], ['the PC', false]] as const)('%s: the surfaces read the page’s current registration', async (_name, isMobile) => {
    mobile.current = isMobile;
    await renderPage();
    const current = currentHandoffPage()?.id;
    expect(current).toBeDefined();
    await waitFor(() => expect(owners[owners.length - 1]).toBe(current));
  });
});

describe('[#4345 1c] the phone’s decision answer (/respond)', () => {
  it('answers 401: expired, hidden, the opening kept; the next detail read’s success brings it back', async () => {
    const token = openingOfW();
    await renderPage();
    await waitFor(() => expect(dialog()).not.toBeNull());
    detailQueued = true;
    respondStatus = 401;
    await answerOnSheet();
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
    expect(dialog()).toBeNull();
    expect(handoffStoreSnapshot().opening?.token).toBe(token);
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
    // The page's own detail poll answers 200: the one recovery.
    respondStatus = 200;
    await waitFor(() => expect(detailQueue.length).toBeGreaterThan(0), { timeout: 8000 });
    await act(async () => {
      for (const release of detailQueue.splice(0)) release();
    });
    await settle();
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
    await waitFor(() => expect(dialog()).not.toBeNull());
    expect(handoffStoreSnapshot().opening?.token).toBe(token);
  }, 15000);

  it('(negative control) answers 403: the session as it was, the sheet still up', async () => {
    openingOfW();
    await renderPage();
    await waitFor(() => expect(dialog()).not.toBeNull());
    respondStatus = 403;
    await answerOnSheet();
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
    expect(dialog()).not.toBeNull();
    expect(screen.getByTestId('mobile-prompt-sheet')).toBeInTheDocument();
  });
});
