/**
 * Issue #2261: `Mod+Shift+Enter` maximizes / restores the split that holds focus.
 *
 * Ownership is resolved exactly the way #2193's `Mod+Shift+M` resolves it — the
 * split whose `[data-split-index]` root contains `event.target` answers — so the
 * two chords cannot disagree about which split the user meant. This file pins
 * that equivalence, plus the one thing this chord needs that #2193 does not:
 * `preventDefault`, because `MessageInput` reads a bare Shift+Enter as "insert a
 * newline" and does not preventDefault it itself.
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

const WORKTREE_ID = 'wt-2261';

function renderSplit(
  splitIndex: number,
  onToggleMaximize: (() => void) | undefined,
  cliToolId: CLIToolType = 'claude',
) {
  return (
    <TerminalSplitPaneContent
      worktreeId={WORKTREE_ID}
      splitIndex={splitIndex}
      cliToolId={cliToolId}
      availableInstances={[inst('claude'), inst('codex')]}
      onInstanceChange={vi.fn()}
      onFocus={vi.fn()}
      autoYes={{ onToggle: vi.fn() }}
      onToggleMaximize={onToggleMaximize}
    />
  );
}

/** Dispatch the chord and report whether the default action was prevented. */
function pressChord(
  target: Element,
  overrides: Record<string, unknown> = {},
): boolean {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
    ...overrides,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('[#2261] TerminalSplitPaneContent Mod+Shift+Enter', () => {
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

  it('toggles the split that owns the focused element, and only that split', () => {
    const first = vi.fn();
    const second = vi.fn();
    render(
      <>
        {renderSplit(0, first, 'claude')}
        {renderSplit(1, second, 'codex')}
      </>,
    );

    pressChord(screen.getByTestId('terminal-split-pane-1'));

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('answers from the composer inside the split (a text field, but this split owns it)', () => {
    const onToggleMaximize = vi.fn();
    render(renderSplit(0, onToggleMaximize));

    const prevented = pressChord(screen.getByTestId('message-input-0'), { metaKey: true, ctrlKey: false });

    expect(onToggleMaximize).toHaveBeenCalledTimes(1);
    // Without this, MessageInput's Shift+Enter would drop a blank line into the
    // draft every time the split was maximized from the keyboard.
    expect(prevented).toBe(true);
  });

  it('falls back to the FIRST split when nothing inside a split has focus', () => {
    const first = vi.fn();
    const second = vi.fn();
    render(
      <>
        {renderSplit(0, first, 'claude')}
        {renderSplit(1, second, 'codex')}
      </>,
    );

    pressChord(document.body);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('stands down while the user is typing outside every split (same rule as #2193)', () => {
    const onToggleMaximize = vi.fn();
    render(renderSplit(0, onToggleMaximize));
    const outsideEditor = document.createElement('textarea');
    document.body.appendChild(outsideEditor);
    try {
      const prevented = pressChord(outsideEditor);
      expect(onToggleMaximize).not.toHaveBeenCalled();
      // And the keystroke still does whatever that field does with it.
      expect(prevented).toBe(false);
    } finally {
      outsideEditor.remove();
    }
  });

  it('ignores the chord without Shift, without the mod key, with Alt, or on another key', () => {
    const onToggleMaximize = vi.fn();
    render(renderSplit(0, onToggleMaximize));
    const pane = screen.getByTestId('terminal-split-pane-0');

    pressChord(pane, { shiftKey: false });
    pressChord(pane, { ctrlKey: false, metaKey: false });
    pressChord(pane, { altKey: true });
    pressChord(pane, { key: 'm' });

    expect(onToggleMaximize).not.toHaveBeenCalled();
  });

  it('leaves a plain Shift+Enter alone so the composer still inserts a newline', () => {
    const onToggleMaximize = vi.fn();
    render(renderSplit(0, onToggleMaximize));

    const prevented = pressChord(screen.getByTestId('message-input-0'), {
      ctrlKey: false,
      metaKey: false,
    });

    expect(onToggleMaximize).not.toHaveBeenCalled();
    expect(prevented).toBe(false);
  });

  it('is inert — and preventDefaults nothing — for a caller that wired no handler', () => {
    render(renderSplit(0, undefined));
    const prevented = pressChord(screen.getByTestId('message-input-0'));
    expect(prevented).toBe(false);
  });

  it('does not disturb the #2193 chord that shares the ownership rule', () => {
    const onToggleMaximize = vi.fn();
    render(renderSplit(0, onToggleMaximize));

    fireEvent.keyDown(screen.getByTestId('terminal-split-pane-0'), {
      key: 'm',
      ctrlKey: true,
      shiftKey: true,
    });

    expect(onToggleMaximize).not.toHaveBeenCalled();
  });
});
