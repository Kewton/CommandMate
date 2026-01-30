/**
 * useContextMenu Hook
 *
 * Manages context menu state for FileTreeView component.
 * Provides menu positioning, target tracking, and event handling.
 *
 * Features:
 * - Right-click menu positioning
 * - Click outside to close
 * - ESC key to close
 * - Stable callback references (React.memo compatible)
 *
 * @module hooks/useContextMenu
 * @see Stage 3 SF-001 - Rendering optimization
 */

'use client';

import { useState, useCallback, useEffect } from 'react';
import type { ContextMenuState } from '@/types/markdown-editor';

/**
 * Initial context menu state
 */
const INITIAL_STATE: ContextMenuState = {
  isOpen: false,
  position: { x: 0, y: 0 },
  targetPath: null,
  targetType: null,
};

/**
 * Return type for useContextMenu hook
 */
export interface UseContextMenuReturn {
  /** Current menu state */
  menuState: ContextMenuState;
  /** Open menu at specified position for target */
  openMenu: (e: React.MouseEvent, path: string, type: 'file' | 'directory') => void;
  /** Close menu (preserves target info) */
  closeMenu: () => void;
  /** Reset menu to initial state */
  resetMenu: () => void;
}

/**
 * Custom hook for managing context menu state
 *
 * Separates context menu state from FileTreeView to prevent
 * unnecessary re-renders of tree items when menu state changes.
 *
 * @returns Context menu state and control functions
 *
 * @example
 * ```tsx
 * function FileTree() {
 *   const { menuState, openMenu, closeMenu, resetMenu } = useContextMenu();
 *
 *   const handleContextMenu = (e: React.MouseEvent, path: string, type: 'file' | 'directory') => {
 *     openMenu(e, path, type);
 *   };
 *
 *   return (
 *     <>
 *       <TreeItems onContextMenu={handleContextMenu} />
 *       {menuState.isOpen && (
 *         <ContextMenu
 *           position={menuState.position}
 *           targetPath={menuState.targetPath}
 *           targetType={menuState.targetType}
 *           onClose={closeMenu}
 *         />
 *       )}
 *     </>
 *   );
 * }
 * ```
 */
export function useContextMenu(): UseContextMenuReturn {
  const [menuState, setMenuState] = useState<ContextMenuState>(INITIAL_STATE);

  /**
   * Open context menu at event position
   */
  const openMenu = useCallback(
    (e: React.MouseEvent, path: string, type: 'file' | 'directory') => {
      e.preventDefault();
      setMenuState({
        isOpen: true,
        position: { x: e.clientX, y: e.clientY },
        targetPath: path,
        targetType: type,
      });
    },
    []
  );

  /**
   * Close menu while preserving target info
   * Useful for operations that need target info after menu closes
   */
  const closeMenu = useCallback(() => {
    setMenuState((prev) => ({
      ...prev,
      isOpen: false,
    }));
  }, []);

  /**
   * Reset menu to initial state
   * Clears all state including target info
   */
  const resetMenu = useCallback(() => {
    setMenuState(INITIAL_STATE);
  }, []);

  /**
   * Handle click outside to close menu
   */
  useEffect(() => {
    if (!menuState.isOpen) return;

    const handleClickOutside = () => {
      closeMenu();
    };

    // Use setTimeout to avoid immediate trigger from the same click
    const timeoutId = setTimeout(() => {
      document.addEventListener('click', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('click', handleClickOutside);
    };
  }, [menuState.isOpen, closeMenu]);

  /**
   * Handle ESC key to close menu
   */
  useEffect(() => {
    if (!menuState.isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeMenu();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuState.isOpen, closeMenu]);

  return {
    menuState,
    openMenu,
    closeMenu,
    resetMenu,
  };
}
