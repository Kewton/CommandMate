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

// Mock FilePanelContent [DR3-006]
vi.mock('@/components/worktree/FilePanelContent', () => ({
  FilePanelContent: ({ tab, onOpenFile }: { tab: FileTab; onOpenFile?: (path: string) => void }) => (
    <div data-testid="file-panel-content" data-path={tab.path} data-has-on-open-file={!!onOpenFile}>
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

  // ============================================================================
  // Dropdown UI Tests (Issue #505)
  // ============================================================================

  describe('dropdown for 6+ tabs', () => {
    it('should not show dropdown when 5 or fewer tabs', () => {
      const tabs = Array.from({ length: 5 }, (_, i) => createTab(`file${i}.ts`));
      render(<FilePanelTabs tabs={tabs} activeIndex={0} {...defaultProps} />);

      expect(screen.queryByTestId('tab-dropdown-button')).not.toBeInTheDocument();
    });

    it('should show dropdown button when 6+ tabs', () => {
      const tabs = Array.from({ length: 7 }, (_, i) => createTab(`file${i}.ts`));
      render(<FilePanelTabs tabs={tabs} activeIndex={0} {...defaultProps} />);

      const dropdownButton = screen.getByTestId('tab-dropdown-button');
      expect(dropdownButton).toBeInTheDocument();
      expect(dropdownButton.textContent).toContain('+2');
    });

    it('should show only first 5 tabs in tab bar when 6+ tabs', () => {
      const tabs = Array.from({ length: 8 }, (_, i) => createTab(`file${i}.ts`));
      render(<FilePanelTabs tabs={tabs} activeIndex={0} {...defaultProps} />);

      // First 5 tabs should be visible in the tab bar
      for (let i = 0; i < 5; i++) {
        expect(screen.getByTestId(`file-tab-file${i}.ts`)).toBeInTheDocument();
      }
      // 6th+ tabs should NOT be in the main tab bar but in dropdown
      expect(screen.queryByTestId('file-tab-file5.ts')).not.toBeInTheDocument();
    });

    it('should call onMoveToFront when selecting from dropdown', () => {
      const onMoveToFront = vi.fn();
      const tabs = Array.from({ length: 7 }, (_, i) => createTab(`file${i}.ts`));
      render(
        <FilePanelTabs
          tabs={tabs}
          activeIndex={0}
          {...defaultProps}
          onMoveToFront={onMoveToFront}
        />,
      );

      // Open dropdown
      fireEvent.click(screen.getByTestId('tab-dropdown-button'));
      // Select from dropdown
      fireEvent.click(screen.getByTestId('tab-dropdown-item-file6.ts'));

      expect(onMoveToFront).toHaveBeenCalledWith('file6.ts');
    });
  });
});
