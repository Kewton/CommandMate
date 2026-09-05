/**
 * Unit Tests for FilePanelSplit Component
 *
 * Issue #438: Terminal + file panel split view with PaneResizer
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FilePanelSplit } from '@/components/worktree/FilePanelSplit';
import {
  FILE_PANEL_COLLAPSED_STORAGE_KEY,
  FILE_PANEL_PANE_ID,
  useOpenFiles,
} from '@/hooks/useFilePanelState';
import type { FileTabsState } from '@/hooks/useFileTabs';

// Mock PaneResizer
vi.mock('@/components/worktree/PaneResizer', () => ({
  PaneResizer: ({ onResize }: { onResize: (delta: number) => void }) => (
    <div data-testid="pane-resizer" onClick={() => onResize(10)} />
  ),
}));

// Mock DiffViewer (Issue #447 path exercised by the #2259 snapshot tests)
vi.mock('@/components/worktree/DiffViewer', () => ({
  DiffViewer: ({ filePath }: { filePath: string }) => (
    <div data-testid="diff-viewer">{filePath}</div>
  ),
}));

// Mock FilePanelTabs
vi.mock('@/components/worktree/FilePanelTabs', () => ({
  FilePanelTabs: ({ tabs }: { tabs: unknown[] }) => (
    <div data-testid="file-panel-tabs">Tabs: {(tabs as { path: string }[]).map(t => t.path).join(',')}</div>
  ),
}));

describe('FilePanelSplit', () => {
  const defaultProps = {
    terminal: <div data-testid="terminal">Terminal</div>,
    worktreeId: 'test-wt',
    onCloseTab: vi.fn(),
    onActivateTab: vi.fn(),
    onLoadContent: vi.fn(),
    onLoadError: vi.fn(),
    onSetLoading: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  const openTabs: FileTabsState = {
    tabs: [{ path: 'a.ts', name: 'a.ts', content: null, loading: false, error: null, isDirty: false }],
    activeIndex: 0,
  };

  const twoTabs: FileTabsState = {
    tabs: [
      { path: 'a.ts', name: 'a.ts', content: null, loading: false, error: null, isDirty: false },
      { path: 'b.ts', name: 'b.ts', content: null, loading: false, error: null, isDirty: false },
    ],
    activeIndex: 0,
  };

  it('should render terminal at full width when no tabs are open', () => {
    const fileTabs: FileTabsState = { tabs: [], activeIndex: null };
    render(<FilePanelSplit fileTabs={fileTabs} {...defaultProps} />);

    expect(screen.getByTestId('terminal')).toBeInTheDocument();
    expect(screen.queryByTestId('pane-resizer')).not.toBeInTheDocument();
    expect(screen.queryByTestId('file-panel-tabs')).not.toBeInTheDocument();
  });

  it('should render split view with terminal and file panel when tabs exist', () => {
    const fileTabs: FileTabsState = {
      tabs: [{ path: 'a.ts', name: 'a.ts', content: null, loading: false, error: null, isDirty: false }],
      activeIndex: 0,
    };
    render(<FilePanelSplit fileTabs={fileTabs} {...defaultProps} />);

    expect(screen.getByTestId('terminal')).toBeInTheDocument();
    expect(screen.getByTestId('pane-resizer')).toBeInTheDocument();
    expect(screen.getByTestId('file-panel-tabs')).toBeInTheDocument();
  });

  it('should render both terminal pane and file panel pane as children', () => {
    const fileTabs: FileTabsState = {
      tabs: [{ path: 'a.ts', name: 'a.ts', content: null, loading: false, error: null, isDirty: false }],
      activeIndex: 0,
    };
    const { container } = render(
      <FilePanelSplit fileTabs={fileTabs} {...defaultProps} />,
    );

    // Should have terminal-pane and file-panel-pane
    expect(container.querySelector('[data-testid="terminal-pane"]')).toBeInTheDocument();
    expect(container.querySelector('[data-testid="file-panel-pane"]')).toBeInTheDocument();
  });

  // Issue #840 persisted the hidden state; Issue #2259 removed BOTH controls
  // this component used to render — the 36px collapsed strip on the right and
  // the 20px collapse column at the panel's left edge. The Action-bar "Open
  // Files" toggle (TerminalSplitContainer) is now the only switch, so hiding
  // the panel hands its whole width back to the terminal.
  describe('hidden state and the removed collapse strips (Issue #840 / #2259)', () => {
    it('uses the persisted collapsed=true state on mount (panel not rendered)', () => {
      window.localStorage.setItem(FILE_PANEL_COLLAPSED_STORAGE_KEY, 'true');
      render(<FilePanelSplit fileTabs={openTabs} {...defaultProps} />);

      expect(screen.queryByTestId('file-panel-tabs')).not.toBeInTheDocument();
      expect(screen.queryByTestId('file-panel-pane')).not.toBeInTheDocument();
      expect(screen.getByTestId('terminal')).toBeInTheDocument();
    });

    it('gives the terminal the full width when the panel is hidden', () => {
      window.localStorage.setItem(FILE_PANEL_COLLAPSED_STORAGE_KEY, 'true');
      render(<FilePanelSplit fileTabs={openTabs} {...defaultProps} />);

      // Pre-#2259 this was `calc(100% - 36px)`, the 36px paying for a strip
      // that only duplicated the Action-bar toggle.
      expect(screen.getByTestId('terminal-pane').style.width).toBe('100%');
      expect(screen.queryByTestId('file-panel-expand-bar')).not.toBeInTheDocument();
    });

    it('renders no toggle of its own in either state', () => {
      window.localStorage.setItem(FILE_PANEL_COLLAPSED_STORAGE_KEY, 'true');
      const { unmount } = render(<FilePanelSplit fileTabs={openTabs} {...defaultProps} />);
      expect(
        screen.queryByRole('button', { name: 'worktree.terminal.showFiles' }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText('worktree.terminal.filesLabel')).not.toBeInTheDocument();
      unmount();

      window.localStorage.setItem(FILE_PANEL_COLLAPSED_STORAGE_KEY, 'false');
      render(<FilePanelSplit fileTabs={openTabs} {...defaultProps} />);
      expect(screen.getByTestId('file-panel-tabs')).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'worktree.terminal.hideFiles' }),
      ).not.toBeInTheDocument();
    });

    it('names the panel region so the Action-bar toggle can point aria-controls at it', () => {
      render(<FilePanelSplit fileTabs={openTabs} {...defaultProps} />);
      expect(screen.getByTestId('file-panel-pane')).toHaveAttribute(
        'id',
        FILE_PANEL_PANE_ID,
      );
    });
  });

  // Issue #2259: the Action bar lives inside `terminal`, several levels below
  // the tab state, so the panel publishes what it holds through context.
  describe('open-files snapshot published to the Action bar (Issue #2259)', () => {
    function Probe() {
      const { tabCount, hasDiff } = useOpenFiles();
      return (
        <div data-testid="probe" data-tab-count={tabCount} data-has-diff={String(hasDiff)} />
      );
    }

    function snapshot() {
      const probe = screen.getByTestId('probe');
      return {
        tabCount: probe.getAttribute('data-tab-count'),
        hasDiff: probe.getAttribute('data-has-diff'),
      };
    }

    it('reports 0 tabs and no diff when nothing is open', () => {
      render(
        <FilePanelSplit
          {...defaultProps}
          terminal={<Probe />}
          fileTabs={{ tabs: [], activeIndex: null }}
        />,
      );
      expect(snapshot()).toEqual({ tabCount: '0', hasDiff: 'false' });
    });

    it('reports the tab count while the panel is open', () => {
      render(
        <FilePanelSplit {...defaultProps} terminal={<Probe />} fileTabs={twoTabs} />,
      );
      expect(snapshot()).toEqual({ tabCount: '2', hasDiff: 'false' });
    });

    it('keeps reporting the count while the panel is hidden', () => {
      window.localStorage.setItem(FILE_PANEL_COLLAPSED_STORAGE_KEY, 'true');
      render(
        <FilePanelSplit {...defaultProps} terminal={<Probe />} fileTabs={twoTabs} />,
      );
      expect(snapshot()).toEqual({ tabCount: '2', hasDiff: 'false' });
    });

    it('reports a diff with no tabs open (Issue #447 path)', () => {
      render(
        <FilePanelSplit
          {...defaultProps}
          terminal={<Probe />}
          fileTabs={{ tabs: [], activeIndex: null }}
          diffContent="@@ -1 +1 @@"
          diffFilePath="a.ts"
          onCloseDiff={vi.fn()}
        />,
      );
      expect(snapshot()).toEqual({ tabCount: '0', hasDiff: 'true' });
    });
  });
});
