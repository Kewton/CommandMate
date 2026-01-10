/**
 * useSidebar Hook
 *
 * Hook for sidebar operations with localStorage persistence.
 * Wraps SidebarContext with persistence logic.
 */

'use client';

import { useEffect } from 'react';
import { useSidebarContext } from '@/contexts/SidebarContext';

// ============================================================================
// Constants
// ============================================================================

/** localStorage key for sidebar state */
export const SIDEBAR_STORAGE_KEY = 'sidebar-state';

// ============================================================================
// Types
// ============================================================================

/** Persisted sidebar state */
interface PersistedSidebarState {
  isOpen: boolean;
  width: number;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * useSidebar hook
 *
 * Provides sidebar state and actions with localStorage persistence.
 *
 * @returns Sidebar state and actions
 *
 * @example
 * ```tsx
 * function MySidebarToggle() {
 *   const { isOpen, toggle } = useSidebar();
 *
 *   return (
 *     <button onClick={toggle}>
 *       {isOpen ? 'Close' : 'Open'} Sidebar
 *     </button>
 *   );
 * }
 * ```
 */
export function useSidebar() {
  const context = useSidebarContext();

  // Persist state changes to localStorage
  useEffect(() => {
    try {
      const state: PersistedSidebarState = {
        isOpen: context.isOpen,
        width: context.width,
      };
      localStorage.setItem(SIDEBAR_STORAGE_KEY, JSON.stringify(state));
    } catch {
      // localStorage might be unavailable (SSR, private mode, etc.)
    }
  }, [context.isOpen, context.width]);

  return {
    isOpen: context.isOpen,
    width: context.width,
    isMobileDrawerOpen: context.isMobileDrawerOpen,
    toggle: context.toggle,
    setWidth: context.setWidth,
    openMobileDrawer: context.openMobileDrawer,
    closeMobileDrawer: context.closeMobileDrawer,
  };
}

/**
 * Get persisted sidebar state from localStorage
 *
 * @returns Persisted state or null if not available
 */
export function getPersistedSidebarState(): PersistedSidebarState | null {
  try {
    const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (!stored) return null;
    return JSON.parse(stored) as PersistedSidebarState;
  } catch {
    return null;
  }
}
