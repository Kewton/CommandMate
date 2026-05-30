/**
 * useActivityBarState Hook (Issue #727)
 *
 * Manages the active ActivityId for the VS Code-style Activity Bar.
 *
 * Behavior:
 * - `active`: ActivityId | null — `null` means the ActivityPane is hidden.
 * - `setActive(id)`: select an activity (open the pane if currently closed).
 * - `toggle(id)`: clicking the same active icon closes the pane (null).
 *
 * Persistence:
 * - The last *selected* ActivityId is persisted to localStorage under
 *   `ACTIVITY_BAR_STORAGE_KEY` so the next visit reopens the same activity.
 * - A `null` (closed) state is intentionally NOT persisted. This keeps the
 *   "next visit shows the previously-opened activity" UX while still allowing
 *   the user to temporarily close the pane.
 *
 * SSR / hydration:
 * - Before the first effect runs we deterministically return DEFAULT_ACTIVITY
 *   ('files'). The localStorage read happens in a useEffect so SSR and the
 *   first client render agree (no hydration mismatch).
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ACTIVITY_BAR_STORAGE_KEY,
  DEFAULT_ACTIVITY,
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

function readStoredActivity(): ActivityId {
  if (typeof window === 'undefined') return DEFAULT_ACTIVITY;
  try {
    const raw = window.localStorage.getItem(ACTIVITY_BAR_STORAGE_KEY);
    if (raw && isActivityId(raw)) return raw;
  } catch {
    /* localStorage unavailable */
  }
  return DEFAULT_ACTIVITY;
}

function writeStoredActivity(id: ActivityId): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ACTIVITY_BAR_STORAGE_KEY, id);
  } catch {
    /* localStorage unavailable */
  }
}

/**
 * React hook for the VS Code-style Activity Bar state.
 */
export function useActivityBarState(): UseActivityBarStateReturn {
  // SSR-safe initial value. The post-mount effect below replaces this with
  // the persisted value (if any).
  const [active, setActiveState] = useState<ActivityId | null>(DEFAULT_ACTIVITY);

  // Track active in a ref so the `toggle` callback identity can stay stable.
  const activeRef = useRef<ActivityId | null>(active);
  activeRef.current = active;

  // Hydrate from localStorage exactly once on mount.
  useEffect(() => {
    const stored = readStoredActivity();
    if (stored !== activeRef.current) {
      setActiveState(stored);
    }
  }, []);

  const setActive = useCallback((id: ActivityId): void => {
    setActiveState(id);
    writeStoredActivity(id);
  }, []);

  const toggle = useCallback((id: ActivityId): void => {
    if (activeRef.current === id) {
      // Close (do NOT persist null — keep the last *opened* activity in storage
      // so the next session reopens it).
      setActiveState(null);
      return;
    }
    setActiveState(id);
    writeStoredActivity(id);
  }, []);

  return { active, setActive, toggle };
}

export default useActivityBarState;
