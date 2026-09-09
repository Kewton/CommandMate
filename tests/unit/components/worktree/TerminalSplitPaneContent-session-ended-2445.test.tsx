/**
 * The PC split copies `attaching` into the chat surface's `live` (Issue #2445).
 *
 * The mirror of `MobileTerminalTab-session-ended-2445.test.tsx`. Both
 * components build `ChatSurfaceLiveState` field by field, and both have already
 * dropped a newly added field once (`isDismissablePanelActive`, #2369 → #2373).
 * The field this Issue adds cannot be dropped quietly: `useTerminalPanePolling`
 * starts every pane at `{ isRunning: false, attaching: true }`, so a surface
 * that never receives `attaching` cannot tell "tmux says there is no session"
 * from "nobody has asked tmux yet".
 *
 * `ChatTranscript` is the REAL component here, so what is asserted is the fold
 * and the banner the reader actually gets, from the polled state the split
 * actually holds — and each assertion has its opposite in the same file, driven
 * from the same mock.
 *
 * The split is also where Issue #2445's archived rule bites hardest: this
 * component shares ONE `useSplitMessages` result between the History column and
 * the chat surface, `includeArchived` and all, so turning "show archived" on in
 * the browser used to push retired rows into the conversation.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import { TerminalSplitPaneContent } from '@/components/worktree/TerminalSplitPaneContent';
import { getSplitSurfaceModeStorageKey } from '@/config/surface-mode-config';
import {
  CHAT_PREVIOUS_SESSION_TOGGLE_TESTID,
  CHAT_SESSION_ENDED_BANNER_TESTID,
} from '@/components/worktree/ChatTranscript';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

beforeAll(() => installRadixJsdomPolyfills());

function inst(cliTool: CLIToolType): AgentInstance {
  return { id: cliTool, cliTool, alias: cliTool, order: 0 };
}

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: ({ output }: { output: string }) => (
    <div data-testid="terminal-display">{output}</div>
  ),
}));

vi.mock('@/components/worktree/MessageInput', () => ({
  MessageInput: ({ splitIndex }: { splitIndex: number }) => (
    <div data-testid={`message-input-${splitIndex}`} />
  ),
}));

vi.mock('@/components/worktree/AutoYesToggle', () => ({
  AutoYesToggle: () => <div data-testid="auto-yes-toggle" />,
}));

vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    groups: [], filteredGroups: [], allCommands: [], loading: false,
    error: null, filter: '', setFilter: vi.fn(), refresh: vi.fn(),
  }),
}));

vi.mock('@/components/worktree/HistoryPane', () => ({
  HistoryPane: () => <div data-testid="history-pane" />,
  splitHistorySlotId: (idx: number) => `split-history-slot-${idx}`,
}));

vi.mock('@/hooks/useHistoryPaneState', () => ({
  useHistoryPaneState: () => ({ visible: true, width: 40, toggle: vi.fn(), setWidth: vi.fn() }),
  DEFAULT_HISTORY_WIDTH: 40,
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
  MOBILE_BREAKPOINT: 768,
}));

const { useTerminalPanePollingMock, useSplitMessagesMock } = vi.hoisted(() => ({
  useTerminalPanePollingMock: vi.fn(),
  useSplitMessagesMock: vi.fn(),
}));
vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: (...args: unknown[]) => useTerminalPanePollingMock(...args),
  UNCLASSIFIED_CONFIRMATION_COUNT: 2,
  UNCLASSIFIED_CONFIRMATION_DELAY_MS: 500,
}));
vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: (...args: unknown[]) => useSplitMessagesMock(...args),
}));

const WORKTREE_ID = 'wt-2445-split';

function msg(id: string, role: ChatMessage['role'], extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role,
    content: `content-${id}`,
    timestamp: new Date('2026-09-09T10:00:00Z'),
    messageType: 'normal',
    archived: false,
    cliToolId: 'claude',
    ...extra,
  };
}

const CONVERSATION = [msg('u1', 'user'), msg('a1', 'assistant')];

/** The pane, as the polling hook reports it. Defaults to a HEALTHY session. */
function mockPane(extra: Record<string, unknown> = {}): void {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: '',
      realtimeSnippet: '',
      isRunning: true,
      isThinking: false,
      sessionStatus: 'ready',
      isSelectionListActive: false,
      isPagerActive: false,
      isDismissablePanelActive: false,
      isUnclassifiedActive: false,
      composerText: '',
      attaching: false,
      autoScroll: true,
      ...extra,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false },
    agentSession: { session: null, context: null, diff: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(),
  });
}

