/**
 * Unit Tests for FilePanelSplit Component
 *
 * Issue #438: Terminal + file panel split view with PaneResizer
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FilePanelSplit } from '@/components/worktree/FilePanelSplit';
import { FILE_PANEL_COLLAPSED_STORAGE_KEY } from '@/hooks/useFilePanelState';
import type { FileTabsState } from '@/hooks/useFileTabs';

// Mock PaneResizer
vi.mock('@/components/worktree/PaneResizer', () => ({
  PaneResizer: ({ onResize }: { onResize: (delta: number) => void }) => (
    <div data-testid="pane-resizer" onClick={() => onResize(10)} />
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

  // Issue #840: collapsed-state persistence + vertical label + Show/Hide wording.
  describe('collapse persistence and labels (Issue #840)', () => {
    it('uses the persisted collapsed=true state on mount (expand bar shown)', () => {
      window.localStorage.setItem(FILE_PANEL_COLLAPSED_STORAGE_KEY, 'true');
      render(<FilePanelSplit fileTabs={openTabs} {...defaultProps} />);

      expect(screen.getByTestId('file-panel-expand-bar')).toBeInTheDocument();
      expect(screen.queryByTestId('file-panel-tabs')).not.toBeInTheDocument();
    });

    it('renders the vertical "Files" label and Show/Hide wording from i18n', () => {
      window.localStorage.setItem(FILE_PANEL_COLLAPSED_STORAGE_KEY, 'true');
      render(<FilePanelSplit fileTabs={openTabs} {...defaultProps} />);

      // i18n mock returns the namespaced key as the rendered string.
      expect(screen.getByText('worktree.terminal.filesLabel')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'worktree.terminal.showFiles' }),
      ).toBeInTheDocument();
    });

    it('toggling the hide button collapses the panel and persists the state', () => {
      render(<FilePanelSplit fileTabs={openTabs} {...defaultProps} />);

      // Expanded by default: file tabs visible, hide button present.
      expect(screen.getByTestId('file-panel-tabs')).toBeInTheDocument();
      fireEvent.click(
        screen.getByRole('button', { name: 'worktree.terminal.hideFiles' }),
      );

      expect(window.localStorage.getItem(FILE_PANEL_COLLAPSED_STORAGE_KEY)).toBe('true');
      expect(screen.getByTestId('file-panel-expand-bar')).toBeInTheDocument();
    });
  });
});
