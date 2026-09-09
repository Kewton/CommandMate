/**
 * The phone copies `attaching` into the chat surface's `live` (Issue #2445).
 *
 * Half of the wiring guard; `TerminalSplitPaneContent-session-ended-2445.test.tsx`
 * is the other. Both components build `ChatSurfaceLiveState` by listing fields
 * one at a time, and that list has now dropped a newly added field twice
 * (`isDismissablePanelActive`, #2369 → #2373). This time the cost of dropping it
 * would be worse than a card looking wrong: `useTerminalPanePolling` starts
 * every pane at `{ isRunning: false, attaching: true }`, so a surface that never
 * receives `attaching` sees `undefined` — and the fold would be gated on a
 * flag whose absence is indistinguishable from "the session is up".
 *
 * ## What makes this suite non-vacuous
 *
 * `ChatTranscript` is the REAL component here, so the fold and the banner are
 * the actual ones the reader gets, driven from the actual polled state. And the
 * assertions run in both directions from the SAME mock: the pane says
 * `attaching: true` and nothing appears, it says `attaching: false` and the
 * fold appears, it says `isRunning: true` and the fold goes away again.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';
import { getMobileSurfaceModeStorageKey } from '@/config/surface-mode-config';
import {
  CHAT_PREVIOUS_SESSION_TOGGLE_TESTID,
  CHAT_SESSION_ENDED_BANNER_TESTID,
} from '@/components/worktree/ChatTranscript';

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: () => <div data-testid="terminal-display" />,
}));

const { useTerminalPanePollingMock, useSplitMessagesMock } = vi.hoisted(() => ({
  useTerminalPanePollingMock: vi.fn(),
  useSplitMessagesMock: vi.fn(),
}));
vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: useTerminalPanePollingMock,
}));
vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: useSplitMessagesMock,
}));

import { MobileTerminalTab } from '@/components/worktree/MobileTerminalTab';

const WORKTREE_ID = 'wt-2445-mobile';
const STORAGE_KEY = getMobileSurfaceModeStorageKey(WORKTREE_ID);

function msg(id: string, role: ChatMessage['role']): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role,
    content: `content-${id}`,
    timestamp: new Date('2026-09-09T10:00:00Z'),
    messageType: 'normal',
    archived: false,
    cliToolId: 'claude',
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
  useSplitMessagesMock.mockReturnValue({
    messages: CONVERSATION,
    isLoading: false,
    refresh: vi.fn(),
  });
}

function renderTab() {
  window.localStorage.setItem(STORAGE_KEY, 'chat');
  return render(<MobileTerminalTab worktreeId={WORKTREE_ID} cliToolId="claude" />);
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) }),
  );
  mockPane();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('[#2445] the phone tab folds the previous session from its own polled state', () => {
  it('folds the rows and draws the banner for a pane tmux says is gone', async () => {
    mockPane({ isRunning: false, sessionStatus: 'idle' });
    renderTab();

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
    // `attaching: true` with the hook's own initial `isRunning: false` — the
    // shape every page load passes through. Without the copied field this is
    // indistinguishable from the case above.
    mockPane({ isRunning: false, attaching: true });
    renderTab();

    await waitFor(() => expect(screen.getByTestId('chat-transcript')).toBeInTheDocument());
    expect(screen.queryByTestId(CHAT_PREVIOUS_SESSION_TOGGLE_TESTID)).toBeNull();
    expect(screen.queryByTestId(CHAT_SESSION_ENDED_BANNER_TESTID)).toBeNull();
    expect(document.querySelector('[data-row-message-id="a1"]')).not.toBeNull();
  });

  it('draws neither while the session is up', async () => {
    renderTab();

    await waitFor(() => expect(screen.getByTestId('chat-transcript')).toBeInTheDocument());
    expect(screen.queryByTestId(CHAT_PREVIOUS_SESSION_TOGGLE_TESTID)).toBeNull();
    expect(screen.queryByTestId(CHAT_SESSION_ENDED_BANNER_TESTID)).toBeNull();
  });

  it('keeps archived rows off the chat surface', async () => {
    // The phone does not pass `includeArchived`, so this is defence for the day
    // it does — and the rule the PC needs, stated on both screens.
    useSplitMessagesMock.mockReturnValue({
      messages: [...CONVERSATION, msg('old', 'assistant')].map((m) =>
        m.id === 'old' ? { ...m, archived: true } : m,
      ),
      isLoading: false,
      refresh: vi.fn(),
    });
    renderTab();

    await waitFor(() => expect(screen.getByTestId('chat-transcript')).toBeInTheDocument());
    expect(document.querySelector('[data-row-message-id="old"]')).toBeNull();
    expect(document.querySelector('[data-row-message-id="a1"]')).not.toBeNull();
  });
});
