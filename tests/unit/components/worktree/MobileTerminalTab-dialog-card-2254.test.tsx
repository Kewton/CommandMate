/**
 * The phone's dialog card, and the docked controls that stand down for it
 * (Issue #2254).
 *
 * The phone has the same duplication problem PC had, one level worse. Its
 * `NavigationButtons` are not in this tab at all: they are docked above the
 * composer in `WorktreeDetailRefactored`, OUTSIDE the tab content, so they
 * cannot see the per-worktree surface mode this component owns. Its escape hatch
 * IS in this tab, but below the output region rather than beside the frame.
 *
 * Two things are pinned here, and the reporting seam is what makes the first one
 * possible at all:
 *
 *  1. **The tab reports its mode up**, on mount as well as on change. On mount
 *     matters because the mode is resolved from localStorage in an effect: a tab
 *     REOPENED in chat mode never fires a change, and a screen that only listened
 *     for changes would leave the docked pad showing.
 *  2. **This tab's own escape hatch stands down in chat mode**, because the card
 *     draws one directly under the frame.
 *
 * The docked pad's own gate is asserted in
 * `WorktreeDetailRefactored-docked-nav-2254.test.tsx`, which is where that
 * control lives.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { getMobileSurfaceModeStorageKey } from '@/config/surface-mode-config';

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

const WORKTREE_ID = 'wt-mobile-2254';
const STORAGE_KEY = getMobileSurfaceModeStorageKey(WORKTREE_ID);

/** A pane with a dialog at the end of it, ANSI-free for readability. */
const FRAME = ['Select model', '❯ 1. Default', '  2. Opus', 'Esc to cancel'].join('\n');

function mockPaneState(extra: Record<string, unknown> = {}): void {
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
    prompt: { visible: false, data: null, messageId: null, answering: false },
    agentSession: { session: null, context: null, diff: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(),
  });
  useSplitMessagesMock.mockReturnValue({
    messages: [],
    isLoading: false,
    refresh: vi.fn(),
  });
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

// ---------------------------------------------------------------------------
// (1) Reporting the mode up
// ---------------------------------------------------------------------------

describe('[#2254] MobileTerminalTab reports its surface mode to the screen', () => {
  it('reports `terminal` on a first mount with nothing persisted', async () => {
    const onSurfaceModeChange = vi.fn();
    render(
      <MobileTerminalTab
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        onSurfaceModeChange={onSurfaceModeChange}
      />,
    );
    await waitFor(() => expect(onSurfaceModeChange).toHaveBeenCalledWith('terminal'));
  });

  it('reports `chat` on mount when the tab was LEFT in chat mode', async () => {
    // The case a change-only listener misses entirely: nothing is toggled, the
    // mode arrives from localStorage in an effect, and the docked pad would sit
    // there beside the card forever.
    window.localStorage.setItem(STORAGE_KEY, 'chat');
    const onSurfaceModeChange = vi.fn();
    render(
      <MobileTerminalTab
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        onSurfaceModeChange={onSurfaceModeChange}
      />,
    );
    await waitFor(() => expect(onSurfaceModeChange).toHaveBeenCalledWith('chat'));
  });

  it('reports the new mode when the toggle is used', async () => {
    const onSurfaceModeChange = vi.fn();
    render(
      <MobileTerminalTab
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        onSurfaceModeChange={onSurfaceModeChange}
      />,
    );
    await waitFor(() => expect(onSurfaceModeChange).toHaveBeenCalledWith('terminal'));

    fireEvent.click(screen.getByTestId('mobile-surface-mode-chat'));

    await waitFor(() => expect(onSurfaceModeChange).toHaveBeenLastCalledWith('chat'));
  });

  it('mounts without the callback at all — every pre-#2254 caller still works', () => {
    expect(() =>
      render(<MobileTerminalTab worktreeId={WORKTREE_ID} cliToolId="claude" />),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// (2) The card, and the hatch that stands down for it
// ---------------------------------------------------------------------------

describe('[#2254] the phone’s dialog card', () => {
  it('draws the card with the pane’s tail while chat is showing', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'chat');
    mockPaneState({ isSelectionListActive: true });
    render(<MobileTerminalTab worktreeId={WORKTREE_ID} cliToolId="claude" />);

    await waitFor(() => expect(screen.getByTestId('chat-dialog-card')).toBeInTheDocument());
    expect(screen.getByTestId('chat-dialog-card-frame')).toHaveTextContent('Esc to cancel');
  });

  it('caps the card at the phone’s height so the transcript keeps its rows', async () => {
    // Issue #2106: the live region is `shrink-0`. `compact` is what the tab
    // passes and `max-h-32` is what it buys; without it the card grows with the
    // frame and takes those pixels straight out of the transcript.
    window.localStorage.setItem(STORAGE_KEY, 'chat');
    mockPaneState({ isSelectionListActive: true });
    render(<MobileTerminalTab worktreeId={WORKTREE_ID} cliToolId="claude" />);

    await waitFor(() => expect(screen.getByTestId('chat-dialog-card')).toBeInTheDocument());
    expect(screen.getByTestId('chat-dialog-card-frame').className).toContain('max-h-32');
  });

  it('draws exactly one escape hatch in chat mode, and it is in the card', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'chat');
    mockPaneState({ isUnclassifiedActive: true });
    render(<MobileTerminalTab worktreeId={WORKTREE_ID} cliToolId="claude" />);

    await waitFor(() => expect(screen.getByTestId('chat-dialog-card')).toBeInTheDocument());
    const hatches = screen.getAllByLabelText('Send Escape');
    expect(hatches).toHaveLength(1);
    expect(screen.getByTestId('chat-dialog-card-actions')).toContainElement(hatches[0]);
    // The card's answer keys are there too — nobody classified this frame, so
    // nobody can promise it navigates rather than asks (#2254 §B).
    expect(screen.getByTestId('prompt-answer-keys')).toBeInTheDocument();
  });

  it('keeps the tab’s own escape hatch in TERMINAL mode, unchanged', async () => {
    mockPaneState({ isUnclassifiedActive: true });
    render(<MobileTerminalTab worktreeId={WORKTREE_ID} cliToolId="claude" />);

    await waitFor(() => expect(screen.getByTestId('terminal-display')).toBeInTheDocument());
    expect(screen.getByLabelText('Send Escape')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-dialog-card')).not.toBeInTheDocument();
    // …and no answer keys: the terminal is on screen and the pane's own frame is
    // what the user is looking at.
    expect(screen.queryByTestId('prompt-answer-keys')).not.toBeInTheDocument();
  });

  it('sends an answer key to /special-keys for this tab’s instance', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'chat');
    mockPaneState({ isUnclassifiedActive: true });
    render(
      <MobileTerminalTab worktreeId={WORKTREE_ID} cliToolId="claude" instanceId="claude-3" />,
    );

    await waitFor(() => expect(screen.getByTestId('prompt-answer-keys')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('prompt-answer-key-1'));

    const fetchMock = vi.mocked(global.fetch);
    const call = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/special-keys'),
    );
    expect(call).toBeDefined();
    expect(JSON.parse(String(call![1]!.body))).toEqual({
      cliToolId: 'claude',
      keys: ['1'],
      instanceId: 'claude-3',
    });
  });
});
