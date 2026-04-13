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
  useRef,
  useMemo,
  type ReactNode,
} from 'react';
import { isValidSortKey } from '@/lib/sidebar-utils';
import type { SortKey, SortDirection, ViewMode } from '@/lib/sidebar-utils';

// ============================================================================
// Constants
// ============================================================================

/** Default sidebar width in pixels (w-56 = 224px) */
export const DEFAULT_SIDEBAR_WIDTH = 224;

/** LocalStorage key for sort settings */
export const SIDEBAR_SORT_STORAGE_KEY = 'mcbd-sidebar-sort';

/** Default sort key */
export const DEFAULT_SORT_KEY: SortKey = 'updatedAt';

/** Default sort direction */
export const DEFAULT_SORT_DIRECTION: SortDirection = 'desc';

/** LocalStorage key for view mode */
export const SIDEBAR_VIEW_MODE_STORAGE_KEY = 'mcbd-sidebar-view-mode';

/** Default view mode */
export const DEFAULT_VIEW_MODE: ViewMode = 'grouped';

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
  /** Current view mode */
  viewMode: ViewMode;
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
  /** Current view mode */
  viewMode: ViewMode;
  /** Set view mode */
  setViewMode: (viewMode: ViewMode) => void;
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
  | { type: 'LOAD_SORT_SETTINGS'; sortKey: SortKey; sortDirection: SortDirection }
  | { type: 'SET_VIEW_MODE'; viewMode: ViewMode };

// ============================================================================
// Context
// ============================================================================

const SidebarContext = createContext<SidebarContextValue | null>(null);

// ============================================================================
// Hooks
// ============================================================================

/**
 * Load a value from localStorage on mount, then persist whenever the value changes.
 *
 * @param storageKey - localStorage key
 * @param value - Current value to persist
 * @param serialize - Convert value to string for storage
 * @param onLoad - Called once on mount with the stored string (if any)
 */
function useLocalStorageSync(
  storageKey: string,
  value: unknown,
  serialize: () => string,
  onLoad: (stored: string) => void,
): void {
  const isInitialMount = useRef(true);

  // Load from localStorage on mount
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) onLoad(stored);
    } catch {
      // Ignore localStorage errors
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist to localStorage on change (skip initial mount to avoid overwriting)
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(storageKey, serialize());
    } catch {
      // Ignore localStorage errors
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
}

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
    case 'SET_VIEW_MODE':
      return { ...state, viewMode: action.viewMode };
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
    viewMode: DEFAULT_VIEW_MODE,
  });

  // Sync sort settings with localStorage (load on mount, persist on change)
  useLocalStorageSync(
    SIDEBAR_SORT_STORAGE_KEY,
    `${state.sortKey}:${state.sortDirection}`,
    () => JSON.stringify({ sortKey: state.sortKey, sortDirection: state.sortDirection }),
    (stored) => {
      try {
        const parsed = JSON.parse(stored);
        const sortDirection = parsed.sortDirection;
        // Validate sortKey against SORT_KEYS to prevent invalid values from localStorage
        const sortKey = isValidSortKey(parsed.sortKey) ? parsed.sortKey : DEFAULT_SORT_KEY;
        if (sortKey && (sortDirection === 'asc' || sortDirection === 'desc')) {
          dispatch({ type: 'LOAD_SORT_SETTINGS', sortKey, sortDirection });
        }
      } catch { /* ignore parse errors */ }
    },
  );

  // Sync viewMode with localStorage (load on mount, persist on change)
  useLocalStorageSync(
    SIDEBAR_VIEW_MODE_STORAGE_KEY,
    state.viewMode,
    () => state.viewMode,
    (stored) => {
      if (stored === 'grouped' || stored === 'flat') {
        dispatch({ type: 'SET_VIEW_MODE', viewMode: stored });
      }
    },
  );

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

  const setViewMode = useCallback((viewMode: ViewMode) => {
    dispatch({ type: 'SET_VIEW_MODE', viewMode });
  }, []);

  const value: SidebarContextValue = useMemo(() => ({
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
    viewMode: state.viewMode,
    setViewMode,
  }), [
    state.isOpen,
    state.width,
    state.isMobileDrawerOpen,
    state.sortKey,
    state.sortDirection,
    state.viewMode,
    toggle,
    setWidth,
    openMobileDrawer,
    closeMobileDrawer,
    setSortKey,
    setSortDirection,
    setViewMode,
  ]);

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
