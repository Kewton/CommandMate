/**
 * The phone's session row (Issue #2357).
 *
 * Four properties, in the order the Issue lists them:
 *
 *  1. **Same words as the PC split header.** The row's text is
 *     `formatAgentModelLabel(...)` / `formatAgentSessionUsage(...)` — the two
 *     formatters `TerminalSplitPaneContent` feeds `TerminalSplitPane` — so the
 *     assertion is equality with those functions' output, not with a literal.
 *     The model comes from the worktrees cache's `sessionStatusByInstance`,
 *     the same field the same builder gives the detail route, so the cache is
 *     the one seam mocked here.
 *  2. **Absent when nothing knows.** No entry for the instance (gemini,
 *     vibe-local, hooks not wired) means no row in the DOM and the surface
 *     toggle back at its #2193 position.
 *  3. **Tapping opens the picker.** `/model` through `/send` for claude; the
 *     `ctrl+x m` chord through `/special-keys` for opencode.
 *  4. **The change notice.** A `model_changed` frame for THIS instance turns
 *     the row amber with a dismissible chip; one for another instance does not;
 *     the notice expires `MODEL_CHANGE_HIGHLIGHT_MS` after the change's own
 *     timestamp.
 *
 * next-intl is mocked with the REAL `locales/en/worktree.json`, so the labels
 * asserted here are the ones a reader sees.
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

const { useTerminalPanePollingMock, useSplitMessagesMock, realtimeListeners, cacheState } = vi.hoisted(() => ({
  useTerminalPanePollingMock: vi.fn(),
  useSplitMessagesMock: vi.fn(),
  realtimeListeners: new Set<(event: RealtimeEvent) => void>(),
  /** What the app-wide worktrees cache publishes; null = no provider above. */
  cacheState: { value: null as null | { worktrees: unknown[]; refresh: () => Promise<void> } },
}));
// The worktrees cache: the sidebar's `/api/worktrees` list, which is where the
// row reads `sessionStatusByInstance[instance].model` from.
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => cacheState.value,
  useWorktreesCacheContext: () => cacheState.value,
  WorktreesCacheProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: useTerminalPanePollingMock,
}));
vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: useSplitMessagesMock,
}));
// The realtime seam: the listener the tab registers is captured so a test can
// deliver a frame the way the socket would, without a provider or a socket.
vi.mock('@/hooks/useRealtimeConnection', async () => {
  const ReactModule = await import('react');
  return {
    useRealtime: () => ({
      status: 'connected',
      connected: true,
      subscribe: () => {},
      unsubscribe: () => {},
      addListener: (listener: (event: RealtimeEvent) => void) => {
        realtimeListeners.add(listener);
        return () => realtimeListeners.delete(listener);
      },
    }),
    useRealtimeListener: (listener: (event: RealtimeEvent) => void) => {
      const ref = ReactModule.useRef(listener);
      ref.current = listener;
      ReactModule.useEffect(() => {
        const wrapped = (event: RealtimeEvent) => ref.current(event);
        realtimeListeners.add(wrapped);
        return () => {
          realtimeListeners.delete(wrapped);
        };
      }, []);
    },
    useRealtimeSubscription: () => {},
  };
});

import { MobileTerminalTab, MODEL_CHANGE_HIGHLIGHT_MS } from '@/components/worktree/MobileTerminalTab';
import {
  formatAgentModelLabel,
  formatAgentSessionUsage,
} from '@/components/worktree/WorktreeDetailSubComponents';
import { MODEL_CHANGED_EVENT_TYPE, type ModelChangedEvent } from '@/lib/realtime/types';
import { OPENCODE_LEADER_KEY } from '@/types/terminal-keys';
import { NAV_KEY_REFRESH_DELAY_MS } from '@/config/ui-feedback-config';
import type { CLIToolType } from '@/lib/cli-tools/types';
import enWorktree from '../../../../locales/en/worktree.json';

const WORKTREE_ID = 'wt-2357-row';
const EMPTY_SESSION: AgentSessionSnapshot = { session: null, context: null, diff: null };

const refreshMock = vi.fn(() => Promise.resolve());

function mockPaneState(agentSession: AgentSessionSnapshot = EMPTY_SESSION): void {
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
    agentSession,
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: refreshMock,
  });
  useSplitMessagesMock.mockReturnValue({ messages: [], isLoading: false, refresh: vi.fn() });
}

