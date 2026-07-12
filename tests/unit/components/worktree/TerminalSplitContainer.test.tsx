/**
 * Tests for TerminalSplitContainer (Issue #728, instance-keyed in Issue #869)
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

/**
 * Issue #869: the container is now driven by an agent-instance roster. The
 * default roster mirrors the pre-#869 selectable CLI tools: one PRIMARY instance
 * per CLI tool (id === cliTool), so split availability math (own + not-taken) is
 * unchanged (CLI_TOOL_IDS.length - taken).
 */
const ROSTER: AgentInstance[] = CLI_TOOL_IDS.map((cliTool, order) => ({
  id: cliTool,
  cliTool,
  alias: getCliToolDisplayName(cliTool),
  order,
}));

function setup(renderImpl?: () => React.ReactNode, instances: AgentInstance[] = ROSTER) {
  const renderPane = vi.fn(({ splitIndex, cliToolId, availableInstances, onFocus }) => (
    <div data-split-index={splitIndex} data-cli-tool={cliToolId}>
      <span data-testid={`pane-cli-${splitIndex}`}>{cliToolId}</span>
      <span data-testid={`pane-available-count-${splitIndex}`}>
        {availableInstances.length}
      </span>
      <textarea data-testid={`pane-textarea-${splitIndex}`} onFocus={onFocus} />
      {renderImpl?.()}
    </div>
  ));
  const utils = render(
    <TerminalSplitContainer
      worktreeId="w-1"
      instances={instances}
      renderPane={renderPane}
    />,
  );
  return { renderPane, ...utils };
}

describe('TerminalSplitContainer', () => {
  beforeEach(() => {
    clearTerminalSplitsLocalStorage();
  });
  afterEach(() => {
    clearTerminalSplitsLocalStorage();
  });

  it('renders an outer group with aria-label', () => {
    setup();
    const group = screen.getByRole('group', { name: /Terminal splits/i });
    expect(group).toBeInTheDocument();
  });

  it('starts with one split and disabled remove button', () => {
    setup();
    expect(screen.getByTestId('pane-cli-0')).toHaveTextContent('claude');
    expect(screen.getByTestId('add-terminal-split')).not.toBeDisabled();
    expect(screen.getByTestId('remove-terminal-split')).toBeDisabled();
  });

  it('add → 2 splits → renders 2 panes and 1 resizer', () => {
    setup();
    fireEvent.click(screen.getByTestId('add-terminal-split'));
    expect(screen.getByTestId('pane-cli-0')).toBeInTheDocument();
    expect(screen.getByTestId('pane-cli-1')).toBeInTheDocument();
    expect(screen.getByTestId('split-resizer-0')).toBeInTheDocument();
    expect(screen.queryByTestId('split-resizer-1')).not.toBeInTheDocument();
  });

  it('disables add at MAX_SPLITS=3 and disables remove at MIN=1', () => {
    setup();
    fireEvent.click(screen.getByTestId('add-terminal-split'));
    fireEvent.click(screen.getByTestId('add-terminal-split'));
    expect(screen.getByTestId('add-terminal-split')).toBeDisabled();
    expect(screen.getByTestId('remove-terminal-split')).not.toBeDisabled();

    fireEvent.click(screen.getByTestId('remove-terminal-split'));
    fireEvent.click(screen.getByTestId('remove-terminal-split'));
    expect(screen.getByTestId('remove-terminal-split')).toBeDisabled();
  });

  it('availableInstances excludes instances used by other splits', () => {
    setup();
    fireEvent.click(screen.getByTestId('add-terminal-split'));
    // split 0 has 'claude', split 1 auto-picked a different instance; both panes
    // should show ROSTER.length - 1 available instances (own + not-taken).
    const expectedAvailable = String(ROSTER.length - 1);
    expect(screen.getByTestId('pane-available-count-0')).toHaveTextContent(expectedAvailable);
    expect(screen.getByTestId('pane-available-count-1')).toHaveTextContent(expectedAvailable);
  });

  it('focuses the newly-added pane textarea after addSplit', async () => {
    setup();
    fireEvent.click(screen.getByTestId('add-terminal-split'));
    // jsdom: focus is sync inside effect
    const ta = screen.getByTestId('pane-textarea-1') as HTMLTextAreaElement;
    expect(document.activeElement).toBe(ta);
  });

  it('routes onFocus through to onFocusedSplitChange', () => {
    const cb = vi.fn();
    const renderPane = vi.fn(({ splitIndex, onFocus }) => (
      <div data-split-index={splitIndex}>
        <textarea data-testid={`ta-${splitIndex}`} onFocus={onFocus} />
      </div>
    ));
    render(
      <TerminalSplitContainer
        worktreeId="w-1"
        instances={ROSTER}
        renderPane={renderPane}
        onFocusedSplitChange={cb}
      />,
    );
    fireEvent.click(screen.getByTestId('add-terminal-split'));
    cb.mockClear();
    fireEvent.focus(screen.getByTestId('ta-0'));
    expect(cb).toHaveBeenCalledWith(0);
  });

  // Issue #869: a worktree may register two instances of the SAME CLI tool. Both
  // must be usable in separate splits and addressable in the availability list.
  it('supports two instances of the same CLI tool (Claude × 2) in separate splits', () => {
    const dualClaude: AgentInstance[] = [
      { id: 'claude', cliTool: 'claude', alias: 'Primary', order: 0 },
      { id: 'claude-2', cliTool: 'claude', alias: 'Review', order: 1 },
    ];
    setup(undefined, dualClaude);
    fireEvent.click(screen.getByTestId('add-terminal-split'));
    // Two splits, each backed by a distinct claude instance (same cliTool).
    expect(screen.getByTestId('pane-cli-0')).toHaveTextContent('claude');
    expect(screen.getByTestId('pane-cli-1')).toHaveTextContent('claude');
    // Each split sees only its own instance available (the other is taken).
    expect(screen.getByTestId('pane-available-count-0')).toHaveTextContent('1');
    expect(screen.getByTestId('pane-available-count-1')).toHaveTextContent('1');
  });
});

