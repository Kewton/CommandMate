/**
 * The phone's tool-activity toggle lives in the surface pill (Issue #2821).
 *
 * Measured at 390x844 on a real phone: the pill (`mobile-surface-mode-toggle`,
 * x286 y150 96x50) covered the transcript's tool-activity icon (x322 y150 28x28)
 * and its search icon (x354 y150 28x28) completely. So on the chat surface the
 * pill grows a third button, and the transcript underneath draws neither icon.
 *
 * `ChatTranscript` is the REAL component here (only the terminal and the two
 * data hooks are stubbed), so "the transcript follows the pill" is asserted on
 * the column the reader actually gets — its `data-tool-activity` and its tool
 * chip — rather than on a prop handed to a stand-in. The pixel claims (the
 * button is on top, nothing scrolls sideways) are the e2e spec's job:
 * `tests/e2e/mobile-chat-tool-activity-2821.spec.ts`.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';
import { getMobileSurfaceModeStorageKey } from '@/config/surface-mode-config';
import { CHAT_TRANSCRIPT_TOOL_ACTIVITY_TESTID } from '@/components/worktree/ChatTranscript';
import { CHAT_TOOL_LOG_TOGGLE_TESTID } from '@/components/worktree/ChatMessageBubble';
import { CHAT_TOOL_ACTIVITY_STORAGE_KEY } from '@/lib/chat/chat-tool-activity';
import { separateTurnBody } from '@/lib/hooks/sources/turn-body';

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

const WORKTREE_ID = 'wt-2821-mobile';
const SURFACE_STORAGE_KEY = getMobileSurfaceModeStorageKey(WORKTREE_ID);
const PILL_BUTTON_TESTID = 'mobile-chat-tool-activity-toggle';
/** The next-intl stub echoes `<namespace>.<key>`. */
const SHOW_LABEL = 'worktree.chatTranscript.toolActivity.show';
const HIDE_LABEL = 'worktree.chatTranscript.toolActivity.hide';

const TURN_BODY = separateTurnBody([
  { kind: 'prose', text: 'Created `probe.txt`.' },
  { kind: 'tool', text: '- `Bash` — ls' },
  { kind: 'tool', text: '- `apply_patch` — probe.txt' },
]).body;

function msg(id: string, role: ChatMessage['role'], content: string, requestId?: string): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role,
    content,
    timestamp: new Date('2026-09-21T10:00:00Z'),
    messageType: 'normal',
    archived: false,
    cliToolId: 'claude',
    ...(requestId ? { requestId } : {}),
  };
}

const CONVERSATION = [
  msg('u1', 'user', 'make a probe file'),
  // `claude-turn:` puts the row on the Markdown path, where the tool log folds.
  msg('a1', 'assistant', TURN_BODY, 'claude-turn:u-1a1'),
];

