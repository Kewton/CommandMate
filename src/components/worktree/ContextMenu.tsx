/**
 * ContextMenu Component
 *
 * Right-click context menu for FileTreeView operations.
 * Supports file/directory creation, rename, and delete.
 *
 * Features:
 * - Different menu items based on target type (file vs directory)
 * - Keyboard navigation
 * - Visual styling with danger indicators for destructive actions
 *
 * @module components/worktree/ContextMenu
 * @see Stage 2 SF-003 - Component separation
 */

'use client';

import React, { memo, useCallback, useEffect, useRef } from 'react';
import { FilePlus, FolderPlus, Pencil, Trash2 } from 'lucide-react';

/**
 * Props for ContextMenu component
 */
export interface ContextMenuProps {
  /** Whether the menu is open */
  isOpen: boolean;
  /** Menu position */
  position: { x: number; y: number };
  /** Target file/directory path */
  targetPath: string | null;
  /** Target type */
  targetType: 'file' | 'directory' | null;
  /** Close menu callback */
  onClose: () => void;
  /** Create new file callback */
  onNewFile?: (parentPath: string) => void;
  /** Create new directory callback */
  onNewDirectory?: (parentPath: string) => void;
  /** Rename callback */
  onRename?: (path: string) => void;
  /** Delete callback */
  onDelete?: (path: string) => void;
}

/**
 * Menu item configuration
 */
interface MenuItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  variant?: 'default' | 'danger';
  showDividerAfter?: boolean;
  /** Show only for certain target types */
  showFor?: ('file' | 'directory')[];
}

/**
 * ContextMenu Component
 *
 * @example
 * ```tsx
 * <ContextMenu
 *   isOpen={menuState.isOpen}
 *   position={menuState.position}
 *   targetPath={menuState.targetPath}
 *   targetType={menuState.targetType}
 *   onClose={closeMenu}
 *   onNewFile={handleNewFile}
 *   onRename={handleRename}
 *   onDelete={handleDelete}
 * />
 * ```
 */
export const ContextMenu = memo(function ContextMenu({
  isOpen,
  position,
  targetPath,
  targetType,
  onClose,
  onNewFile,
  onNewDirectory,
  onRename,
  onDelete,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  /**
   * Handle menu item click
   */
  const handleItemClick = useCallback(
    (handler?: (path: string) => void) => {
      if (handler && targetPath) {
        handler(targetPath);
      }
      onClose();
    },
    [targetPath, onClose]
  );

  /**
   * Build menu items based on target type
   */
  const menuItems: MenuItem[] = [
    {
      id: 'new-file',
      label: 'New File',
      icon: <FilePlus className="w-4 h-4" aria-hidden="true" role="img" />,
      onClick: () => handleItemClick(onNewFile),
      showFor: ['directory'],
    },
    {
      id: 'new-directory',
      label: 'New Directory',
      icon: <FolderPlus className="w-4 h-4" aria-hidden="true" role="img" />,
      onClick: () => handleItemClick(onNewDirectory),
      showFor: ['directory'],
      showDividerAfter: true,
    },
    {
      id: 'rename',
      label: 'Rename',
      icon: <Pencil className="w-4 h-4" aria-hidden="true" role="img" />,
      onClick: () => handleItemClick(onRename),
      showDividerAfter: targetType === 'file',
    },
    {
      id: 'delete',
      label: 'Delete',
      icon: <Trash2 className="w-4 h-4" aria-hidden="true" role="img" />,
      onClick: () => handleItemClick(onDelete),
      variant: 'danger',
    },
  ];

  /**
   * Filter items based on target type
   */
  const visibleItems = menuItems.filter((item) => {
    if (!item.showFor) return true;
    return targetType && item.showFor.includes(targetType);
  });

  /**
   * Handle keyboard navigation
   */
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = menuRef.current?.querySelectorAll('[role="menuitem"]');
        if (!items?.length) return;

        const currentIndex = Array.from(items).findIndex(
          (item) => item === document.activeElement
        );

        let nextIndex: number;
        if (e.key === 'ArrowDown') {
          nextIndex = currentIndex < items.length - 1 ? currentIndex + 1 : 0;
        } else {
          nextIndex = currentIndex > 0 ? currentIndex - 1 : items.length - 1;
        }

        (items[nextIndex] as HTMLElement).focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  /**
   * Focus first item when menu opens
   */
  useEffect(() => {
    if (isOpen && menuRef.current) {
      const firstItem = menuRef.current.querySelector('[role="menuitem"]');
      if (firstItem) {
        (firstItem as HTMLElement).focus();
      }
    }
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  return (
    <div
      ref={menuRef}
      data-testid="context-menu"
      role="menu"
      aria-label="File actions"
      className="fixed z-50 min-w-[160px] py-1 bg-white rounded-lg shadow-lg border border-gray-200 animate-in fade-in-0 zoom-in-95 duration-100"
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
      }}
    >
      {visibleItems.map((item, index) => (
        <React.Fragment key={item.id}>
          <button
            role="menuitem"
            onClick={item.onClick}
            disabled={!targetPath}
            className={`w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors focus:outline-none focus:bg-gray-100 ${
              item.variant === 'danger'
                ? 'text-red-600 hover:bg-red-50 focus:bg-red-50'
                : 'text-gray-700 hover:bg-gray-100'
            } ${!targetPath ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
          {item.showDividerAfter && index < visibleItems.length - 1 && (
            <div
              data-testid="context-menu-divider"
              className="my-1 border-t border-gray-200"
            />
          )}
        </React.Fragment>
      ))}
    </div>
  );
});

export default ContextMenu;
