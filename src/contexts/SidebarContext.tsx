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
  type ReactNode,
} from 'react';

// ============================================================================
// Constants
// ============================================================================

/** Default sidebar width in pixels (w-72 = 288px) */
export const DEFAULT_SIDEBAR_WIDTH = 288;

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
}

/** Sidebar context value */
interface SidebarContextValue {
  /** Current open state */
  isOpen: boolean;
  /** Current width */
  width: number;
  /** Mobile drawer open state */
  isMobileDrawerOpen: boolean;
  /** Toggle sidebar open/closed */
  toggle: () => void;
  /** Set sidebar width */
  setWidth: (width: number) => void;
  /** Open mobile drawer */
  openMobileDrawer: () => void;
  /** Close mobile drawer */
  closeMobileDrawer: () => void;
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
  | { type: 'CLOSE_MOBILE_DRAWER' };

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
  });

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

  const value: SidebarContextValue = {
    isOpen: state.isOpen,
    width: state.width,
    isMobileDrawerOpen: state.isMobileDrawerOpen,
    toggle,
    setWidth,
    openMobileDrawer,
    closeMobileDrawer,
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
