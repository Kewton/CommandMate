/**
 * WorktreeSelectionContext
 *
 * Context for managing worktree selection state including:
 * - Currently selected worktree
 * - List of available worktrees
 * - Optimistic UI updates
 * - Loading and error states
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
import type { Worktree } from '@/types/models';
import { worktreeApi } from '@/lib/api-client';

// ============================================================================
// Constants
// ============================================================================

/** Polling intervals for worktree status updates based on activity state */
export const POLLING_INTERVALS = {
  /** When any worktree is processing or waiting for response */
  PROCESSING: 2000,
  /** When session is running but not actively processing */
  SESSION_RUNNING: 5000,
  /** When all worktrees are idle */
  IDLE: 10000,
} as const;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Determines the appropriate polling interval based on worktree states.
 *
 * Priority:
 * 1. PROCESSING (2s) - If any worktree is processing or waiting for response
 * 2. SESSION_RUNNING (5s) - If any session is running but not processing
 * 3. IDLE (10s) - All worktrees are idle
 *
 * @param worktrees - Array of worktrees to check
 * @returns Polling interval in milliseconds
 */
export function getPollingInterval(worktrees: Worktree[]): number {
  const hasActiveProcessing = worktrees.some(wt =>
    wt.isProcessing || wt.isWaitingForResponse
  );
  if (hasActiveProcessing) {
    return POLLING_INTERVALS.PROCESSING;
  }

  const hasRunningSession = worktrees.some(wt => wt.isSessionRunning);
  if (hasRunningSession) {
    return POLLING_INTERVALS.SESSION_RUNNING;
  }

  return POLLING_INTERVALS.IDLE;
}

// ============================================================================
// Types
// ============================================================================

/** Worktree selection state shape */
interface WorktreeSelectionState {
  /** Currently selected worktree ID */
  selectedWorktreeId: string | null;
  /** List of available worktrees */
  worktrees: Worktree[];
  /** Detailed data for selected worktree */
  selectedWorktreeDetail: Worktree | null;
  /** Loading state for worktree list */
  isLoading: boolean;
  /** Loading state for worktree detail */
  isLoadingDetail: boolean;
  /** Error message if any */
  error: string | null;
}

/** Context value exposed to consumers */
interface WorktreeSelectionContextValue {
  /** Currently selected worktree ID */
  selectedWorktreeId: string | null;
  /** List of available worktrees */
  worktrees: Worktree[];
  /** Detailed data for selected worktree */
  selectedWorktreeDetail: Worktree | null;
  /** Loading state for worktree detail */
  isLoadingDetail: boolean;
  /** Error message if any */
  error: string | null;
  /** Select a worktree by ID */
  selectWorktree: (id: string) => Promise<void>;
  /** Refresh the worktree list */
  refreshWorktrees: () => Promise<void>;
}

/** Provider props */
interface WorktreeSelectionProviderProps {
  children: ReactNode;
}

/** Reducer action types */
type WorktreeSelectionAction =
  | { type: 'SET_WORKTREES'; worktrees: Worktree[] }
  | { type: 'SELECT_WORKTREE'; id: string }
  | { type: 'SET_WORKTREE_DETAIL'; detail: Worktree }
  | { type: 'SET_LOADING'; isLoading: boolean }
  | { type: 'SET_LOADING_DETAIL'; isLoadingDetail: boolean }
  | { type: 'SET_ERROR'; error: string | null };

// ============================================================================
// Context
// ============================================================================

const WorktreeSelectionContext = createContext<WorktreeSelectionContextValue | null>(null);

// ============================================================================
// Reducer
// ============================================================================

const initialState: WorktreeSelectionState = {
  selectedWorktreeId: null,
  worktrees: [],
  selectedWorktreeDetail: null,
  isLoading: true,
  isLoadingDetail: false,
  error: null,
};

function worktreeSelectionReducer(
  state: WorktreeSelectionState,
  action: WorktreeSelectionAction
): WorktreeSelectionState {
  switch (action.type) {
    case 'SET_WORKTREES':
      return { ...state, worktrees: action.worktrees, isLoading: false };
    case 'SELECT_WORKTREE':
      return { ...state, selectedWorktreeId: action.id };
    case 'SET_WORKTREE_DETAIL':
      return { ...state, selectedWorktreeDetail: action.detail };
    case 'SET_LOADING':
      return { ...state, isLoading: action.isLoading };
    case 'SET_LOADING_DETAIL':
      return { ...state, isLoadingDetail: action.isLoadingDetail };
    case 'SET_ERROR':
      return { ...state, error: action.error, isLoading: false };
    default:
      return state;
  }
}

// ============================================================================
// Provider
// ============================================================================

