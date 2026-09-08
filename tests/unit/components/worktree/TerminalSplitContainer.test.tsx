/**
 * Tests for TerminalSplitContainer (Issue #728, instance-keyed in Issue #869)
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { TerminalSplitContainer } from '@/components/worktree/TerminalSplitContainer';
import {
  OpenFilesContext,
  FILE_PANEL_PANE_ID,
  type OpenFilesSnapshot,
} from '@/hooks/useFilePanelState';
import { SURFACE_MODE_CHANGE_EVENT } from '@/hooks/useSplitSurfaceModes';
import { getSplitSurfaceModeStorageKey } from '@/config/surface-mode-config';
import {
  clearTerminalSplitsLocalStorage,
  mockTerminalSplitsLocalStorage,
  readTerminalSplitsLocalStorage,
} from '@tests/helpers/terminal-splits';
import { TOOLTIP_DELAY_MS } from '@/components/common/Tooltip';
import {
  CLI_TOOL_IDS,
  getCliToolDisplayName,
  type AgentInstance,
} from '@/lib/cli-tools/types';
import { MIN_GRID_ROW_PX } from '@/config/terminal-split-config';

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

/**
 * Issue #2307: the layout-ops / panel-toggle buttons no longer carry a native
 * `title` — they are wrapped in `common/Tooltip` (Issue #730's ActivityBar
 * mechanism). Reveal the bubble the same way ActivityBar.test.tsx does:
 * hover the trigger, advance past `TOOLTIP_DELAY_MS`, and read the portalled
 * `role="tooltip"` text. Caller must wrap in `vi.useFakeTimers()`.
 */
function revealTooltip(trigger: HTMLElement): string {
  fireEvent.mouseEnter(trigger);
  act(() => {
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
  });
  return screen.getByRole('tooltip', { hidden: true }).textContent ?? '';
}

/**
 * Issue #2259: the Action bar's "Open Files" toggle is disabled while the file
 * panel has nothing to show, and the count it badges comes from the enclosing
 * `FilePanelSplit` through context. Tests that drive that button therefore have
 * to declare what is open.
 */
