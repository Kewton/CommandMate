/**
 * Unit Tests for FilePanelTabs Component
 *
 * Issue #438: Tab bar UI with close buttons and content display
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FilePanelTabs } from '@/components/worktree/FilePanelTabs';
import type { FileTab } from '@/hooks/useFileTabs';
import type { FileContent } from '@/types/models';

// Mock FilePanelContent
vi.mock('@/components/worktree/FilePanelContent', () => ({
  FilePanelContent: ({ tab }: { tab: FileTab }) => (
    <div data-testid="file-panel-content" data-path={tab.path}>
      Content: {tab.name}
    </div>
  ),
}));

// ============================================================================
// Fixtures
// ============================================================================

function createTab(path: string, overrides: Partial<FileTab> = {}): FileTab {
  const name = path.split('/').pop() || path;
  return {
    path,
    name,
    content: null,
    loading: false,
    error: null,
    isDirty: false,
    ...overrides,
  };
}

describe('FilePanelTabs', () => {
  const defaultProps = {
    worktreeId: 'test-wt',
    onClose: vi.fn(),
    onActivate: vi.fn(),
    onLoadContent: vi.fn(),
    onLoadError: vi.fn(),
    onSetLoading: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render tab buttons for each tab', () => {
    const tabs = [createTab('a.ts'), createTab('b.ts')];
    render(<FilePanelTabs tabs={tabs} activeIndex={0} {...defaultProps} />);

    expect(screen.getByText('a.ts')).toBeInTheDocument();
    expect(screen.getByText('b.ts')).toBeInTheDocument();
  });

  it('should highlight the active tab', () => {
    const tabs = [createTab('a.ts'), createTab('b.ts')];
    render(<FilePanelTabs tabs={tabs} activeIndex={0} {...defaultProps} />);

    const activeTab = screen.getByText('a.ts').closest('[data-testid^="file-tab-"]');
    expect(activeTab).toHaveAttribute('data-active', 'true');
  });

  it('should call onActivate when clicking a non-active tab', () => {
    const tabs = [createTab('a.ts'), createTab('b.ts')];
    render(<FilePanelTabs tabs={tabs} activeIndex={0} {...defaultProps} />);

    fireEvent.click(screen.getByText('b.ts'));
    expect(defaultProps.onActivate).toHaveBeenCalledWith('b.ts');
  });

  it('should call onClose when clicking close button', () => {
    const tabs = [createTab('a.ts')];
    render(<FilePanelTabs tabs={tabs} activeIndex={0} {...defaultProps} />);

    const closeButton = screen.getByLabelText('Close a.ts');
    fireEvent.click(closeButton);
    expect(defaultProps.onClose).toHaveBeenCalledWith('a.ts');
  });

  it('should not propagate click from close button to tab activation', () => {
    const tabs = [createTab('a.ts'), createTab('b.ts')];
    render(<FilePanelTabs tabs={tabs} activeIndex={0} {...defaultProps} />);

    // Click close on the non-active tab
    const closeButton = screen.getByLabelText('Close b.ts');
    fireEvent.click(closeButton);

    expect(defaultProps.onClose).toHaveBeenCalledWith('b.ts');
    expect(defaultProps.onActivate).not.toHaveBeenCalled();
  });

  it('should render active tab content via FilePanelContent', () => {
    const tabs = [createTab('a.ts'), createTab('b.ts')];
    render(<FilePanelTabs tabs={tabs} activeIndex={1} {...defaultProps} />);

    const content = screen.getByTestId('file-panel-content');
    expect(content).toHaveAttribute('data-path', 'b.ts');
  });

  it('should not render content when activeIndex is null', () => {
    const tabs = [createTab('a.ts')];
    render(<FilePanelTabs tabs={tabs} activeIndex={null} {...defaultProps} />);

    expect(screen.queryByTestId('file-panel-content')).not.toBeInTheDocument();
  });

  it('should not render content when activeIndex is out of bounds', () => {
    const tabs = [createTab('a.ts')];
    render(<FilePanelTabs tabs={tabs} activeIndex={5} {...defaultProps} />);

    expect(screen.queryByTestId('file-panel-content')).not.toBeInTheDocument();
  });

  it('should render nothing when tabs is empty', () => {
    const { container } = render(
      <FilePanelTabs tabs={[]} activeIndex={null} {...defaultProps} />,
    );
    // Component should still render the container but with no tabs
    expect(container.querySelector('[data-testid^="file-tab-"]')).toBeNull();
  });
});
