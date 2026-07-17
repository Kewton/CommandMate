/**
 * Tests for ContextMenu component
 *
 * @module tests/unit/components/ContextMenu
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ContextMenu } from '@/components/worktree/ContextMenu';
import { CONTEXT_MENU_EXIT_DURATION_MS } from '@/config/ui-feedback-config';

// Issue #1277: this file asserts rendered wording (menu item labels, the menu
// aria-label), so it must resolve keys through the real dictionary. The global
// mock in tests/setup.ts echoes `worktree.<key>` back and would keep these
// assertions green even if the key did not exist.
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

describe('ContextMenu', () => {
  const defaultProps = {
    isOpen: true,
    position: { x: 100, y: 200 },
    targetPath: 'docs/readme.md',
    targetType: 'file' as const,
    onClose: vi.fn(),
    onNewFile: vi.fn(),
    onNewDirectory: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('should render when isOpen is true', () => {
      render(<ContextMenu {...defaultProps} />);

      expect(screen.getByTestId('context-menu')).toBeInTheDocument();
    });

    it('should not render when isOpen is false', () => {
      render(<ContextMenu {...defaultProps} isOpen={false} />);

      expect(screen.queryByTestId('context-menu')).not.toBeInTheDocument();
    });

    // [Issue #1114] Closing keeps the menu mounted for the exit window so the
    // fade-out animation can play, then unmounts.
    it('should play the exit animation before unmounting when closed', () => {
      vi.useFakeTimers();
      try {
        const { rerender } = render(<ContextMenu {...defaultProps} />);
        expect(screen.getByTestId('context-menu')).toBeInTheDocument();

        rerender(<ContextMenu {...defaultProps} isOpen={false} />);

        // Still mounted with exit classes; clicks are ignored while exiting.
        const menu = screen.getByTestId('context-menu');
        expect(menu.className).toContain('animate-out');
        expect(menu.className).toContain('fade-out-0');
        expect(menu.className).toContain('zoom-out-95');
        expect(menu.className).toContain('pointer-events-none');
        expect(menu.className).not.toContain('animate-in');

        act(() => {
          vi.advanceTimersByTime(CONTEXT_MENU_EXIT_DURATION_MS);
        });
        expect(screen.queryByTestId('context-menu')).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should position menu at specified coordinates', () => {
      render(<ContextMenu {...defaultProps} position={{ x: 150, y: 250 }} />);

      const menu = screen.getByTestId('context-menu');
      expect(menu).toHaveStyle({ left: '150px', top: '250px' });
    });

    it('should have fixed position and high z-index', () => {
      render(<ContextMenu {...defaultProps} />);

      const menu = screen.getByTestId('context-menu');
      expect(menu).toHaveClass('fixed');
    });
  });

  // [Issue #1362] A right-click / long press near a viewport edge must not push
  // the menu off screen: it is `position: fixed`, so anything past the edge is
  // unreachable (no scrolling brings it back).
  describe('viewport clamping', () => {
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;

    /** Report a fixed menu size, since jsdom lays everything out as 0x0. */
    const mockMenuSize = (width: number, height: number) => {
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
        width,
        height,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect);
    };

    const mockViewport = (width: number, height: number) => {
      Object.defineProperty(window, 'innerWidth', {
        value: width,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(window, 'innerHeight', {
        value: height,
        writable: true,
        configurable: true,
      });
    };

    afterEach(() => {
      vi.restoreAllMocks();
      mockViewport(originalInnerWidth, originalInnerHeight);
    });

    it('should keep the menu on screen when opened near the bottom-right corner', () => {
      // iPhone-sized viewport: the long-press case from the issue report.
      mockViewport(375, 667);
      mockMenuSize(180, 240);

      render(<ContextMenu {...defaultProps} position={{ x: 360, y: 640 }} />);

      const menu = screen.getByTestId('context-menu');
      // 375 - 180 - 8 = 187, 667 - 240 - 8 = 419
      expect(menu).toHaveStyle({ left: '187px', top: '419px' });
    });

    it('should keep the menu on screen when opened past the top-left edge', () => {
      mockViewport(375, 667);
      mockMenuSize(180, 240);

      render(<ContextMenu {...defaultProps} position={{ x: 2, y: 1 }} />);

      const menu = screen.getByTestId('context-menu');
      expect(menu).toHaveStyle({ left: '8px', top: '8px' });
    });

    it('should leave the menu at the pointer when it already fits', () => {
      mockViewport(1024, 768);
      mockMenuSize(180, 240);

      render(<ContextMenu {...defaultProps} position={{ x: 300, y: 400 }} />);

      const menu = screen.getByTestId('context-menu');
      expect(menu).toHaveStyle({ left: '300px', top: '400px' });
    });

    it('should pin the menu to the near edge when it is larger than the viewport', () => {
      // Tiny viewport: clamping to the far edge would push the first items
      // off screen, so the near edge wins.
      mockViewport(150, 200);
      mockMenuSize(180, 240);

      render(<ContextMenu {...defaultProps} position={{ x: 120, y: 150 }} />);

      const menu = screen.getByTestId('context-menu');
      expect(menu).toHaveStyle({ left: '8px', top: '8px' });
    });

    it('should re-clamp when reopened at a different anchor', () => {
      mockViewport(375, 667);
      mockMenuSize(180, 240);

      const { rerender } = render(
        <ContextMenu {...defaultProps} position={{ x: 360, y: 640 }} />
      );
      expect(screen.getByTestId('context-menu')).toHaveStyle({ left: '187px' });

      rerender(<ContextMenu {...defaultProps} position={{ x: 40, y: 60 }} />);

      expect(screen.getByTestId('context-menu')).toHaveStyle({
        left: '40px',
        top: '60px',
      });
    });

    it('should hold its clamped position while the exit animation plays', () => {
      vi.useFakeTimers();
      try {
        mockViewport(375, 667);
        mockMenuSize(180, 240);

        const { rerender } = render(
          <ContextMenu {...defaultProps} position={{ x: 360, y: 640 }} />
        );
        rerender(
          <ContextMenu
            {...defaultProps}
            position={{ x: 360, y: 640 }}
            isOpen={false}
          />
        );

        // Still mounted for the fade-out; it must not snap back to the origin.
        expect(screen.getByTestId('context-menu')).toHaveStyle({
          left: '187px',
          top: '419px',
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('file menu items', () => {
    it('should show rename and delete options for files', () => {
      render(<ContextMenu {...defaultProps} targetType="file" />);

      expect(screen.getByText('Rename')).toBeInTheDocument();
      expect(screen.getByText('Delete')).toBeInTheDocument();
    });

    it('should NOT show new file/directory options for files', () => {
      render(<ContextMenu {...defaultProps} targetType="file" />);

      expect(screen.queryByText('New File')).not.toBeInTheDocument();
      expect(screen.queryByText('New Directory')).not.toBeInTheDocument();
    });
  });

  describe('directory menu items', () => {
    it('should show all options for directories', () => {
      render(<ContextMenu {...defaultProps} targetType="directory" />);

      expect(screen.getByText('New File')).toBeInTheDocument();
      expect(screen.getByText('New Directory')).toBeInTheDocument();
      expect(screen.getByText('Rename')).toBeInTheDocument();
      expect(screen.getByText('Delete')).toBeInTheDocument();
    });
  });

  describe('menu item clicks', () => {
    it('should call onNewFile when clicking New File', () => {
      const onNewFile = vi.fn();
      render(
        <ContextMenu
          {...defaultProps}
          targetType="directory"
          onNewFile={onNewFile}
        />
      );

      const newFileItem = screen.getByText('New File');
      fireEvent.click(newFileItem);

      expect(onNewFile).toHaveBeenCalledWith('docs/readme.md');
    });

    it('should call onNewDirectory when clicking New Directory', () => {
      const onNewDirectory = vi.fn();
      render(
        <ContextMenu
          {...defaultProps}
          targetType="directory"
          onNewDirectory={onNewDirectory}
        />
      );

      const newDirItem = screen.getByText('New Directory');
      fireEvent.click(newDirItem);

      expect(onNewDirectory).toHaveBeenCalledWith('docs/readme.md');
    });

    it('should call onRename when clicking Rename', () => {
      const onRename = vi.fn();
      render(<ContextMenu {...defaultProps} onRename={onRename} />);

      const renameItem = screen.getByText('Rename');
      fireEvent.click(renameItem);

      expect(onRename).toHaveBeenCalledWith('docs/readme.md');
    });

    it('should call onDelete when clicking Delete', () => {
      const onDelete = vi.fn();
      render(<ContextMenu {...defaultProps} onDelete={onDelete} />);

      const deleteItem = screen.getByText('Delete');
      fireEvent.click(deleteItem);

      expect(onDelete).toHaveBeenCalledWith('docs/readme.md');
    });

    it('should close menu after clicking any item', () => {
      const onClose = vi.fn();
      render(<ContextMenu {...defaultProps} onClose={onClose} />);

      const renameItem = screen.getByText('Rename');
      fireEvent.click(renameItem);

      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('accessibility', () => {
    it('should have menu role', () => {
      render(<ContextMenu {...defaultProps} />);

      expect(screen.getByRole('menu')).toBeInTheDocument();
    });

    it('should have menuitem role for each item', () => {
      render(<ContextMenu {...defaultProps} targetType="directory" />);

      const menuItems = screen.getAllByRole('menuitem');
      expect(menuItems.length).toBeGreaterThanOrEqual(4);
    });

    it('should be keyboard navigable', () => {
      render(<ContextMenu {...defaultProps} targetType="directory" />);

      const firstItem = screen.getAllByRole('menuitem')[0];

      // Focus should be possible
      firstItem.focus();
      expect(document.activeElement).toBe(firstItem);
    });
  });

  describe('visual styling', () => {
    it('should have delete item styled as danger', () => {
      render(<ContextMenu {...defaultProps} />);

      const deleteItem = screen.getByText('Delete').closest('button');
      expect(deleteItem).toHaveClass('text-danger');
    });

    it('should show divider before delete option', () => {
      render(<ContextMenu {...defaultProps} targetType="directory" />);

      // Check there's a visual separator before delete
      const dividers = screen.getAllByTestId('context-menu-divider');
      expect(dividers.length).toBeGreaterThan(0);
    });
  });

  describe('icons', () => {
    it('should show appropriate icons for each menu item', () => {
      render(<ContextMenu {...defaultProps} targetType="directory" />);

      // Icons should be present (testing by aria-hidden attribute)
      const icons = screen.getAllByRole('img', { hidden: true });
      expect(icons.length).toBeGreaterThan(0);
    });
  });

  describe('edge cases', () => {
    it('should handle null targetPath gracefully', () => {
      render(<ContextMenu {...defaultProps} targetPath={null} />);

      // Menu should still render but items should not call handlers
      expect(screen.getByTestId('context-menu')).toBeInTheDocument();
    });

    it('should handle null targetType gracefully', () => {
      render(<ContextMenu {...defaultProps} targetType={null} />);

      // Should render minimal menu
      expect(screen.getByTestId('context-menu')).toBeInTheDocument();
    });
  });
});
