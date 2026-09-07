/**
 * The PC split copies the dismiss-only verdict into the chat surface's `live`
 * (Issue #2373).
 *
 * Issue #2369 added `isDismissablePanelActive` and wired it from
 * `buildCurrentOutput` through the API, the WebSocket push and
 * `useTerminalPanePolling` — but this component builds `live` by listing fields
 * one at a time, and that list never got the new one. The surface therefore
 * only ever saw `undefined`, and `resolveBlockedReason` fell back to reading the
 * frame. The card looked right; the field it was added for never arrived.
 *
 * ## What makes this suite non-vacuous
 *
 * The fallback (`live.isDismissablePanelActive ?? hasDismissablePanelFooter(frame)`)
 * stays, so a test that simply raises the flag on a frame that ALSO carries
 * `Press Esc to close` passes with or without the copy — the frame answers it.
 * Two shapes here cannot be answered by the frame, and they are the ones that go
 * red if the copied line is deleted:
 *
 *  - **the server says yes and the frame does not.** The two read different
 *    bytes (the server judges `frame.lastLines`, the client the raw capture's
 *    last 15 rows), which is the divergence the Issue is about;
 *  - **the server says no and the frame says yes.** `??` is written so an
 *    explicit `false` outranks the frame — a branch that could not run at all
 *    while the field never arrived.
 *
 * One test deliberately uses a footer-bearing frame WITH the flag: it is the
 * control that stays green under that mutation, and it is here so the difference
 * is visible in the file rather than only in a reviewer's head.
 *
 * The key strips are the real implementations — a stubbed `TerminalEscapeHatch`
 * or `PromptAnswerKeys` would make "and neither pad is drawn" true by
 * construction.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { TerminalSplitPaneContent } from '@/components/worktree/TerminalSplitPaneContent';
import { getSplitSurfaceModeStorageKey } from '@/config/surface-mode-config';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import { hasDismissablePanelFooter } from '@/lib/detection/selection-shape';
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

// Same seam every other pane suite in this directory uses: the polled state is
// handed in directly rather than driven through `fetch`, so this stays a test
// about what the component copies out of it.
const useTerminalPanePollingMock = vi.fn();
vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: (...args: unknown[]) => useTerminalPanePollingMock(...args),
  UNCLASSIFIED_CONFIRMATION_COUNT: 2,
  UNCLASSIFIED_CONFIRMATION_DELAY_MS: 500,
}));

const WORKTREE_ID = 'wt-2373-split';

/**
 * Command Code's `/usage` panel with its footer row, as Issue #2369 captured it.
 * `hasDismissablePanelFooter` reads this as a dismiss-only panel on its own.
 */
const PANEL_FRAME_WITH_FOOTER = [
  ' USAGE  Go Plan · active',
  '█░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 4% used',
  'Cycle: $9.61 left · 259 requests · 26 days to renewal',
  'Press Esc to close',
].join('\n');

/**
 * The same panel as the client sees it when the footer is NOT in the bytes it
 * holds — the server judged `frame.lastLines`, this is a capture whose tail was
 * cut somewhere else. The frame cannot produce the verdict; only the copied
 * field can.
 */
const PANEL_FRAME_WITHOUT_FOOTER = [
  ' USAGE  Go Plan · active',
  '█░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 4% used',
  'Cycle: $9.61 left · 259 requests · 26 days to renewal',
].join('\n');

