/**
 * The split's History column has no vertical strip any more (Issue #2259).
 *
 * Hiding the column used to leave a 36px `w-9` bar carrying a second "show
 * history" button — 108px of terminal width at three splits, spent duplicating
 * a toggle the Action bar already owns, and pointing RIGHT in both directions
 * (the same glyph hid it and reopened it). This file pins the two halves of the
 * replacement: nothing renders beside the terminal, and the terminal is
 * explicitly the full width of the row.
 *
 * It also pins the broadcast the Action bar depends on: the bar disables its
 * History toggle while every split is in chat mode, and it learns about a mode
 * change from a CustomEvent — a same-window `localStorage.setItem` fires no
 * `storage` event, so without the emit the bar would stay stale until remount.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TerminalSplitPaneContent } from '@/components/worktree/TerminalSplitPaneContent';
import { SURFACE_MODE_CHANGE_EVENT } from '@/hooks/useSplitSurfaceModes';
import { getSplitSurfaceModeStorageKey } from '@/config/surface-mode-config';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

beforeAll(() => installRadixJsdomPolyfills());

function inst(cliTool: CLIToolType): AgentInstance {
  return { id: cliTool, cliTool, alias: cliTool, order: 0 };
}

/** Mutable so each test can drive the column's visibility. */
const historyState = {
  visible: true,
  width: 40,
  toggle: vi.fn(),
  setWidth: vi.fn(),
};

vi.mock('@/hooks/useHistoryPaneState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useHistoryPaneState')>();
  return {
    ...actual,
    useHistoryPaneState: () => historyState,
  };
});

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

vi.mock('@/components/worktree/HistoryPane', () => ({
  HistoryPane: () => <div data-testid="history-pane" />,
  splitHistorySlotId: (idx: number) => `split-history-slot-${idx}`,
}));

vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: () => <div data-testid="chat-transcript" />,
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: () => ({
    messages: [{ id: 'm1', content: 'hello' }],
    isLoading: false,
    refresh: vi.fn(() => Promise.resolve()),
  }),
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
  MOBILE_BREAKPOINT: 768,
}));

const WORKTREE_ID = 'wt-2259';

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

describe('[#2259] the split History column has no vertical strip', () => {
  beforeEach(() => {
    historyState.visible = true;
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

  it('renders the column and its resizer while visible', () => {
    render(renderSplit(0));

    expect(screen.getByTestId('split-history-slot-0')).toBeInTheDocument();
    expect(screen.getByTestId('split-terminal-slot-0')).toBeInTheDocument();
    // Column + resizer + terminal.
    expect(screen.getByTestId('split-terminal-row-0').children).toHaveLength(3);
  });

  it('renders no expand strip when the column is hidden', () => {
    historyState.visible = false;
    render(renderSplit(0));

    expect(screen.queryByTestId('split-history-slot-0')).not.toBeInTheDocument();
    expect(screen.queryByTestId('split-history-expand-bar-0')).not.toBeInTheDocument();
    expect(screen.queryByTestId('split-history-expand-0')).not.toBeInTheDocument();
  });

  it('gives the terminal 100% of the split when the column is hidden', () => {
    historyState.visible = false;
    render(renderSplit(0));

    const row = screen.getByTestId('split-terminal-row-0');
    const terminal = screen.getByTestId('split-terminal-slot-0');
    // The terminal is the row's ONLY child — a `w-9` strip beside it would make
    // this 2 and cost the terminal 36px.
    expect(row.children).toHaveLength(1);
    expect(row.children[0]).toBe(terminal);
    expect(terminal.style.width).toBe('100%');
  });

  it('leaves the width to the column while it is visible', () => {
    render(renderSplit(0));
    // Not 100%: the column and the resizer are beside it.
    expect(screen.getByTestId('split-terminal-slot-0').style.width).toBe('');
    expect(screen.getByTestId('split-history-slot-0').style.width).toBe('40%');
  });

  it('announces a surface-mode change so the Action bar can re-evaluate', () => {
    const heard: Array<{ splitIndex: number; mode: string; worktreeId: string }> = [];
    const listener = (event: Event) => {
      heard.push((event as CustomEvent).detail);
    };
    window.addEventListener(SURFACE_MODE_CHANGE_EVENT, listener);
    try {
      render(renderSplit(0));
      fireEvent.click(screen.getByTestId('surface-mode-chat-0'));
    } finally {
      window.removeEventListener(SURFACE_MODE_CHANGE_EVENT, listener);
    }

    expect(heard).toContainEqual({
      worktreeId: WORKTREE_ID,
      splitIndex: 0,
      mode: 'chat',
    });
    // The persisted value the bar reads on mount agrees with what was announced.
    expect(
      window.localStorage.getItem(getSplitSurfaceModeStorageKey(WORKTREE_ID, 0)),
    ).toBe('chat');
  });
});
