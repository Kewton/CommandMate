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
 *
 * Scope (Issue #2510):
 *   - The keys above are the worktree screen's, and they are what a call with
 *     no argument reads — unchanged, and pinned by
 *     `tests/unit/hooks/useHistoryPaneState-scope-2510.test.ts`.
 *   - A different screen that needs its own History toggle passes its own
 *     {@link HistoryPaneStorageKeys}. The `/sessions` tile does
 *     ({@link SESSION_TILE_HISTORY_PANE_STORAGE_KEYS}): before #2510 the only
 *     scope was the global one, so closing History in a tile would have closed
 *     it on every worktree screen too, and vice versa.
 *   - The same-page broadcast below carries the scope, so two scopes mounted on
 *     one page cannot flip each other either.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export const HISTORY_VISIBLE_STORAGE_KEY = 'commandmate.worktree.historyVisible';
export const HISTORY_WIDTH_STORAGE_KEY = 'commandmate.worktree.historyWidth';

/**
 * The pair of localStorage keys one History toggle persists under (Issue #2510).
 *
 * A pair rather than a single prefix so the worktree screen's two pre-existing
 * keys stay byte-for-byte what they were — a derived key would have silently
 * reset every stored preference.
 */
export interface HistoryPaneStorageKeys {
  readonly visible: string;
  readonly width: string;
}

/** The worktree screen's scope — what `useHistoryPaneState()` reads. */
export const WORKTREE_HISTORY_PANE_STORAGE_KEYS: HistoryPaneStorageKeys = {
  visible: HISTORY_VISIBLE_STORAGE_KEY,
  width: HISTORY_WIDTH_STORAGE_KEY,
};

/**
 * Whether History is shown under a `/sessions` tile's terminal (Issue #2510).
 *
 * One value for every tile rather than one per worktree — the same "common
 * across panes" rule the worktree screen applies to its splits — but never the
 * worktree screen's value: a tile stacks History UNDER a ~800px terminal, the
 * worktree screen puts it BESIDE a full-width one, and a choice made for one
 * layout says nothing about the other.
 */
export const SESSION_TILE_HISTORY_VISIBLE_STORAGE_KEY = 'commandmate.sessions.tileHistoryVisible';

/**
 * Reserved partner of {@link SESSION_TILE_HISTORY_VISIBLE_STORAGE_KEY}. A tile
 * stacks History vertically at a fixed share and never calls `setWidth`, so
 * nothing writes this today; it exists so the tile's scope is a complete pair
 * and can never fall through to the worktree screen's width key.
 */
export const SESSION_TILE_HISTORY_WIDTH_STORAGE_KEY = 'commandmate.sessions.tileHistoryWidth';

/** The `/sessions` tile's scope (Issue #2510). */
export const SESSION_TILE_HISTORY_PANE_STORAGE_KEYS: HistoryPaneStorageKeys = {
  visible: SESSION_TILE_HISTORY_VISIBLE_STORAGE_KEY,
  width: SESSION_TILE_HISTORY_WIDTH_STORAGE_KEY,
};

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

function readStoredVisible(key: string): boolean {
  if (typeof window === 'undefined') return DEFAULT_HISTORY_VISIBLE;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {
    /* unavailable */
  }
  return DEFAULT_HISTORY_VISIBLE;
}

function readStoredWidth(key: string): number {
  if (typeof window === 'undefined') return DEFAULT_HISTORY_WIDTH;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return DEFAULT_HISTORY_WIDTH;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return clampWidth(parsed);
  } catch {
    /* unavailable */
  }
  return DEFAULT_HISTORY_WIDTH;
}

function writeStoredVisible(key: string, v: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, String(v));
  } catch {
    /* unavailable */
  }
}

function writeStoredWidth(key: string, n: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, String(n));
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
  /**
   * Issue #2510: which scope changed, as its visible key. A listener in another
   * scope ignores the event — without this a tile toggle would flip any
   * worktree-screen instance mounted on the same page.
   */
  scope: string;
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

/**
 * @param storageKeys - Which scope to read and write. Omit for the worktree
 *   screen's ({@link WORKTREE_HISTORY_PANE_STORAGE_KEYS}); pass a module-level
 *   constant otherwise — the effects re-run on the key strings, not on the
 *   object's identity, but a constant keeps that obvious.
 */
export function useHistoryPaneState(
  storageKeys: HistoryPaneStorageKeys = WORKTREE_HISTORY_PANE_STORAGE_KEYS
): UseHistoryPaneStateReturn {
  const { visible: visibleKey, width: widthKey } = storageKeys;
  const [visible, setVisibleState] = useState<boolean>(DEFAULT_HISTORY_VISIBLE);
  const [width, setWidthState] = useState<number>(DEFAULT_HISTORY_WIDTH);

  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const widthRef = useRef(width);
  widthRef.current = width;

  // Hydrate on mount (and again if a caller ever switches scope).
  useEffect(() => {
    const v = readStoredVisible(visibleKey);
    const w = readStoredWidth(widthKey);
    setVisibleState(v);
    setWidthState(w);
  }, [visibleKey, widthKey]);

  // Issue #730: sync state across hook instances on the same page.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onChange = (event: Event): void => {
      const ce = event as CustomEvent<HistoryPaneStateEventDetail>;
      if (!ce.detail) return;
      // Issue #2510: another scope's toggle is not this scope's news.
      if (ce.detail.scope !== visibleKey) return;
      if (ce.detail.visible !== visibleRef.current) {
        setVisibleState(ce.detail.visible);
      }
      if (ce.detail.width !== widthRef.current) {
        setWidthState(ce.detail.width);
      }
    };
    window.addEventListener(HISTORY_PANE_STATE_EVENT, onChange);
    return () => window.removeEventListener(HISTORY_PANE_STATE_EVENT, onChange);
  }, [visibleKey]);

  const toggle = useCallback((): void => {
    const next = !visibleRef.current;
    setVisibleState(next);
    writeStoredVisible(visibleKey, next);
    emitChange({ scope: visibleKey, visible: next, width: widthRef.current });
  }, [visibleKey]);

  const setWidth = useCallback((next: number): void => {
    const clamped = clampWidth(next);
    setWidthState(clamped);
    writeStoredWidth(widthKey, clamped);
    emitChange({ scope: visibleKey, visible: visibleRef.current, width: clamped });
  }, [visibleKey, widthKey]);

  return { visible, width, toggle, setWidth };
}

/**
 * DOM id of the History column rendered inside PC split `splitIndex`
 * (Issue #744, moved here by Issue #2259).
 *
 * Lives beside the visibility state rather than inside `HistoryPane` because
 * #2259 made the Action-bar toggle the single control for this column, and that
 * toggle needs the region ids for `aria-controls` without importing the whole
 * `HistoryPane` module (and its transcript/virtualizer dependency tree) into
 * `TerminalSplitContainer`. `HistoryPane` re-exports it, so every existing
 * importer — and every test that mocks `@/components/worktree/HistoryPane` —
 * keeps working unchanged.
 */
export function splitHistorySlotId(splitIndex: number): string {
  return `split-history-slot-${splitIndex}`;
}

export default useHistoryPaneState;