function setupWithOpenFiles(
  openFiles: OpenFilesSnapshot,
  instances: AgentInstance[] = ROSTER,
) {
  const renderPane = vi.fn(({ splitIndex, cliToolId }) => (
    <div data-split-index={splitIndex} data-cli-tool={cliToolId}>
      <span data-testid={`pane-cli-${splitIndex}`}>{cliToolId}</span>
    </div>
  ));
  const utils = render(
    <OpenFilesContext.Provider value={openFiles}>
      <TerminalSplitContainer
        worktreeId="w-1"
        instances={instances}
        renderPane={renderPane}
      />
    </OpenFilesContext.Provider>,
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

  // Issue #2421: the ceiling moved 3 -> 4, so the 3rd add is no longer the last.
  it('disables add at MAX_SPLITS=4 and disables remove at MIN=1', () => {
    setup();
    fireEvent.click(screen.getByTestId('add-terminal-split'));
    fireEvent.click(screen.getByTestId('add-terminal-split'));
    expect(screen.getByTestId('add-terminal-split')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('add-terminal-split'));
    expect(screen.getByTestId('add-terminal-split')).toBeDisabled();
    expect(screen.getByTestId('remove-terminal-split')).not.toBeDisabled();

    fireEvent.click(screen.getByTestId('remove-terminal-split'));
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
    fireEvent.click(screen.getByTestId('add-terminal-split')); // Issue #2421: MAX is 4
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
    setupWithOpenFiles({ tabCount: 1, hasDiff: false });
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
    setupWithOpenFiles({ tabCount: 1, hasDiff: false });
    fireEvent.click(screen.getByTestId('toggle-file-panel'));
    // Files hidden → file panel collapsed=true
    expect(window.localStorage.getItem(FILE_PANEL_KEY)).toBe('true');
  });

  it('aria-label / Tooltip reflect show vs hide depending on state', () => {
    vi.useFakeTimers();
    setupWithOpenFiles({ tabCount: 1, hasDiff: false });
    const history = screen.getByTestId('toggle-history-pane');
    // default visible → "hide" wording
    expect(history).toHaveAttribute('aria-label', 'worktree.terminal.hideHistory');
    // No native title (Issue #2307: replaced by common/Tooltip).
    expect(history.getAttribute('title')).toBeNull();
    // Issue #2259: the Tooltip also carries the scope of the switch, because
    // one History state drives every split.
    const tooltipText = revealTooltip(history);
    expect(tooltipText).toContain('worktree.terminal.hideHistory');
    expect(tooltipText).toContain('worktree.terminal.historyAllSplitsHint');
    vi.useRealTimers();
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

  it('has a descriptive aria-label / Tooltip', () => {
    vi.useFakeTimers();
    setup();
    const btn = screen.getByTestId('equalize-split-widths');
    expect(btn).toHaveAttribute('aria-label', 'worktree.terminal.equalizeWidthsHint');
    expect(btn.getAttribute('title')).toBeNull();
    expect(revealTooltip(btn)).toBe('worktree.terminal.equalizeWidthsHint');
    vi.useRealTimers();
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

// ===========================================================================
// Issue #1152: the DesktopHeader instance switcher must drive the PRIMARY split
// (which owns the display polling + message send), not just the worktree-global
// active badge. The header publishes a token-stamped `headerInstanceSelection`;
// the container applies it to split 0 (or focus-moves on an S1-002 collision).
// Applying it to `split.instanceId` is the fix — the pane already resolves
// `instanceId ?? cliToolId` into its /current-output poll + send (covered by
// TerminalSplitPaneContent.test.tsx), so once the split reflects the header the
// whole chain (display + send) follows.
// ===========================================================================
describe('TerminalSplitContainer header→split wiring (Issue #1152)', () => {
  const DUAL_CLAUDE: AgentInstance[] = [
    { id: 'claude', cliTool: 'claude', alias: 'Primary', order: 0 },
    { id: 'claude-2', cliTool: 'claude', alias: 'Review', order: 1 },
  ];

  beforeEach(() => {
    clearTerminalSplitsLocalStorage();
  });
  afterEach(() => {
    clearTerminalSplitsLocalStorage();
  });

  /**
   * Harness that owns the token-stamped `headerInstanceSelection` state exactly
   * like WorktreeDetailDesktop, so tests exercise the real prop contract. The
   * panes expose their resolved `instanceId` (the value that flows into polling +
   * send) plus a button that drives the split-internal dropdown path.
   */
  function setupHeaderWiring(instances: AgentInstance[] = DUAL_CLAUDE) {
    const onFocusedSplitChange = vi.fn();
    function Harness() {
      const [sel, setSel] = React.useState<{ instanceId: string; token: number } | null>(null);
      const tokenRef = React.useRef(0);
      const select = (id: string) => {
        tokenRef.current += 1;
        setSel({ instanceId: id, token: tokenRef.current });
      };
      return (
        <>
          <button type="button" data-testid="hdr-select-claude" onClick={() => select('claude')}>
            claude
          </button>
          <button type="button" data-testid="hdr-select-claude-2" onClick={() => select('claude-2')}>
            claude-2
          </button>
          <TerminalSplitContainer
            worktreeId="w-1"
            instances={instances}
            headerInstanceSelection={sel}
            onFocusedSplitChange={onFocusedSplitChange}
            renderPane={({ splitIndex, instanceId, cliToolId, onInstanceChange, onFocus }) => (
              <div data-split-index={splitIndex}>
                <span data-testid={`pane-inst-${splitIndex}`}>{instanceId}</span>
                <span data-testid={`pane-cli-${splitIndex}`}>{cliToolId}</span>
                <button
                  type="button"
                  data-testid={`pane-dropdown-claude-2-${splitIndex}`}
                  onClick={() => onInstanceChange('claude-2')}
                >
                  dropdown claude-2
                </button>
                <textarea data-testid={`ta-${splitIndex}`} onFocus={onFocus} />
              </div>
            )}
          />
        </>
      );
    }
    const utils = render(<Harness />);
    return { onFocusedSplitChange, ...utils };
  }

  it('header selection binds an unshown instance to the primary split (the wiring bug fix)', () => {
    setupHeaderWiring();
    // Default: split 0 shows the first roster instance.
    expect(screen.getByTestId('pane-inst-0').textContent).toBe('claude');

    // Select "Claude 2" in the header → the primary split switches to claude-2
    // (previously the header updated only the active badge, leaving the split —
    // and therefore display + send — on claude).
    fireEvent.click(screen.getByTestId('hdr-select-claude-2'));
    expect(screen.getByTestId('pane-inst-0').textContent).toBe('claude-2');

    // And back to claude.
    fireEvent.click(screen.getByTestId('hdr-select-claude'));
    expect(screen.getByTestId('pane-inst-0').textContent).toBe('claude');
  });

  it('collision policy: selecting an instance already shown in another split focus-moves, no reassignment (S1-002)', () => {
    const { onFocusedSplitChange } = setupHeaderWiring();
    // Grow to 2 splits: [claude, claude-2].
    fireEvent.click(screen.getByTestId('add-terminal-split'));
    expect(screen.getByTestId('pane-inst-0').textContent).toBe('claude');
    expect(screen.getByTestId('pane-inst-1').textContent).toBe('claude-2');

    // Focus split 0 so the focus-move to split 1 is an observable change.
    fireEvent.focus(screen.getByTestId('ta-0'));
    onFocusedSplitChange.mockClear();

    // Header selects claude-2, which already lives in split 1.
    fireEvent.click(screen.getByTestId('hdr-select-claude-2'));

    // Splits are untouched — no duplication, no reassignment.
    expect(screen.getByTestId('pane-inst-0').textContent).toBe('claude');
    expect(screen.getByTestId('pane-inst-1').textContent).toBe('claude-2');
    // Focus moved to the split that already shows the selected instance.
    expect(onFocusedSplitChange).toHaveBeenCalledWith(1);
  });

  it('no-op: selecting the instance already in the primary split changes nothing', () => {
    const { onFocusedSplitChange } = setupHeaderWiring();
    expect(screen.getByTestId('pane-inst-0').textContent).toBe('claude');
    onFocusedSplitChange.mockClear();

    fireEvent.click(screen.getByTestId('hdr-select-claude'));

    expect(screen.getByTestId('pane-inst-0').textContent).toBe('claude');
    expect(onFocusedSplitChange).not.toHaveBeenCalled();
  });

  it('regression: the split-internal dropdown still reassigns via onInstanceChange', () => {
    setupHeaderWiring();
    // split 0 starts as claude; the dropdown picks claude-2.
    expect(screen.getByTestId('pane-inst-0').textContent).toBe('claude');
    fireEvent.click(screen.getByTestId('pane-dropdown-claude-2-0'));
    expect(screen.getByTestId('pane-inst-0').textContent).toBe('claude-2');
  });

  it('applies each header click once and is a no-op without a selection', () => {
    // No selection (sel=null) → the default split is untouched.
    setupHeaderWiring();
    expect(screen.getByTestId('pane-inst-0').textContent).toBe('claude');
    // Repeated selection of the same target is idempotent (token gate).
    fireEvent.click(screen.getByTestId('hdr-select-claude-2'));
    fireEvent.click(screen.getByTestId('hdr-select-claude-2'));
    expect(screen.getByTestId('pane-inst-0').textContent).toBe('claude-2');
  });
});

// ===========================================================================
// Issue #2259: the Action bar is now the ONLY place either panel is toggled,
// so each toggle has to say when its panel cannot appear at all instead of
// flipping a state with no visible effect.
//
//  - History lives in the TERMINAL surface. The chat surface (#2193) shows the
//    transcript alone by design (#2232), so with every split in chat mode the
//    button changed nothing while still rendering as pressed — the screenshot
//    in #2232's UAT.
//  - The file panel is not rendered at all with no tabs and no diff, which is
//    the "press Files and nothing happens" complaint the Issue opens with.
// ===========================================================================
describe('TerminalSplitContainer panel toggle availability (Issue #2259)', () => {
  const WORKTREE_ID = 'w-1';

  beforeEach(() => {
    window.localStorage.clear();
    clearTerminalSplitsLocalStorage();
  });
  afterEach(() => {
    window.localStorage.clear();
    clearTerminalSplitsLocalStorage();
  });

  function setSurface(splitIndex: number, mode: 'terminal' | 'chat') {
    window.localStorage.setItem(
      getSplitSurfaceModeStorageKey(WORKTREE_ID, splitIndex),
      mode,
    );
  }

  describe('History toggle', () => {
    it('is enabled while the only split shows the terminal surface', () => {
      setSurface(0, 'terminal');
      setup();
      const btn = screen.getByTestId('toggle-history-pane');
      expect(btn).not.toBeDisabled();
      expect(btn).toHaveAttribute('aria-disabled', 'false');
    });

    it('is disabled when every split shows chat', () => {
      vi.useFakeTimers();
      setSurface(0, 'chat');
      setup();
      const btn = screen.getByTestId('toggle-history-pane');
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute('aria-disabled', 'true');
      expect(btn.getAttribute('title')).toBeNull();
      expect(revealTooltip(btn)).toBe('worktree.terminal.historyChatOnlyHint');
      vi.useRealTimers();
    });

    it('does not toggle the persisted state while disabled', () => {
      setSurface(0, 'chat');
      setup();
      fireEvent.click(screen.getByTestId('toggle-history-pane'));
      expect(
        window.localStorage.getItem('commandmate.worktree.historyVisible'),
      ).toBeNull();
    });

    it('is enabled again as soon as ONE split shows the terminal', () => {
      setSurface(0, 'chat');
      setSurface(1, 'terminal');
      setup();
      expect(screen.getByTestId('toggle-history-pane')).toBeDisabled();
      // Adding split 1 brings a terminal surface back onto the screen.
      fireEvent.click(screen.getByTestId('add-terminal-split'));
      expect(screen.getByTestId('toggle-history-pane')).not.toBeDisabled();
    });

    it('re-enables live when a split switches back to the terminal', () => {
      setSurface(0, 'chat');
      setup();
      expect(screen.getByTestId('toggle-history-pane')).toBeDisabled();

      // The panes broadcast their mode changes; the bar listens (a same-window
      // localStorage write fires no `storage` event).
      act(() => {
        window.dispatchEvent(
          new CustomEvent(SURFACE_MODE_CHANGE_EVENT, {
            detail: { worktreeId: WORKTREE_ID, splitIndex: 0, mode: 'terminal' },
          }),
        );
      });
      expect(screen.getByTestId('toggle-history-pane')).not.toBeDisabled();
    });

    it('names every split history region in aria-controls', () => {
      setup();
      expect(screen.getByTestId('toggle-history-pane')).toHaveAttribute(
        'aria-controls',
        'split-history-slot-0',
      );
      fireEvent.click(screen.getByTestId('add-terminal-split'));
      expect(screen.getByTestId('toggle-history-pane')).toHaveAttribute(
        'aria-controls',
        'split-history-slot-0 split-history-slot-1',
      );
    });

    it('reports its expanded state, not just its pressed state', () => {
      setup();
      const btn = screen.getByTestId('toggle-history-pane');
      expect(btn).toHaveAttribute('aria-expanded', 'true');
      fireEvent.click(btn);
      expect(btn).toHaveAttribute('aria-expanded', 'false');
    });
  });

  describe('"Open Files" toggle', () => {
    it('is disabled with no tabs and no diff', () => {
      vi.useFakeTimers();
      setupWithOpenFiles({ tabCount: 0, hasDiff: false });
      const btn = screen.getByTestId('toggle-file-panel');
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute('aria-disabled', 'true');
      expect(btn.getAttribute('title')).toBeNull();
      expect(revealTooltip(btn)).toBe('worktree.terminal.filesEmptyHint');
      expect(screen.queryByTestId('open-files-count')).not.toBeInTheDocument();
      vi.useRealTimers();
    });

    it('is enabled by a diff even with no tabs open (Issue #447 path)', () => {
      setupWithOpenFiles({ tabCount: 0, hasDiff: true });
      expect(screen.getByTestId('toggle-file-panel')).not.toBeDisabled();
      // A diff is not a tab, so there is no count to badge.
      expect(screen.queryByTestId('open-files-count')).not.toBeInTheDocument();
    });

    it('badges the open tab count', () => {
      setupWithOpenFiles({ tabCount: 3, hasDiff: false });
      const btn = screen.getByTestId('toggle-file-panel');
      expect(btn).not.toBeDisabled();
      expect(screen.getByTestId('open-files-count')).toHaveTextContent('3');
    });

    it('does not toggle the persisted state while disabled', () => {
      setupWithOpenFiles({ tabCount: 0, hasDiff: false });
      fireEvent.click(screen.getByTestId('toggle-file-panel'));
      expect(
        window.localStorage.getItem('commandmate.worktree.filePanelCollapsed'),
      ).toBeNull();
    });

    it('points aria-controls / aria-expanded at the file panel region', () => {
      setupWithOpenFiles({ tabCount: 1, hasDiff: false });
      const btn = screen.getByTestId('toggle-file-panel');
      expect(btn).toHaveAttribute('aria-controls', FILE_PANEL_PANE_ID);
      expect(btn).toHaveAttribute('aria-expanded', 'true');
      fireEvent.click(btn);
      expect(btn).toHaveAttribute('aria-expanded', 'false');
    });
  });
});

/**
 * Issue #2421: the 2x2 grid.
 *
 * A quarter-width column cannot show a 200-column agent TUI, so the 4th split
 * switches the container from a flex row to a CSS grid. These tests read the
 * layout the way the browser does — the container's `grid-template-*` and each
 * pane's track placement — because "there are four panes on screen" is equally
 * true of the four-column layout this Issue exists to avoid.
 */
describe('[#2421] TerminalSplitContainer 2x2 grid', () => {
  beforeEach(() => clearTerminalSplitsLocalStorage());
  afterEach(() => clearTerminalSplitsLocalStorage());

  function addSplits(n: number): void {
    for (let i = 0; i < n; i++) {
      fireEvent.click(screen.getByTestId('add-terminal-split'));
    }
  }

  const layout = () => screen.getByTestId('terminal-split-layout');
  const wrapperOf = (idx: number) => screen.getByTestId(`split-wrapper-${idx}`);

  describe('1-3 splits stay the pre-#2421 flex row (regression)', () => {
    it.each([1, 2, 3])('renders %i split(s) as a row, not a grid', (count) => {
      setup();
      addSplits(count - 1);
      expect(layout()).toHaveAttribute('data-layout', 'row');
      expect(layout().className).toContain('flex');
      expect(layout().className).not.toContain('grid');
      expect(layout().style.gridTemplateColumns).toBe('');
      expect(layout().style.gridTemplateRows).toBe('');
      // Panes are flex children sized by flex-grow, with no track placement.
      for (let i = 0; i < count; i++) {
        expect(wrapperOf(i).style.flexBasis).toBe('0px');
        expect(Number(wrapperOf(i).style.flexGrow)).toBeGreaterThan(0);
        expect(wrapperOf(i).style.gridColumn).toBe('');
      }
      // One divider per boundary, all of them the row's positional resizers.
      expect(document.querySelectorAll('[data-testid^="split-resizer-"]')).toHaveLength(
        count - 1,
      );
      expect(screen.queryByTestId('split-grid-column-resizer')).not.toBeInTheDocument();
      expect(screen.queryByTestId('split-grid-row-resizer')).not.toBeInTheDocument();
    });
  });

  it('switches to a 2x2 grid at the 4th split', () => {
    setup();
    addSplits(3);
    expect(layout()).toHaveAttribute('data-layout', 'grid');
    expect(layout().className).toContain('grid');
    // Two pane columns with a divider track between them, as NORMALISED `fr`
    // factors (#2424). The stored shares are `0.25` per pane; handing those to
    // CSS verbatim sums to 0.5, which lays the tracks out at half width and
    // leaves the right half of the grid blank.
    expect(layout().style.gridTemplateColumns).toBe('1fr 4px 1fr');
    // ...and two pane rows, each floored so a 2x2 cannot crush the terminals.
    expect(layout().style.gridTemplateRows).toBe(
      `minmax(${MIN_GRID_ROW_PX}px, 1fr) 4px minmax(${MIN_GRID_ROW_PX}px, 1fr)`,
    );
  });

  /*
   * Issue #2424: the grid must FILL its container, not merely keep the ratio.
   *
   * The regression it guards was a ratio that was already right — `0.25fr` and
   * `0.25fr` describe two equal columns — laid out at half width because CSS
   * gives tracks whose flex factors sum below 1 only that fraction of the
   * leftover space. Asserting the ratio alone passes against the bug.
   *
   * The invariant asserted here is **每 factor >= 1**, not "the pair sums to 1".
   * The weaker one is not enough under `minmax()`: once a row is pinned at
   * MIN_GRID_ROW_PX the grid freezes that track and shares what is left among
   * the REMAINING factors, so a partner holding 0.74 strands the rest. Measured
   * on a 775px container: `0.7387fr / 0.2613fr` renders `362.7px / 280px` and
   * leaves 128px blank; `2.827fr / 1fr` renders `491px / 280px` and leaves none.
   */
  describe('grid tracks fill the container (Issue #2424)', () => {
    // Every `<number>fr` in the template, wherever it sits — the row track is
    // `minmax(280px, 0.5fr)`, so splitting on spaces would miss it entirely and
    // report a sum of 0 for a perfectly good template.
    const frSum = (template: string): number =>
      [...template.matchAll(/([\d.]+)fr/g)].reduce(
        (total, match) => total + parseFloat(match[1]),
        0,
      );

    const frFactors = (template: string): number[] =>
      [...template.matchAll(/([\d.]+)fr/g)].map((m) => parseFloat(m[1]));

    it('every column fr factor is at least 1 on a fresh grid', () => {
      setup();
      addSplits(3);
      const factors = frFactors(layout().style.gridTemplateColumns);
      expect(factors).toHaveLength(2);
      for (const f of factors) expect(f).toBeGreaterThanOrEqual(1);
    });

    it('every row fr factor is at least 1 on a fresh grid', () => {
      setup();
      addSplits(3);
      const factors = frFactors(layout().style.gridTemplateRows);
      expect(factors).toHaveLength(2);
      for (const f of factors) expect(f).toBeGreaterThanOrEqual(1);
    });

    it('fills vertically for a persisted rowHeights pair that sums below 1', () => {
      // `isValidRowHeights` accepts any positive pair, so this payload is legal
      // and reaches the renderer as-is. Before #2424 it opened a gap along the
      // bottom the same way the columns opened one down the right.
      mockTerminalSplitsLocalStorage('w-1', {
        splits: [
          { cliToolId: 'claude', instanceId: 'claude' },
          { cliToolId: 'claude', instanceId: 'claude-2' },
          { cliToolId: 'codex', instanceId: 'codex' },
          { cliToolId: 'codex', instanceId: 'codex-2' },
        ],
        widths: [0.25, 0.25, 0.25, 0.25],
        rowHeights: [0.3, 0.3],
      });
      setup();
      expect(layout()).toHaveAttribute('data-layout', 'grid');
      const factors = frFactors(layout().style.gridTemplateRows);
      expect(factors).toHaveLength(2);
      for (const f of factors) expect(f).toBeGreaterThanOrEqual(1);
    });
  });

  it('places the four panes as 2 rows x 2 columns (not one row of four)', () => {
    setup();
    addSplits(3);
    // Tracks 1 and 3 are the panes; track 2 on each axis is the divider.
    expect([wrapperOf(0).style.gridColumn, wrapperOf(0).style.gridRow]).toEqual(['1', '1']);
    expect([wrapperOf(1).style.gridColumn, wrapperOf(1).style.gridRow]).toEqual(['3', '1']);
    expect([wrapperOf(2).style.gridColumn, wrapperOf(2).style.gridRow]).toEqual(['1', '3']);
    expect([wrapperOf(3).style.gridColumn, wrapperOf(3).style.gridRow]).toEqual(['3', '3']);
    // The flex sizing that WOULD produce four columns is gone.
    for (const i of [0, 1, 2, 3]) expect(wrapperOf(i).style.flexGrow).toBe('');
  });

  it('scrolls rather than shrinking past the row floor on a short viewport', () => {
    setup();
    addSplits(3);
    expect(layout().className).toContain('overflow-y-auto');
  });

  /*
   * A grid column is shared by both of its cells, so the grid has ONE column
   * boundary and ONE row boundary — two dividers, not the three a four-way flex
   * row would have.
   */
  it('replaces the row dividers with exactly one column and one row divider', () => {
    setup();
    addSplits(3);
    expect(document.querySelectorAll('[data-testid^="split-resizer-"]')).toHaveLength(0);

    const column = screen.getByTestId('split-grid-column-resizer');
    const row = screen.getByTestId('split-grid-row-resizer');
    expect(within(column).getByRole('separator')).toHaveAttribute(
      'aria-orientation',
      'horizontal',
    );
    // The vertical orientation had NO caller in src/ before this Issue.
    expect(within(row).getByRole('separator')).toHaveAttribute(
      'aria-orientation',
      'vertical',
    );
    expect(within(row).getByRole('separator').className).toContain('cursor-row-resize');
    // Each spans the whole of its axis, across both of the tracks it divides.
    expect([column.style.gridColumn, column.style.gridRow]).toEqual(['2', '1 / span 3']);
    expect([row.style.gridColumn, row.style.gridRow]).toEqual(['1 / span 3', '2']);
  });

  describe('the vertical divider drives (and persists) the row heights', () => {
    // jsdom reports every box as 0x0, and the resize math divides by the
    // container's size — so the pixel delta has to land against a real one.
    function withContainerSize(run: () => void): void {
      Object.defineProperty(HTMLDivElement.prototype, 'offsetHeight', {
        configurable: true,
        value: 1000,
      });
      Object.defineProperty(HTMLDivElement.prototype, 'offsetWidth', {
        configurable: true,
        value: 1000,
      });
      try {
        run();
      } finally {
        Object.defineProperty(HTMLDivElement.prototype, 'offsetHeight', {
          configurable: true,
          value: 0,
        });
        Object.defineProperty(HTMLDivElement.prototype, 'offsetWidth', {
          configurable: true,
          value: 0,
        });
      }
    }

    it('drags the row boundary down and writes the new ratio to storage', () => {
      withContainerSize(() => {
        setup();
        addSplits(3);
        const handle = within(screen.getByTestId('split-grid-row-resizer')).getByRole(
          'separator',
        );

        fireEvent.mouseDown(handle, { clientY: 500 });
        fireEvent.mouseMove(document, { clientY: 600 }); // +100px of 1000px = +0.1
        fireEvent.mouseUp(document);

        // Top row grew, bottom row shrank, and the pair still sums to 1.
        expect(layout().style.gridTemplateRows).toBe(
          `minmax(${MIN_GRID_ROW_PX}px, 1.4999999999999998fr) 4px minmax(${MIN_GRID_ROW_PX}px, 1fr)`,
        );
        const stored = readTerminalSplitsLocalStorage('w-1');
        expect(stored?.rowHeights?.[0]).toBeCloseTo(0.6, 5);
        expect(stored?.rowHeights?.[1]).toBeCloseTo(0.4, 5);
      });
    });

    it('resizes with the keyboard too (ArrowDown / ArrowUp)', () => {
      withContainerSize(() => {
        setup();
        addSplits(3);
        const handle = within(screen.getByTestId('split-grid-row-resizer')).getByRole(
          'separator',
        );

        fireEvent.keyDown(handle, { key: 'ArrowDown' }); // +10px of 1000px
        expect(readTerminalSplitsLocalStorage('w-1')?.rowHeights?.[0]).toBeCloseTo(0.51, 5);

        fireEvent.keyDown(handle, { key: 'ArrowUp' });
        expect(readTerminalSplitsLocalStorage('w-1')?.rowHeights?.[0]).toBeCloseTo(0.5, 5);
      });
    });

    /*
     * `PaneResizer`'s `orientation="vertical"` branch had NO caller in `src/`
     * before this Issue, so all three of its input paths are exercised here
     * rather than assumed: mouse (above), keyboard (above) and touch. Touch
     * matters because the vertical branch reads `touches[0].clientY` where the
     * horizontal one reads `clientX` — a copy-paste slip there is invisible on a
     * desktop and total on a tablet.
     */
    it('resizes by touch drag as well', () => {
      withContainerSize(() => {
        setup();
        addSplits(3);
        const handle = within(screen.getByTestId('split-grid-row-resizer')).getByRole(
          'separator',
        );

        fireEvent.touchStart(handle, { touches: [{ clientX: 0, clientY: 400 }] });
        fireEvent.touchMove(document, { touches: [{ clientX: 0, clientY: 500 }] });
        fireEvent.touchEnd(document, { touches: [] });

        expect(readTerminalSplitsLocalStorage('w-1')?.rowHeights?.[0]).toBeCloseTo(0.6, 5);
      });
    });

    it('refuses to drag a row past the 5% floor', () => {
      withContainerSize(() => {
        setup();
        addSplits(3);
        const handle = within(screen.getByTestId('split-grid-row-resizer')).getByRole(
          'separator',
        );

        fireEvent.mouseDown(handle, { clientY: 500 });
        fireEvent.mouseMove(document, { clientY: 1500 }); // would leave the bottom row at -0.5
        fireEvent.mouseUp(document);

        expect(readTerminalSplitsLocalStorage('w-1')?.rowHeights).toEqual([0.5, 0.5]);
      });
    });

    /*
     * The column divider cannot reuse the row layout's handler: that one divides
     * by the sum of ALL FOUR widths (1.0) while the two visible columns only
     * occupy half of it, which would move the boundary at twice the pointer's
     * speed. 100px of a 1000px container has to read as 10% of the columns.
     */
    it('moves the shared column boundary at pointer speed and mirrors it to the bottom row', () => {
      withContainerSize(() => {
        setup();
        addSplits(3);
        const handle = within(screen.getByTestId('split-grid-column-resizer')).getByRole(
          'separator',
        );

        fireEvent.mouseDown(handle, { clientX: 500 });
        fireEvent.mouseMove(document, { clientX: 600 }); // +100px of 1000px
        fireEvent.mouseUp(document);

        // 0.25 + 0.1 * (0.25 + 0.25) = 0.30 -> a 60/40 column split, written
        // out as normalised `fr` (#2424): the handler preserves its own total
        // (0.5), so the shares stay 0.3 / 0.2 and only the rendered factors are
        // scaled.
        expect(layout().style.gridTemplateColumns).toBe('1.4999999999999998fr 4px 1fr');
        const stored = readTerminalSplitsLocalStorage('w-1');
        expect(stored?.widths?.[2]).toBeCloseTo(stored?.widths?.[0] ?? 0, 5);
        expect(stored?.widths?.[3]).toBeCloseTo(stored?.widths?.[1] ?? 0, 5);
      });
    });

    it('double-clicking a grid divider equalizes both axes', () => {
      withContainerSize(() => {
        setup();
        addSplits(3);
        const rowHandle = within(screen.getByTestId('split-grid-row-resizer')).getByRole(
          'separator',
        );
        fireEvent.keyDown(rowHandle, { key: 'ArrowDown' });
        expect(readTerminalSplitsLocalStorage('w-1')?.rowHeights?.[0]).not.toBeCloseTo(
          0.5,
          5,
        );

        fireEvent.doubleClick(rowHandle);
        expect(readTerminalSplitsLocalStorage('w-1')?.rowHeights).toEqual([0.5, 0.5]);
      });
    });
  });
});
