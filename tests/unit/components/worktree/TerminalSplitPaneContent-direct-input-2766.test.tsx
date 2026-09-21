/**
 * The split pane offers direct input regardless of what detection sees
 * (Issue #2766).
 *
 * Two failures are pinned here, and they are the two this file is prone to.
 *
 * **1. The `footerSlot` memo.** The footer is one big `useMemo` with a
 * hand-written dependency list. A new piece of state that gates something
 * inside it — here `directInputOpen` — has to be added to that list by hand, and
 * when it is not, the toggle flips, `aria-pressed` follows it (the toggle is in
 * the same memo, but React re-renders the button through the state it closes
 * over) and the bar simply never appears. Nothing errors. So the assertions
 * below are on the BAR, not on the toggle's state.
 *
 * **2. The gate it hangs off.** Every other key surface in this footer is
 * conditioned on a detection verdict, and the whole reason this one exists is
 * the frame detection could not read. `isSelectionListActive` /
 * `isUnclassifiedActive` / `prompt.visible` are therefore swept in every
 * combination, because the natural way to write this feature — next to
 * `TerminalEscapeHatch`, under its condition — is wrong in exactly the case it
 * is needed.
 *
 * `MessageInput` and `AutoYesToggle` are the REAL components: the toggle is
 * handed to the composer through `autoYesSlot` as a Fragment beside Auto-Yes,
 * and a stub for either would make "both are in the meta row" true by
 * construction rather than by rendering.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { TerminalSplitPaneContent } from '@/components/worktree/TerminalSplitPaneContent';
import { getSplitSurfaceModeStorageKey } from '@/config/surface-mode-config';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

beforeAll(() => installRadixJsdomPolyfills());

function inst(cliTool: CLIToolType): AgentInstance {
  return { id: cliTool, cliTool, alias: cliTool, order: 0 };
}

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: () => <div data-testid="terminal-display" />,
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

vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    groups: [], filteredGroups: [], allCommands: [], loading: false,
    error: null, filter: '', setFilter: vi.fn(), refresh: vi.fn(),
  }),
}));

// Stable IDENTITY, not merely a stable value. `handleMessageSent` closes over
// `refreshSplitMessages` and is itself a dependency of the footer memo, so a
// mock that hands back a fresh object (and a fresh `vi.fn`) on every render
// invalidates that memo every render — which would make the missing-dependency
// mutation above impossible to detect, and this whole file vacuous.
const splitMessages = { messages: [], isLoading: false, refresh: vi.fn(() => Promise.resolve()) };
vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: () => splitMessages,
}));

// Same reason, for the same memo: `handlePromptRespond` depends on `t`. The
// global mock in `tests/setup.ts` returns a NEW closure per call; next-intl's
// own `useTranslations` does not. Memoised per namespace here so this suite
// measures the component's memoisation rather than the harness's.
const translators = new Map<string, (key: string, params?: Record<string, string | number>) => string>();
vi.mock('next-intl', () => ({
  useTranslations: (namespace?: string) => {
    const scope = namespace ?? '';
    if (!translators.has(scope)) {
      translators.set(scope, (key, params) => {
        const full = namespace ? `${namespace}.${key}` : key;
        return params
          ? Object.entries(params).reduce((str, [k, v]) => str.replace(`{${k}}`, String(v)), full)
          : full;
      });
    }
    return translators.get(scope)!;
  },
  useLocale: () => 'en',
  NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/hooks/useHistoryPaneState', () => ({
  useHistoryPaneState: () => ({ visible: false, width: 40, toggle: vi.fn(), setWidth: vi.fn() }),
  DEFAULT_HISTORY_WIDTH: 40,
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
  MOBILE_BREAKPOINT: 768,
}));

const useTerminalPanePollingMock = vi.fn();
vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: (...args: unknown[]) => useTerminalPanePollingMock(...args),
  UNCLASSIFIED_CONFIRMATION_COUNT: 2,
  UNCLASSIFIED_CONFIRMATION_DELAY_MS: 500,
}));

const WORKTREE_ID = 'wt-2766-split';

interface PaneOverrides {
  terminal?: Record<string, unknown>;
  prompt?: Record<string, unknown>;
}

function mockPane({ terminal = {}, prompt = {} }: PaneOverrides = {}) {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: 'idle frame',
      realtimeSnippet: 'idle frame',
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
      ...terminal,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false, ...prompt },
    agentSession: { session: null, context: null, diff: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(),
  });
}

function split(): React.ReactElement {
  return (
    <TerminalSplitPaneContent
      worktreeId={WORKTREE_ID}
      splitIndex={0}
      cliToolId="command-code"
      availableInstances={[inst('command-code')]}
      onInstanceChange={vi.fn()}
      onFocus={vi.fn()}
      autoYes={{ onToggle: vi.fn() }}
    />
  );
}

function toggle(): HTMLElement {
  return screen.getByTestId('direct-input-toggle');
}

function bar(): HTMLElement | null {
  return screen.queryByTestId('direct-input-bar');
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
  mockPane();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('[#2766] the toggle drives the bar', () => {
  it('draws no bar until the toggle is pressed', () => {
    render(split());
    expect(toggle()).toBeInTheDocument();
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    expect(bar()).toBeNull();
  });

  it('shows the bar on the first press and takes it away on the second', async () => {
    // The `footerSlot` dependency-list pin. Under a memo that does not list
    // `directInputOpen`, `aria-pressed` still flips and this line still fails.
    render(split());

    fireEvent.click(toggle());
    await waitFor(() => expect(bar()).toBeInTheDocument());
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('direct-input-capture')).toBeInTheDocument();

    fireEvent.click(toggle());
    await waitFor(() => expect(bar()).toBeNull());
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
  });

  it('closes the bar from its own Exit button', async () => {
    render(split());
    fireEvent.click(toggle());
    await waitFor(() => expect(bar()).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('direct-input-close'));
    await waitFor(() => expect(bar()).toBeNull());
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
  });

  it('sits in the composer meta row beside Auto-Yes', () => {
    // #2598's row. Both controls go through the one `autoYesSlot`, so this is
    // where a second control would show up as a broken strip if it broke one.
    render(split());
    const row = screen.getByTestId('composer-auto-yes');
    expect(within(row).getByTestId('direct-input-toggle')).toBe(toggle());
    expect(within(row).getByRole('switch')).toBeInTheDocument();
  });
});

describe('[#2766] the session gate', () => {
  it('disables the toggle while no session is running', () => {
    mockPane({ terminal: { isRunning: false } });
    render(split());
    expect(toggle()).toBeDisabled();
  });

  it('closes an open bar when the session goes away', async () => {
    const { rerender } = render(split());
    fireEvent.click(toggle());
    await waitFor(() => expect(bar()).toBeInTheDocument());

    mockPane({ terminal: { isRunning: false } });
    rerender(split());

    await waitFor(() => expect(bar()).toBeNull());
    expect(toggle()).toBeDisabled();
  });

  it('does not reopen the bar when the session comes back', async () => {
    // The two close rules are separate effects on purpose: one watches the
    // target, one watches `isRunning`. A single effect over both would close
    // the bar every time `isRunning` merely CHANGED, including false -> true.
    const { rerender } = render(split());
    mockPane({ terminal: { isRunning: false } });
    rerender(split());
    mockPane({ terminal: { isRunning: true } });
    rerender(split());

    await waitFor(() => expect(toggle()).toBeEnabled());
    expect(bar()).toBeNull();

    fireEvent.click(toggle());
    await waitFor(() => expect(bar()).toBeInTheDocument());
    // …and it survives an ordinary poll tick that changes nothing.
    mockPane({ terminal: { isRunning: true, output: 'a later frame' } });
    rerender(split());
    expect(bar()).toBeInTheDocument();
  });
});

describe('[#2766] independence from detection', () => {
  const FLAGS = [false, true];
  const combinations = FLAGS.flatMap((isSelectionListActive) =>
    FLAGS.flatMap((isUnclassifiedActive) =>
      FLAGS.map((promptVisible) => ({ isSelectionListActive, isUnclassifiedActive, promptVisible })),
    ),
  );

  it.each(combinations)(
    'offers direct input with selection=$isSelectionListActive unclassified=$isUnclassifiedActive prompt=$promptVisible',
    async ({ isSelectionListActive, isUnclassifiedActive, promptVisible }) => {
      mockPane({
        terminal: { isSelectionListActive, isUnclassifiedActive },
        prompt: { visible: promptVisible },
      });
      render(split());

      expect(toggle()).toBeEnabled();
      fireEvent.click(toggle());
      await waitFor(() => expect(bar()).toBeInTheDocument());
    },
  );

  it('offers it on the chat surface too, where nav and hatch are gone', async () => {
    // #2254 turns `showNav` / `showEscapeHatch` off in chat mode. This one is
    // not a frame driver in that sense — it is the last way in — so it stays.
    window.localStorage.setItem(getSplitSurfaceModeStorageKey(WORKTREE_ID, 0), 'chat');
    mockPane({ terminal: { isUnclassifiedActive: true } });
    render(split());

    await waitFor(() => expect(screen.getByTestId('chat-transcript')).toBeInTheDocument());
    expect(toggle()).toBeEnabled();
    fireEvent.click(toggle());
    await waitFor(() => expect(bar()).toBeInTheDocument());
  });
});
