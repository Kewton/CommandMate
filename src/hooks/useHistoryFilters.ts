/**
 * useHistoryFilters hook (Issue #923)
 *
 * Owns the History pane's filter/display state extracted from
 * `useWorktreeDetailController` as a pure structural refactor (no behavior
 * change). This is one of the Phase 1 "low-risk, no cross-concern coupling"
 * sub-hooks — it manages only self-contained state with localStorage sync:
 *  - `historySubTab`        : 'message' (default) | 'git'           (Issue #447)
 *  - `showArchived`         : include archived messages toggle      (Issue #168)
 *  - `historyUserOnly`      : HistoryPane "User only" filter toggle (Issue #725)
 *  - `historyDisplayLimit`  : how many messages to request          (Issue #701)
 *
 * Ownership boundary: this hook covers the filter *values* and their
 * localStorage persistence only. The ref mirrors (`showArchivedRef` /
 * `historyDisplayLimitRef`) that keep the controller's `fetchMessages` a stable
 * closure stay in the controller — they belong to the polling/fetch concern
 * (deferred to Issue #923 Phase 2/3), not to this filter-state concern.
 */

'use client';

import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  HISTORY_DISPLAY_LIMIT_STORAGE_KEY,
  HISTORY_USER_ONLY_STORAGE_KEY,
  DEFAULT_MESSAGES_LIMIT,
  isHistoryDisplayLimit,
  type HistoryDisplayLimit,
} from '@/config/history-display-config';

/** localStorage key for the "show archived messages" toggle (Issue #168). */
const SHOW_ARCHIVED_STORAGE_KEY = 'commandmate:showArchived';

/** Public API returned by {@link useHistoryFilters}. */
export interface UseHistoryFiltersReturn {
  /** History sub-tab: 'message' (default) or 'git' (Issue #447). */
  historySubTab: 'message' | 'git';
  /** Setter for {@link historySubTab}. */
  setHistorySubTab: Dispatch<SetStateAction<'message' | 'git'>>;
  /** Whether archived messages are included in the History pane (Issue #168). */
  showArchived: boolean;
  /** Update {@link showArchived} and persist it to localStorage. */
  handleShowArchivedChange: (show: boolean) => void;
  /** HistoryPane "User only" filter toggle (Issue #725). */
  historyUserOnly: boolean;
  /** Update {@link historyUserOnly} and persist it to localStorage. */
  handleHistoryUserOnlyChange: (next: boolean) => void;
  /** How many messages to request from the History API (Issue #701). */
  historyDisplayLimit: HistoryDisplayLimit;
  /** Update {@link historyDisplayLimit} and persist it to localStorage. */
  handleHistoryDisplayLimitChange: (limit: HistoryDisplayLimit) => void;
}

/**
 * State management for the History pane's filter/display toggles.
 *
 * @returns The filter state and their localStorage-synced change handlers.
 */
export function useHistoryFilters(): UseHistoryFiltersReturn {
  // [Issue #447] History sub-tab: 'message' (default) or 'git'
  const [historySubTab, setHistorySubTab] = useState<'message' | 'git'>('message');

  // Issue #168: showArchived toggle state with localStorage persistence
  const [showArchived, setShowArchived] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem(SHOW_ARCHIVED_STORAGE_KEY) === 'true';
  });
  const handleShowArchivedChange = useCallback((show: boolean) => {
    setShowArchived(show);
    localStorage.setItem(SHOW_ARCHIVED_STORAGE_KEY, String(show));
  }, []);

  // Issue #725: HistoryPane "User only" filter toggle with localStorage persistence.
  // Value representation: 'true' / 'false' (matches commandmate:showArchived).
  // Any other value (including legacy '1'/'0') is treated as false (safe-off fallback).
  const [historyUserOnly, setHistoryUserOnly] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return localStorage.getItem(HISTORY_USER_ONLY_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const handleHistoryUserOnlyChange = useCallback((next: boolean) => {
    setHistoryUserOnly(next);
    try {
      localStorage.setItem(HISTORY_USER_ONLY_STORAGE_KEY, String(next));
    } catch {
      /* localStorage unavailable */
    }
  }, []);

  // Issue #701: history display limit state with localStorage persistence
  const [historyDisplayLimit, setHistoryDisplayLimit] = useState<HistoryDisplayLimit>(() => {
    if (typeof window === 'undefined') return DEFAULT_MESSAGES_LIMIT;
    try {
      const stored = localStorage.getItem(HISTORY_DISPLAY_LIMIT_STORAGE_KEY);
      if (stored === null) return DEFAULT_MESSAGES_LIMIT;
      const parsed = parseInt(stored, 10);
      return isHistoryDisplayLimit(parsed) ? parsed : DEFAULT_MESSAGES_LIMIT;
    } catch {
      return DEFAULT_MESSAGES_LIMIT;
    }
  });
  const handleHistoryDisplayLimitChange = useCallback((limit: HistoryDisplayLimit) => {
    setHistoryDisplayLimit(limit);
    try {
      localStorage.setItem(HISTORY_DISPLAY_LIMIT_STORAGE_KEY, String(limit));
    } catch {
      /* localStorage unavailable */
    }
  }, []);

  return {
    historySubTab,
    setHistorySubTab,
    showArchived,
    handleShowArchivedChange,
    historyUserOnly,
    handleHistoryUserOnlyChange,
    historyDisplayLimit,
    handleHistoryDisplayLimitChange,
  };
}
