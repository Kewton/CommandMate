/**
 * Tests for TerminalContainer (Issue #730)
 *
 * TerminalContainer hosts the History pane + Terminal+FilePanel area together,
 * so the ActivityBar can run full-height while History no longer lives in the
 * top-level desktop layout.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  TerminalContainer,
  HISTORY_PANE_ID,
} from '@/components/worktree/TerminalContainer';

// We mock the hook so we can control visible/width and assert toggle/setWidth.
const mockToggle = vi.fn();
const mockSetWidth = vi.fn();
const hookReturn = {
  visible: true,
  width: 40,
  toggle: mockToggle,
  setWidth: mockSetWidth,
};

vi.mock('@/hooks/useHistoryPaneState', () => ({
  useHistoryPaneState: () => hookReturn,
  DEFAULT_HISTORY_WIDTH: 40,
  HISTORY_VISIBLE_STORAGE_KEY: 'commandmate.worktree.historyVisible',
  HISTORY_WIDTH_STORAGE_KEY: 'commandmate.worktree.historyWidth',
}));

// Lightweight ErrorBoundary mock: pass through children but expose componentName.
vi.mock('@/components/error/ErrorBoundary', () => ({
  ErrorBoundary: ({
    componentName,
    children,
  }: {
    componentName?: string;
    children: React.ReactNode;
  }) => (
    <div data-testid={`error-boundary-${componentName ?? 'unknown'}`}>
      {children}
    </div>
  ),
}));

describe('TerminalContainer (Issue #730)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hookReturn.visible = true;
    hookReturn.width = 40;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exports HISTORY_PANE_ID = "worktree-history-pane"', () => {
    expect(HISTORY_PANE_ID).toBe('worktree-history-pane');
  });

  it('renders both history and terminal when visible=true', () => {
    render(
      <TerminalContainer
        history={<div data-testid="history-content">H</div>}
        terminal={<div data-testid="terminal-content">T</div>}
      />
    );
    expect(screen.getByTestId('history-content')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-content')).toBeInTheDocument();
  });

  it('history wrapper has id=worktree-history-pane and percent width style', () => {
    render(
      <TerminalContainer
        history={<div data-testid="history-content">H</div>}
        terminal={<div data-testid="terminal-content">T</div>}
      />
    );
    const slot = document.getElementById('worktree-history-pane');
    expect(slot).not.toBeNull();
    expect(slot?.style.width).toBe('40%');
  });

  it('renders PaneResizer (role=separator) when visible=true', () => {
    render(
      <TerminalContainer
        history={<div data-testid="history-content">H</div>}
        terminal={<div data-testid="terminal-content">T</div>}
      />
    );
    expect(screen.getByRole('separator')).toBeInTheDocument();
  });

  // Issue #2259: hiding the column used to leave a 36px vertical strip carrying
  // a second "show history" button. It is gone — the Action-bar toggle is the
  // only control — so the terminal is the whole row.
  it('renders nothing beside the terminal when visible=false', () => {
    hookReturn.visible = false;
    render(
      <TerminalContainer
        history={<div data-testid="history-content">H</div>}
        terminal={<div data-testid="terminal-content">T</div>}
      />
    );
    expect(document.getElementById('worktree-history-pane')).toBeNull();
    expect(screen.queryByTestId('history-content')).not.toBeInTheDocument();
    expect(screen.queryByTestId('terminal-container-expand-bar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('history-pane-expand')).not.toBeInTheDocument();
    // The terminal slot is the row's only child, so it occupies 100% of it.
    const row = screen.getByTestId('terminal-container-terminal-slot').parentElement;
    expect(row?.children).toHaveLength(1);
  });

  it('offers no toggle of its own while the column is hidden', () => {
    hookReturn.visible = false;
    render(
      <TerminalContainer
        history={<div data-testid="history-content">H</div>}
        terminal={<div data-testid="terminal-content">T</div>}
      />
    );
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(mockToggle).not.toHaveBeenCalled();
  });

  it('terminal is rendered regardless of visible state', () => {
    hookReturn.visible = false;
    const { rerender } = render(
      <TerminalContainer
        history={<div data-testid="history-content">H</div>}
        terminal={<div data-testid="terminal-content">T</div>}
      />
    );
    expect(screen.getByTestId('terminal-content')).toBeInTheDocument();
    hookReturn.visible = true;
    rerender(
      <TerminalContainer
        history={<div data-testid="history-content">H</div>}
        terminal={<div data-testid="terminal-content">T</div>}
      />
    );
    expect(screen.getByTestId('terminal-content')).toBeInTheDocument();
  });

  it('wraps history with ErrorBoundary componentName="HistoryPane"', () => {
    render(
      <TerminalContainer
        history={<div data-testid="history-content">H</div>}
        terminal={<div data-testid="terminal-content">T</div>}
      />
    );
    expect(screen.getByTestId('error-boundary-HistoryPane')).toBeInTheDocument();
  });

  it('wraps terminal with ErrorBoundary componentName="TerminalAndFilePanel"', () => {
    render(
      <TerminalContainer
        history={<div data-testid="history-content">H</div>}
        terminal={<div data-testid="terminal-content">T</div>}
      />
    );
    expect(
      screen.getByTestId('error-boundary-TerminalAndFilePanel')
    ).toBeInTheDocument();
  });

  it('uses width from useHistoryPaneState (e.g. 55%)', () => {
    hookReturn.width = 55;
    render(
      <TerminalContainer
        history={<div data-testid="history-content">H</div>}
        terminal={<div data-testid="terminal-content">T</div>}
      />
    );
    const slot = document.getElementById('worktree-history-pane');
    expect(slot?.style.width).toBe('55%');
  });

  it('PaneResizer keyboard resize delegates to setWidth via percent delta', () => {
    // Mock container offsetWidth so the resize math produces a non-zero delta.
    Object.defineProperty(HTMLDivElement.prototype, 'offsetWidth', {
      configurable: true,
      value: 1000,
    });
    render(
      <TerminalContainer
        history={<div data-testid="history-content">H</div>}
        terminal={<div data-testid="terminal-content">T</div>}
      />
    );
    const resizer = screen.getByRole('separator');
    // Trigger keyboard arrow to invoke onResize (delta=10px → 1% of 1000px).
    fireEvent.keyDown(resizer, { key: 'ArrowRight' });
    expect(mockSetWidth).toHaveBeenCalled();
    Object.defineProperty(HTMLDivElement.prototype, 'offsetWidth', {
      configurable: true,
      value: 0,
    });
  });

  // Issue #744: on PC the History pane now lives inside each terminal split,
  // so the top-level TerminalContainer is rendered WITHOUT a `history` prop.
  describe('history prop omitted (Issue #744 PC default)', () => {
    it('renders only the terminal area when history is omitted', () => {
      render(<TerminalContainer terminal={<div data-testid="terminal-content">T</div>} />);
      expect(screen.getByTestId('terminal-content')).toBeInTheDocument();
      // No history column, no resizer, no expand bar.
      expect(document.getElementById('worktree-history-pane')).toBeNull();
      expect(screen.queryByTestId('terminal-container-history-slot')).not.toBeInTheDocument();
      expect(screen.queryByRole('separator')).not.toBeInTheDocument();
      expect(screen.queryByTestId('terminal-container-expand-bar')).not.toBeInTheDocument();
    });

    it('does not render the history-pane-expand button when history is omitted', () => {
      render(<TerminalContainer terminal={<div data-testid="terminal-content">T</div>} />);
      expect(screen.queryByTestId('history-pane-expand')).not.toBeInTheDocument();
    });

    it('still wraps the terminal area in its ErrorBoundary', () => {
      render(<TerminalContainer terminal={<div data-testid="terminal-content">T</div>} />);
      expect(
        screen.getByTestId('error-boundary-TerminalAndFilePanel')
      ).toBeInTheDocument();
    });
  });
});
