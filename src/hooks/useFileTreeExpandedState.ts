/**
 * useFileTreeExpandedState Hook (Issue #1108)
 *
 * Persists the FileTreeView directory-expansion set (`Set<string>`) per worktree
 * in localStorage so expanded folders survive activity switches, panel
 * open/close, page reloads and worktree round-trips. Mirrors the per-worktree
 * localStorage pattern of `useFileTabs` / `useActivityBarState`.
 *
 * Persistence:
 *   - `commandmate:file-tree-expanded:<worktreeId>` — JSON array of paths.
 *
 * Design notes:
 *   - The set is restored via a *lazy* useState initializer (not an effect) so
 *     it is available synchronously on the first render. FileTreeView's mount
 *     reload reads the expanded set through a ref and must see the persisted
 *     dirs in order to re-fetch their children (Issue #1108 S3-001). This is
 *     safe from a hydration standpoint because FileTreeView renders a loading
 *     placeholder until `rootItems` are fetched client-side, so the expanded
 *     set never affects the SSR/first-paint DOM.
 *   - `setExpanded` is a raw `Dispatch<SetStateAction<Set<string>>>` so the
 *     existing functional-update call sites (stale removal, handleToggle,
 *     content-search auto-expand) keep working unchanged.
 *   - An empty set removes the key rather than storing `"[]"`, keeping storage
 *     clean and satisfying the reset contract (the key is deleted, not just
 *     emptied).
 *   - Persisting keys off the worktree that `expanded` was hydrated for
 *     (tracked in `lastWorktreeIdRef`) so a worktree switch never leaks one
 *     branch's expansion into another's key.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export const FILE_TREE_EXPANDED_STORAGE_KEY_PREFIX =
  'commandmate:file-tree-expanded:';

export function getFileTreeExpandedStorageKey(worktreeId: string): string {
  return FILE_TREE_EXPANDED_STORAGE_KEY_PREFIX + worktreeId;
}

export interface UseFileTreeExpandedStateReturn {
  /** Currently expanded directory paths. */
  expanded: Set<string>;
  /** Raw state setter (value or updater), persisted via effect. */
  setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>;
  /** Collapse everything and delete the persisted key. */
  resetExpanded: () => void;
}

function readStoredExpanded(worktreeId: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(
      getFileTreeExpandedStorageKey(worktreeId),
    );
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((p) => typeof p === 'string')) {
      return new Set(parsed as string[]);
    }
  } catch {
    /* malformed / unavailable */
  }
  return new Set();
}

function writeStoredExpanded(worktreeId: string, expanded: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    const key = getFileTreeExpandedStorageKey(worktreeId);
    if (expanded.size === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify(Array.from(expanded)));
  } catch {
    /* quota exceeded / unavailable */
  }
}

/**
 * Manage the FileTreeView expansion set with per-worktree localStorage
 * persistence.
 *
 * @param worktreeId - worktree whose expansion set to persist/restore.
 */
export function useFileTreeExpandedState(
  worktreeId: string,
): UseFileTreeExpandedStateReturn {
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    readStoredExpanded(worktreeId),
  );

  // Tracks the worktree that the current `expanded` value belongs to. Updated
  // synchronously on a worktree switch (before the re-render that carries the
  // rehydrated set) so the persist effect never writes to the wrong key.
  const lastWorktreeIdRef = useRef(worktreeId);

  // Re-hydrate when the worktree changes in place (without a remount).
  useEffect(() => {
    if (lastWorktreeIdRef.current === worktreeId) return;
    lastWorktreeIdRef.current = worktreeId;
    setExpanded(readStoredExpanded(worktreeId));
  }, [worktreeId]);

  // Persist whenever the set changes. Keyed on `expanded` only: on a worktree
  // switch the set reference is unchanged in that render (the rehydrate setter
  // schedules a later render), so this does not fire until `expanded` actually
  // reflects the new worktree — and it always writes under lastWorktreeIdRef.
  useEffect(() => {
    writeStoredExpanded(lastWorktreeIdRef.current, expanded);
  }, [expanded]);

  const resetExpanded = useCallback(() => {
    setExpanded(new Set());
  }, []);

  return { expanded, setExpanded, resetExpanded };
}

export default useFileTreeExpandedState;
