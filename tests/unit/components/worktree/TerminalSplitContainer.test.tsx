/**
 * Tests for TerminalSplitContainer (Issue #728)
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TerminalSplitContainer } from '@/components/worktree/TerminalSplitContainer';
import { clearTerminalSplitsLocalStorage } from '@tests/helpers/terminal-splits';

function setup(renderImpl?: () => React.ReactNode) {
  const renderPane = vi.fn(({ splitIndex, cliToolId, availableCliTools, onFocus }) => (
    <div data-split-index={splitIndex} data-cli-tool={cliToolId}>
      <span data-testid={`pane-cli-${splitIndex}`}>{cliToolId}</span>
      <span data-testid={`pane-available-count-${splitIndex}`}>
        {availableCliTools.length}
      </span>
      <textarea data-testid={`pane-textarea-${splitIndex}`} onFocus={onFocus} />
      {renderImpl?.()}
    </div>
  ));
  const utils = render(
    <TerminalSplitContainer worktreeId="w-1" renderPane={renderPane} />,
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

  it('availableCliTools excludes CLI used by other splits', () => {
    setup();
    fireEvent.click(screen.getByTestId('add-terminal-split'));
    // split 0 has 'claude', split 1 picked a different CLI; both panes should
    // show CLI_TOOL_IDS.length - 1 = 5 available tools (own + 4 others not taken).
    expect(screen.getByTestId('pane-available-count-0')).toHaveTextContent('5');
    expect(screen.getByTestId('pane-available-count-1')).toHaveTextContent('5');
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
        renderPane={renderPane}
        onFocusedSplitChange={cb}
      />,
    );
    fireEvent.click(screen.getByTestId('add-terminal-split'));
    cb.mockClear();
    fireEvent.focus(screen.getByTestId('ta-0'));
    expect(cb).toHaveBeenCalledWith(0);
  });
});

// ===========================================================================
// Issue #786: drag-drop validation owner. The container holds the `splits`
// array, so it classifies a drop as no-op / reject / apply and owns the toast
// messaging + activeCliTab sync. Each pane receives `onDropCliTool` via the
// renderPane args.
// ===========================================================================
describe('TerminalSplitContainer drop validation (Issue #786)', () => {
  beforeEach(() => {
    clearTerminalSplitsLocalStorage();
  });
  afterEach(() => {
    clearTerminalSplitsLocalStorage();
  });

  /**
   * Render a container whose panes expose a button that invokes the
   * `onDropCliTool` arg with a fixed cliId, so tests can simulate a drop on a
   * given splitIndex without a full DragEvent.
   */
  function setupDrop(opts: {
    showToast?: (message: string, type?: string) => void;
    onActiveCliTabChange?: (cliId: string) => void;
  }) {
    const renderPane = vi.fn(({ splitIndex, cliToolId, onDropCliTool }) => (
      <div data-split-index={splitIndex} data-cli-tool={cliToolId}>
        <span data-testid={`pane-cli-${splitIndex}`}>{cliToolId}</span>
        <button
          type="button"
          data-testid={`drop-claude-${splitIndex}`}
          onClick={() => onDropCliTool?.('claude')}
        >
          drop claude
        </button>
        <button
          type="button"
          data-testid={`drop-gemini-${splitIndex}`}
          onClick={() => onDropCliTool?.('gemini')}
        >
          drop gemini
        </button>
      </div>
    ));
    const utils = render(
      <TerminalSplitContainer
        worktreeId="w-1"
        renderPane={renderPane}
        showToast={opts.showToast}
        onActiveCliTabChange={opts.onActiveCliTabChange}
      />,
    );
    return { renderPane, ...utils };
  }

  it('accept: drops an unused CLI onto a split → switches CLI + activeCliTab sync + success toast', () => {
    const showToast = vi.fn();
    const onActiveCliTabChange = vi.fn();
    setupDrop({ showToast, onActiveCliTabChange });

    // Single split starts as 'claude'; drop 'gemini' (unused) onto split 0.
    fireEvent.click(screen.getByTestId('drop-gemini-0'));

    expect(screen.getByTestId('pane-cli-0')).toHaveTextContent('gemini');
    expect(onActiveCliTabChange).toHaveBeenCalledTimes(1);
    expect(onActiveCliTabChange).toHaveBeenCalledWith('gemini');
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0][1]).toBe('success');
  });

  it('reject: dropping a CLI already used by another split → warning toast naming split N, no change', () => {
    const showToast = vi.fn();
    const onActiveCliTabChange = vi.fn();
    setupDrop({ showToast, onActiveCliTabChange });

    // Grow to 2 splits: split 0 = claude, split 1 = (auto-picked, e.g. codex).
    fireEvent.click(screen.getByTestId('add-terminal-split'));
    showToast.mockClear();
    onActiveCliTabChange.mockClear();

    // Drop 'claude' (used by split 0, which is "split 1" in 1-based label) onto split 1.
    fireEvent.click(screen.getByTestId('drop-claude-1'));

    // Split 1 unchanged.
    expect(screen.getByTestId('pane-cli-1')).not.toHaveTextContent('claude');
    expect(onActiveCliTabChange).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledTimes(1);
    const [message, type] = showToast.mock.calls[0];
    expect(type).toBe('warning');
    expect(message).toMatch(/already in use by split 1/i);
    expect(message).toMatch(/Claude/);
  });

  it('no-op: dropping the split its OWN current CLI → no toast, no activeCliTab sync', () => {
    const showToast = vi.fn();
    const onActiveCliTabChange = vi.fn();
    setupDrop({ showToast, onActiveCliTabChange });

    // Split 0 is 'claude'; drop 'claude' onto it.
    fireEvent.click(screen.getByTestId('drop-claude-0'));

    expect(showToast).not.toHaveBeenCalled();
    expect(onActiveCliTabChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('pane-cli-0')).toHaveTextContent('claude');
  });

  it('does not throw when showToast / onActiveCliTabChange are omitted', () => {
    const renderPane = vi.fn(({ splitIndex, cliToolId, onDropCliTool }) => (
      <div data-split-index={splitIndex}>
        <span data-testid={`pane-cli-${splitIndex}`}>{cliToolId}</span>
        <button
          type="button"
          data-testid={`drop-gemini-${splitIndex}`}
          onClick={() => onDropCliTool?.('gemini')}
        >
          drop
        </button>
      </div>
    ));
    render(<TerminalSplitContainer worktreeId="w-1" renderPane={renderPane} />);
    expect(() =>
      fireEvent.click(screen.getByTestId('drop-gemini-0')),
    ).not.toThrow();
    // Change still applies (toast is optional).
    expect(screen.getByTestId('pane-cli-0')).toHaveTextContent('gemini');
  });
});
