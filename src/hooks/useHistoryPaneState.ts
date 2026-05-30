/**
 * useHistoryPaneState Hook (Issue #727)
 *
 * Manages PC History pane visibility and width.
 *
 * Persistence:
 *   - `commandmate.worktree.historyVisible` (boolean)
 *   - `commandmate.worktree.historyWidth` (number, percentage 10-60)
 *
 * Defaults:
 *   - visible: true
 *   - width: 25 (percent)
 *
 * SSR / hydration:
 *   - SSR returns defaults. Effect on mount syncs from localStorage.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export const HISTORY_VISIBLE_STORAGE_KEY = 'commandmate.worktree.historyVisible';
export const HISTORY_WIDTH_STORAGE_KEY = 'commandmate.worktree.historyWidth';

export const DEFAULT_HISTORY_VISIBLE = true;
export const DEFAULT_HISTORY_WIDTH = 25;
export const MIN_HISTORY_WIDTH = 10;
export const MAX_HISTORY_WIDTH = 60;

export interface UseHistoryPaneStateReturn {
  /** Whether the History pane is visible. */
  visible: boolean;
  /** Width in percent (clamped to [MIN_HISTORY_WIDTH, MAX_HISTORY_WIDTH]). */
  width: number;
  /** Toggle visibility (also persists). */
  toggle: () => void;
  /** Set width (clamped + persisted). */
  setWidth: (next: number) => void;
}

function clampWidth(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_HISTORY_WIDTH;
  return Math.min(MAX_HISTORY_WIDTH, Math.max(MIN_HISTORY_WIDTH, n));
}

function readStoredVisible(): boolean {
  if (typeof window === 'undefined') return DEFAULT_HISTORY_VISIBLE;
  try {
    const raw = window.localStorage.getItem(HISTORY_VISIBLE_STORAGE_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {
    /* unavailable */
  }
  return DEFAULT_HISTORY_VISIBLE;
}

function readStoredWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_HISTORY_WIDTH;
  try {
    const raw = window.localStorage.getItem(HISTORY_WIDTH_STORAGE_KEY);
    if (raw === null) return DEFAULT_HISTORY_WIDTH;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return clampWidth(parsed);
  } catch {
    /* unavailable */
  }
  return DEFAULT_HISTORY_WIDTH;
}

function writeStoredVisible(v: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(HISTORY_VISIBLE_STORAGE_KEY, String(v));
  } catch {
    /* unavailable */
  }
}

function writeStoredWidth(n: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(HISTORY_WIDTH_STORAGE_KEY, String(n));
  } catch {
    /* unavailable */
  }
}

export function useHistoryPaneState(): UseHistoryPaneStateReturn {
  const [visible, setVisibleState] = useState<boolean>(DEFAULT_HISTORY_VISIBLE);
  const [width, setWidthState] = useState<number>(DEFAULT_HISTORY_WIDTH);

  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  // Hydrate once on mount.
  useEffect(() => {
    const v = readStoredVisible();
    const w = readStoredWidth();
    setVisibleState(v);
    setWidthState(w);
  }, []);

  const toggle = useCallback((): void => {
    const next = !visibleRef.current;
    setVisibleState(next);
    writeStoredVisible(next);
  }, []);

  const setWidth = useCallback((next: number): void => {
    const clamped = clampWidth(next);
    setWidthState(clamped);
    writeStoredWidth(clamped);
  }, []);

  return { visible, width, toggle, setWidth };
}

export default useHistoryPaneState;