const cacheRefresh = vi.fn(() => Promise.resolve());

/**
 * Publish `sessionStatusByInstance` for THIS worktree through the cache, the
 * way `/api/worktrees` reports it: `{ model, reasoningEffort }` per instance,
 * both keys omitted for an instance nothing has reported on. A second worktree
 * with a model of its own is always present, so a row that read the wrong
 * worktree's entry would show up as the wrong label.
 */
function publishModels(
  byInstance: Record<string, { model?: string; reasoningEffort?: string }>
): void {
  const statuses = Object.fromEntries(
    Object.entries(byInstance).map(([id, entry]) => [
      id,
      { isRunning: true, isWaitingForResponse: false, isProcessing: false, ...entry },
    ])
  );
  cacheState.value = {
    worktrees: [
      {
        id: 'wt-other',
        name: 'other',
        sessionStatusByInstance: {
          claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false, model: 'other-model' },
        },
      },
      { id: WORKTREE_ID, name: 'feature/2357', sessionStatusByInstance: statuses },
    ],
    refresh: cacheRefresh,
  };
}

function renderTab(
  byInstance: Record<string, { model?: string; reasoningEffort?: string }>,
  props: { cliToolId?: CLIToolType; instanceId?: string } = {}
) {
  publishModels(byInstance);
  return render(
    <MobileTerminalTab
      worktreeId={WORKTREE_ID}
      cliToolId={props.cliToolId ?? 'claude'}
      instanceId={props.instanceId}
    />
  );
}

/** Deliver a frame to every listener the tab registered, inside `act`. */
function deliver(event: RealtimeEvent): void {
  act(() => {
    for (const listener of realtimeListeners) listener(event);
  });
}

function modelChanged(overrides: Partial<ModelChangedEvent> = {}): ModelChangedEvent {
  return {
    type: MODEL_CHANGED_EVENT_TYPE,
    worktreeId: WORKTREE_ID,
    cliTool: 'claude',
    instance: 'claude',
    from: 'claude-opus-5[1m]',
    to: 'claude-sonnet-5',
    source: 'hook',
    at: Date.now(),
    ...overrides,
  };
}

/** Bodies of every POST the tab issued, with their URLs. */
function posts(): Array<{ url: string; body: Record<string, unknown> }> {
  const fetchMock = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([url, init]) => ({
      url: String(url),
      body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>,
    }));
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
  realtimeListeners.clear();
  refreshMock.mockClear();
  cacheRefresh.mockClear();
  cacheState.value = null;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      redirected: false,
      url: 'http://localhost/api',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ id: 'm-1', content: '/model', timestamp: new Date().toISOString() }),
    })
  );
  mockPaneState();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/');
});

// ---------------------------------------------------------------------------
// (1) The same words as PC
// ---------------------------------------------------------------------------

