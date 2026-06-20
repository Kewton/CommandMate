/**
 * useDiffViewerState hook (Issue #923)
 *
 * Owns the PC right-pane diff viewer state extracted from
 * `useWorktreeDetailController` as a pure structural refactor (no behavior
 * change). One of the Phase 1 "low-risk, no cross-concern coupling" sub-hooks:
 * the diff content/path is set by `handleDiffSelect` (from GitPane, PC only)
 * and cleared by `handleCloseDiff`, with no other coupling to the controller's
 * terminal/auto-yes concerns (Issue #447).
 *
 * `handleDiffSelect` no-ops on mobile (the diff is rendered inline within
 * GitPane there), so `isMobile` is passed in to preserve that exact behavior.
 */

'use client';

import { useCallback, useState } from 'react';

/** Public API returned by {@link useDiffViewerState}. */
export interface UseDiffViewerStateReturn {
  /** Diff text shown in the PC right pane, or null when no diff is open. */
  diffContent: string | null;
  /** Path of the file whose diff is shown, or null when no diff is open. */
  diffFilePath: string | null;
  /**
   * Show a diff in the PC right pane (Issue #447). No-op on mobile, where the
   * diff is rendered inline within GitPane instead.
   */
  handleDiffSelect: (diff: string, filePath: string) => void;
  /** Close the diff view in the PC right pane. */
  handleCloseDiff: () => void;
}

/**
 * State management for the PC right-pane diff viewer.
 *
 * @param isMobile - When true, {@link handleDiffSelect} is a no-op (mobile
 *   renders the diff inline within GitPane).
 * @returns The diff content/path plus open/close handlers.
 */
export function useDiffViewerState(isMobile: boolean): UseDiffViewerStateReturn {
  // [Issue #447] Diff content for right pane display (PC only)
  const [diffContent, setDiffContent] = useState<string | null>(null);
  const [diffFilePath, setDiffFilePath] = useState<string | null>(null);

  /** Handle diff selection from GitPane (Issue #447) */
  const handleDiffSelect = useCallback((diff: string, filePath: string) => {
    if (!isMobile) {
      // PC: show diff in right pane file panel area
      setDiffContent(diff);
      setDiffFilePath(filePath);
    }
    // Mobile: diff is shown inline within GitPane
  }, [isMobile]);

  /** Close diff view in right pane (Issue #447) */
  const handleCloseDiff = useCallback(() => {
    setDiffContent(null);
    setDiffFilePath(null);
  }, []);

  return {
    diffContent,
    diffFilePath,
    handleDiffSelect,
    handleCloseDiff,
  };
}
