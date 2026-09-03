/**
 * Issue #2261: the Action bar's maximize/restore toggle and the layout it drives.
 *
 * The load-bearing assertion here is that the other splits are HIDDEN, not
 * unmounted: their `useTerminalPanePolling` and their tmux sessions have to keep
 * running while they are off screen, which is the difference between "maximize"
 * and "close the other splits". A `flexGrow: 0` implementation would also read
 * as hidden to the eye while leaving a zero-width box for every `measureElement`
 * inside it, so the display property itself is pinned.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TerminalSplitContainer } from '@/components/worktree/TerminalSplitContainer';
import { clearTerminalSplitsLocalStorage } from '@tests/helpers/terminal-splits';
import {
  CLI_TOOL_IDS,
  getCliToolDisplayName,
  type AgentInstance,
} from '@/lib/cli-tools/types';

const ROSTER: AgentInstance[] = CLI_TOOL_IDS.map((cliTool, order) => ({
  id: cliTool,
  cliTool,
  alias: getCliToolDisplayName(cliTool),
  order,
}));

/**
 * The pane stub mirrors the real wiring: `data-split-index` on the root (which
 * is what both keyboard chords resolve ownership through) and the container's
 * own maximize props surfaced as a button + a pressed marker.
 */
function setup() {
  const renderPane = vi.fn(
    ({ splitIndex, onFocus, isMaximized, onToggleMaximize }) => (
      <div data-split-index={splitIndex}>
        <span data-testid={`pane-${splitIndex}`}>pane {splitIndex}</span>
        <textarea data-testid={`pane-textarea-${splitIndex}`} onFocus={onFocus} />
        <button
          type="button"
          data-testid={`pane-maximize-${splitIndex}`}
          aria-pressed={isMaximized}
          onClick={onToggleMaximize}
        >
          maximize
        </button>
      </div>
    ),
  );
  const utils = render(
    <TerminalSplitContainer worktreeId="w-1" instances={ROSTER} renderPane={renderPane} />,
  );
  return { renderPane, ...utils };
}

function wrapperOf(idx: number): HTMLElement {
  return screen.getByTestId(`split-wrapper-${idx}`);
}

function addSplits(n: number): void {
  for (let i = 0; i < n; i++) {
    fireEvent.click(screen.getByTestId('add-terminal-split'));
  }
}

