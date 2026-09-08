/**
 * The session note on the phone (Issue #2427).
 *
 * Four properties:
 *
 *  1. **It sits on the model row.** The memo renders immediately right of
 *     `mobile-session-model`, which is where the Issue puts it, with the same
 *     stamp the PC split header shows.
 *  2. **The row now has two reasons to exist.** Before this Issue the row was
 *     rendered only when a model was known; a pane whose tool reports none
 *     (gemini, vibe-local, hooks not wired) is exactly the pane whose header
 *     says least, so a note alone is enough to raise it — and the floating
 *     surface toggle steps down with it, which is the #2106 arithmetic #2357
 *     established.
 *  3. **The editor is opened from the actions sheet.** That sheet is rendered
 *     outside this tab and knows neither worktree nor instance, so it raises a
 *     window event. The tab is the listener, and the target is the ACTIVE
 *     instance — the one whose terminal is on screen.
 *  4. **The same guards as PC.** One editor component, so the IME guard and the
 *     100-character bound are the same code; asserted here against the phone's
 *     own mount so a future divergence cannot hide behind "PC covers it".
 *
 * next-intl is mocked with the REAL `locales/en/worktree.json`.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { RealtimeEvent } from '@/lib/realtime/types';
import type { AgentSessionSnapshot } from '@/types/agent-session';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

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

const { useTerminalPanePollingMock, useSplitMessagesMock, cacheState } = vi.hoisted(() => ({
  useTerminalPanePollingMock: vi.fn(),
  useSplitMessagesMock: vi.fn(),
  cacheState: {
    value: null as null | { worktrees: unknown[]; refresh: () => Promise<void> },
  },
}));

vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => cacheState.value,
  useWorktreesCacheContext: () => cacheState.value,
  WorktreesCacheProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: useTerminalPanePollingMock,
}));
vi.mock('@/hooks/useSplitMessages', () => ({ useSplitMessages: useSplitMessagesMock }));
vi.mock('@/hooks/useRealtimeConnection', () => ({
  useRealtime: () => ({
    status: 'connected',
    connected: true,
    subscribe: () => {},
    unsubscribe: () => {},
    addListener: () => () => {},
  }),
  useRealtimeListener: (_listener: (event: RealtimeEvent) => void) => {},
  useRealtimeSubscription: () => {},
}));

import { MobileTerminalTab } from '@/components/worktree/MobileTerminalTab';
import { MobileTerminalActionsSheet } from '@/components/mobile/MobileTerminalActionsSheet';
import { SESSION_NOTE_OPEN_EVENT } from '@/components/worktree/TerminalSplitPane';
import { MAX_SESSION_NOTE_LENGTH } from '@/lib/db/agent-instances-db';

const WORKTREE_ID = 'wt-2427-mobile';
const NOW = new Date(2026, 8, 8, 18, 0, 0);
const TODAY_1432 = new Date(2026, 8, 8, 14, 32, 0).getTime();
const YESTERDAY_1432 = new Date(2026, 8, 7, 14, 32, 0).getTime();
const EMPTY_SESSION: AgentSessionSnapshot = { session: null, context: null, diff: null };

const refreshMock = vi.fn(() => Promise.resolve());
const cacheRefresh = vi.fn(() => Promise.resolve());
let fetchMock: ReturnType<typeof vi.fn>;

function mockPaneState(): void {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: '',
      realtimeSnippet: '',
      isRunning: true,
      isThinking: false,
      sessionStatus: 'ready',
      isSelectionListActive: false,
      isPagerActive: false,
      isUnclassifiedActive: false,
      composerText: '',
      attaching: false,
      autoScroll: true,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false },
    agentSession: EMPTY_SESSION,
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: refreshMock,
  });
  useSplitMessagesMock.mockReturnValue({ messages: [], isLoading: false, refresh: vi.fn() });
}

/**
 * Publish the list cache: a second worktree with a note of its own is always
 * present, so a tab reading the wrong worktree's map shows up as the wrong memo.
 */
function publish(options: {
  notes?: Record<string, { text: string; updatedAt: number }>;
  models?: Record<string, { model?: string }>;
}): void {
  const statuses = Object.fromEntries(
    Object.entries(options.models ?? {}).map(([id, entry]) => [
      id,
      { isRunning: true, isWaitingForResponse: false, isProcessing: false, ...entry },
    ])
  );
  cacheState.value = {
    worktrees: [
      { id: 'wt-other', sessionNotes: { claude: { text: 'somebody else', updatedAt: 1 } } },
      { id: WORKTREE_ID, sessionStatusByInstance: statuses, sessionNotes: options.notes ?? {} },
    ],
    refresh: cacheRefresh,
  };
}

