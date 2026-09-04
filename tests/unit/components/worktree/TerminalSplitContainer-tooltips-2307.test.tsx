/**
 * Issue #2307: the Action bar's layout-ops and panel-toggle buttons (Add /
 * Remove split, equalize widths, maximize the focused split, History /
 * Files visibility) are wrapped in `common/Tooltip` instead of relying on
 * the native `title` attribute — same mechanism ActivityBar uses (Issue
 * #730), same reason: native title is slow (~1-1.5s), unreachable by
 * keyboard, and browser-styled.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { TerminalSplitContainer } from '@/components/worktree/TerminalSplitContainer';
import { clearTerminalSplitsLocalStorage } from '@tests/helpers/terminal-splits';
import { CLI_TOOL_IDS, getCliToolDisplayName, type AgentInstance } from '@/lib/cli-tools/types';
import { TOOLTIP_DELAY_MS } from '@/components/common/Tooltip';

const ROSTER: AgentInstance[] = CLI_TOOL_IDS.map((cliTool, order) => ({
  id: cliTool,
  cliTool,
  alias: getCliToolDisplayName(cliTool),
  order,
}));

function setup() {
  const renderPane = vi.fn(({ splitIndex }: { splitIndex: number }) => (
    <div data-testid={`pane-${splitIndex}`} />
  ));
  return render(
    <TerminalSplitContainer worktreeId="w-1" instances={ROSTER} renderPane={renderPane} />,
  );
}

/** Hover a trigger and advance past TOOLTIP_DELAY_MS; caller owns fake timers. */
function revealTooltip(trigger: HTMLElement): string {
  fireEvent.mouseEnter(trigger);
  act(() => {
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
  });
  return screen.getByRole('tooltip', { hidden: true }).textContent ?? '';
}

const TARGET_TESTIDS = [
  'add-terminal-split',
  'remove-terminal-split',
  'equalize-split-widths',
  'toggle-maximize-split',
  'toggle-history-pane',
  'toggle-file-panel',
];

describe('[#2307] TerminalSplitContainer Action-bar hover discoverability', () => {
  beforeEach(() => clearTerminalSplitsLocalStorage());
  afterEach(() => clearTerminalSplitsLocalStorage());

  it('carries no native title on any Action-bar button', () => {
    setup();
    for (const testid of TARGET_TESTIDS) {
      expect(screen.getByTestId(testid).getAttribute('title')).toBeNull();
    }
  });

  it('wraps every Action-bar button in a common/Tooltip', () => {
    setup();
    for (const testid of TARGET_TESTIDS) {
      const btn = screen.getByTestId(testid);
      // Tooltip.tsx renders `<span data-testid="tooltip-wrapper">` as the
      // direct parent of the trigger it wraps.
      expect(btn.parentElement).toHaveAttribute('data-testid', 'tooltip-wrapper');
    }
  });

  it('shows the Add-split Tooltip on hover after the delay', () => {
    vi.useFakeTimers();
    setup();
    expect(revealTooltip(screen.getByTestId('add-terminal-split'))).toBe(
      'worktree.terminal.addSplit',
    );
    vi.useRealTimers();
  });

  it('shows the Remove-split Tooltip on hover after the delay', () => {
    vi.useFakeTimers();
    setup();
    expect(revealTooltip(screen.getByTestId('remove-terminal-split'))).toBe(
      'worktree.terminal.removeSplit',
    );
    vi.useRealTimers();
  });

  it('shows the Action-bar maximize Tooltip carrying the shortcut hint', () => {
    vi.useFakeTimers();
    setup();
    const text = revealTooltip(screen.getByTestId('toggle-maximize-split'));
    expect(text).toContain('worktree.terminal.maximizeFocusedSplit');
    expect(text).toContain('worktree.terminal.maximizeShortcutHint');
    vi.useRealTimers();
  });

  it('keeps aria-label / data-testid unchanged on every wrapped button', () => {
    setup();
    expect(screen.getByTestId('add-terminal-split')).toHaveAttribute(
      'aria-label',
      'worktree.terminal.addSplit',
    );
    expect(screen.getByTestId('remove-terminal-split')).toHaveAttribute(
      'aria-label',
      'worktree.terminal.removeSplit',
    );
    expect(screen.getByTestId('equalize-split-widths')).toHaveAttribute(
      'aria-label',
      'worktree.terminal.equalizeWidthsHint',
    );
  });
});
