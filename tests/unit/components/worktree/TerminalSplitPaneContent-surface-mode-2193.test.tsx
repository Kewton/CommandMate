/**
 * PC output-surface switching (Issue #2193).
 *
 * The split's output half swaps between `TerminalDisplay` and the split's own
 * transcript — `ChatTranscript` since Issue #2232, `HistoryPane` before it.
 * Three properties are load-bearing and each has a way of quietly regressing:
 *
 *  1. In chat mode the transcript must appear ONCE. The pane already embeds a
 *     collapsible History column, so the obvious implementation shows the same
 *     messages twice side by side.
 *  2. The mode is per split. A single shared key would flip both panes at once,
 *     which defeats the reason splits exist.
 *  3. The INPUT half is untouched. Composer, Auto-Yes and the prompt panel keep
 *     rendering in chat mode — that is what makes the surfaces interchangeable
 *     mid-turn rather than two separate screens.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { TerminalSplitPaneContent } from '@/components/worktree/TerminalSplitPaneContent';
import { getSplitSurfaceModeStorageKey } from '@/config/surface-mode-config';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';
import { TOOLTIP_DELAY_MS } from '@/components/common/Tooltip';

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
// Both mocks are needed here because this file drives BOTH modes — the History
// column in terminal mode, the transcript in chat mode — and the property under
// test is that exactly one transcript is on screen in each.
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

// History column visible, so "chat mode hides it" is an observable change
// rather than a coincidence of the collapsed default.
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

const WORKTREE_ID = 'wt-2193';

function renderSplit(splitIndex: number, cliToolId: CLIToolType = 'claude') {
  return (
    <TerminalSplitPaneContent
      worktreeId={WORKTREE_ID}
      splitIndex={splitIndex}
      cliToolId={cliToolId}
      availableInstances={[inst('claude'), inst('codex')]}
      onInstanceChange={vi.fn()}
      onFocus={vi.fn()}
      autoYes={{ onToggle: vi.fn() }}
    />
  );
}

describe('[#2193] TerminalSplitPaneContent output surface', () => {
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

  it('defaults to the terminal surface, unchanged from before #2193', () => {
    render(renderSplit(0));

    expect(screen.getByTestId('terminal-display')).toBeInTheDocument();
    expect(screen.getByTestId('split-history-slot-0')).toBeInTheDocument();
    expect(screen.queryByTestId('split-chat-slot-0')).not.toBeInTheDocument();
    // The embedded column keeps its collapse button.
    expect(screen.getByTestId('history-pane').getAttribute('data-collapsible')).toBe('true');
  });

  it('renders the toggle with the active segment pressed', () => {
    vi.useFakeTimers();
    render(renderSplit(0));

    const terminalBtn = screen.getByTestId('surface-mode-terminal-0');
    const chatBtn = screen.getByTestId('surface-mode-chat-0');
    expect(terminalBtn).toHaveAttribute('aria-pressed', 'true');
    expect(chatBtn).toHaveAttribute('aria-pressed', 'false');
    // Discoverability: both segments name themselves for screen readers AND
    // hover, since the icons carry no text. Issue #2307: the hover affordance
    // is now common/Tooltip, not a native `title`.
    expect(chatBtn).toHaveAttribute('aria-label');
    expect(chatBtn.getAttribute('title')).toBeNull();
    fireEvent.mouseEnter(chatBtn);
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    expect(screen.getByRole('tooltip', { hidden: true })).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('swaps the terminal for the transcript — shown exactly once', async () => {
    render(renderSplit(0));

    fireEvent.click(screen.getByTestId('surface-mode-chat-0'));

    await waitFor(() => {
      expect(screen.getByTestId('split-chat-slot-0')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('terminal-display')).not.toBeInTheDocument();
    // The collapsible History column is gone, so the transcript is not doubled.
    expect(screen.queryByTestId('split-history-slot-0')).not.toBeInTheDocument();
    expect(screen.queryByTestId('history-pane')).not.toBeInTheDocument();
    const panes = screen.getAllByTestId('chat-transcript');
    expect(panes).toHaveLength(1);
    // Same instance-scoped fetch as the column it replaced.
    expect(panes[0].getAttribute('data-cli-tool-id')).toBe('claude');
    expect(panes[0].getAttribute('data-message-count')).toBe('1');
  });

  it('keeps the whole input half rendered in chat mode', async () => {
    render(renderSplit(0));
    fireEvent.click(screen.getByTestId('surface-mode-chat-0'));

    await waitFor(() => {
      expect(screen.getByTestId('split-chat-slot-0')).toBeInTheDocument();
    });
    expect(screen.getByTestId('message-input-0')).toBeInTheDocument();
    expect(screen.getByTestId('auto-yes-toggle')).toBeInTheDocument();
    // The pane header (instance selector + search) is untouched too.
    expect(screen.getByTestId('cli-selector-0')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-search-button-0')).toBeInTheDocument();
  });

  it('persists the choice under a per-split key', async () => {
    render(renderSplit(0));
    fireEvent.click(screen.getByTestId('surface-mode-chat-0'));

    await waitFor(() => {
      expect(window.localStorage.getItem(getSplitSurfaceModeStorageKey(WORKTREE_ID, 0))).toBe(
        'chat',
      );
    });
    // Nothing was written for the sibling split.
    expect(window.localStorage.getItem(getSplitSurfaceModeStorageKey(WORKTREE_ID, 1))).toBeNull();
  });

  it('restores the persisted mode on mount', async () => {
    window.localStorage.setItem(getSplitSurfaceModeStorageKey(WORKTREE_ID, 0), 'chat');
    render(renderSplit(0));

    await waitFor(() => {
      expect(screen.getByTestId('split-chat-slot-0')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('terminal-display')).not.toBeInTheDocument();
  });

  it('falls back to the terminal for a corrupt persisted value', () => {
    window.localStorage.setItem(getSplitSurfaceModeStorageKey(WORKTREE_ID, 0), 'xterm');
    render(renderSplit(0));

    expect(screen.getByTestId('terminal-display')).toBeInTheDocument();
    expect(screen.queryByTestId('split-chat-slot-0')).not.toBeInTheDocument();
  });

  it('keeps the two splits independent', async () => {
    window.localStorage.setItem(getSplitSurfaceModeStorageKey(WORKTREE_ID, 1), 'chat');
    render(
      <>
        {renderSplit(0, 'claude')}
        {renderSplit(1, 'codex')}
      </>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('split-chat-slot-1')).toBeInTheDocument();
    });
    // Split 0 still shows its terminal, and only one terminal is on screen.
    expect(screen.getAllByTestId('terminal-display')).toHaveLength(1);
    expect(screen.getByTestId('split-history-slot-0')).toBeInTheDocument();
    expect(screen.queryByTestId('split-chat-slot-0')).not.toBeInTheDocument();
    expect(screen.queryByTestId('split-history-slot-1')).not.toBeInTheDocument();
  });

  it('opens in chat when ?view=chat deep-links it, and persists that', async () => {
    window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}?pane=terminal&view=chat`);
    render(renderSplit(0));

    await waitFor(() => {
      expect(screen.getByTestId('split-chat-slot-0')).toBeInTheDocument();
    });
    expect(window.localStorage.getItem(getSplitSurfaceModeStorageKey(WORKTREE_ID, 0))).toBe('chat');
  });

  it('ignores an invalid ?view= and keeps the stored mode', async () => {
    window.localStorage.setItem(getSplitSurfaceModeStorageKey(WORKTREE_ID, 0), 'chat');
    window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}?view=%3Cscript%3E`);
    render(renderSplit(0));

    await waitFor(() => {
      expect(screen.getByTestId('split-chat-slot-0')).toBeInTheDocument();
    });
  });

  it('lets ?view= win over a conflicting stored mode', async () => {
    window.localStorage.setItem(getSplitSurfaceModeStorageKey(WORKTREE_ID, 0), 'chat');
    window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}?view=terminal`);
    render(renderSplit(0));

    await waitFor(() => {
      expect(screen.getByTestId('terminal-display')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('split-chat-slot-0')).not.toBeInTheDocument();
  });

  describe('Mod+Shift+M', () => {
    it('toggles the split that owns the focused element', async () => {
      render(
        <>
          {renderSplit(0, 'claude')}
          {renderSplit(1, 'codex')}
        </>,
      );

      fireEvent.keyDown(screen.getByTestId('terminal-split-pane-1'), {
        key: 'M',
        ctrlKey: true,
        shiftKey: true,
      });

      await waitFor(() => {
        expect(screen.getByTestId('split-chat-slot-1')).toBeInTheDocument();
      });
      // The other split did not move.
      expect(screen.queryByTestId('split-chat-slot-0')).not.toBeInTheDocument();
    });

    it('toggles back, and persists each time', async () => {
      render(renderSplit(0));
      const pane = screen.getByTestId('terminal-split-pane-0');

      fireEvent.keyDown(pane, { key: 'm', metaKey: true, shiftKey: true });
      await waitFor(() => {
        expect(screen.getByTestId('split-chat-slot-0')).toBeInTheDocument();
      });
      expect(window.localStorage.getItem(getSplitSurfaceModeStorageKey(WORKTREE_ID, 0))).toBe(
        'chat',
      );

      fireEvent.keyDown(pane, { key: 'm', metaKey: true, shiftKey: true });
      await waitFor(() => {
        expect(screen.getByTestId('terminal-display')).toBeInTheDocument();
      });
      expect(window.localStorage.getItem(getSplitSurfaceModeStorageKey(WORKTREE_ID, 0))).toBe(
        'terminal',
      );
    });

    it('falls back to the first split when nothing inside a split has focus', async () => {
      render(
        <>
          {renderSplit(0, 'claude')}
          {renderSplit(1, 'codex')}
        </>,
      );

      fireEvent.keyDown(document.body, { key: 'M', ctrlKey: true, shiftKey: true });

      await waitFor(() => {
        expect(screen.getByTestId('split-chat-slot-0')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('split-chat-slot-1')).not.toBeInTheDocument();
    });

    it('stands down while the user is typing outside every split', () => {
      // MarkdownEditor binds a bare Ctrl+M (Issue #1518) without checking
      // Shift, so on Windows / Linux the same chord reaches its textarea. This
      // guard is what stops both handlers from firing on one keystroke.
      render(renderSplit(0));
      const outsideEditor = document.createElement('textarea');
      document.body.appendChild(outsideEditor);
      try {
        fireEvent.keyDown(outsideEditor, { key: 'm', ctrlKey: true, shiftKey: true });
        expect(screen.queryByTestId('split-chat-slot-0')).not.toBeInTheDocument();
        expect(screen.getByTestId('terminal-display')).toBeInTheDocument();
      } finally {
        outsideEditor.remove();
      }
    });

    it('ignores the chord without Shift, and Shift without the mod key', () => {
      render(renderSplit(0));
      const pane = screen.getByTestId('terminal-split-pane-0');

      fireEvent.keyDown(pane, { key: 'm', ctrlKey: true });
      fireEvent.keyDown(pane, { key: 'm', shiftKey: true });
      fireEvent.keyDown(pane, { key: 'm', ctrlKey: true, shiftKey: true, altKey: true });
      fireEvent.keyDown(pane, { key: 'k', ctrlKey: true, shiftKey: true });

      expect(screen.queryByTestId('split-chat-slot-0')).not.toBeInTheDocument();
    });
  });
});
