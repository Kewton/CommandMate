/**
 * ChatSurface wiring on both screens (Issue #2194).
 *
 * `ChatSurface`'s own suite proves the surface behaves; this proves the two
 * surfaces actually FEED it. That is a separate failure mode with no overlap: a
 * pane that renders `<ChatSurface live={{}} />` passes every test in
 * `ChatSurface-2194.test.tsx` and ships a chat surface that never notices a
 * selection list.
 *
 * The prompt flags are the part most likely to be wired wrong, because
 * `useTerminalPanePolling` does NOT return an `isPromptWaiting` — it folds
 * `isPromptWaiting && promptData` into `prompt.visible` and returns that. Feeding
 * the surface from `prompt.visible` / `prompt.data` is what makes "a wait nobody
 * could read" reachable at all, so both screens are checked for it.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { getSplitSurfaceModeStorageKey, getMobileSurfaceModeStorageKey } from '@/config/surface-mode-config';
import { UNCLASSIFIED_PROMPT_TYPE } from '@/types/models';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

beforeAll(() => installRadixJsdomPolyfills());

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: () => <div data-testid="terminal-display" />,
}));

vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: ({ messages }: { messages: Array<{ id: string }> }) => (
    <div data-testid="chat-transcript" data-message-count={String(messages.length)}>
      <div data-testid="chat-transcript-scroll-container" />
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

vi.mock('@/components/worktree/HistoryPane', () => ({
  HistoryPane: ({ messages }: { messages: Array<{ id: string }> }) => (
    <div data-testid="history-pane" data-message-count={String(messages.length)}>
      <div data-testid="history-scroll-container" />
    </div>
  ),
  splitHistorySlotId: (idx: number) => `split-history-slot-${idx}`,
}));

vi.mock('@/components/worktree/MessageInput', () => ({
  MessageInput: ({ splitIndex }: { splitIndex?: number }) => (
    <div data-testid={`message-input-${splitIndex ?? 0}`} />
  ),
}));

vi.mock('@/components/worktree/NavigationButtons', () => ({
  NavigationButtons: () => <div data-testid="navigation-buttons" />,
}));

vi.mock('@/components/worktree/TerminalEscapeHatch', () => ({
  TerminalEscapeHatch: () => <div data-testid="terminal-escape-hatch" />,
}));

vi.mock('@/components/worktree/PromptPanel', () => ({
  PromptPanel: ({ visible }: { visible: boolean }) =>
    visible ? <div data-testid="prompt-panel" /> : null,
}));

vi.mock('@/components/worktree/AutoYesToggle', () => ({
  AutoYesToggle: () => <div data-testid="auto-yes-toggle" />,
}));

vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: () => ({
    messages: [{ id: 'm1' }],
    isLoading: false,
    refresh: vi.fn(() => Promise.resolve()),
  }),
}));

vi.mock('@/hooks/useHistoryPaneState', () => ({
  useHistoryPaneState: () => ({ visible: true, width: 40, toggle: vi.fn(), setWidth: vi.fn() }),
  DEFAULT_HISTORY_WIDTH: 40,
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
  MOBILE_BREAKPOINT: 768,
}));

const { useTerminalPanePollingMock } = vi.hoisted(() => ({
  useTerminalPanePollingMock: vi.fn(),
}));
vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: useTerminalPanePollingMock,
}));

import { TerminalSplitPaneContent } from '@/components/worktree/TerminalSplitPaneContent';
import { MobileTerminalTab } from '@/components/worktree/MobileTerminalTab';

const WORKTREE_ID = 'wt-2194-wiring';

interface PaneOverrides {
  isRunning?: boolean;
  isThinking?: boolean;
  isSelectionListActive?: boolean;
  isPagerActive?: boolean;
  isUnclassifiedActive?: boolean;
  promptVisible?: boolean;
  promptData?: unknown;
}

function mockPane(overrides: PaneOverrides = {}): void {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: 'frame',
      realtimeSnippet: 'frame',
      isRunning: overrides.isRunning ?? false,
      isThinking: overrides.isThinking ?? false,
      isSelectionListActive: overrides.isSelectionListActive ?? false,
      isPagerActive: overrides.isPagerActive ?? false,
      isUnclassifiedActive: overrides.isUnclassifiedActive ?? false,
      composerText: '',
      attaching: false,
      autoScroll: true,
    },
    prompt: {
      visible: overrides.promptVisible ?? false,
      data: overrides.promptData ?? null,
      messageId: null,
      answering: false,
    },
    agentSession: { session: null, context: null, diff: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(() => Promise.resolve()),
  });
}

const UNREADABLE_PROMPT = {
  type: UNCLASSIFIED_PROMPT_TYPE,
  status: 'unclassified',
  question: 'Unreadable frame',
  options: [],
  dwellSeconds: 12,
  sessionStatusReason: 'running/default',
};

const ANSWERABLE_PROMPT = {
  type: 'yes_no',
  question: 'Proceed?',
  options: [
    { number: 1, label: 'Yes' },
    { number: 2, label: 'No' },
  ],
};

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
  mockPane();
  global.fetch = vi.fn(() =>
    Promise.resolve({ ok: true, json: async () => ({}) }),
  ) as unknown as typeof fetch;
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

afterEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/');
});

// ---------------------------------------------------------------------------
// PC split
// ---------------------------------------------------------------------------

function inst(cliTool: CLIToolType): AgentInstance {
  return { id: cliTool, cliTool, alias: cliTool, order: 0 };
}

function renderSplitInChat() {
  window.localStorage.setItem(getSplitSurfaceModeStorageKey(WORKTREE_ID, 0), 'chat');
  return render(
    <TerminalSplitPaneContent
      worktreeId={WORKTREE_ID}
      splitIndex={0}
      cliToolId="claude"
      availableInstances={[inst('claude'), inst('codex')]}
      onInstanceChange={vi.fn()}
      onFocus={vi.fn()}
      autoYes={{ onToggle: vi.fn() }}
    />,
  );
}

describe('[#2194] PC split feeds the chat surface', () => {
  it('mounts ChatSurface as the chat body', async () => {
    renderSplitInChat();
    await waitFor(() => expect(screen.getByTestId('chat-surface')).toBeInTheDocument());
    expect(screen.getByTestId('chat-surface')).toHaveAttribute('data-instance-id', 'claude');
  });

  it('raises the banner for a selection list, and the button switches the surface', async () => {
    mockPane({ isSelectionListActive: true, isRunning: true });
    renderSplitInChat();

    await waitFor(() => {
      expect(screen.getByTestId('chat-surface-terminal-banner')).toHaveAttribute(
        'data-reason',
        'selectionList',
      );
    });

    fireEvent.click(screen.getByTestId('chat-surface-open-terminal'));

    await waitFor(() => expect(screen.getByTestId('terminal-display')).toBeInTheDocument());
    expect(screen.queryByTestId('chat-surface')).not.toBeInTheDocument();
    // ...and the choice is persisted, exactly as the header toggle persists it.
    expect(window.localStorage.getItem(getSplitSurfaceModeStorageKey(WORKTREE_ID, 0))).toBe(
      'terminal',
    );
  });

  it('raises the banner for a wait whose payload nobody could parse', async () => {
    mockPane({ promptVisible: true, promptData: UNREADABLE_PROMPT });
    renderSplitInChat();

    await waitFor(() => {
      expect(screen.getByTestId('chat-surface-terminal-banner')).toHaveAttribute(
        'data-reason',
        'promptUnreadable',
      );
    });
  });

  it('leaves an answerable wait to the composer prompt panel', async () => {
    mockPane({ promptVisible: true, promptData: ANSWERABLE_PROMPT });
    renderSplitInChat();

    await waitFor(() => expect(screen.getByTestId('chat-surface')).toBeInTheDocument());
    // The prompt panel is still on screen in chat mode (#2193) and the surface
    // adds nothing beside it.
    expect(screen.getByTestId('prompt-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-surface-terminal-banner')).not.toBeInTheDocument();
  });

  it('shows the generating row while a turn runs with no pending pair', async () => {
    mockPane({ isRunning: true });
    renderSplitInChat();
    // The mocked history is a single row with no role, so there is no pending
    // pair for `ConversationPairCard` to own the indicator for.
    await waitFor(() => expect(screen.getByTestId('chat-surface-generating')).toBeInTheDocument());
  });

  it('adds nothing to the terminal surface', async () => {
    mockPane({ isSelectionListActive: true });
    render(
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
    await waitFor(() => expect(screen.getByTestId('terminal-display')).toBeInTheDocument());
    expect(screen.queryByTestId('chat-surface')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-surface-terminal-banner')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Mobile tab
// ---------------------------------------------------------------------------

function renderMobileInChat() {
  window.localStorage.setItem(getMobileSurfaceModeStorageKey(WORKTREE_ID), 'chat');
  return render(<MobileTerminalTab worktreeId={WORKTREE_ID} cliToolId="claude" instanceId="claude-2" />);
}

describe('[#2194] mobile terminal tab feeds the chat surface', () => {
  it('mounts ChatSurface as the chat body', async () => {
    renderMobileInChat();
    await waitFor(() => expect(screen.getByTestId('chat-surface')).toBeInTheDocument());
    expect(screen.getByTestId('chat-surface')).toHaveAttribute('data-instance-id', 'claude-2');
  });

  it('raises the banner for a pager, and the button switches the surface', async () => {
    mockPane({ isPagerActive: true, isSelectionListActive: true, isRunning: true });
    renderMobileInChat();

    await waitFor(() => {
      expect(screen.getByTestId('chat-surface-terminal-banner')).toHaveAttribute(
        'data-reason',
        'pager',
      );
    });

    fireEvent.click(screen.getByTestId('chat-surface-open-terminal'));

    await waitFor(() => expect(screen.getByTestId('terminal-display')).toBeInTheDocument());
    expect(window.localStorage.getItem(getMobileSurfaceModeStorageKey(WORKTREE_ID))).toBe(
      'terminal',
    );
  });

  it('raises the banner for an unclassified frame', async () => {
    mockPane({ isUnclassifiedActive: true, isRunning: true });
    renderMobileInChat();
    await waitFor(() => {
      expect(screen.getByTestId('chat-surface-terminal-banner')).toHaveAttribute(
        'data-reason',
        'unclassified',
      );
    });
  });

  it('adds nothing to the terminal surface', async () => {
    mockPane({ isUnclassifiedActive: true });
    render(<MobileTerminalTab worktreeId={WORKTREE_ID} cliToolId="claude" />);
    await waitFor(() => expect(screen.getByTestId('terminal-display')).toBeInTheDocument());
    expect(screen.queryByTestId('chat-surface')).not.toBeInTheDocument();
  });
});
