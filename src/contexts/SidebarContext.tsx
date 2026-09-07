/**
 * SidebarContext
 *
 * Context for managing sidebar state including:
 * - Open/closed state for desktop (persisted since Issue #2374)
 * - Width configuration
 * - Mobile drawer state
 * - Sort key / direction and view mode
 * - The saved repository group order, and when the repository tab bar shows
 *   (Issue #2374)
 *
 * The last two live here rather than in `Sidebar` because two surfaces read
 * them: the sidebar's grouped list and the header's `RepositoryTabBar`. A
 * component-local copy in each is how "I dragged the groups and the tabs did
 * not move" happens. The `/api/sidebar/group-order` fetch and PUT still belong
 * to `Sidebar` (AppShell mounts it on every route); this context is where the
 * result is published.
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
import {
  isValidSortKey,
  isValidRepoTabBarMode,
  readRepositoryOrderCache,
  persistRepositoryOrderCache,
  DEFAULT_REPO_TAB_BAR_MODE,
} from '@/lib/sidebar-utils';
import type {
  SortKey,
  SortDirection,
  ViewMode,
  RepoTabBarMode,
} from '@/lib/sidebar-utils';

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

/** LocalStorage key for sidebar width */
export const SIDEBAR_WIDTH_STORAGE_KEY = 'mcbd-sidebar-width';

/**
 * LocalStorage key for the desktop open/closed state (Issue #2374).
 *
 * The other three sidebar preferences have been persisted since #651; this one
 * was not, so every reload reopened a sidebar the user had deliberately
 * collapsed — the state the repository tab bar exists to serve.
 */
export const SIDEBAR_OPEN_STORAGE_KEY = 'mcbd-sidebar-open';

/** LocalStorage key for the repository tab bar's visibility rule (Issue #2374) */
export const REPO_TAB_BAR_MODE_STORAGE_KEY = 'mcbd-repo-tab-bar-mode';

/**
 * Default visibility rule for the repository tab bar. Declared in
 * `@/lib/sidebar-utils` alongside the mode list and re-exported here so the
 * three `DEFAULT_*` sidebar preferences stay discoverable together.
 */
export { DEFAULT_REPO_TAB_BAR_MODE };