describe('[#2357] the session row shows the PC split header’s label', () => {
  it('renders `model · effort` exactly as formatAgentModelLabel composes it', () => {
    const label = formatAgentModelLabel('claude-opus-5[1m]', 'xhigh');
    renderTab({ claude: { model: 'claude-opus-5[1m]', reasoningEffort: 'xhigh' } });

    const row = screen.getByTestId('mobile-session-row');
    expect(row).toBeInTheDocument();
    expect(screen.getByTestId('mobile-session-model')).toHaveTextContent(label!);
    // The literal, so the formatter itself cannot drift unnoticed.
    expect(screen.getByTestId('mobile-session-model')).toHaveTextContent('claude-opus-5[1m] · xhigh');
    // No usage chip for a tool that publishes none.
    expect(screen.queryByTestId('mobile-session-usage')).not.toBeInTheDocument();
    // Not amber until a change is heard.
    expect(row).toHaveAttribute('data-model-changed', 'false');
  });

  it('reads the label for THIS instance, not the primary’s', () => {
    renderTab(
      {
        claude: { model: 'claude-opus-5[1m]', reasoningEffort: 'xhigh' },
        'claude-2': { model: 'claude-sonnet-5', reasoningEffort: 'high' },
      },
      { instanceId: 'claude-2' }
    );
    expect(screen.getByTestId('mobile-session-model')).toHaveTextContent('claude-sonnet-5 · high');
  });

  it('prepends opencode’s persona and shows its usage chip, from the same two formatters PC uses', () => {
    const session = {
      id: 'ses-1',
      title: 'Fix the build',
      agent: 'build',
      cost: 0.0346,
      tokens: null,
    } as unknown as NonNullable<AgentSessionSnapshot['session']>;
    const context = { tokens: 8508, limit: 200000, percent: 4 } as NonNullable<AgentSessionSnapshot['context']>;
    mockPaneState({ session, context, diff: null });
    renderTab({ opencode: { model: 'claude-sonnet-4.6', reasoningEffort: 'high' } }, { cliToolId: 'opencode' });

    expect(screen.getByTestId('mobile-session-model')).toHaveTextContent(
      formatAgentModelLabel('claude-sonnet-4.6 · high', null, 'build')!
    );
    expect(screen.getByTestId('mobile-session-model')).toHaveTextContent('build · claude-sonnet-4.6 · high');

    const t = (key: string, values?: Record<string, string | number>) => {
      const template = key
        .split('.')
        .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], enWorktree) as string;
      return Object.entries(values ?? {}).reduce(
        (s, [k, v]) => s.replace(`{${k}}`, String(v)),
        template
      );
    };
    const usage = formatAgentSessionUsage(session, context, t, 'en');
    expect(usage).not.toBeNull();
    expect(screen.getByTestId('mobile-session-usage')).toHaveTextContent(usage!);
    expect(screen.getByTestId('mobile-session-usage')).toHaveTextContent('$0.03 · 8.5K (4%)');
  });

  it('names the row for assistive tech and moves the surface toggle below it', () => {
    renderTab({ claude: { model: 'claude-opus-5[1m]', reasoningEffort: 'xhigh' } });
    expect(screen.getByTestId('mobile-session-model')).toHaveAttribute(
      'aria-label',
      'Model: claude-opus-5[1m] · xhigh. Tap to open the model picker.'
    );
    expect(screen.getByTestId('mobile-surface-mode-toggle').className).toContain('top-9');
  });
});

// ---------------------------------------------------------------------------
// (2) Absent when nothing knows
// ---------------------------------------------------------------------------

