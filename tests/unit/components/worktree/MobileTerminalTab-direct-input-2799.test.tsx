/**
 * The mobile terminal tab while the direct-input keyboard is open (Issue #2799 §8).
 *
 * The keyboard is docked in the screen's bottom bar, not in this tab; what the
 * tab owes it is:
 *
 *  - its own key pads stand down — the unsent-input bar, the opencode quick
 *    keys and the escape hatch. The keyboard offers every key they do, and the
 *    terminal needs their rows;
 *  - the surface pill is drawn unavailable and refuses the tap (direct input is
 *    aimed at the terminal frame, which chat does not draw);
 *  - the terminal is re-pinned to its last row as the keyboard takes height —
 *    unless the user had scrolled away, or the pane is a `disableAutoFollow` one.
 *
 * `directInputOpen` is optional: every other suite mounts this tab without it,
 * and the first case pins that the pads are back when it is false.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { getMobileSurfaceModeStorageKey } from '@/config/surface-mode-config';

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: () => (
    <div data-testid="terminal-display">
      <div role="log" data-testid="terminal-log" />
    </div>
  ),
}));
vi.mock('@/components/worktree/TerminalEscapeHatch', () => ({
  TerminalEscapeHatch: () => <div data-testid="escape-hatch" />,
}));
vi.mock('@/components/worktree/UnsentComposerBar', () => ({
  UnsentComposerBar: () => <div data-testid="unsent-composer-bar" />,
  hasUnsentComposerText: (text: string | null | undefined) => (text ?? '').trim() !== '',
}));
vi.mock('@/components/worktree/OpencodeQuickKeys', () => ({
  OpencodeQuickKeys: () => <div data-testid="opencode-quick-keys" />,
}));

const { useTerminalPanePollingMock } = vi.hoisted(() => ({
  useTerminalPanePollingMock: vi.fn(),
}));
vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: useTerminalPanePollingMock,
}));

import { MobileTerminalTab } from '@/components/worktree/MobileTerminalTab';

const WORKTREE_ID = 'wt-mobile-2799';

function mockPaneState(overrides: { autoScroll?: boolean } = {}): void {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: 'output',
      realtimeSnippet: 'output',
      isRunning: true,
      isThinking: false,
      isSelectionListActive: false,
      isPagerActive: false,
      // Arms the escape hatch …
      isUnclassifiedActive: true,
      // … and the unsent-input bar.
      composerText: 'half-typed',
      attaching: false,
      autoScroll: overrides.autoScroll ?? true,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false },
    agentSession: { session: null, context: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(),
  });
}

function renderTab(props: Partial<React.ComponentProps<typeof MobileTerminalTab>> = {}) {
  return render(<MobileTerminalTab worktreeId={WORKTREE_ID} cliToolId="opencode" {...props} />);
}

beforeEach(() => {
  window.localStorage.clear();
  mockPaneState();
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('[#2799] MobileTerminalTab with the direct-input keyboard', () => {
  it('draws its pads as before when the keyboard is closed (or the prop is absent)', () => {
    renderTab();
    expect(screen.getByTestId('unsent-composer-bar')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-quick-keys-slot')).toBeInTheDocument();
    expect(screen.getByTestId('opencode-quick-keys')).toBeInTheDocument();
    expect(screen.getByTestId('escape-hatch')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-surface-mode-chat')).not.toHaveAttribute('aria-disabled');
  });

  it('stands its three pads down while the keyboard is open', () => {
    renderTab({ directInputOpen: true });
    expect(screen.queryByTestId('unsent-composer-bar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mobile-quick-keys-slot')).not.toBeInTheDocument();
    expect(screen.queryByTestId('opencode-quick-keys')).not.toBeInTheDocument();
    expect(screen.queryByTestId('escape-hatch')).not.toBeInTheDocument();
    // The terminal itself stays.
    expect(screen.getByTestId('mobile-terminal-region')).toContainElement(screen.getByTestId('terminal-display'));
  });

  it('locks the surface pill: drawn unavailable, and the tap is refused', () => {
    renderTab({ directInputOpen: true });
    const chat = screen.getByTestId('mobile-surface-mode-chat');
    expect(chat).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(chat);
    expect(screen.getByTestId('mobile-surface-mode-terminal')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('mobile-chat-surface')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(getMobileSurfaceModeStorageKey(WORKTREE_ID))).toBeNull();
  });

  it('re-pins the terminal to its last row when the keyboard opens', () => {
    const { rerender } = renderTab();
    const log = screen.getByTestId('terminal-log');
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 900 });
    log.scrollTop = 100;

    rerender(<MobileTerminalTab worktreeId={WORKTREE_ID} cliToolId="opencode" directInputOpen />);
    expect(log.scrollTop).toBe(900);
  });

  it('leaves a user who scrolled away where they are', () => {
    mockPaneState({ autoScroll: false });
    const { rerender } = renderTab();
    const log = screen.getByTestId('terminal-log');
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 900 });
    log.scrollTop = 100;

    rerender(<MobileTerminalTab worktreeId={WORKTREE_ID} cliToolId="opencode" directInputOpen />);
    expect(log.scrollTop).toBe(100);
  });

  it('leaves a disableAutoFollow pane where it is', () => {
    const { rerender } = renderTab({ disableAutoFollow: true });
    const log = screen.getByTestId('terminal-log');
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 900 });
    log.scrollTop = 0;

    rerender(
      <MobileTerminalTab worktreeId={WORKTREE_ID} cliToolId="opencode" disableAutoFollow directInputOpen />,
    );
    expect(log.scrollTop).toBe(0);
  });
});