/**
 * WorktreeSelectionProvider component
 *
 * Provides worktree selection state to child components.
 * Fetches worktrees on mount and provides selection functionality.
 *
 * @example
 * ```tsx
 * <WorktreeSelectionProvider>
 *   <Sidebar />
 *   <MainContent />
 * </WorktreeSelectionProvider>
 * ```
 */
export function WorktreeSelectionProvider({ children }: WorktreeSelectionProviderProps) {
  const [state, dispatch] = useReducer(worktreeSelectionReducer, initialState);

  // Fetch worktrees on mount
  const fetchWorktrees = useCallback(async () => {
    dispatch({ type: 'SET_LOADING', isLoading: true });
    dispatch({ type: 'SET_ERROR', error: null });

    try {
      const response = await worktreeApi.getAll();
      dispatch({ type: 'SET_WORKTREES', worktrees: response.worktrees });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch worktrees';
      dispatch({ type: 'SET_ERROR', error: message });
    }
  }, []);

  // Select a worktree with optimistic update
  const selectWorktree = useCallback(async (id: string) => {
    // Optimistic update: immediately set selected ID
    dispatch({ type: 'SELECT_WORKTREE', id });
    dispatch({ type: 'SET_LOADING_DETAIL', isLoadingDetail: true });
    dispatch({ type: 'SET_ERROR', error: null });

    try {
      // G6: Mark worktree as viewed when selected (for unread tracking - Issue #31)
      // Fire and forget - don't wait for this to complete
      worktreeApi.markAsViewed(id).catch((err) => {
        console.warn('[WorktreeSelectionContext] Failed to mark as viewed:', err);
      });

      const detail = await worktreeApi.getById(id);
      dispatch({ type: 'SET_WORKTREE_DETAIL', detail });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch worktree detail';
      dispatch({ type: 'SET_ERROR', error: message });
    } finally {
      dispatch({ type: 'SET_LOADING_DETAIL', isLoadingDetail: false });
    }
  }, []);

  // Refresh worktree list
  const refreshWorktrees = useCallback(async () => {
    await fetchWorktrees();
  }, [fetchWorktrees]);

  // Initial fetch
  useEffect(() => {
    fetchWorktrees();
  }, [fetchWorktrees]);

  // Dynamic polling for worktree status updates
  // Uses setTimeout for adaptive polling intervals based on worktree activity
  useEffect(() => {
    let timeoutId: NodeJS.Timeout | null = null;
    let isMounted = true;

    const poll = async () => {
      if (!isMounted) return;

      try {
        // Silent refresh (don't show loading state during polling)
        const response = await worktreeApi.getAll();
        dispatch({ type: 'SET_WORKTREES', worktrees: response.worktrees });

        // Schedule next poll with dynamic interval based on current worktree states
        const nextInterval = getPollingInterval(response.worktrees);
        if (isMounted) {
          timeoutId = setTimeout(poll, nextInterval);
        }
      } catch (err) {
        console.error('[WorktreeSelectionContext] Polling error:', err);
        // On error, retry with SESSION_RUNNING interval
        if (isMounted) {
          timeoutId = setTimeout(poll, POLLING_INTERVALS.SESSION_RUNNING);
        }
      }
    };

    // Start polling immediately
    poll();

    return () => {
      isMounted = false;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, []);

  const value: WorktreeSelectionContextValue = {
    selectedWorktreeId: state.selectedWorktreeId,
    worktrees: state.worktrees,
    selectedWorktreeDetail: state.selectedWorktreeDetail,
    isLoadingDetail: state.isLoadingDetail,
    error: state.error,
    selectWorktree,
    refreshWorktrees,
  };

  return (
    <WorktreeSelectionContext.Provider value={value}>
      {children}
    </WorktreeSelectionContext.Provider>
  );
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook to access worktree selection context
 *
 * @throws Error if used outside WorktreeSelectionProvider
 *
 * @example
 * ```tsx
 * function BranchList() {
 *   const { worktrees, selectedWorktreeId, selectWorktree } = useWorktreeSelection();
 *
 *   return (
 *     <ul>
 *       {worktrees.map(wt => (
 *         <li
 *           key={wt.id}
 *           onClick={() => selectWorktree(wt.id)}
 *           className={wt.id === selectedWorktreeId ? 'selected' : ''}
 *         >
 *           {wt.name}
 *         </li>
 *       ))}
 *     </ul>
 *   );
 * }
 * ```
 */
export function useWorktreeSelection(): WorktreeSelectionContextValue {
  const context = useContext(WorktreeSelectionContext);
  if (!context) {
    throw new Error('useWorktreeSelection must be used within a WorktreeSelectionProvider');
  }
  return context;
}
