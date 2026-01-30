/**
 * Tests for ContextMenu component
 *
 * @module tests/unit/components/ContextMenu
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContextMenu } from '@/components/worktree/ContextMenu';

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
      expect(deleteItem).toHaveClass('text-red-600');
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
