/**
 * usePendingInsertText hook (Issue #755, resolves TODO:D1-001)
 *
 * Owns the "pending insert text" state that History / Memo panes use to push
 * text into a MessageInput. Extracted from `WorktreeDetailRefactored.tsx`
 * (previously inline state + handlers around L378-410) to shrink the parent
 * component without changing behavior.
 *
 * Issue #728: the insert target is tracked per-split (Map<splitIndex, text>)
 * for PC. Mobile keeps using splitIndex=0 since it has a single MessageInput.
 *
 * Ownership boundary (S3-003): this hook owns BOTH the `pendingInsertTextMap`
 * and `focusedSplitIndex` / `setFocusedSplitIndex`. `handleInsertToMessage`
 * closes over `focusedSplitIndex` internally so callers do not need to thread
 * the focused index through their own `useCallback` dependency arrays
 * (S1-004 — preserves the parent's stable closure-dependency structure).
 */

'use client';

import { useCallback, useState } from 'react';

/** Public API returned by {@link usePendingInsertText}. */
export interface UsePendingInsertTextReturn {
  /**
   * Per-split pending insert text. `null` (or a missing key) means no pending
   * text for that split. Consumers read `map.get(splitIndex) ?? null`.
   */
  pendingInsertTextMap: Map<number, string | null>;
  /**
   * Mobile-compat helper: the single pending insert text for splitIndex=0.
   * Equivalent to `pendingInsertTextMap.get(0) ?? null`.
   */
  pendingInsertText: string | null;
  /** The split index that most recently received focus (PC). Mobile keeps 0. */
  focusedSplitIndex: number;
  /** Update the focused split index (wired to `onFocusedSplitChange` on PC). */
  setFocusedSplitIndex: (idx: number) => void;
  /**
   * Insert `text` into whichever split currently has focus
   * (`focusedSplitIndex`). Used by History / Memo panes that do not know a
   * concrete split index. Mobile uses splitIndex=0.
   */
  handleInsertToMessage: (text: string) => void;
  /**
   * Insert `text` into an explicit `splitIndex` (S3-005). Each PC split's
   * embedded HistoryPane targets its OWN MessageInput, not `focusedSplitIndex`.
   */
  handleInsertToSplit: (splitIndex: number, text: string) => void;
  /** Clear the pending insert text for `idx` once a MessageInput consumes it. */
  handleInsertConsumed: (idx: number) => void;
  /** Mobile-compat helper: clear the pending insert text for splitIndex=0. */
  handleInsertConsumedSingle: () => void;
}

/**
 * State management for inserting text from history/memo into a message input.
 *
 * @returns Stable-reference handlers plus the per-split pending insert state.
 */
export function usePendingInsertText(): UsePendingInsertTextReturn {
  // Issue #728: tracked per-split (Map<splitIndex, string | null>) for PC.
  // Mobile path still routes through splitIndex=0 since it has one MessageInput.
  const [pendingInsertTextMap, setPendingInsertTextMap] = useState<Map<number, string | null>>(
    () => new Map(),
  );
  // Issue #728: focusedSplitIndex follows whichever MessageInput was last
  // focused on PC. HistoryPane / MemoPane insertions target this split. Mobile
  // keeps using 0.
  const [focusedSplitIndex, setFocusedSplitIndex] = useState(0);

  const handleInsertToMessage = useCallback((text: string) => {
    setPendingInsertTextMap(prev => {
      const next = new Map(prev);
      next.set(focusedSplitIndex, text);
      return next;
    });
  }, [focusedSplitIndex]);

  // Issue #744 / S3-005: insert routed by an explicit splitIndex (each split's
  // embedded HistoryPane targets its own MessageInput, not focusedSplitIndex).
  const handleInsertToSplit = useCallback((splitIndex: number, text: string) => {
    setPendingInsertTextMap(prev => {
      const next = new Map(prev);
      next.set(splitIndex, text);
      return next;
    });
  }, []);

  const handleInsertConsumed = useCallback((idx: number) => {
    setPendingInsertTextMap(prev => {
      if (!prev.has(idx)) return prev;
      const next = new Map(prev);
      next.delete(idx);
      return next;
    });
  }, []);

  // Mobile-compat helper: returns the single pending insert text from splitIndex=0.
  const pendingInsertText = pendingInsertTextMap.get(0) ?? null;
  const handleInsertConsumedSingle = useCallback(
    () => handleInsertConsumed(0),
    [handleInsertConsumed],
  );

  return {
    pendingInsertTextMap,
    pendingInsertText,
    focusedSplitIndex,
    setFocusedSplitIndex,
    handleInsertToMessage,
    handleInsertToSplit,
    handleInsertConsumed,
    handleInsertConsumedSingle,
  };
}