function mockMessages(messages: ChatMessage[]): void {
  useSplitMessagesMock.mockReturnValue({ messages, isLoading: false, refresh: vi.fn() });
}

function renderSplit() {
  window.localStorage.setItem(getSplitSurfaceModeStorageKey(WORKTREE_ID, 0), 'chat');
  return render(
    <TerminalSplitPaneContent
      worktreeId={WORKTREE_ID}
      splitIndex={0}
      cliToolId="claude"
      availableInstances={[inst('claude')]}
      onInstanceChange={vi.fn()}
      onFocus={vi.fn()}
      autoYes={{ onToggle: vi.fn() }}
    />,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  global.fetch = vi.fn(() =>
    Promise.resolve({ ok: true, json: async () => ({}) }),
  ) as unknown as typeof fetch;
  mockPane();
  mockMessages(CONVERSATION);
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('[#2445] the split folds the previous session from its own polled state', () => {
  it('folds the rows and draws the banner for a pane tmux says is gone', async () => {
    mockPane({ isRunning: false, sessionStatus: 'idle' });
    renderSplit();

    await waitFor(() =>
      expect(screen.getByTestId(CHAT_PREVIOUS_SESSION_TOGGLE_TESTID)).toHaveAttribute(
        'data-count',
        '2',
      ),
    );
    expect(screen.getByTestId(CHAT_SESSION_ENDED_BANNER_TESTID)).toBeInTheDocument();
    expect(document.querySelector('[data-row-message-id="a1"]')).toBeNull();
  });

  it('draws neither before the first poll has been applied', async () => {
    mockPane({ isRunning: false, attaching: true });
    renderSplit();

    await waitFor(() => expect(screen.getByTestId('chat-transcript')).toBeInTheDocument());
    expect(screen.queryByTestId(CHAT_PREVIOUS_SESSION_TOGGLE_TESTID)).toBeNull();
    expect(screen.queryByTestId(CHAT_SESSION_ENDED_BANNER_TESTID)).toBeNull();
    expect(document.querySelector('[data-row-message-id="a1"]')).not.toBeNull();
  });

  it('draws neither while the session is up', async () => {
    renderSplit();

    await waitFor(() => expect(screen.getByTestId('chat-transcript')).toBeInTheDocument());
    expect(screen.queryByTestId(CHAT_PREVIOUS_SESSION_TOGGLE_TESTID)).toBeNull();
    expect(screen.queryByTestId(CHAT_SESSION_ENDED_BANNER_TESTID)).toBeNull();
  });

  it('names this split in the fold’s aria-controls', async () => {
    // Up to four of these mount side by side; a shared id would point every
    // split's button at the first split's rows.
    mockPane({ isRunning: false, sessionStatus: 'idle' });
    renderSplit();

    const toggle = await screen.findByTestId(CHAT_PREVIOUS_SESSION_TOGGLE_TESTID);
    const regionId = toggle.getAttribute('aria-controls')!;
    expect(regionId).toContain('-0');
    expect(document.getElementById(regionId)).not.toBeNull();
  });

  it('keeps the shared fetch’s archived rows out of the conversation', async () => {
    // The History column and this surface read ONE `useSplitMessages` result,
    // `includeArchived: showArchived` included. History still renders them; the
    // chat surface must not.
    mockMessages([...CONVERSATION, msg('old', 'assistant', { archived: true })]);
    renderSplit();

    await waitFor(() => expect(screen.getByTestId('chat-transcript')).toBeInTheDocument());
    expect(document.querySelector('[data-row-message-id="old"]')).toBeNull();
    expect(document.querySelector('[data-row-message-id="a1"]')).not.toBeNull();
  });
});
