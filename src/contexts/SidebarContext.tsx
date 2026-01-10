/**
 * SidebarContext
 *
 * Context for managing sidebar state including:
 * - Open/closed state for desktop
 * - Width configuration
 * - Mobile drawer state
 */

'use client';

import React, {
  createContext,
  useContext,
  useReducer,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';
import type { SortKey, SortDirection } from '@/lib/sidebar-utils';

// ============================================================================
// Constants
// ============================================================================

/** Default sidebar width in pixels (w-72 = 288px) */
export const DEFAULT_SIDEBAR_WIDTH = 288;

/** LocalStorage key for sort settings */
export const SIDEBAR_SORT_STORAGE_KEY = 'mcbd-sidebar-sort';

/** Default sort key */
export const DEFAULT_SORT_KEY: SortKey = 'updatedAt';

/** Default sort direction */
export const DEFAULT_SORT_DIRECTION: SortDirection = 'desc';

// ============================================================================
// Types
// ============================================================================

/** Sidebar state shape */
interface SidebarState {
  /** Whether sidebar is open (desktop) */
  isOpen: boolean;
  /** Sidebar width in pixels */
  width: number;
  /** Whether mobile drawer is open */
  isMobileDrawerOpen: boolean;
  /** Current sort key */
  sortKey: SortKey;
  /** Current sort direction */
  sortDirection: SortDirection;
}

/** Sidebar context value */
interface SidebarContextValue {
  /** Current open state */
  isOpen: boolean;
  /** Current width */
  width: number;
  /** Mobile drawer open state */
  isMobileDrawerOpen: boolean;
  /** Current sort key */
  sortKey: SortKey;
  /** Current sort direction */
  sortDirection: SortDirection;
  /** Toggle sidebar open/closed */
  toggle: () => void;
  /** Set sidebar width */
  setWidth: (width: number) => void;
  /** Open mobile drawer */
  openMobileDrawer: () => void;
  /** Close mobile drawer */
  closeMobileDrawer: () => void;
  /** Set sort key */
  setSortKey: (key: SortKey) => void;
  /** Set sort direction */
  setSortDirection: (direction: SortDirection) => void;
}

/** Sidebar provider props */
interface SidebarProviderProps {
  children: ReactNode;
  /** Initial open state (default: true) */
  initialOpen?: boolean;
  /** Initial width (default: DEFAULT_SIDEBAR_WIDTH) */
  initialWidth?: number;
}

/** Reducer action types */
type SidebarAction =
  | { type: 'TOGGLE' }
  | { type: 'SET_WIDTH'; width: number }
  | { type: 'OPEN_MOBILE_DRAWER' }
  | { type: 'CLOSE_MOBILE_DRAWER' }
  | { type: 'SET_SORT_KEY'; sortKey: SortKey }
  | { type: 'SET_SORT_DIRECTION'; sortDirection: SortDirection }
  | { type: 'LOAD_SORT_SETTINGS'; sortKey: SortKey; sortDirection: SortDirection };

// ============================================================================
// Context
// ============================================================================

const SidebarContext = createContext<SidebarContextValue | null>(null);

// ============================================================================
// Reducer
// ============================================================================

function sidebarReducer(state: SidebarState, action: SidebarAction): SidebarState {
  switch (action.type) {
    case 'TOGGLE':
      return { ...state, isOpen: !state.isOpen };
    case 'SET_WIDTH':
      return { ...state, width: action.width };
    case 'OPEN_MOBILE_DRAWER':
      return { ...state, isMobileDrawerOpen: true };
    case 'CLOSE_MOBILE_DRAWER':
      return { ...state, isMobileDrawerOpen: false };
    case 'SET_SORT_KEY':
      return { ...state, sortKey: action.sortKey };
    case 'SET_SORT_DIRECTION':
      return { ...state, sortDirection: action.sortDirection };
    case 'LOAD_SORT_SETTINGS':
      return { ...state, sortKey: action.sortKey, sortDirection: action.sortDirection };
    default:
      return state;
  }
}

// ============================================================================
// Provider
// ============================================================================

/**
 * SidebarProvider component
 *
 * Provides sidebar state to child components
 *
 * @example
 * ```tsx
 * <SidebarProvider>
 *   <AppShell>
 *     <MyContent />
 *   </AppShell>
 * </SidebarProvider>
 * ```
 */
export function SidebarProvider({
  children,
  initialOpen = true,
  initialWidth = DEFAULT_SIDEBAR_WIDTH,
}: SidebarProviderProps) {
  const [state, dispatch] = useReducer(sidebarReducer, {
    isOpen: initialOpen,
    width: initialWidth,
    isMobileDrawerOpen: false,
    sortKey: DEFAULT_SORT_KEY,
    sortDirection: DEFAULT_SORT_DIRECTION,
  });

  // Load sort settings from localStorage on mount
  useEffect(() => {
    if (typeof window === 'undefined') return;

    try {
      const stored = localStorage.getItem(SIDEBAR_SORT_STORAGE_KEY);
      if (stored) {
        const { sortKey, sortDirection } = JSON.parse(stored);
        if (sortKey && sortDirection) {
          dispatch({
            type: 'LOAD_SORT_SETTINGS',
            sortKey,
            sortDirection,
          });
        }
      }
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  // Persist sort settings to localStorage
  useEffect(() => {
    if (typeof window === 'undefined') return;

    try {
      localStorage.setItem(
        SIDEBAR_SORT_STORAGE_KEY,
        JSON.stringify({
          sortKey: state.sortKey,
          sortDirection: state.sortDirection,
        })
      );
    } catch {
      // Ignore localStorage errors
    }
  }, [state.sortKey, state.sortDirection]);

  const toggle = useCallback(() => {
    dispatch({ type: 'TOGGLE' });
  }, []);

  const setWidth = useCallback((width: number) => {
    dispatch({ type: 'SET_WIDTH', width });
  }, []);

  const openMobileDrawer = useCallback(() => {
    dispatch({ type: 'OPEN_MOBILE_DRAWER' });
  }, []);

  const closeMobileDrawer = useCallback(() => {
    dispatch({ type: 'CLOSE_MOBILE_DRAWER' });
  }, []);

  const setSortKey = useCallback((sortKey: SortKey) => {
    dispatch({ type: 'SET_SORT_KEY', sortKey });
  }, []);

  const setSortDirection = useCallback((sortDirection: SortDirection) => {
    dispatch({ type: 'SET_SORT_DIRECTION', sortDirection });
  }, []);

  const value: SidebarContextValue = {
    isOpen: state.isOpen,
    width: state.width,
    isMobileDrawerOpen: state.isMobileDrawerOpen,
    sortKey: state.sortKey,
    sortDirection: state.sortDirection,
    toggle,
    setWidth,
    openMobileDrawer,
    closeMobileDrawer,
    setSortKey,
    setSortDirection,
  };

  return (
    <SidebarContext.Provider value={value}>
      {children}
    </SidebarContext.Provider>
  );
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook to access sidebar context
 *
 * @throws Error if used outside SidebarProvider
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { isOpen, toggle } = useSidebarContext();
 *   return <button onClick={toggle}>{isOpen ? 'Close' : 'Open'}</button>;
 * }
 * ```
 */
export function useSidebarContext(): SidebarContextValue {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error('useSidebarContext must be used within a SidebarProvider');
  }
  return context;
}
