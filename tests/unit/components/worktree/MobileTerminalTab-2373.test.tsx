/**
 * The phone copies the dismiss-only verdict into the chat surface's `live`
 * (Issue #2373).
 *
 * The mirror of `TerminalSplitPaneContent-2373.test.tsx`, for the other of the
 * two components that build `ChatSurfaceLiveState` field by field. Issue #2369
 * carried `isDismissablePanelActive` all the way to `useTerminalPanePolling` and
 * both of these lists dropped it, so the surface saw `undefined` on the very
 * screen the field was added for and re-derived the verdict from the frame.
 *
 * The shapes asserted here are the two the frame fallback cannot answer — the
 * server saying yes over a frame with no dismiss footer, and the server saying
 * `false` over a frame that has one — plus a footer-bearing control that is
 * green either way, so the difference between "pinned by the copy" and "pinned
 * by the fallback" is visible in the file.
 *
 * `PromptAnswerKeys` (which owns `DismissPanelKeys`) and `TerminalEscapeHatch`
 * are the real implementations; stubbing them would make every "and not the
 * other pad" assertion true by construction.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { getMobileSurfaceModeStorageKey } from '@/config/surface-mode-config';
import { hasDismissablePanelFooter } from '@/lib/detection/selection-shape';

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: () => <div data-testid="terminal-display" />,
}));

vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: () => (
    <div data-testid="chat-transcript">
      <div data-testid="chat-transcript-scroll-container" />
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
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

const WORKTREE_ID = 'wt-2373-mobile';
const STORAGE_KEY = getMobileSurfaceModeStorageKey(WORKTREE_ID);

/** Command Code's `/usage` panel, footer row included (Issue #2369's capture). */
const PANEL_FRAME_WITH_FOOTER = [
  ' USAGE  Go Plan · active',
  '█░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 4% used',
  'Cycle: $9.61 left · 259 requests · 26 days to renewal',
  'Press Esc to close',
].join('\n');

/** The same panel with the footer outside the bytes the client holds. */
const PANEL_FRAME_WITHOUT_FOOTER = [
  ' USAGE  Go Plan · active',
  '█░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 4% used',
  'Cycle: $9.61 left · 259 requests · 26 days to renewal',
].join('\n');

function mockPaneState(extra: Record<string, unknown> = {}): void {
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
  useSplitMessagesMock.mockReturnValue({ messages: [], isLoading: false, refresh: vi.fn() });
}

function renderTab() {
  return render(<MobileTerminalTab worktreeId={WORKTREE_ID} cliToolId="command-code" />);
}

/** The verdict itself, drawn whether or not there is a frame under it. */
function banner(): HTMLElement {
  return screen.getByTestId('chat-surface-terminal-banner');
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) }),
  );
  mockPaneState();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('[#2373] the frames these tests rely on', () => {
  it('one carries a dismiss footer and the other does not', () => {
    expect(hasDismissablePanelFooter(PANEL_FRAME_WITH_FOOTER)).toBe(true);
    expect(hasDismissablePanelFooter(PANEL_FRAME_WITHOUT_FOOTER)).toBe(false);
  });
});

describe('[#2373] the phone copies isDismissablePanelActive into `live`', () => {
  it('raises the dismissablePanel card from the field alone, with no dismiss footer in the frame', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'chat');
    mockPaneState({ isDismissablePanelActive: true });
    renderTab();

    await waitFor(() => expect(banner()).toHaveAttribute('data-reason', 'dismissablePanel'));
    expect(within(screen.getByTestId('chat-dialog-card-actions')).getByTestId('dismiss-panel-keys'))
      .toBeInTheDocument();
  });

  it('draws the Esc button and NEITHER full pad for it', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'chat');
    mockPaneState({ isDismissablePanelActive: true });
    renderTab();

    await waitFor(() => expect(screen.getByTestId('dismiss-panel-keys')).toBeInTheDocument());
    expect(screen.queryByTestId('prompt-answer-keys')).toBeNull();
    for (const label of ['Send Left', 'Send Up', 'Send Down', 'Send Right', 'Send Enter']) {
      expect(screen.queryByLabelText(label)).toBeNull();
    }
  });

  it('still reports the verdict when there is no frame to fall back to at all', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'chat');
    mockPaneState({ isDismissablePanelActive: true, output: '', realtimeSnippet: '' });
    renderTab();

    await waitFor(() => expect(banner()).toHaveAttribute('data-reason', 'dismissablePanel'));
    expect(screen.queryByTestId('chat-dialog-card')).toBeNull();
  });

  it('lets an explicit `false` from the server outrank a footer-bearing frame', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'chat');
    mockPaneState({
      isDismissablePanelActive: false,
      output: PANEL_FRAME_WITH_FOOTER,
      realtimeSnippet: PANEL_FRAME_WITH_FOOTER,
    });
    renderTab();

    await waitFor(() => expect(screen.getByTestId('mobile-chat-surface')).toBeInTheDocument());
    expect(screen.queryByTestId('chat-surface-terminal-banner')).toBeNull();
    expect(screen.queryByTestId('dismiss-panel-keys')).toBeNull();
  });
});

describe('[#2373] what the copy must not change', () => {
  it('keeps the frame fallback working for a footer-bearing frame', async () => {
    // The control: green with the copy and green without it — an old daemon that
    // sends no such field still gets its card.
    window.localStorage.setItem(STORAGE_KEY, 'chat');
    mockPaneState({
      isDismissablePanelActive: true,
      output: PANEL_FRAME_WITH_FOOTER,
      realtimeSnippet: PANEL_FRAME_WITH_FOOTER,
    });
    renderTab();

    await waitFor(() => expect(banner()).toHaveAttribute('data-reason', 'dismissablePanel'));
  });

  it('leaves an unclassified frame with both pads', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'chat');
    mockPaneState({ isUnclassifiedActive: true });
    renderTab();

    await waitFor(() => expect(banner()).toHaveAttribute('data-reason', 'unclassified'));
    const row = screen.getByTestId('chat-dialog-card-actions');
    expect(within(row).getByTestId('prompt-answer-keys')).toBeInTheDocument();
    expect(within(row).getByLabelText('Send Escape')).toBeInTheDocument();
    expect(screen.queryByTestId('dismiss-panel-keys')).toBeNull();
  });

  it('does not draw the card in terminal mode', async () => {
    mockPaneState({ isDismissablePanelActive: true });
    renderTab();

    await waitFor(() => expect(screen.getByTestId('terminal-display')).toBeInTheDocument());
    expect(screen.queryByTestId('chat-surface-terminal-banner')).toBeNull();
  });
});