function renderTab(props: { instanceId?: string } = {}) {
  return render(
    <MobileTerminalTab worktreeId={WORKTREE_ID} cliToolId="claude" instanceId={props.instanceId} />
  );
}

function flushSave(): Promise<void> {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('MobileTerminalTab session note (Issue #2427)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    mockPaneState();
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ instanceId: 'claude', note: null }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    cacheState.value = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    cacheState.value = null;
  });

  // ==========================================================================
  // 1. On the model row
  // ==========================================================================

  it('renders the memo immediately right of the model, with its stamp', () => {
    publish({
      models: { claude: { model: 'claude-opus-5' } },
      notes: { claude: { text: 'DB 層の実装', updatedAt: TODAY_1432 } },
    });
    renderTab();

    const row = screen.getByTestId('mobile-session-row');
    const note = screen.getByTestId('mobile-session-note');
    expect(note).toHaveTextContent('DB 層の実装');
    expect(screen.getByTestId('mobile-session-note-time')).toHaveTextContent('14:32');

    // "Right of" is a DOM order the Issue names explicitly.
    const children = Array.from(row.children);
    expect(children.indexOf(screen.getByTestId('mobile-session-model'))).toBeLessThan(
      children.indexOf(note)
    );
  });

  it('stamps a memo from before today with the date in front', () => {
    publish({
      models: { claude: { model: 'claude-opus-5' } },
      notes: { claude: { text: 'yesterday', updatedAt: YESTERDAY_1432 } },
    });
    renderTab();

    expect(screen.getByTestId('mobile-session-note-time')).toHaveTextContent('9/7 14:32');
  });

  it('reads the note of the ACTIVE instance, not of the worktree', () => {
    publish({
      models: { claude: { model: 'claude-opus-5' }, 'codex-2': { model: 'gpt-5' } },
      notes: {
        claude: { text: 'claude のメモ', updatedAt: TODAY_1432 },
        'codex-2': { text: 'codex のメモ', updatedAt: TODAY_1432 },
      },
    });
    renderTab({ instanceId: 'codex-2' });

    expect(screen.getByTestId('mobile-session-note')).toHaveTextContent('codex のメモ');
    expect(screen.queryByText('claude のメモ')).toBeNull();
  });

  it('shows nothing at all when the session has no note and no model', () => {
    publish({});
    renderTab();

    expect(screen.queryByTestId('mobile-session-row')).toBeNull();
    expect(screen.queryByTestId('mobile-session-note')).toBeNull();
    // The pre-#2357 position of the floating surface toggle.
    expect(screen.getByTestId('mobile-surface-mode-toggle').className).toContain('top-2');
  });

  // ==========================================================================
  // 2. A note alone raises the row
  // ==========================================================================

  it('raises the row for a memo even when no model was ever reported', () => {
    publish({ notes: { claude: { text: 'gemini でも読める', updatedAt: TODAY_1432 } } });
    renderTab();

    expect(screen.getByTestId('mobile-session-row')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-session-note')).toHaveTextContent('gemini でも読める');
    // The model half is absent rather than empty.
    expect(screen.queryByTestId('mobile-session-model')).toBeNull();
    // ...and the toggle steps down over the row, as it does for a model.
    expect(screen.getByTestId('mobile-surface-mode-toggle').className).toContain('top-9');
  });

  // ==========================================================================
  // 3. Opened from the actions sheet
  // ==========================================================================

  it('opens the editor when the actions sheet raises the intent', () => {
    publish({ notes: { claude: { text: 'DB 層の実装', updatedAt: TODAY_1432 } } });
    renderTab();

    expect(screen.queryByTestId('mobile-session-note-editor')).toBeNull();
    act(() => {
      window.dispatchEvent(new CustomEvent(SESSION_NOTE_OPEN_EVENT));
    });

    expect(screen.getByTestId('mobile-session-note-input')).toHaveValue('DB 層の実装');
  });

  it('opens an empty editor for a session that has no memo yet', () => {
    publish({ models: { claude: { model: 'claude-opus-5' } } });
    renderTab();

    act(() => {
      window.dispatchEvent(new CustomEvent(SESSION_NOTE_OPEN_EVENT));
    });

    expect(screen.getByTestId('mobile-session-note-input')).toHaveValue('');
  });

  it('is what the actions sheet’s own row dispatches', () => {
    publish({});
    renderTab();
    const onClose = vi.fn();
    render(
      <MobileTerminalActionsSheet
        open
        onClose={onClose}
        onSearch={vi.fn()}
        onEnd={vi.fn()}
      />
    );

    act(() => {
      fireEvent.click(screen.getByTestId('actions-sheet-session-note'));
    });

    expect(screen.getByTestId('mobile-session-note-input')).toBeInTheDocument();
    expect(onClose).toHaveBeenCalled();
  });

  it('opens the editor by tapping the memo itself', () => {
    publish({ notes: { claude: { text: 'DB 層の実装', updatedAt: TODAY_1432 } } });
    renderTab();

    fireEvent.click(screen.getByTestId('mobile-session-note'));

    expect(screen.getByTestId('mobile-session-note-input')).toHaveValue('DB 層の実装');
  });

  // ==========================================================================
  // 4. Writing, with PC's guards
  // ==========================================================================

  it('writes through the narrow endpoint and shows the memo at once', async () => {
    publish({ models: { claude: { model: 'claude-opus-5' } } });
    renderTab();

    act(() => {
      window.dispatchEvent(new CustomEvent(SESSION_NOTE_OPEN_EVENT));
    });
    const input = screen.getByTestId('mobile-session-note-input');
    fireEvent.change(input, { target: { value: 'レビュー待ち' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await flushSave();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/worktrees/${WORKTREE_ID}/instances/notes`);
    expect(JSON.parse(String(init.body))).toEqual({ instanceId: 'claude', text: 'レビュー待ち' });
    expect(screen.queryByTestId('mobile-session-note-editor')).toBeNull();
    expect(screen.getByTestId('mobile-session-note')).toHaveTextContent('レビュー待ち');
  });

  it('targets the active instance, not the primary one', async () => {
    publish({ models: { 'codex-2': { model: 'gpt-5' } } });
    renderTab({ instanceId: 'codex-2' });

    act(() => {
      window.dispatchEvent(new CustomEvent(SESSION_NOTE_OPEN_EVENT));
    });
    fireEvent.change(screen.getByTestId('mobile-session-note-input'), {
      target: { value: 'codex 側' },
    });
    fireEvent.keyDown(screen.getByTestId('mobile-session-note-input'), { key: 'Enter' });
    await flushSave();

    expect(
      JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)).instanceId
    ).toBe('codex-2');
  });

  it('does not save the unconverted kana when Enter confirms an IME candidate', () => {
    publish({ models: { claude: { model: 'claude-opus-5' } } });
    renderTab();

    act(() => {
      window.dispatchEvent(new CustomEvent(SESSION_NOTE_OPEN_EVENT));
    });
    const input = screen.getByTestId('mobile-session-note-input');
    fireEvent.change(input, { target: { value: 'れびゅー' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('mobile-session-note-input')).toBeInTheDocument();
  });

  it('bounds the field at the server’s limit', () => {
    publish({ models: { claude: { model: 'claude-opus-5' } } });
    renderTab();

    act(() => {
      window.dispatchEvent(new CustomEvent(SESSION_NOTE_OPEN_EVENT));
    });

    expect(screen.getByTestId('mobile-session-note-input')).toHaveAttribute(
      'maxlength',
      String(MAX_SESSION_NOTE_LENGTH)
    );
  });

  it('clears the memo when the field is emptied', async () => {
    publish({ notes: { claude: { text: 'DB 層の実装', updatedAt: TODAY_1432 } } });
    renderTab();

    fireEvent.click(screen.getByTestId('mobile-session-note'));
    const input = screen.getByTestId('mobile-session-note-input');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await flushSave();

    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)).text).toBe(
      ''
    );
    expect(screen.queryByTestId('mobile-session-note')).toBeNull();
  });

  it('discards the edit on Escape', () => {
    publish({ notes: { claude: { text: 'DB 層の実装', updatedAt: TODAY_1432 } } });
    renderTab();

    fireEvent.click(screen.getByTestId('mobile-session-note'));
    fireEvent.keyDown(screen.getByTestId('mobile-session-note-input'), { key: 'Escape' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mobile-session-note-editor')).toBeNull();
    expect(screen.getByTestId('mobile-session-note')).toHaveTextContent('DB 層の実装');
  });
});
