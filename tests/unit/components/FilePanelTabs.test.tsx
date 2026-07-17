/**
 * Unit Tests for FilePanelTabs Component
 *
 * Issue #438: Tab bar UI with close buttons and content display
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FilePanelTabs } from '@/components/worktree/FilePanelTabs';
import type { FileTab } from '@/hooks/useFileTabs';
import type { FileContent } from '@/types/models';

// Issue #1275: this file asserts rendered wording (the per-tab close label), so
// it must resolve keys through the real dictionary. The global mock in
// tests/setup.ts echoes `worktree.<key>` back — it does not even interpolate
// {name} — and would keep these assertions green even if the key did not exist.
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

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

/**
 * [Issue #1365] The overflow dropdown is anchored `absolute right-0 top-full`
 * off the "+N" button at the right end of the tab bar. With many tabs open it
 * can reach past the bottom of the viewport, so once open it is measured and
 * nudged back with a transform. It stays absolutely positioned (rather than
 * portalled) because the click-outside handler asks whether the click landed
 * inside the dropdown's container.
 */
describe('FilePanelTabs overflow dropdown clamping (Issue #1365)', () => {
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
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeRect(overrides: Partial<DOMRect>): DOMRect {
    return {
      top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0,
      ...overrides,
      toJSON: () => ({}),
    } as DOMRect;
  }

  /** Only the dropdown menu reports a box; everything else is zeroed. */
  function menuRect(rect: Partial<DOMRect>): void {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      return this.getAttribute('data-testid') === 'tab-dropdown-menu'
        ? makeRect(rect)
        : makeRect({});
    });
  }

  /** 7 tabs => 5 in the bar, 2 in the dropdown. */
  const overflowingTabs = [
    'a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts',
  ].map((p) => createTab(p));

  function openDropdown(): HTMLElement {
    render(<FilePanelTabs tabs={overflowingTabs} activeIndex={0} {...defaultProps} />);
    fireEvent.click(screen.getByTestId('tab-dropdown-button'));
    return screen.getByTestId('tab-dropdown-menu');
  }

  it('does not shift a dropdown that already fits on screen', () => {
    menuRect({ top: 40, left: 700, width: 200, height: 300 });

    expect(openDropdown().style.transform).toBe('');
  });

  it('pulls a dropdown that overflows the bottom edge back into view', () => {
    // 600 + 300 + 8 - 768 = 140 over the bottom; horizontally it still fits.
    menuRect({ top: 600, left: 700, width: 200, height: 300 });

    expect(openDropdown().style.transform).toBe('translate(0px, -140px)');
  });

  it('pulls a dropdown that overflows the right edge back into view', () => {
    // 900 + 200 + 8 - 1024 = 84 over the right edge.
    menuRect({ top: 40, left: 900, width: 200, height: 300 });

    expect(openDropdown().style.transform).toBe('translate(-84px, 0px)');
  });
});
