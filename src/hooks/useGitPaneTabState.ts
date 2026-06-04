/**
 * useGitPaneTabState Hook (Issue #818)
 *
 * Consolidates all GitPane UI-persistence state behind a single hook:
 * - `activeTab`: the active mobile tab (Status / Changes / History / Advanced),
 *   persisted so the last tab is restored on the next visit.
 * - `historyOpen`: Commit History collapsed/expanded state (was an ephemeral
 *   `useState` before Phase 4; now persisted).
 * - `advancedOpen`: Advanced operations collapsed/expanded state (introduced in
 *   Phase 1 / Issue #815; the localStorage key is preserved here unchanged so
 *   existing users keep their setting).
 *
 * Phase 4 (Issue #818 C) "整理・集約": every key lives under the shared
 * `commandmate:gitPane:` namespace and is owned by this one hook instead of
 * being scattered across the component.
 *
 * SSR-safe: each value starts at its default and hydrates from localStorage on
 * mount via {@link useLocalStorageState}.
 *
 * @module hooks/useGitPaneTabState
 */

'use client';

import { useCallback } from 'react';
import { useLocalStorageState } from './useLocalStorageState';

/**
 * The four mobile tabs of the GitPane.
 * - `status`   : Current Status + Quick actions
 * - `changes`  : Changes (stage / commit / push)
 * - `history`  : Commit History
 * - `advanced` : Advanced operations (Fetch / Branches / Stash / Danger Zone)
 */
export const GIT_PANE_TABS = ['status', 'changes', 'history', 'advanced'] as const;

/** A single GitPane mobile tab id. */
export type GitPaneTab = (typeof GIT_PANE_TABS)[number];

/** Shared localStorage namespace for all GitPane UI persistence (Issue #818 C). */
const STORAGE_PREFIX = 'commandmate:gitPane:';

/**
 * Consolidated localStorage keys. `advancedOpen` keeps the exact key introduced
 * in Phase 1 (#815) for backward compatibility; the others are new in Phase 4.
 */
export const GIT_PANE_STORAGE_KEYS = {
  activeTab: `${STORAGE_PREFIX}activeTab`,
  historyOpen: `${STORAGE_PREFIX}historyOpen`,
  advancedOpen: `${STORAGE_PREFIX}advancedOpen`,
} as const;

/** Type guard for a persisted tab id (rejects stale / unknown values). */
export function isGitPaneTab(value: unknown): value is GitPaneTab {
  return typeof value === 'string' && (GIT_PANE_TABS as readonly string[]).includes(value);
}

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

/** Return shape of {@link useGitPaneTabState}. */
export interface UseGitPaneTabStateReturn {
  /** Currently active mobile tab (persisted). */
  activeTab: GitPaneTab;
  /** Switch the active mobile tab (persisted). */
  setActiveTab: (tab: GitPaneTab) => void;
  /** Whether Commit History is expanded (persisted). */
  historyOpen: boolean;
  /** Toggle Commit History expanded/collapsed. */
  toggleHistory: () => void;
  /** Whether Advanced operations are expanded (persisted). */
  advancedOpen: boolean;
  /** Toggle Advanced operations expanded/collapsed. */
  toggleAdvanced: () => void;
  /** Whether localStorage persistence is active (false during SSR / when unavailable). */
  isPersistent: boolean;
}

/**
 * Manage the GitPane's persisted UI state (mobile tab + collapse states).
 *
 * @returns The current values plus stable setters/togglers.
 */
export function useGitPaneTabState(): UseGitPaneTabStateReturn {
  const {
    value: activeTab,
    setValue: setActiveTabRaw,
    isAvailable,
  } = useLocalStorageState<GitPaneTab>({
    key: GIT_PANE_STORAGE_KEYS.activeTab,
    defaultValue: 'status',
    validate: isGitPaneTab,
  });

  const { value: historyOpen, setValue: setHistoryOpen } = useLocalStorageState<boolean>({
    key: GIT_PANE_STORAGE_KEYS.historyOpen,
    defaultValue: true,
    validate: isBoolean,
  });

  const { value: advancedOpen, setValue: setAdvancedOpen } = useLocalStorageState<boolean>({
    key: GIT_PANE_STORAGE_KEYS.advancedOpen,
    defaultValue: false,
    validate: isBoolean,
  });

  const setActiveTab = useCallback(
    (tab: GitPaneTab) => setActiveTabRaw(tab),
    [setActiveTabRaw]
  );
  const toggleHistory = useCallback(
    () => setHistoryOpen((prev) => !prev),
    [setHistoryOpen]
  );
  const toggleAdvanced = useCallback(
    () => setAdvancedOpen((prev) => !prev),
    [setAdvancedOpen]
  );

  return {
    activeTab,
    setActiveTab,
    historyOpen,
    toggleHistory,
    advancedOpen,
    toggleAdvanced,
    isPersistent: isAvailable,
  };
}

export default useGitPaneTabState;