describe('[#2261] TerminalSplitContainer maximize toggle', () => {
  beforeEach(() => clearTerminalSplitsLocalStorage());
  afterEach(() => clearTerminalSplitsLocalStorage());

  it('renders the toggle in the Action bar, unpressed, after the equalize button', () => {
    setup();
    const button = screen.getByTestId('toggle-maximize-split');
    expect(button).toHaveAttribute('aria-pressed', 'false');
    const equalize = screen.getByTestId('equalize-split-widths');
    expect(
      equalize.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('is disabled at a single split (nothing to take room from)', () => {
    setup();
    expect(screen.getByTestId('toggle-maximize-split')).toBeDisabled();
    addSplits(1);
    expect(screen.getByTestId('toggle-maximize-split')).not.toBeDisabled();
  });

  it('hides the other splits with display:none WITHOUT unmounting them', () => {
    setup();
    addSplits(2); // -> 3 splits

    fireEvent.click(screen.getByTestId('pane-maximize-1'));

    expect(wrapperOf(0).style.display).toBe('none');
    expect(wrapperOf(2).style.display).toBe('none');
    expect(wrapperOf(1).style.display).toBe('');
    // Still mounted: their polling and sessions keep running while off screen.
    expect(screen.getByTestId('pane-0')).toBeInTheDocument();
    expect(screen.getByTestId('pane-2')).toBeInTheDocument();
  });

  it('gives the maximized split the whole row (flex-grow 1, not 0 for the rest)', () => {
    setup();
    addSplits(1); // -> 2 splits ([0.5, 0.5])

    fireEvent.click(screen.getByTestId('pane-maximize-0'));

    expect(Number(wrapperOf(0).style.flexGrow)).toBe(1);
    // The hidden split keeps its persisted ratio — nothing zeroed it, so
    // restoring is exact rather than a re-derivation.
    expect(Number(wrapperOf(1).style.flexGrow)).toBeCloseTo(0.5, 5);
  });

  it('restores the exact previous ratios', () => {
    setup();
    addSplits(2); // -> 3 splits ([0.5, 0.25, 0.25])
    const before = [0, 1, 2].map((i) => Number(wrapperOf(i).style.flexGrow));

    fireEvent.click(screen.getByTestId('pane-maximize-2'));
    fireEvent.click(screen.getByTestId('pane-maximize-2'));

    const after = [0, 1, 2].map((i) => Number(wrapperOf(i).style.flexGrow));
    expect(after).toEqual(before);
    for (const i of [0, 1, 2]) expect(wrapperOf(i).style.display).toBe('');
  });

  it('hides the resizers while a split is maximized and brings them back on restore', () => {
    setup();
    addSplits(1);
    expect(screen.getByTestId('split-resizer-0').style.display).toBe('');

    fireEvent.click(screen.getByTestId('pane-maximize-0'));
    expect(screen.getByTestId('split-resizer-0').style.display).toBe('none');

    fireEvent.click(screen.getByTestId('pane-maximize-0'));
    expect(screen.getByTestId('split-resizer-0').style.display).toBe('');
  });

  describe('the two toggles are one state', () => {
    it('the Action bar toggle maximizes the FOCUSED split', () => {
      setup();
      addSplits(1);
      fireEvent.focus(screen.getByTestId('pane-textarea-1'));

      fireEvent.click(screen.getByTestId('toggle-maximize-split'));

      expect(wrapperOf(0).style.display).toBe('none');
      expect(wrapperOf(1).style.display).toBe('');
    });

    it('the Action bar toggle restores what a title-bar toggle maximized', () => {
      setup();
      addSplits(1);
      fireEvent.click(screen.getByTestId('pane-maximize-1'));
      expect(wrapperOf(0).style.display).toBe('none');

      fireEvent.click(screen.getByTestId('toggle-maximize-split'));
      expect(wrapperOf(0).style.display).toBe('');
    });

    it('keeps aria-pressed in sync across the title bar and the Action bar', () => {
      setup();
      addSplits(1);
      const header = () => screen.getByTestId('toggle-maximize-split');
      const pane1 = () => screen.getByTestId('pane-maximize-1');

      expect(header()).toHaveAttribute('aria-pressed', 'false');
      expect(pane1()).toHaveAttribute('aria-pressed', 'false');

      fireEvent.click(pane1());
      expect(header()).toHaveAttribute('aria-pressed', 'true');
      expect(pane1()).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('pane-maximize-0')).toHaveAttribute('aria-pressed', 'false');

      fireEvent.click(header());
      expect(header()).toHaveAttribute('aria-pressed', 'false');
      expect(pane1()).toHaveAttribute('aria-pressed', 'false');
    });

    it('swaps the Action bar label between maximize and restore', () => {
      setup();
      addSplits(1);
      expect(screen.getByTestId('toggle-maximize-split')).toHaveAttribute(
        'aria-label',
        'worktree.terminal.maximizeFocusedSplit',
      );
      fireEvent.click(screen.getByTestId('pane-maximize-0'));
      expect(screen.getByTestId('toggle-maximize-split')).toHaveAttribute(
        'aria-label',
        'worktree.terminal.restoreSplits',
      );
    });
  });

  describe('the split-count label', () => {
    it('shows the count while nothing is maximized', () => {
      setup();
      addSplits(1);
      expect(screen.getByTestId('split-count-label')).toHaveTextContent('2 / 3 splits');
    });

    it('says which split is filling the row while one is maximized', () => {
      setup();
      addSplits(1);
      fireEvent.click(screen.getByTestId('pane-maximize-1'));
      // The mock t() echoes the key; the real message interpolates {split}=2.
      expect(screen.getByTestId('split-count-label')).toHaveTextContent(
        'worktree.terminal.maximizedStatus',
      );
      expect(screen.getByTestId('split-count-label')).not.toHaveTextContent('splits');
    });
  });

  describe('release conditions reach the layout', () => {
    it('adding a split restores every split', () => {
      setup();
      addSplits(1);
      fireEvent.click(screen.getByTestId('pane-maximize-0'));
      expect(wrapperOf(1).style.display).toBe('none');

      addSplits(1); // -> 3 splits
      for (const i of [0, 1, 2]) expect(wrapperOf(i).style.display).toBe('');
      expect(screen.getByTestId('toggle-maximize-split')).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    });

    it('removing a split restores every split', () => {
      setup();
      addSplits(2);
      fireEvent.click(screen.getByTestId('pane-maximize-0'));
      expect(wrapperOf(1).style.display).toBe('none');

      fireEvent.click(screen.getByTestId('remove-terminal-split')); // -> 2 splits
      for (const i of [0, 1]) expect(wrapperOf(i).style.display).toBe('');
    });

    it('equalizing widths restores every split', () => {
      setup();
      addSplits(1);
      fireEvent.click(screen.getByTestId('pane-maximize-1'));
      expect(wrapperOf(0).style.display).toBe('none');

      fireEvent.click(screen.getByTestId('equalize-split-widths'));
      for (const i of [0, 1]) expect(wrapperOf(i).style.display).toBe('');
    });
  });
});
