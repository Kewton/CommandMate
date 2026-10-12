/**
 * Issue #3612: `maximizeDisabled` crosses TerminalSplitPaneContent into the real
 * TerminalSplitPane — the "…" maximize item is aria-disabled and inert, and
 * Mod+Shift+Enter neither toggles nor preventDefaults. Two splits: unchanged.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TerminalSplitPaneContent } from '@/components/worktree/TerminalSplitPaneContent';
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

// The real composer, minus everything but the textarea: the point of the
// `preventDefault` assertion is that this textarea does not gain a newline.
vi.mock('@/components/worktree/MessageInput', () => ({
  MessageInput: ({ splitIndex }: { splitIndex: number }) => (
    <textarea data-testid={`message-input-${splitIndex}`} />
  ),
}));

vi.mock('@/components/worktree/NavigationButtons', () => ({
  NavigationButtons: () => <div data-testid="navigation-buttons" />,
}));

vi.mock('@/components/worktree/TerminalEscapeHatch', () => ({
  TerminalEscapeHatch: () => <div data-testid="terminal-escape-hatch" />,
}));

vi.mock('@/components/worktree/PromptPanel', () => ({
  PromptPanel: () => null,
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

vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: () => ({
    messages: [],
    isLoading: false,
    refresh: vi.fn(() => Promise.resolve()),
  }),
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
  MOBILE_BREAKPOINT: 768,
}));

const WORKTREE_ID = 'wt-3612';

function renderSplit(maximizeDisabled: boolean, onToggleMaximize = vi.fn()) {
  render(
    <TerminalSplitPaneContent
      worktreeId={WORKTREE_ID}
      splitIndex={0}
      cliToolId="claude"
      availableInstances={[inst('claude'), inst('codex')]}
      onInstanceChange={vi.fn()}
      onFocus={vi.fn()}
      autoYes={{ onToggle: vi.fn() }}
      onToggleMaximize={onToggleMaximize}
      maximizeDisabled={maximizeDisabled}
    />,
  );
  return onToggleMaximize;
}

function openMoreMenu(): void {
  fireEvent.keyDown(screen.getByTestId('split-more-menu-0'), { key: 'Enter' });
}

function pressChord(target: Element): boolean {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('[#3612] maximize with a lone split, through TerminalSplitPaneContent', () => {
  beforeEach(() => {
    window.localStorage.clear();
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({ isRunning: true, fullOutput: 'tmux frame', thinking: false }),
      }),
    ) as unknown as typeof fetch;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('disables the "…" maximize item; click, Enter and Space do nothing', () => {
    const toggle = renderSplit(true);
    openMoreMenu();
    const item = screen.getByTestId('split-more-maximize-0');
    expect(item).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(item);
    fireEvent.keyDown(item, { key: 'Enter' });
    fireEvent.keyDown(item, { key: ' ' });
    expect(toggle).not.toHaveBeenCalled();
  });

  it('does not toggle or preventDefault Mod+Shift+Enter', () => {
    const toggle = renderSplit(true);
    const prevented = pressChord(screen.getByTestId('message-input-0'));
    expect(toggle).not.toHaveBeenCalled();
    expect(prevented).toBe(false);
  });

  it('keeps the item usable and the chord working with several splits (negative control)', () => {
    const toggle = renderSplit(false);
    openMoreMenu();
    const item = screen.getByTestId('split-more-maximize-0');
    expect(item).not.toHaveAttribute('aria-disabled');
    fireEvent.click(item);
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(pressChord(screen.getByTestId('message-input-0'))).toBe(true);
    expect(toggle).toHaveBeenCalledTimes(2);
  });
});