/** Legacy default width before Issue #651 compaction (for migration) */
const LEGACY_SIDEBAR_WIDTH = 288;

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
  /** Saved repository group order (Issue #2374: shared with the tab bar) */
  repositoryOrder: string[];
  /** When the repository tab bar is shown */
  repoTabBarMode: RepoTabBarMode;
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
  /**
   * Repository display names in the order the user arranged them (Issue #2374).
   *
   * Lives here rather than in `Sidebar` so the header's repository tab bar
   * follows a sidebar drag in the same commit — two components each holding
   * their own copy is how "the tabs did not move" happens.
   */
  repositoryOrder: string[];
  /** Replace the repository order (also refreshes the localStorage cache) */
  setRepositoryOrder: (order: string[]) => void;
  /** When the repository tab bar is shown */
  repoTabBarMode: RepoTabBarMode;
  /** Set the repository tab bar's visibility rule */
  setRepoTabBarMode: (mode: RepoTabBarMode) => void;
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
  | { type: 'SET_VIEW_MODE'; viewMode: ViewMode }
  | { type: 'SET_OPEN'; isOpen: boolean }
  | { type: 'SET_REPOSITORY_ORDER'; repositoryOrder: string[] }
  | { type: 'SET_REPO_TAB_BAR_MODE'; repoTabBarMode: RepoTabBarMode };

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
    case 'SET_OPEN':
      return state.isOpen === action.isOpen ? state : { ...state, isOpen: action.isOpen };
    case 'SET_REPOSITORY_ORDER':
      return { ...state, repositoryOrder: action.repositoryOrder };
    case 'SET_REPO_TAB_BAR_MODE':
      return { ...state, repoTabBarMode: action.repoTabBarMode };
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
    // Read synchronously so the sidebar groups and the repository tabs paint in
    // the user's order on the first frame, before the API answers (Issue #2374).
    repositoryOrder: readRepositoryOrderCache(),
    repoTabBarMode: DEFAULT_REPO_TAB_BAR_MODE,
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

  // Sync width with localStorage (load on mount, persist on change)
  // Issue #651 follow-up: migrate legacy width 288 → 224
  useLocalStorageSync(
    SIDEBAR_WIDTH_STORAGE_KEY,
    state.width,
    () => String(state.width),
    (stored) => {
      const parsed = Number(stored);
      if (!isNaN(parsed) && parsed > 0) {
        const width = parsed === LEGACY_SIDEBAR_WIDTH ? DEFAULT_SIDEBAR_WIDTH : parsed;
        dispatch({ type: 'SET_WIDTH', width });
      }
    },
  );

  // Sync the desktop open/closed state with localStorage (Issue #2374).
  //
  // Stored as the literal 'true'/'false' rather than JSON so a corrupted or
  // hand-edited value simply fails both comparisons and leaves the default
  // (open) in place. `useLocalStorageSync` only calls `onLoad` for a non-empty
  // string, and both literals are non-empty — a bare `'0'`-style encoding would
  // be fine too, but this one is readable in devtools.
  useLocalStorageSync(
    SIDEBAR_OPEN_STORAGE_KEY,
    state.isOpen,
    () => String(state.isOpen),
    (stored) => {
      if (stored === 'true' || stored === 'false') {
        dispatch({ type: 'SET_OPEN', isOpen: stored === 'true' });
      }
    },
  );

  // Sync the repository tab bar's visibility rule with localStorage (Issue #2374)
  useLocalStorageSync(
    REPO_TAB_BAR_MODE_STORAGE_KEY,
    state.repoTabBarMode,
    () => state.repoTabBarMode,
    (stored) => {
      if (isValidRepoTabBarMode(stored)) {
        dispatch({ type: 'SET_REPO_TAB_BAR_MODE', repoTabBarMode: stored });
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

  // The order cache is written here rather than by each caller: `Sidebar` sets
  // it from the API response AND from an optimistic drag, and the tab bar reads
  // it on the next mount — one writer keeps those three in step.
  const setRepositoryOrder = useCallback((repositoryOrder: string[]) => {
    dispatch({ type: 'SET_REPOSITORY_ORDER', repositoryOrder });
    persistRepositoryOrderCache(repositoryOrder);
  }, []);

  const setRepoTabBarMode = useCallback((repoTabBarMode: RepoTabBarMode) => {
    dispatch({ type: 'SET_REPO_TAB_BAR_MODE', repoTabBarMode });
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
    repositoryOrder: state.repositoryOrder,
    setRepositoryOrder,
    repoTabBarMode: state.repoTabBarMode,
    setRepoTabBarMode,
  }), [
    state.isOpen,
    state.width,
    state.isMobileDrawerOpen,
    state.sortKey,
    state.sortDirection,
    state.viewMode,
    state.repositoryOrder,
    state.repoTabBarMode,
    toggle,
    setWidth,
    openMobileDrawer,
    closeMobileDrawer,
    setSortKey,
    setSortDirection,
    setViewMode,
    setRepositoryOrder,
    setRepoTabBarMode,
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

/**
 * Non-throwing variant of {@link useSidebarContext} (Issue #2374).
 *
 * Mirrors `useOptionalWorktreesCacheContext`: a control that merely *adjusts* a
 * sidebar preference — rather than being part of the sidebar — must be safe to
 * mount in a tree that has no `SidebarProvider`, such as an isolated component
 * test of the header. Consumers render nothing when this returns null.
 *
 * @returns The context value, or null when no provider is above the caller
 */
export function useOptionalSidebarContext(): SidebarContextValue | null {
  return useContext(SidebarContext);
}