// ===========================================================================
// Issue #841 (Phase 2): the existing +Split/-Split Action bar also hosts
// "History" and "Files" toggle buttons. They are the single source of truth
// shared with the vertical collapse strips (useHistoryPaneState /
// useFilePanelState broadcast across instances), so toggling here flips the
// persisted state and aria-pressed reflects current visibility.
// ===========================================================================
describe('TerminalSplitContainer History/Files toggles (Issue #841)', () => {
  const HISTORY_KEY = 'commandmate.worktree.historyVisible';
  const FILE_PANEL_KEY = 'commandmate.worktree.filePanelCollapsed';

  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('renders History and Files toggle buttons (always visible at 1 split)', () => {
    setup();
    expect(screen.getByTestId('toggle-history-pane')).toBeInTheDocument();
    expect(screen.getByTestId('toggle-file-panel')).toBeInTheDocument();
  });

  it('keeps the toggles visible at MAX splits (split-count independent)', () => {
    setup();
    fireEvent.click(screen.getByTestId('add-terminal-split'));
    fireEvent.click(screen.getByTestId('add-terminal-split'));
    expect(screen.getByTestId('add-terminal-split')).toBeDisabled(); // at MAX
    expect(screen.getByTestId('toggle-history-pane')).toBeInTheDocument();
    expect(screen.getByTestId('toggle-file-panel')).toBeInTheDocument();
  });

  it('History toggle defaults to pressed (visible) and flips on click', () => {
    setup();
    const btn = screen.getByTestId('toggle-history-pane');
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-pressed', 'true');
  });

  it('Files toggle defaults to pressed (visible) and flips on click', () => {
    setup();
    const btn = screen.getByTestId('toggle-file-panel');
    // collapsed=false → visible → pressed
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-pressed', 'true');
  });

  it('History toggle persists visibility to localStorage', () => {
    setup();
    fireEvent.click(screen.getByTestId('toggle-history-pane'));
    expect(window.localStorage.getItem(HISTORY_KEY)).toBe('false');
  });

  it('Files toggle persists collapsed state to localStorage', () => {
    setup();
    fireEvent.click(screen.getByTestId('toggle-file-panel'));
    // Files hidden → file panel collapsed=true
    expect(window.localStorage.getItem(FILE_PANEL_KEY)).toBe('true');
  });

  it('aria-label / title reflect show vs hide depending on state', () => {
    setup();
    const history = screen.getByTestId('toggle-history-pane');
    // default visible → "hide" wording
    expect(history).toHaveAttribute('aria-label', 'worktree.terminal.hideHistory');
    expect(history).toHaveAttribute('title', 'worktree.terminal.hideHistory');
    fireEvent.click(history);
    expect(history).toHaveAttribute('aria-label', 'worktree.terminal.showHistory');

    const files = screen.getByTestId('toggle-file-panel');
    expect(files).toHaveAttribute('aria-label', 'worktree.terminal.hideFiles');
    fireEvent.click(files);
    expect(files).toHaveAttribute('aria-label', 'worktree.terminal.showFiles');
  });

  it('applies accent accent when active and gray when inactive', () => {
    setup();
    const history = screen.getByTestId('toggle-history-pane');
    // active (visible) → accent accent classes
    expect(history.className).toMatch(/accent/);
    fireEvent.click(history);
    // inactive (hidden) → gray text, no accent accent
    expect(history.className).not.toMatch(/accent/);
    expect(history.className).toMatch(/text-gray-500/);
  });

  it('does not affect the existing +Split / -Split controls', () => {
    setup();
    // +Split still adds; -Split still disabled at MIN=1
    expect(screen.getByTestId('add-terminal-split')).not.toBeDisabled();
    expect(screen.getByTestId('remove-terminal-split')).toBeDisabled();
    fireEvent.click(screen.getByTestId('add-terminal-split'));
    expect(screen.getByTestId('pane-cli-1')).toBeInTheDocument();
    expect(screen.getByTestId('remove-terminal-split')).not.toBeDisabled();
  });
});