function mockPane(): void {
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

function renderTab(surface: 'terminal' | 'chat') {
  if (surface === 'chat') window.localStorage.setItem(SURFACE_STORAGE_KEY, 'chat');
  return render(<MobileTerminalTab worktreeId={WORKTREE_ID} cliToolId="claude" />);
}

async function waitForTranscript(): Promise<HTMLElement> {
  await waitFor(() => expect(screen.getByTestId('chat-transcript')).toBeInTheDocument());
  return screen.getByTestId('chat-transcript');
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

describe('[#2821] where the button is', () => {
  it('is not drawn on the terminal surface', () => {
    renderTab('terminal');

    expect(screen.getByTestId('terminal-display')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-surface-mode-toggle')).toBeInTheDocument();
    expect(screen.queryByTestId(PILL_BUTTON_TESTID)).toBeNull();
  });

  it('is drawn inside the pill on the chat surface, and the transcript draws neither corner icon', async () => {
    renderTab('chat');
    await waitForTranscript();

    const pill = screen.getByTestId('mobile-surface-mode-toggle');
    expect(within(pill).getByTestId(PILL_BUTTON_TESTID)).toBeInTheDocument();
    expect(screen.queryByTestId(CHAT_TRANSCRIPT_TOOL_ACTIVITY_TESTID)).toBeNull();
    expect(screen.queryByTestId('chat-transcript-search-toggle')).toBeNull();
  });

  it('comes and goes with the surface, keeping its answer', async () => {
    renderTab('chat');
    await waitForTranscript();
    fireEvent.click(screen.getByTestId(PILL_BUTTON_TESTID));

    fireEvent.click(screen.getByTestId('mobile-surface-mode-terminal'));
    await waitFor(() => expect(screen.getByTestId('terminal-display')).toBeInTheDocument());
    expect(screen.queryByTestId(PILL_BUTTON_TESTID)).toBeNull();

    fireEvent.click(screen.getByTestId('mobile-surface-mode-chat'));
    const column = await waitForTranscript();
    expect(screen.getByTestId(PILL_BUTTON_TESTID)).toHaveAttribute('aria-pressed', 'true');
    expect(column).toHaveAttribute('data-tool-activity', 'shown');
  });
});

describe('[#2821] what the button does', () => {
  it('opens and folds the transcript underneath, and remembers it', async () => {
    renderTab('chat');
    const column = await waitForTranscript();
    const button = screen.getByTestId(PILL_BUTTON_TESTID);

    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(button).toHaveAttribute('aria-label', SHOW_LABEL);
    expect(button).toHaveAttribute('title', SHOW_LABEL);
    expect(column).toHaveAttribute('data-tool-activity', 'folded');
    expect(within(column).getByTestId(CHAT_TOOL_LOG_TOGGLE_TESTID)).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    fireEvent.click(button);

    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).toHaveAttribute('aria-label', HIDE_LABEL);
    expect(button).toHaveAttribute('title', HIDE_LABEL);
    expect(column).toHaveAttribute('data-tool-activity', 'shown');
    expect(within(column).getByTestId(CHAT_TOOL_LOG_TOGGLE_TESTID)).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(window.localStorage.getItem(CHAT_TOOL_ACTIVITY_STORAGE_KEY)).toBe('true');

    fireEvent.click(button);

    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(column).toHaveAttribute('data-tool-activity', 'folded');
    expect(window.localStorage.getItem(CHAT_TOOL_ACTIVITY_STORAGE_KEY)).toBe('false');
  });

  it('starts from the stored answer', async () => {
    window.localStorage.setItem(CHAT_TOOL_ACTIVITY_STORAGE_KEY, 'true');
    renderTab('chat');
    const column = await waitForTranscript();

    expect(screen.getByTestId(PILL_BUTTON_TESTID)).toHaveAttribute('aria-pressed', 'true');
    expect(column).toHaveAttribute('data-tool-activity', 'shown');
  });
});

describe('[#2821] how the button is built', () => {
  it('is a >=44px, pointer-events-auto, touch-manipulation target (#1127)', async () => {
    renderTab('chat');
    await waitForTranscript();
    const button = screen.getByTestId(PILL_BUTTON_TESTID);

    expect(button.className).toContain('min-h-[44px]');
    expect(button.className).toContain('min-w-[44px]');
    expect(button.className).toContain('touch-manipulation');
    expect(button.className).toContain('pointer-events-auto');
    expect(button).toHaveAttribute('type', 'button');
  });

  it('wears the accent tint only while on, behind a rule that sets it apart from the segments', async () => {
    renderTab('chat');
    await waitForTranscript();
    const button = screen.getByTestId(PILL_BUTTON_TESTID);

    const rule = button.previousElementSibling as HTMLElement | null;
    expect(rule).not.toBeNull();
    expect(rule!.tagName).toBe('SPAN');
    expect(rule).toHaveAttribute('aria-hidden', 'true');
    expect(rule!.className).toContain('w-px');
    expect(rule!.className).toContain('bg-border');

    expect(button.className).toContain('text-muted-foreground');
    expect(button.className).not.toContain('bg-accent-500/15');

    fireEvent.click(button);

    expect(button.className).toContain('bg-accent-500/15');
    expect(button.className).toContain('text-accent-700');
    expect(button.className).toContain('dark:text-accent-400');
    expect(button.className).not.toContain('text-muted-foreground');
  });
});
