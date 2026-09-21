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
 * handed to the composer through `directInputSlot` (Issue #2797 moved it there
 * from `autoYesSlot`), and a stub for the composer would make "it is in the
 * toolbar's end group" true by construction rather than by rendering.
 *
 * **Where it is drawn (Issue #2797).** In #2766 it rode the meta row beside
 * Auto-Yes, which hid it in the two-split pane and the 2x2 grid and scrolled it
 * partly or wholly out of sight in the three-split panes. What is measured
 * about that lives in `tests/e2e/composer-two-row-2598.spec.ts`; this file pins
 * the structure the measurement depends on — the group it is mounted in, and
 * the container-query literal that prints its label.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import {
  DIRECT_INPUT_LABEL_MIN_CONTAINER_PX,
  TerminalSplitPaneContent,
} from '@/components/worktree/TerminalSplitPaneContent';
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
});

describe('[#2797] where the toggle is drawn', () => {
  it('sits in the toolbar end group, before the interrupt button', () => {
    // The end group is the one place in the composer that neither shrinks nor
    // scrolls. The start group and the meta row's Auto-Yes half both scroll
    // sideways, and #2766's toggle was scrolled out of the latter.
    render(split());
    const end = screen.getByTestId('composer-toolbar-end');
    expect(within(end).getByTestId('direct-input-toggle')).toBe(toggle());
    const order = Array.from(end.querySelectorAll('[data-testid]')).map(n => n.getAttribute('data-testid'));
    expect(order.indexOf('direct-input-toggle')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('direct-input-toggle')).toBeLessThan(order.indexOf('interrupt-button'));
    expect(screen.getAllByTestId('direct-input-toggle')).toHaveLength(1);
  });

  it('is gone from the meta row and from the scrolling start group', () => {
    render(split());
    const meta = screen.getByTestId('composer-meta-row');
    expect(within(meta).queryByTestId('direct-input-toggle')).toBeNull();
    expect(within(screen.getByTestId('composer-toolbar-start')).queryByTestId('direct-input-toggle')).toBeNull();
    // The meta row's Auto-Yes half holds Auto-Yes and nothing else again —
    // the budget #2598 measured.
    const autoYes = screen.getByTestId('composer-auto-yes');
    expect(within(autoYes).getByRole('switch')).toBeInTheDocument();
    expect(within(autoYes).queryAllByRole('button')).toHaveLength(0);
  });

  it('prints its label only from the container threshold, spelled as a literal', () => {
    render(split());
    const label = screen.getByTestId('direct-input-toggle-label');
    expect(toggle().contains(label)).toBe(true);
    expect(label).toHaveTextContent(/directInput\.toggle$/);
    const classes = label.className.split(/\s+/);
    // Hidden by default, printed from the threshold up. Tailwind cannot see an
    // interpolated class, so the literal must spell the constant.
    expect(classes).toContain('hidden');
    expect(classes).toContain(`@min-[${DIRECT_INPUT_LABEL_MIN_CONTAINER_PX}px]:inline`);
    expect(toggle().className.split(/\s+/)).toContain(`@min-[${DIRECT_INPUT_LABEL_MIN_CONTAINER_PX}px]:px-2`);
  });

  it('keeps a name and an icon where the label is not printed', () => {
    render(split());
    // `aria-label` names it whether or not the label is drawn; the icon is
    // decoration, so it does not add to the name.
    expect(toggle()).toHaveAccessibleName(/directInput\.toggleAria$/);
    const icon = toggle().querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute('aria-hidden', 'true');
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
