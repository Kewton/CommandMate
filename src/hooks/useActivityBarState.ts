/**
 * useActivityBarState Hook (Issue #727, per-worktree persistence Issue #858)
 *
 * Manages the active ActivityId for the VS Code-style Activity Bar.
 *
 * Behavior:
 * - `active`: ActivityId | null — `null` means the ActivityPane is hidden.
 * - `setActive(id)`: select an activity (open the pane if currently closed).
 * - `toggle(id)`: clicking the same active icon closes the pane (null).
 *
 * Persistence (Issue #858):
 * - The state is persisted *per worktree* under
 *   `getActivityBarStorageKey(worktreeId)` (mirrors the per-worktree CLI tab
 *   key). This prevents the open/closed state from leaking across branch
 *   (worktree) switches.
 * - Both the selected ActivityId *and* the explicitly closed (null) state are
 *   persisted. A closed pane is stored as `ACTIVITY_CLOSED_SENTINEL` so that
 *   hiding the pane on branch A survives a visit to branch B and back to A.
 * - An *unvisited* worktree (no stored value) still defaults to
 *   DEFAULT_ACTIVITY ('files').
 *
 * SSR / hydration:
 * - Before the first effect runs we deterministically return DEFAULT_ACTIVITY
 *   ('files'). The localStorage read happens in a useEffect so SSR and the
 *   first client render agree (no hydration mismatch).
 * - The hydration effect re-runs whenever `worktreeId` changes, so switching
 *   worktrees in-place (without a full remount) still re-reads the correct
 *   per-worktree state.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ACTIVITY_CLOSED_SENTINEL,
  DEFAULT_ACTIVITY,
  getActivityBarStorageKey,
  isActivityId,
  type ActivityId,
} from '@/config/activity-bar-config';

export interface UseActivityBarStateReturn {
  /** Currently active activity, or null when the pane is closed. */
  active: ActivityId | null;
  /** Select a specific activity (opens the pane). */
  setActive: (id: ActivityId) => void;
  /**
   * Toggle behavior: if `id` equals the current active activity, close
   * (set null). Otherwise switch to `id`.
   */
  toggle: (id: ActivityId) => void;
}

/**
 * Read the persisted activity for a worktree.
 * - A valid ActivityId string → that activity.
 * - The closed sentinel → `null` (explicitly hidden).
 * - No / invalid value → DEFAULT_ACTIVITY (unvisited worktree).
 */
function readStoredActivity(worktreeId: string): ActivityId | null {
  if (typeof window === 'undefined') return DEFAULT_ACTIVITY;
  try {
    const raw = window.localStorage.getItem(getActivityBarStorageKey(worktreeId));
    if (raw === ACTIVITY_CLOSED_SENTINEL) return null;
    if (raw && isActivityId(raw)) return raw;
  } catch {
    /* localStorage unavailable */
  }
  return DEFAULT_ACTIVITY;
}

/**
 * Persist the activity (or the closed sentinel for `null`) for a worktree.
 */
function writeStoredActivity(worktreeId: string, value: ActivityId | null): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      getActivityBarStorageKey(worktreeId),
      value ?? ACTIVITY_CLOSED_SENTINEL,
    );
  } catch {
    /* localStorage unavailable */
  }
}

/**
 * React hook for the VS Code-style Activity Bar state.
 *
 * @param worktreeId - the worktree whose Activity Bar state to manage. The
 *   open/closed/selected state is persisted and restored per worktree.
 */
export function useActivityBarState(worktreeId: string): UseActivityBarStateReturn {
  // SSR-safe initial value. The post-mount effect below replaces this with
  // the persisted value (if any).
  const [active, setActiveState] = useState<ActivityId | null>(DEFAULT_ACTIVITY);

  // Track active in a ref so the `toggle` callback identity can stay stable.
  const activeRef = useRef<ActivityId | null>(active);
  activeRef.current = active;

  // Keep the latest worktreeId available to the stable callbacks below.
  const worktreeIdRef = useRef(worktreeId);
  worktreeIdRef.current = worktreeId;

  // Hydrate from localStorage on mount and whenever the worktree changes.
  useEffect(() => {
    const stored = readStoredActivity(worktreeId);
    if (stored !== activeRef.current) {
      setActiveState(stored);
    }
  }, [worktreeId]);

  const setActive = useCallback((id: ActivityId): void => {
    setActiveState(id);
    writeStoredActivity(worktreeIdRef.current, id);
  }, []);

  const toggle = useCallback((id: ActivityId): void => {
    if (activeRef.current === id) {
      // Close: persist the closed sentinel so the hidden state survives a
      // round-trip to another worktree and back (Issue #858).
      setActiveState(null);
      writeStoredActivity(worktreeIdRef.current, null);
      return;
    }
    setActiveState(id);
    writeStoredActivity(worktreeIdRef.current, id);
  }, []);

  return { active, setActive, toggle };
}

export default useActivityBarState;