describe('[#2357] the row is absent, not empty, when no model is known', () => {
  it('renders no row for an instance with no entry (gemini, vibe-local, no hooks)', () => {
    renderTab(
      { claude: { model: 'claude-opus-5[1m]', reasoningEffort: 'xhigh' }, gemini: {} },
      { cliToolId: 'gemini' }
    );
    expect(screen.queryByTestId('mobile-session-row')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mobile-session-model')).not.toBeInTheDocument();
    // The toggle is back at its #2193 position.
    expect(screen.getByTestId('mobile-surface-mode-toggle').className).toContain('top-2');
    expect(screen.getByTestId('mobile-terminal-region')).toBeInTheDocument();
  });

  it('renders no row with no cache provider above at all — every pre-#2357 mount', () => {
    cacheState.value = null;
    render(<MobileTerminalTab worktreeId={WORKTREE_ID} cliToolId="claude" />);
    expect(screen.queryByTestId('mobile-session-row')).not.toBeInTheDocument();
  });

  it('renders no row for a worktree the cache has not listed yet', () => {
    publishModels({ claude: { model: 'claude-opus-5[1m]' } });
    render(<MobileTerminalTab worktreeId="wt-unlisted" cliToolId="claude" />);
    expect(screen.queryByTestId('mobile-session-row')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// (3) Tapping opens the picker
// ---------------------------------------------------------------------------

describe('[#2357] tapping the row opens the model picker', () => {
  it('sends /model through /send for claude, then re-polls the pane', async () => {
    vi.useFakeTimers();
    renderTab({ claude: { model: 'claude-opus-5[1m]', reasoningEffort: 'xhigh' } });

    fireEvent.click(screen.getByTestId('mobile-session-model'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(posts()).toEqual([
      { url: `/api/worktrees/${WORKTREE_ID}/send`, body: { content: '/model', cliToolId: 'claude' } },
    ]);
    expect(refreshMock).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(NAV_KEY_REFRESH_DELAY_MS);
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('targets the tab’s own instance on /send', async () => {
    renderTab({ 'codex-2': { model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' } }, { cliToolId: 'codex', instanceId: 'codex-2' });
    fireEvent.click(screen.getByTestId('mobile-session-model'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(posts()[0]).toEqual({
      url: `/api/worktrees/${WORKTREE_ID}/send`,
      body: { content: '/model', cliToolId: 'codex', instanceId: 'codex-2' },
    });
  });

  it('sends the ctrl+x m chord through /special-keys for opencode, which has no /model', async () => {
    renderTab({ opencode: { model: 'claude-sonnet-4.6' } }, { cliToolId: 'opencode' });
    fireEvent.click(screen.getByTestId('mobile-session-model'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(posts()).toEqual([
      {
        url: `/api/worktrees/${WORKTREE_ID}/special-keys`,
        body: { cliToolId: 'opencode', keys: [OPENCODE_LEADER_KEY, 'm'] },
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// (4) The change notice
// ---------------------------------------------------------------------------

describe('[#2357] the row turns amber on a model_changed frame for this instance', () => {
  it('shows the dismissible chip, naming both models, and clears it on tap', () => {
    renderTab({ claude: { model: 'claude-sonnet-5', reasoningEffort: 'high' } });
    deliver(modelChanged());

    const row = screen.getByTestId('mobile-session-row');
    expect(row).toHaveAttribute('data-model-changed', 'true');
    // The label's source polls slowly; the frame is what tells it to re-read.
    expect(cacheRefresh).toHaveBeenCalledTimes(1);
    const chip = screen.getByTestId('mobile-session-model-changed');
    expect(chip).toHaveTextContent('Changed');
    expect(chip).toHaveAttribute(
      'aria-label',
      'Model changed from claude-opus-5[1m] to claude-sonnet-5. Tap to dismiss.'
    );

    fireEvent.click(chip);
    expect(screen.queryByTestId('mobile-session-model-changed')).not.toBeInTheDocument();
    expect(row).toHaveAttribute('data-model-changed', 'false');
    // Dismissing sent nothing.
    expect(posts()).toEqual([]);
  });

  it('ignores a frame for another instance or another worktree', () => {
    renderTab({ claude: { model: 'claude-sonnet-5', reasoningEffort: 'high' } });
    deliver(modelChanged({ instance: 'claude-2' }));
    deliver(modelChanged({ worktreeId: 'wt-other' }));
    deliver({ type: 'session_status_changed', worktreeId: WORKTREE_ID, isRunning: true });
    expect(screen.getByTestId('mobile-session-row')).toHaveAttribute('data-model-changed', 'false');
    expect(screen.queryByTestId('mobile-session-model-changed')).not.toBeInTheDocument();
    expect(cacheRefresh).not.toHaveBeenCalled();
  });

  it('expires MODEL_CHANGE_HIGHLIGHT_MS after the change’s own timestamp, not after arrival', () => {
    vi.useFakeTimers();
    const now = Date.now();
    renderTab({ claude: { model: 'claude-sonnet-5', reasoningEffort: 'high' } });
    // A change that happened four minutes ago, heard just now (a reconnect).
    deliver(modelChanged({ at: now - (MODEL_CHANGE_HIGHLIGHT_MS - 60_000) }));
    expect(screen.getByTestId('mobile-session-model-changed')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(59_000);
    });
    expect(screen.getByTestId('mobile-session-model-changed')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.queryByTestId('mobile-session-model-changed')).not.toBeInTheDocument();
    expect(screen.getByTestId('mobile-session-row')).toHaveAttribute('data-model-changed', 'false');
  });

  it('never shows a notice that is already older than the window', () => {
    renderTab({ claude: { model: 'claude-sonnet-5', reasoningEffort: 'high' } });
    deliver(modelChanged({ at: Date.now() - MODEL_CHANGE_HIGHLIGHT_MS - 1 }));
    expect(screen.queryByTestId('mobile-session-model-changed')).not.toBeInTheDocument();
  });

  it('keeps the picker tap separate from the dismiss tap', async () => {
    renderTab({ claude: { model: 'claude-sonnet-5', reasoningEffort: 'high' } });
    deliver(modelChanged());
    fireEvent.click(screen.getByTestId('mobile-session-model'));
    await act(async () => {
      await Promise.resolve();
    });
    // Opening the picker did not dismiss the notice…
    expect(screen.getByTestId('mobile-session-model-changed')).toBeInTheDocument();
    // …and it did send.
    expect(posts()).toHaveLength(1);
  });
});
