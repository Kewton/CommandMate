/**
 * The PC footer's key strips defer to the chat surface's dialog card (Issue #2254).
 *
 * The pane's footer (`footer={footerSlot}`) is rendered in BOTH output modes and
 * always has been — that is what keeps the composer, Auto-Yes and `PromptPanel`
 * on screen while the transcript is showing, which is #2193's whole point. Two
 * of its members are not composer controls though: `NavigationButtons` and
 * `TerminalEscapeHatch` drive the TUI frame, and before #2254 neither gate
 * looked at `surfaceMode`. So switching to chat produced the worst combination
 * available — an arrow pad under the composer, a dozen rows away from a
 * selection list the surface was simultaneously saying it could not show.
 *
 * #2254 gives the chat surface its own copy of both, inside the dialog card and
 * directly under the frame they act on. This suite pins the consequence:
 *
 *  - in TERMINAL mode nothing moved (the regression risk of a `surfaceMode` term
 *    is that it hides a control everyone still needs);
 *  - in CHAT mode the footer's two frame-driving strips are gone and the card's
 *    are there instead, so there is exactly ONE of each on screen;
 *  - `PromptPanel` is NOT gated, because it answers a dialog the chat surface
 *    deliberately draws nothing for.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { TerminalSplitPaneContent } from '@/components/worktree/TerminalSplitPaneContent';
import { getSplitSurfaceModeStorageKey } from '@/config/surface-mode-config';
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
  // `autoYesSlot` is rendered because Auto-Yes lives INSIDE the composer's meta
  // row (Issue #1080), and "the composer half survived the gate" is one of the
  // things this suite checks.
  MessageInput: ({
    splitIndex,
    autoYesSlot,
  }: {
    splitIndex: number;
    autoYesSlot?: React.ReactNode;
  }) => <div data-testid={`message-input-${splitIndex}`}>{autoYesSlot}</div>,
}));

// NOT mocked away to nothing: each records WHERE it was mounted, because the
// property under test is "one of these, in the right place" rather than "one of
// these". A bare `<div data-testid="navigation-buttons" />` would pass a
// footer-only implementation and a card-only one identically.
vi.mock('@/components/worktree/NavigationButtons', () => ({
  NavigationButtons: ({ showPagerKeys }: { showPagerKeys?: boolean }) => (
    <div data-testid="navigation-buttons" data-pager-keys={String(showPagerKeys ?? false)} />
  ),
}));

vi.mock('@/components/worktree/TerminalEscapeHatch', () => ({
  TerminalEscapeHatch: () => <div data-testid="terminal-escape-hatch" />,
}));

vi.mock('@/components/worktree/PromptAnswerKeys', () => ({
  PromptAnswerKeys: () => <div data-testid="prompt-answer-keys" />,
  PROMPT_ANSWER_KEYS: [],
  // Issue #2297 put two more selection-list toolbars in this module, and
  // `ChatSurface` renders them from the same import. A module mock replaces the
  // WHOLE module, so leaving them out makes this suite throw
  // "No SelectionNumberKeys export is defined on the mock" the moment a
  // selection list is on screen — which is what half of these tests set up.
  SelectionNumberKeys: ({ optionCount }: { optionCount: number }) => (
    <div data-testid="selection-number-keys" data-option-count={String(optionCount)} />
  ),
  SelectionCommitKeys: () => <div data-testid="selection-commit-keys" />,
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
  ChatTranscript: () => (
    <div data-testid="chat-transcript">
      <div data-testid="chat-transcript-scroll-container" />
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: () => ({ messages: [], isLoading: false, refresh: vi.fn() }),
}));

vi.mock('@/hooks/useHistoryPaneState', () => ({
  useHistoryPaneState: () => ({ visible: true, width: 40, toggle: vi.fn(), setWidth: vi.fn() }),
  DEFAULT_HISTORY_WIDTH: 40,
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
  MOBILE_BREAKPOINT: 768,
}));

// The polled state is mocked rather than driven through `fetch`, because
// `isUnclassifiedActive` is CONFIRMED over time — the hook requires
// `UNCLASSIFIED_CONFIRMATION_COUNT` consecutive polls plus
// `UNCLASSIFIED_CONFIRMATION_DELAY_MS`, which turns "does the footer draw this?"
// into a timer test about a different module. The same seam every other pane
// suite in this directory uses (`MobileTerminalTab.test.tsx`).
const useTerminalPanePollingMock = vi.fn();
vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: (...args: unknown[]) => useTerminalPanePollingMock(...args),
  UNCLASSIFIED_CONFIRMATION_COUNT: 2,
  UNCLASSIFIED_CONFIRMATION_DELAY_MS: 500,
}));

const WORKTREE_ID = 'wt-2254-footer';

/** A pane the dialog card has something to draw. */
const FRAME = ['Select model', '❯ 1. Default', '  2. Opus', 'Esc to cancel'].join('\n');

/** The pane state the split renders from, with the frame flags under test. */
function mockPane(extra: Record<string, unknown> = {}, prompt: Record<string, unknown> = {}) {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: FRAME,
      realtimeSnippet: FRAME,
      isRunning: true,
      isThinking: false,
      sessionStatus: 'waiting',
      isSelectionListActive: false,
      isPagerActive: false,
      isUnclassifiedActive: false,
      composerText: '',
      attaching: false,
      autoScroll: true,
      ...extra,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false, ...prompt },
    agentSession: { session: null, context: null, diff: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(),
  });
}

