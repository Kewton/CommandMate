/**
 * useFileTabs Hook
 *
 * Manages file tab state for the desktop file panel.
 * Uses useReducer for predictable state transitions.
 *
 * Issue #438: PC file display panel with tabs
 */

'use client';

import { useReducer, useCallback, useEffect, useRef } from 'react';
import type { FileContent } from '@/types/models';

// ============================================================================
// Constants
// ============================================================================

/** Maximum number of simultaneously open file tabs */
export const MAX_FILE_TABS = 5;

/** localStorage key prefix for file tab persistence */
const STORAGE_KEY_PREFIX = 'commandmate:file-tabs:';

/** Persisted tab data (paths only, content is re-fetched) */
interface PersistedTabData {
  paths: string[];
  activePath: string | null;
}

// ============================================================================
// Types
// ============================================================================

/** Individual file tab state */
export interface FileTab {
  /** File path relative to worktree root */
  path: string;
  /** Display name (filename extracted from path) */
  name: string;
  /** Loaded file content (null until fetched) */
  content: FileContent | null;
  /** Whether content is being fetched */
  loading: boolean;
  /** Error message if fetch failed */
  error: string | null;
}

/** State for all file tabs */
export interface FileTabsState {
  /** Array of open file tabs */
  tabs: FileTab[];
  /** Index of the currently active tab (null if no tabs) */
  activeIndex: number | null;
}

/** Actions for the file tabs reducer */
export type FileTabsAction =
  | { type: 'OPEN_FILE'; path: string }
  | { type: 'CLOSE_TAB'; path: string }
  | { type: 'ACTIVATE_TAB'; path: string }
  | { type: 'SET_CONTENT'; path: string; content: FileContent }
  | { type: 'SET_LOADING'; path: string; loading: boolean }
  | { type: 'SET_ERROR'; path: string; error: string }
  | { type: 'RENAME_FILE'; oldPath: string; newPath: string }
  | { type: 'DELETE_FILE'; path: string }
  | { type: 'RESTORE'; paths: string[]; activePath: string | null };

// ============================================================================
// Helper Functions
// ============================================================================

/** Extract filename from a file path */
function extractFileName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

/** Update a specific tab by path, returning new tabs array or null if not found */
function updateTabByPath(
  tabs: FileTab[],
  path: string,
  updater: (tab: FileTab) => FileTab,
): FileTab[] | null {
  const index = tabs.findIndex((t) => t.path === path);
  if (index === -1) return null;
  const newTabs = [...tabs];
  newTabs[index] = updater(newTabs[index]);
  return newTabs;
}

/**
 * Compute new activeIndex after removing a tab.
 * - If no tabs remain, return null
 * - If the removed tab was before activeIndex, shift down by 1
 * - If the removed tab was the active tab, activate the previous tab (or 0)
 * - Otherwise keep the same activeIndex
 */
function computeActiveIndexAfterRemoval(
  removedIndex: number,
  currentActive: number | null,
  remainingCount: number,
): number | null {
  if (remainingCount === 0) return null;
  if (currentActive === null) return null;

  if (removedIndex < currentActive) {
    return currentActive - 1;
  }
  if (removedIndex === currentActive) {
    // Activate previous tab, or first tab if removing first
    return Math.min(removedIndex, remainingCount - 1);
  }
  return currentActive;
}

// ============================================================================
// Reducer
// ============================================================================

const initialState: FileTabsState = { tabs: [], activeIndex: null };

/** Reducer for file tabs state management */
export function fileTabsReducer(state: FileTabsState, action: FileTabsAction): FileTabsState {
  switch (action.type) {
    case 'OPEN_FILE': {
      // Check if already open
      const existingIndex = state.tabs.findIndex((t) => t.path === action.path);
      if (existingIndex !== -1) {
        if (state.activeIndex === existingIndex) return state;
        return { ...state, activeIndex: existingIndex };
      }
      // Check limit
      if (state.tabs.length >= MAX_FILE_TABS) {
        return state;
      }
      // Add new tab
      const newTab: FileTab = {
        path: action.path,
        name: extractFileName(action.path),
        content: null,
        loading: false,
        error: null,
      };
      const newTabs = [...state.tabs, newTab];
      return { tabs: newTabs, activeIndex: newTabs.length - 1 };
    }

    case 'CLOSE_TAB': {
      const removeIndex = state.tabs.findIndex((t) => t.path === action.path);
      if (removeIndex === -1) return state;

      const remaining = state.tabs.filter((_, i) => i !== removeIndex);
      const newActive = computeActiveIndexAfterRemoval(
        removeIndex,
        state.activeIndex,
        remaining.length,
      );
      return { tabs: remaining, activeIndex: newActive };
    }

    case 'ACTIVATE_TAB': {
      const index = state.tabs.findIndex((t) => t.path === action.path);
      if (index === -1 || state.activeIndex === index) return state;
      return { ...state, activeIndex: index };
    }

    case 'SET_CONTENT': {
      const newTabs = updateTabByPath(state.tabs, action.path, (tab) => ({
        ...tab,
        content: action.content,
        loading: false,
        error: null,
      }));
      if (!newTabs) return state;
      return { ...state, tabs: newTabs };
    }

    case 'SET_LOADING': {
      const newTabs = updateTabByPath(state.tabs, action.path, (tab) => ({
        ...tab,
        loading: action.loading,
      }));
      if (!newTabs) return state;
      return { ...state, tabs: newTabs };
    }

    case 'SET_ERROR': {
      const newTabs = updateTabByPath(state.tabs, action.path, (tab) => ({
        ...tab,
        error: action.error,
        loading: false,
      }));
      if (!newTabs) return state;
      return { ...state, tabs: newTabs };
    }

    case 'RENAME_FILE': {
      const index = state.tabs.findIndex((t) => t.path === action.oldPath);
      if (index === -1) return state;
      const newTabs = [...state.tabs];
      newTabs[index] = {
        ...newTabs[index],
        path: action.newPath,
        name: extractFileName(action.newPath),
      };
      return { ...state, tabs: newTabs };
    }

    case 'DELETE_FILE': {
      // Reuse CLOSE_TAB logic
      return fileTabsReducer(state, { type: 'CLOSE_TAB', path: action.path });
    }

    case 'RESTORE': {
      const tabs: FileTab[] = action.paths
        .slice(0, MAX_FILE_TABS)
        .map((path) => ({
          path,
          name: extractFileName(path),
          content: null,
          loading: false,
          error: null,
        }));
      if (tabs.length === 0) return initialState;
      const activeIndex = action.activePath
        ? Math.max(0, tabs.findIndex((t) => t.path === action.activePath))
        : 0;
      return { tabs, activeIndex };
    }

    default:
      return state;
  }
}

