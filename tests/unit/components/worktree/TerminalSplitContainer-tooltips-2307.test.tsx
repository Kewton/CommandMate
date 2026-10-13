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

// Issue #3514: the Add / Remove split buttons became the layout icons 1-4.
const TARGET_TESTIDS = [
  'split-layout-1',
  'split-layout-2',
  'split-layout-3',
  'split-layout-4',
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
    // Issue #3514: "add a split" is now the next layout icon.
    expect(revealTooltip(screen.getByTestId('split-layout-2'))).toBe(
      'worktree.terminal.layoutSplits',
    );
    vi.useRealTimers();
  });

  it('shows the Remove-split Tooltip on hover after the delay', () => {
    vi.useFakeTimers();
    setup();
    // Issue #3514: "back to fewer splits" is the lower layout icon.
    expect(revealTooltip(screen.getByTestId('split-layout-1'))).toBe(
      'worktree.terminal.layoutSplits',
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
    // Issue #3514: the layout icons share their label with their Tooltip.
    for (const count of [1, 2, 3, 4]) {
      expect(screen.getByTestId(`split-layout-${count}`)).toHaveAttribute(
        'aria-label',
        'worktree.terminal.layoutSplits',
      );
    }
    expect(screen.getByTestId('equalize-split-widths')).toHaveAttribute(
      'aria-label',
      'worktree.terminal.equalizeWidthsHint',
    );
  });
});
