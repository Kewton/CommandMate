/**
 * useFilePanelState Hook (Issue #840)
 *
 * Manages the PC file panel collapsed state with localStorage persistence.
 * Mirrors `useHistoryPaneState` (Issue #727/#730) so the two panes behave
 * consistently. The file panel only needs a collapsed boolean (its width is
 * handled by `FilePanelSplit`'s own resizer), so this hook is the
 * visibility-only subset of the History pattern.
 *
 * Persistence:
 *   - `commandmate.worktree.filePanelCollapsed` (boolean)
 *
 * Default:
 *   - collapsed: false (file panel visible)
 *
 * SSR / hydration:
 *   - SSR returns the default. An effect on mount syncs from localStorage.
 */

'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

export const FILE_PANEL_COLLAPSED_STORAGE_KEY =
  'commandmate.worktree.filePanelCollapsed';

export const DEFAULT_FILE_PANEL_COLLAPSED = false;

/**
 * DOM id of the file-panel region (Issue #2259).
 *
 * `FilePanelSplit` stamps it on the pane it renders and the Action-bar toggle
 * names it in `aria-controls`, so the one remaining control for this panel
 * points at a region that actually exists. Declared here rather than in
 * `FilePanelSplit` so `TerminalSplitContainer` can reference it without pulling
 * the tabs/diff component tree into its own module graph.
 */
export const FILE_PANEL_PANE_ID = 'worktree-file-panel';

/**
 * What the file panel currently holds, as seen by controls OUTSIDE it
 * (Issue #2259).
 *
 * The Action bar's "Open Files" toggle has to be disabled — and carry a count
 * badge — while nothing is open, because toggling a panel that renders nothing
 * is the "press it and nothing happens" complaint the Issue opens with. The
 * numbers live in `useFileTabs`, several components above the Action bar, and
 * `FilePanelSplit` is the nearest common ancestor of the panel and the bar
 * (the bar is inside its `terminal` slot), so it publishes them here rather
 * than a new prop being threaded down from `WorktreeDetailDesktop`.
 */
export interface OpenFilesSnapshot {
  /** Number of open file tabs. */
  tabCount: number;
  /** Whether a diff is being shown in the panel (Issue #447). */
  hasDiff: boolean;
}

/** Snapshot used when no `FilePanelSplit` is above the consumer (tests, mobile). */
export const EMPTY_OPEN_FILES: OpenFilesSnapshot = { tabCount: 0, hasDiff: false };

export const OpenFilesContext = createContext<OpenFilesSnapshot>(EMPTY_OPEN_FILES);

/** Read the enclosing `FilePanelSplit`'s open-files snapshot. */
export function useOpenFiles(): OpenFilesSnapshot {
  return useContext(OpenFilesContext);
}

export interface UseFilePanelStateReturn {
  /** Whether the file panel is collapsed (true = hidden). */
  collapsed: boolean;
  /** Toggle collapsed state (also persists). */
  toggle: () => void;
  /** Set collapsed state explicitly (also persists). */
  setCollapsed: (next: boolean) => void;
}

function readStoredCollapsed(): boolean {
  if (typeof window === 'undefined') return DEFAULT_FILE_PANEL_COLLAPSED;
  try {
    const raw = window.localStorage.getItem(FILE_PANEL_COLLAPSED_STORAGE_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {
    /* unavailable */
  }
  return DEFAULT_FILE_PANEL_COLLAPSED;
}

function writeStoredCollapsed(v: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(FILE_PANEL_COLLAPSED_STORAGE_KEY, String(v));
  } catch {
    /* unavailable */
  }
}

/**
 * Custom event used to broadcast hook state changes across multiple
 * `useFilePanelState` instances on the same page (same rationale as
 * `useHistoryPaneState` — Issue #730): same-window localStorage writes do not
 * fire the native `storage` event, so a second consumer (e.g. the Phase 2
 * toolbar toggle) would otherwise desync. We emit a lightweight CustomEvent on
 * every write and listen for it on every mount.
 */
const FILE_PANEL_STATE_EVENT = 'commandmate:filePanelStateChange';

interface FilePanelStateEventDetail {
  collapsed: boolean;
}

function emitChange(detail: FilePanelStateEventDetail): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(
      new CustomEvent<FilePanelStateEventDetail>(FILE_PANEL_STATE_EVENT, {
        detail,
      })
    );
  } catch {
    /* CustomEvent may be unavailable in very old environments */
  }
}

export function useFilePanelState(): UseFilePanelStateReturn {
  const [collapsed, setCollapsedState] = useState<boolean>(
    DEFAULT_FILE_PANEL_COLLAPSED
  );

  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;

  // Hydrate once on mount.
  useEffect(() => {
    setCollapsedState(readStoredCollapsed());
  }, []);

  // Sync state across hook instances on the same page.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onChange = (event: Event): void => {
      const ce = event as CustomEvent<FilePanelStateEventDetail>;
      if (!ce.detail) return;
      if (ce.detail.collapsed !== collapsedRef.current) {
        setCollapsedState(ce.detail.collapsed);
      }
    };
    window.addEventListener(FILE_PANEL_STATE_EVENT, onChange);
    return () => window.removeEventListener(FILE_PANEL_STATE_EVENT, onChange);
  }, []);

  const setCollapsed = useCallback((next: boolean): void => {
    setCollapsedState(next);
    writeStoredCollapsed(next);
    emitChange({ collapsed: next });
  }, []);

  const toggle = useCallback((): void => {
    setCollapsed(!collapsedRef.current);
  }, [setCollapsed]);

  return { collapsed, toggle, setCollapsed };
}

export default useFilePanelState;
