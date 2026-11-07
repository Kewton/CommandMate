/**
 * usePaneSide (Issue #4219)
 *
 * Which side of the body the activity pane sits on: `'right'` (default) or
 * `'left'`. Persisted like `usePanePinnedState`: localStorage under a global
 * key, every read / write in try/catch, anything unreadable means `'right'`.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type PaneSide = 'left' | 'right';

/** Global (not per worktree), like the pin key. */
export const ACTIVITY_PANE_SIDE_STORAGE_KEY = 'commandmate.worktree.activityPaneSide';

export const DEFAULT_PANE_SIDE: PaneSide = 'right';

function readSide(storageKey: string): PaneSide {
  if (typeof window === 'undefined') return DEFAULT_PANE_SIDE;
  try {
    return window.localStorage.getItem(storageKey) === 'left' ? 'left' : DEFAULT_PANE_SIDE;
  } catch {
    /* localStorage unavailable */
  }
  return DEFAULT_PANE_SIDE;
}

function writeSide(storageKey: string, value: PaneSide): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey, value);
  } catch {
    /* localStorage unavailable */
  }
}

export interface UsePaneSideReturn {
  side: PaneSide;
  /** Flip left / right and persist it. */
  toggleSide: () => void;
}

/** SSR and the first client render return `'right'`; the stored value is read in an effect. */
export function usePaneSide(storageKey: string = ACTIVITY_PANE_SIDE_STORAGE_KEY): UsePaneSideReturn {
  const [side, setSide] = useState<PaneSide>(DEFAULT_PANE_SIDE);
  const sideRef = useRef(side);
  sideRef.current = side;

  useEffect(() => {
    setSide(readSide(storageKey));
  }, [storageKey]);

  const toggleSide = useCallback((): void => {
    const next: PaneSide = sideRef.current === 'left' ? 'right' : 'left';
    setSide(next);
    writeSide(storageKey, next);
  }, [storageKey]);

  return { side, toggleSide };
}