// ===========================================================================
// Issue #861: the Action bar hosts an "equalize widths" button that, in one
// action, (a) equalizes the terminal split widths to 1/n and (b) resets the
// (split-shared) Message History width to its default. Disabled only when there
// is nothing to equalize (single split AND History hidden). Double-clicking a
// terminal resizer equalizes the split widths only (History is left as-is).
// ===========================================================================
describe('TerminalSplitContainer equalize widths (Issue #861)', () => {
  const HISTORY_WIDTH_KEY = 'commandmate.worktree.historyWidth';

  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  /** Read the flex-grow applied to each split's wrapper div (parent of the pane). */
  function splitFlexGrows(count: number): number[] {
    return Array.from({ length: count }, (_, i) => {
      const pane = document.querySelector(`[data-split-index="${i}"]`);
      const wrapper = pane?.parentElement as HTMLElement;
      return Number(wrapper.style.flexGrow);
    });
  }

  it('renders the equalize-widths button in the Action bar', () => {
    setup();
    expect(screen.getByTestId('equalize-split-widths')).toBeInTheDocument();
  });

  it('is enabled at 1 split while History is visible', () => {
    setup();
    expect(screen.getByTestId('equalize-split-widths')).not.toBeDisabled();
  });

  it('is disabled at 1 split when History is hidden (nothing to equalize)', () => {
    setup();
    fireEvent.click(screen.getByTestId('toggle-history-pane')); // hide History
    expect(screen.getByTestId('equalize-split-widths')).toBeDisabled();
  });

  it('is enabled with >1 split even when History is hidden', () => {
    setup();
    fireEvent.click(screen.getByTestId('toggle-history-pane')); // hide History
    fireEvent.click(screen.getByTestId('add-terminal-split')); // -> 2 splits
    expect(screen.getByTestId('equalize-split-widths')).not.toBeDisabled();
  });

  it('equalizes split widths on click (3 splits → each flex-grow ~1/3)', () => {
    setup();
    fireEvent.click(screen.getByTestId('add-terminal-split')); // -> 2
    fireEvent.click(screen.getByTestId('add-terminal-split')); // -> 3 ([0.5,0.25,0.25])
    // Pre-condition: widths are NOT all equal.
    const before = splitFlexGrows(3);
    expect(before[0]).not.toBeCloseTo(before[1]);

    fireEvent.click(screen.getByTestId('equalize-split-widths'));
    for (const g of splitFlexGrows(3)) {
      expect(g).toBeCloseTo(1 / 3, 5);
    }
  });

  it('resets the History width to default (40) on click', () => {
    window.localStorage.setItem(HISTORY_WIDTH_KEY, '25');
    setup();
    fireEvent.click(screen.getByTestId('equalize-split-widths'));
    expect(window.localStorage.getItem(HISTORY_WIDTH_KEY)).toBe('40');
  });

  it('has a descriptive aria-label / title', () => {
    setup();
    const btn = screen.getByTestId('equalize-split-widths');
    expect(btn).toHaveAttribute('aria-label', 'worktree.terminal.equalizeWidthsHint');
    expect(btn).toHaveAttribute('title', 'worktree.terminal.equalizeWidthsHint');
  });

  it('double-clicking a terminal resizer equalizes widths but leaves History width', () => {
    window.localStorage.setItem(HISTORY_WIDTH_KEY, '25');
    setup();
    fireEvent.click(screen.getByTestId('add-terminal-split')); // -> 2
    fireEvent.click(screen.getByTestId('add-terminal-split')); // -> 3

    const separator = screen
      .getByTestId('split-resizer-0')
      .querySelector('[role="separator"]') as HTMLElement;
    fireEvent.doubleClick(separator);

    for (const g of splitFlexGrows(3)) {
      expect(g).toBeCloseTo(1 / 3, 5);
    }
    // Double-click is terminal-only: History width is untouched.
    expect(window.localStorage.getItem(HISTORY_WIDTH_KEY)).toBe('25');
  });
});

