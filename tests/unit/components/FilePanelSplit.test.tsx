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
  });

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
});