function mockPane(extra: Record<string, unknown> = {}) {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: PANEL_FRAME_WITHOUT_FOOTER,
      realtimeSnippet: PANEL_FRAME_WITHOUT_FOOTER,
      isRunning: true,
      isThinking: false,
      sessionStatus: 'waiting',
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

function renderSplit() {
  return render(
    <TerminalSplitPaneContent
      worktreeId={WORKTREE_ID}
      splitIndex={0}
      cliToolId="command-code"
      availableInstances={[inst('command-code')]}
      onInstanceChange={vi.fn()}
      onFocus={vi.fn()}
      autoYes={{ onToggle: vi.fn() }}
    />,
  );
}

/** Open the split in chat mode from the start, so no toggle click is needed. */
function openInChat() {
  window.localStorage.setItem(getSplitSurfaceModeStorageKey(WORKTREE_ID, 0), 'chat');
}

/** The banner is the verdict itself; it is drawn whether or not a frame exists. */
function banner(): HTMLElement {
  return screen.getByTestId('chat-surface-terminal-banner');
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

// ---------------------------------------------------------------------------
// The fixtures themselves, so the two shapes below cannot rot into each other
// ---------------------------------------------------------------------------

describe('[#2373] the frames these tests rely on', () => {
  it('one carries a dismiss footer and the other does not', () => {
    expect(hasDismissablePanelFooter(PANEL_FRAME_WITH_FOOTER)).toBe(true);
    expect(hasDismissablePanelFooter(PANEL_FRAME_WITHOUT_FOOTER)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The copy, on frames the fallback cannot answer
// ---------------------------------------------------------------------------

describe('[#2373] the split copies isDismissablePanelActive into `live`', () => {
  it('raises the dismissablePanel card from the field alone, with no dismiss footer in the frame', async () => {
    openInChat();
    mockPane({ isDismissablePanelActive: true });
    renderSplit();

    await waitFor(() => expect(banner()).toHaveAttribute('data-reason', 'dismissablePanel'));
    expect(within(screen.getByTestId('chat-dialog-card-actions')).getByTestId('dismiss-panel-keys'))
      .toBeInTheDocument();
  });

  it('draws the Esc button and NEITHER full pad for it', async () => {
    // Presence alone would pass a card that drew all three strips; #2369's whole
    // point is that seventeen of those eighteen buttons do nothing to a panel.
    openInChat();
    mockPane({ isDismissablePanelActive: true });
    renderSplit();

    await waitFor(() => expect(screen.getByTestId('dismiss-panel-keys')).toBeInTheDocument());
    expect(screen.queryByTestId('prompt-answer-keys')).toBeNull();
    for (const label of ['Send Left', 'Send Up', 'Send Down', 'Send Right', 'Send Enter']) {
      expect(screen.queryByLabelText(label)).toBeNull();
    }
  });

  it('still reports the verdict when there is no frame to fall back to at all', async () => {
    // The banner is outside the `frame ? … : null` branch, so this is the shape
    // where the field is provably the only source: an empty capture reads as
    // "no panel" through `hasDismissablePanelFooter`.
    openInChat();
    mockPane({ isDismissablePanelActive: true, output: '', realtimeSnippet: '' });
    renderSplit();

    await waitFor(() => expect(banner()).toHaveAttribute('data-reason', 'dismissablePanel'));
    expect(screen.queryByTestId('chat-dialog-card')).toBeNull();
  });

  it('lets an explicit `false` from the server outrank a footer-bearing frame', async () => {
    // The other half of `??`, and dead code until this Issue: the server knows
    // the panel closed, the capture in hand still shows its footer.
    openInChat();
    mockPane({
      isDismissablePanelActive: false,
      output: PANEL_FRAME_WITH_FOOTER,
      realtimeSnippet: PANEL_FRAME_WITH_FOOTER,
    });
    renderSplit();

    await waitFor(() => expect(screen.getByTestId('chat-transcript')).toBeInTheDocument());
    expect(screen.queryByTestId('chat-surface-terminal-banner')).toBeNull();
    expect(screen.queryByTestId('dismiss-panel-keys')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The parts that must not move
// ---------------------------------------------------------------------------

describe('[#2373] what the copy must not change', () => {
  it('keeps the frame fallback working for a footer-bearing frame', async () => {
    // The control: green with the copy and green without it. Old daemons and
    // panes that predate #2369 land here, and this is the case the mutation
    // check must NOT be run against.
    openInChat();
    mockPane({
      isDismissablePanelActive: true,
      output: PANEL_FRAME_WITH_FOOTER,
      realtimeSnippet: PANEL_FRAME_WITH_FOOTER,
    });
    renderSplit();

    await waitFor(() => expect(banner()).toHaveAttribute('data-reason', 'dismissablePanel'));
  });

  it('leaves an unclassified frame with both pads', async () => {
    openInChat();
    mockPane({ isUnclassifiedActive: true });
    renderSplit();

    await waitFor(() => expect(banner()).toHaveAttribute('data-reason', 'unclassified'));
    const row = screen.getByTestId('chat-dialog-card-actions');
    expect(within(row).getByTestId('prompt-answer-keys')).toBeInTheDocument();
    expect(within(row).getByLabelText('Send Left')).toBeInTheDocument();
    expect(screen.queryByTestId('dismiss-panel-keys')).toBeNull();
  });

  it('does not draw the card in terminal mode', async () => {
    mockPane({ isDismissablePanelActive: true });
    renderSplit();

    await waitFor(() => expect(screen.getByTestId('terminal-display')).toBeInTheDocument());
    expect(screen.queryByTestId('chat-surface-terminal-banner')).toBeNull();
  });
});
