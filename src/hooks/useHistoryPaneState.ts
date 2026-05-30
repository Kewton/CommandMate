/**
 * useHistoryPaneState Hook (Issue #727, updated by Issue #730)
 *
 * Manages PC History pane visibility and width.
 *
 * Persistence:
 *   - `commandmate.worktree.historyVisible` (boolean)
 *   - `commandmate.worktree.historyWidth` (number, percentage 10-60)
 *
 * Defaults:
 *   - visible: true
 *   - width: 40 (percent of the TerminalContainer inner area — Issue #730
 *     moved History inside TerminalContainer, so the percentage is now
 *     relative to that inner area, not the whole desktop layout. The default
 *     was raised 25 → 40 to keep the History column visually comparable to
 *     the previous 4-column layout. This is documented in CHANGELOG as a
 *     Breaking Change for users with a stored `historyWidth` value.)
 *
 * SSR / hydration:
 *   - SSR returns defaults. Effect on mount syncs from localStorage.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export const HISTORY_VISIBLE_STORAGE_KEY = 'commandmate.worktree.historyVisible';
export const HISTORY_WIDTH_STORAGE_KEY = 'commandmate.worktree.historyWidth';

export const DEFAULT_HISTORY_VISIBLE = true;
/**
 * Default History pane width in percent of the TerminalContainer area
 * (Issue #730: raised 25 → 40 because History is now inside TerminalContainer,
 * not the full desktop layout).
 */
export const DEFAULT_HISTORY_WIDTH = 40;
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

/**
 * Custom event name used to broadcast hook state changes across multiple
 * `useHistoryPaneState` instances on the same page (Issue #730).
 *
 * Same-window writes to localStorage do not fire the native `storage` event,
 * so when two consumers of this hook coexist (e.g. `WorktreeDetailRefactored`
 * for `onCollapse` wiring, and `TerminalContainer` for the visible/width
 * render) they would otherwise desync on the second toggle. We emit a
 * lightweight CustomEvent on every write and listen for it on every mount.
 */
const HISTORY_PANE_STATE_EVENT = 'commandmate:historyPaneStateChange';

interface HistoryPaneStateEventDetail {
  visible: boolean;
  width: number;
}

function emitChange(detail: HistoryPaneStateEventDetail): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(
      new CustomEvent<HistoryPaneStateEventDetail>(HISTORY_PANE_STATE_EVENT, {
        detail,
      })
    );
  } catch {
    /* CustomEvent may be unavailable in very old environments */
  }
}

export function useHistoryPaneState(): UseHistoryPaneStateReturn {
  const [visible, setVisibleState] = useState<boolean>(DEFAULT_HISTORY_VISIBLE);
  const [width, setWidthState] = useState<number>(DEFAULT_HISTORY_WIDTH);

  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const widthRef = useRef(width);
  widthRef.current = width;

  // Hydrate once on mount.
  useEffect(() => {
    const v = readStoredVisible();
    const w = readStoredWidth();
    setVisibleState(v);
    setWidthState(w);
  }, []);

  // Issue #730: sync state across hook instances on the same page.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onChange = (event: Event): void => {
      const ce = event as CustomEvent<HistoryPaneStateEventDetail>;
      if (!ce.detail) return;
      if (ce.detail.visible !== visibleRef.current) {
        setVisibleState(ce.detail.visible);
      }
      if (ce.detail.width !== widthRef.current) {
        setWidthState(ce.detail.width);
      }
    };
    window.addEventListener(HISTORY_PANE_STATE_EVENT, onChange);
    return () => window.removeEventListener(HISTORY_PANE_STATE_EVENT, onChange);
  }, []);

  const toggle = useCallback((): void => {
    const next = !visibleRef.current;
    setVisibleState(next);
    writeStoredVisible(next);
    emitChange({ visible: next, width: widthRef.current });
  }, []);

  const setWidth = useCallback((next: number): void => {
    const clamped = clampWidth(next);
    setWidthState(clamped);
    writeStoredWidth(clamped);
    emitChange({ visible: visibleRef.current, width: clamped });
  }, []);

  return { visible, width, toggle, setWidth };
}

export default useHistoryPaneState;
