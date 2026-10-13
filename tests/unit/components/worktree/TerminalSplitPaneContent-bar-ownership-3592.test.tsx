/**
 * Issue #3592 (second contract): with one split, the split's controls live in
 * the action bar — outside the pane's subtree — and still belong to the split.
 * The split's own chords resolve their owner through `[data-split-index]`
 * (`splitOwnsKeyEvent`), so the moved controls carry the mark too: Mod+Shift+M
 * typed in the bar's note editor switches Terminal / Chat exactly as it does
 * from the note editor in a split's title bar.
 *
 * @vitest-environment jsdom
 */

import React, { useMemo, useState } from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { TerminalSplitPaneContent } from '@/components/worktree/TerminalSplitPaneContent';
import {
  SplitHeaderSlotsProvider,
  type SplitHeaderSlots,
} from '@/components/worktree/SplitPaneHeaderControls';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
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
  MessageInput: ({ splitIndex, autoYesSlot }: { splitIndex: number; autoYesSlot?: React.ReactNode }) => (
    <div data-testid={`message-input-${splitIndex}`}>{autoYesSlot}</div>
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

vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    groups: [], filteredGroups: [], allCommands: [], loading: false,
    error: null, filter: '', setFilter: vi.fn(), refresh: vi.fn(),
  }),
}));

// The HistoryPane mock records whether it was handed a collapse affordance:
// the embedded column gets one, the output surface must NOT (collapsing the
// output would leave the split showing nothing).
vi.mock('@/components/worktree/HistoryPane', () => ({
  HistoryPane: ({
    splitIndex,
    cliToolId,
    messages,
    onCollapse,
  }: {
    splitIndex?: number;
    cliToolId?: string;
    messages: Array<{ id: string }>;
    onCollapse?: () => void;
  }) => (
    <div
      data-testid="history-pane"
      data-split-index={String(splitIndex)}
      data-cli-tool-id={cliToolId}
      data-message-count={String(messages.length)}
      data-collapsible={String(onCollapse != null)}
    />
  ),
  splitHistorySlotId: (idx: number) => `split-history-slot-${idx}`,
}));

// Issue #2232: the chat surface's body is `ChatTranscript`, not `HistoryPane`.
// Both mocks are needed here because this file drives BOTH modes, and the
// property under test is which BODY fills the output box: `TerminalDisplay` or
// the transcript. Since #2446 the History column is beside either one, so
// `history-pane` is present in both modes and cannot stand in for the mode.
vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: ({
    splitIndex,
    cliToolId,
    messages,
  }: {
    splitIndex?: number;
    cliToolId?: string;
    messages: Array<{ id: string }>;
  }) => (
    <div
      data-testid="chat-transcript"
      data-split-index={String(splitIndex)}
      data-cli-tool-id={cliToolId}
      data-message-count={String(messages.length)}
    />
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: () => ({
    messages: [{ id: 'm1', content: 'hello' }],
    isLoading: false,
    refresh: vi.fn(() => Promise.resolve()),
  }),
}));

// History column visible in both modes. Issue #2446: chat mode no longer hides
// it, so what this pins is that the SAME column is on screen either way — the
// mock's `visible: true` is the shared `useHistoryPaneState` value both rows
// read.
vi.mock('@/hooks/useHistoryPaneState', () => ({
  useHistoryPaneState: () => ({
    visible: true,
    width: 40,
    toggle: vi.fn(),
    setWidth: vi.fn(),
  }),
  DEFAULT_HISTORY_WIDTH: 40,
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
  MOBILE_BREAKPOINT: 768,
}));

const WORKTREE_ID = 'wt-3592';

function renderSplit(splitIndex: number) {
  return (
    <TerminalSplitPaneContent
      worktreeId={WORKTREE_ID}
      splitIndex={splitIndex}
      cliToolId="claude"
      availableInstances={[inst('claude'), inst('codex')]}
      onInstanceChange={vi.fn()}
      onFocus={vi.fn()}
      autoYes={{ onToggle: vi.fn() }}
    />
  );
}

/** The action bar's two slots, as `TerminalSplitContainer` provides them with one split. */
function InActionBar({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<HTMLDivElement | null>(null);
  const [actions, setActions] = useState<HTMLDivElement | null>(null);
  const slots = useMemo<SplitHeaderSlots | null>(
    () => (session && actions ? { session, actions } : null),
    [session, actions],
  );
  return (
    <>
      <div data-testid="bar">
        <div ref={setSession} />
        <div ref={setActions} />
      </div>
      <SplitHeaderSlotsProvider value={slots}>{children}</SplitHeaderSlotsProvider>
    </>
  );
}

const MOD_SHIFT_M = { key: 'M', ctrlKey: true, shiftKey: true };

describe('[#3592] the split owns its controls in the action bar', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({ isRunning: true, fullOutput: 'tmux frame', thinking: false }),
      }),
    ) as unknown as typeof fetch;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, '', '/');
  });

  it('Mod+Shift+M in the bar\'s note editor switches the split to Chat (positive)', async () => {
    render(<InActionBar>{renderSplit(0)}</InActionBar>);
    fireEvent.click(screen.getByTestId('split-session-note-edit-0'));
    const input = screen.getByTestId('split-session-note-input-0');
    expect(screen.getByTestId('terminal-split-pane-0').contains(input)).toBe(false);

    fireEvent.keyDown(input, MOD_SHIFT_M);

    await waitFor(() => {
      expect(screen.getByTestId('split-chat-slot-0')).toBeInTheDocument();
    });
  });

  it('does the same from a split\'s own title bar (negative: unchanged)', async () => {
    render(renderSplit(0));
    fireEvent.keyDown(screen.getByTestId('cli-selector-0'), MOD_SHIFT_M);

    await waitFor(() => {
      expect(screen.getByTestId('split-chat-slot-0')).toBeInTheDocument();
    });
  });

  it('still stands down for a text field outside every split (negative)', () => {
    render(<InActionBar>{renderSplit(0)}</InActionBar>);
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    try {
      fireEvent.keyDown(outside, MOD_SHIFT_M);
      expect(screen.queryByTestId('split-chat-slot-0')).toBeNull();
      expect(screen.getByTestId('terminal-display')).toBeInTheDocument();
    } finally {
      outside.remove();
    }
  });
});