// ===========================================================================
// Issue #786 / #869: drag-drop validation owner. The container holds the
// `splits` array, so it classifies a drop as no-op / reject / apply and owns the
// toast messaging + active-instance sync. Each pane receives `onDropInstance`
// via the renderPane args; the payload is now an agent `instanceId`.
// ===========================================================================
describe('TerminalSplitContainer drop validation (Issue #786 / #869)', () => {
  beforeEach(() => {
    clearTerminalSplitsLocalStorage();
  });
  afterEach(() => {
    clearTerminalSplitsLocalStorage();
  });

  /**
   * Render a container whose panes expose buttons that invoke `onDropInstance`
   * with a fixed instanceId, so tests can simulate a drop on a given splitIndex
   * without a full DragEvent.
   */
  function setupDrop(opts: {
    showToast?: (message: string, type?: string) => void;
    onActiveInstanceChange?: (instanceId: string) => void;
  }) {
    const renderPane = vi.fn(({ splitIndex, cliToolId, onDropInstance }) => (
      <div data-split-index={splitIndex} data-cli-tool={cliToolId}>
        <span data-testid={`pane-cli-${splitIndex}`}>{cliToolId}</span>
        <button
          type="button"
          data-testid={`drop-claude-${splitIndex}`}
          onClick={() => onDropInstance?.('claude')}
        >
          drop claude
        </button>
        <button
          type="button"
          data-testid={`drop-gemini-${splitIndex}`}
          onClick={() => onDropInstance?.('gemini')}
        >
          drop gemini
        </button>
      </div>
    ));
    const utils = render(
      <TerminalSplitContainer
        worktreeId="w-1"
        instances={ROSTER}
        renderPane={renderPane}
        showToast={opts.showToast}
        onActiveInstanceChange={opts.onActiveInstanceChange}
      />,
    );
    return { renderPane, ...utils };
  }

  it('accept: drops an unused instance onto a split → switches instance + active sync + success toast', () => {
    const showToast = vi.fn();
    const onActiveInstanceChange = vi.fn();
    setupDrop({ showToast, onActiveInstanceChange });

    // Single split starts as 'claude'; drop 'gemini' (unused) onto split 0.
    fireEvent.click(screen.getByTestId('drop-gemini-0'));

    expect(screen.getByTestId('pane-cli-0')).toHaveTextContent('gemini');
    expect(onActiveInstanceChange).toHaveBeenCalledTimes(1);
    expect(onActiveInstanceChange).toHaveBeenCalledWith('gemini');
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0][1]).toBe('success');
  });

  it('reject: dropping an instance already used by another split → warning toast naming split N, no change', () => {
    const showToast = vi.fn();
    const onActiveInstanceChange = vi.fn();
    setupDrop({ showToast, onActiveInstanceChange });

    // Grow to 2 splits: split 0 = claude, split 1 = (auto-picked, e.g. codex).
    fireEvent.click(screen.getByTestId('add-terminal-split'));
    showToast.mockClear();
    onActiveInstanceChange.mockClear();

    // Drop 'claude' (used by split 0, which is "split 1" in 1-based label) onto split 1.
    fireEvent.click(screen.getByTestId('drop-claude-1'));

    // Split 1 unchanged.
    expect(screen.getByTestId('pane-cli-1')).not.toHaveTextContent('claude');
    expect(onActiveInstanceChange).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledTimes(1);
    const [message, type] = showToast.mock.calls[0];
    expect(type).toBe('warning');
    expect(message).toMatch(/already in use by split 1/i);
    expect(message).toMatch(/Claude/);
  });

  it('no-op: dropping the split its OWN current instance → no toast, no active sync', () => {
    const showToast = vi.fn();
    const onActiveInstanceChange = vi.fn();
    setupDrop({ showToast, onActiveInstanceChange });

    // Split 0 is 'claude'; drop 'claude' onto it.
    fireEvent.click(screen.getByTestId('drop-claude-0'));

    expect(showToast).not.toHaveBeenCalled();
    expect(onActiveInstanceChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('pane-cli-0')).toHaveTextContent('claude');
  });

  it('does not throw when showToast / onActiveInstanceChange are omitted', () => {
    const renderPane = vi.fn(({ splitIndex, cliToolId, onDropInstance }) => (
      <div data-split-index={splitIndex}>
        <span data-testid={`pane-cli-${splitIndex}`}>{cliToolId}</span>
        <button
          type="button"
          data-testid={`drop-gemini-${splitIndex}`}
          onClick={() => onDropInstance?.('gemini')}
        >
          drop
        </button>
      </div>
    ));
    render(
      <TerminalSplitContainer
        worktreeId="w-1"
        instances={ROSTER}
        renderPane={renderPane}
      />,
    );
    expect(() =>
      fireEvent.click(screen.getByTestId('drop-gemini-0')),
    ).not.toThrow();
    // Change still applies (toast is optional).
    expect(screen.getByTestId('pane-cli-0')).toHaveTextContent('gemini');
  });
});

// ===========================================================================
// Issue #977: the action-bar buttons are all left-aligned in a single group,
// ordered +Split → -Split → Equal widths → History → Files. The `ml-auto` that
// previously split the bar into left/right groups has been removed.
// ===========================================================================
describe('TerminalSplitContainer action-bar layout (Issue #977)', () => {
  it('renders the action buttons in DOM order +Split → -Split → Equal widths → History → Files', () => {
    setup();
    const order = [
      'add-terminal-split',
      'remove-terminal-split',
      'equalize-split-widths',
      'toggle-history-pane',
      'toggle-file-panel',
    ];
    // Each button must precede the next in document order (left-to-right bar).
    for (let i = 0; i < order.length - 1; i++) {
      const current = screen.getByTestId(order[i]);
      const next = screen.getByTestId(order[i + 1]);
      expect(
        current.compareDocumentPosition(next) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it('does not push +Split to the right with ml-auto (left-aligned bar)', () => {
    setup();
    expect(screen.getByTestId('add-terminal-split').className).not.toContain(
      'ml-auto',
    );
  });
});