// ============================================================================
// Hook
// ============================================================================

/** Return type of the useFileTabs hook */
export interface UseFileTabsReturn {
  state: FileTabsState;
  dispatch: React.Dispatch<FileTabsAction>;
  openFile: (path: string) => 'opened' | 'activated' | 'limit_reached';
  closeTab: (path: string) => void;
  activateTab: (path: string) => void;
  onFileRenamed: (oldPath: string, newPath: string) => void;
  onFileDeleted: (path: string) => void;
}

/** Read persisted tab data from localStorage */
function readPersistedTabs(worktreeId: string): PersistedTabData | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY_PREFIX + worktreeId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === 'object' && parsed !== null &&
      Array.isArray(parsed.paths) &&
      parsed.paths.every((p: unknown) => typeof p === 'string') &&
      (parsed.activePath === null || typeof parsed.activePath === 'string')
    ) {
      return parsed as PersistedTabData;
    }
  } catch { /* ignore */ }
  return null;
}

/** Write persisted tab data to localStorage */
function writePersistedTabs(worktreeId: string, state: FileTabsState): void {
  if (typeof window === 'undefined') return;
  try {
    const data: PersistedTabData = {
      paths: state.tabs.map((t) => t.path),
      activePath: state.activeIndex !== null ? state.tabs[state.activeIndex]?.path ?? null : null,
    };
    window.localStorage.setItem(STORAGE_KEY_PREFIX + worktreeId, JSON.stringify(data));
  } catch { /* quota exceeded or unavailable */ }
}

/**
 * Hook for managing file tabs in the desktop file panel.
 * Persists open tab paths to localStorage per worktreeId.
 *
 * @param worktreeId - Worktree identifier for localStorage scoping
 * @returns File tabs state and action dispatchers
 */
export function useFileTabs(worktreeId: string): UseFileTabsReturn {
  const [state, dispatch] = useReducer(fileTabsReducer, initialState);
  const restoredRef = useRef(false);
  const lastWorktreeIdRef = useRef(worktreeId);

  // Restore tabs from localStorage on mount or when worktreeId changes
  useEffect(() => {
    // Reset restoration flag when worktreeId changes
    if (lastWorktreeIdRef.current !== worktreeId) {
      lastWorktreeIdRef.current = worktreeId;
      restoredRef.current = false;
    }
    if (restoredRef.current) return;
    restoredRef.current = true;
    const persisted = readPersistedTabs(worktreeId);
    if (persisted && persisted.paths.length > 0) {
      dispatch({ type: 'RESTORE', paths: persisted.paths, activePath: persisted.activePath });
    }
  }, [worktreeId]);

  // Persist tabs to localStorage on state change (skip initial empty state before restore)
  useEffect(() => {
    if (!restoredRef.current) return;
    writePersistedTabs(worktreeId, state);
  }, [worktreeId, state]);

  const stateRef = useRef(state);
  stateRef.current = state;

  const openFile = useCallback(
    (path: string): 'opened' | 'activated' | 'limit_reached' => {
      const currentTabs = stateRef.current.tabs;
      // Check if already open
      const existingIndex = currentTabs.findIndex((t) => t.path === path);
      if (existingIndex !== -1) {
        dispatch({ type: 'OPEN_FILE', path });
        return 'activated';
      }
      // Check limit
      if (currentTabs.length >= MAX_FILE_TABS) {
        return 'limit_reached';
      }
      dispatch({ type: 'OPEN_FILE', path });
      return 'opened';
    },
    [],
  );

  const closeTab = useCallback((path: string) => {
    dispatch({ type: 'CLOSE_TAB', path });
  }, []);

  const activateTab = useCallback((path: string) => {
    dispatch({ type: 'ACTIVATE_TAB', path });
  }, []);

  const onFileRenamed = useCallback((oldPath: string, newPath: string) => {
    dispatch({ type: 'RENAME_FILE', oldPath, newPath });
  }, []);

  const onFileDeleted = useCallback((path: string) => {
    dispatch({ type: 'DELETE_FILE', path });
  }, []);

  return { state, dispatch, openFile, closeTab, activateTab, onFileRenamed, onFileDeleted };
}
