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
 *
 * [Issue #123] openMenu now accepts both MouseEvent and TouchEvent
 * to support iPad/iPhone long press context menus.
 */
export interface UseContextMenuReturn {
  /** Current menu state */
  menuState: ContextMenuState;
  /** Open menu at specified position for target (supports mouse and touch events) */
  openMenu: (e: React.MouseEvent | React.TouchEvent, path: string, type: 'file' | 'directory') => void;
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
   *
   * [Issue #123] Supports both MouseEvent and TouchEvent.
   * Touch coordinates are extracted from touches[0].clientX/clientY.
   * These are safe numeric values provided by the browser Touch API.
   * [SEC-CONSIDER-001] Touch coordinates are read-only numeric primitives
   * from the browser, not user-controlled strings.
   */
  const openMenu = useCallback(
    (e: React.MouseEvent | React.TouchEvent, path: string, type: 'file' | 'directory') => {
      e.preventDefault();

      // Extract coordinates from mouse or touch event
      // Touch coordinates are safe numeric values from browser Touch API
      //
      // [SF-001] Future refactoring consideration:
      // If this coordinate extraction logic is needed in 2+ locations,
      // consider extracting to src/lib/event-utils.ts as:
      //   getEventCoordinates(e: React.MouseEvent | React.TouchEvent): { x: number, y: number } | null
      // Currently only used here, so inline implementation is preferred (YAGNI).
      let x: number, y: number;
      if ('touches' in e && e.touches.length > 0) {
        // TouchEvent - extract from first touch point
        x = e.touches[0].clientX;
        y = e.touches[0].clientY;
      } else if ('clientX' in e) {
        // MouseEvent - use clientX/clientY directly
        x = e.clientX;
        y = e.clientY;
      } else {
        // Cannot determine position, do not open menu
        return;
      }

      setMenuState({
        isOpen: true,
        position: { x, y },
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
   * [NOTE] This is intentionally duplicated with ContextMenu.tsx for defensive programming.
   * The hook handles ESC when menu state changes, while ContextMenu handles it when rendered.
   * This ensures ESC works even if there's a timing issue between state and rendering.
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