function renderSplit() {
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
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

/** Open the split in chat mode from the start, so no toggle click is needed. */
function openInChat() {
  window.localStorage.setItem(getSplitSurfaceModeStorageKey(WORKTREE_ID, 0), 'chat');
}

// ---------------------------------------------------------------------------
// Terminal mode: nothing moved
// ---------------------------------------------------------------------------

describe('[#2254] terminal mode keeps the footer exactly as it was', () => {
  it('still draws NavigationButtons in the footer for a selection list', async () => {
    mockPane({ isSelectionListActive: true });
    renderSplit();

    await waitFor(() => {
      expect(screen.getByTestId('navigation-buttons')).toBeInTheDocument();
    });
    const footer = screen.getByTestId('split-footer-0');
    expect(footer).toContainElement(screen.getByTestId('navigation-buttons'));
    // No card: the terminal itself is on screen.
    expect(screen.queryByTestId('chat-dialog-card')).not.toBeInTheDocument();
  });

  it('still draws the pager keys in the footer for a pager', async () => {
    mockPane({ isSelectionListActive: true, isPagerActive: true });
    renderSplit();

    await waitFor(() => {
      expect(screen.getByTestId('navigation-buttons')).toHaveAttribute('data-pager-keys', 'true');
    });
  });

  it('still draws the escape hatch in the footer for an unclassified frame', async () => {
    mockPane({ isUnclassifiedActive: true });
    renderSplit();

    await waitFor(() => {
      expect(screen.getByTestId('terminal-escape-hatch')).toBeInTheDocument();
    });
    expect(screen.getByTestId('split-footer-0')).toContainElement(
      screen.getByTestId('terminal-escape-hatch'),
    );
  });
});

// ---------------------------------------------------------------------------
// Chat mode: the card owns them, and there is only one of each
// ---------------------------------------------------------------------------

describe('[#2254] chat mode moves the frame-driving strips into the card', () => {
  it('draws exactly one arrow pad for a selection list, and it is in the card', async () => {
    openInChat();
    mockPane({ isSelectionListActive: true });
    renderSplit();

    await waitFor(() => {
      expect(screen.getByTestId('chat-dialog-card')).toBeInTheDocument();
    });
    const pads = screen.getAllByTestId('navigation-buttons');
    expect(pads).toHaveLength(1);
    expect(screen.getByTestId('chat-dialog-card-actions')).toContainElement(pads[0]);
    // …and the footer, which IS rendered in chat mode, holds none of it.
    expect(screen.getByTestId('split-footer-0')).not.toContainElement(pads[0]);
  });

  it('carries the pager keys across the move rather than losing them', async () => {
    openInChat();
    mockPane({ isSelectionListActive: true, isPagerActive: true });
    renderSplit();

    await waitFor(() => {
      expect(screen.getByTestId('navigation-buttons')).toHaveAttribute('data-pager-keys', 'true');
    });
    expect(screen.getAllByTestId('navigation-buttons')).toHaveLength(1);
  });

  it('draws exactly one escape hatch for an unclassified frame, in the card', async () => {
    openInChat();
    mockPane({ isUnclassifiedActive: true });
    renderSplit();

    await waitFor(() => {
      expect(screen.getByTestId('chat-dialog-card')).toBeInTheDocument();
    });
    const hatches = screen.getAllByTestId('terminal-escape-hatch');
    expect(hatches).toHaveLength(1);
    expect(screen.getByTestId('chat-dialog-card-actions')).toContainElement(hatches[0]);
    expect(screen.getByTestId('split-footer-0')).not.toContainElement(hatches[0]);
  });

  it('leaves the footer with no frame-driving strip at all', async () => {
    openInChat();
    mockPane({ isUnclassifiedActive: true });
    renderSplit();

    await waitFor(() => {
      expect(screen.getByTestId('chat-dialog-card')).toBeInTheDocument();
    });
    const footer = screen.getByTestId('split-footer-0');
    // The composer half is untouched — that is #2193's contract and #2254 must
    // not have collapsed the whole footer to satisfy this Issue.
    expect(footer).toContainElement(screen.getByTestId('message-input-0'));
    expect(footer).toContainElement(screen.getByTestId('auto-yes-toggle'));
  });

  it('keeps PromptPanel in the footer for an ANSWERABLE wait, with no card beside it', async () => {
    // The one member of the footer that #2254 deliberately did NOT gate. The
    // chat surface draws nothing for an answerable wait (`resolveBlockedReason`
    // returns null), so hiding the panel here would leave an ordinary yes/no
    // unanswerable in chat mode.
    openInChat();
    mockPane(
      {},
      {
        visible: true,
        data: { type: 'yes_no', status: 'pending', question: 'Proceed?', options: ['yes', 'no'] },
        messageId: 'p1',
      },
    );
    renderSplit();

    await waitFor(() => {
      expect(screen.getByTestId('prompt-panel')).toBeInTheDocument();
    });
    expect(screen.getByTestId('split-footer-0')).toContainElement(screen.getByTestId('prompt-panel'));
    expect(screen.queryByTestId('chat-dialog-card')).not.toBeInTheDocument();
  });
});
