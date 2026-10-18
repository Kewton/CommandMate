/**
 * The lifecycle status a sidebar branch row shows and sets from its "…"
 * (Issue #3594).
 *
 * Issue #3604: moved out of BranchListItem as is.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { useTranslations } from 'next-intl';
import { useToast } from '@/components/common/Toast';
import { useOptionalWorktreesCacheContext } from '@/components/providers/WorktreesCacheProvider';
import {
  currentWorktreeStatusGeneration,
  saveWorktreeStatus,
  worktreeListFetchedSince,
  type WorktreeLifecycleStatus,
} from '@/lib/worktree-status';

export interface WorktreeLifecycleStatusState {
  /** What the row shows: the pending pick, else the list value. */
  worktreeStatus: WorktreeLifecycleStatus | null;
  /** Saves a pick from the row's "…". */
  handleWorktreeStatusChange: (next: WorktreeLifecycleStatus | null) => Promise<void>;
}

export function useWorktreeLifecycleStatus(
  branchId: string,
  listStatus: WorktreeLifecycleStatus | null | undefined,
  t: ReturnType<typeof useTranslations<'common'>>
): WorktreeLifecycleStatusState {
  // ---- Issue #3594: lifecycle status from the row's "…" ----
  // The pick shows at once (`pendingStatus`); a failed save puts the old value
  // back and says so. A successful one keeps showing the pick until the list
  // re-fetch brings it back as `branch.worktreeStatus`, so the badge never
  // flickers to the old value in between. With picks in a row, the LAST pick
  // holds until its own save and re-fetch are done: an earlier pick's re-fetch
  // landing meanwhile (Ready while Done is still saving) does not replace it,
  // and a re-fetch that FAILED keeps it too: it is released only once a list
  // fetch that started after its save has succeeded.
  const { showToast } = useToast();
  const refreshList = useOptionalWorktreesCacheContext()?.refresh;
  const [pendingStatus, setPendingStatus] = useState<WorktreeLifecycleStatus | null | undefined>(undefined);
  const statusRequestRef = useRef(0);
  /** The latest request whose save (and re-fetch) has finished. */
  const settledRequestRef = useRef(0);
  /** The list value when the latest pick was made, and the list value now. */
  const savedAtPickRef = useRef<WorktreeLifecycleStatus | null>(null);
  const savedStatusRef = useRef<WorktreeLifecycleStatus | null>(null);
  /**
   * Set when the last pick was saved: the clock position its save left. The
   * pick is held until a list fetch started at or after it has succeeded.
   */
  const holdUntilRef = useRef<number | null>(null);
  const savedStatus = listStatus ?? null;
  const worktreeStatus = pendingStatus !== undefined ? pendingStatus : savedStatus;
  savedStatusRef.current = savedStatus;

  // A new value from the list (ours, or one set elsewhere) replaces the pick —
  // unless a pick is still being saved, which then owns the row, or a saved
  // pick still waits for a successful re-fetch that carries it.
  useEffect(() => {
    if (statusRequestRef.current !== settledRequestRef.current) return;
    const holdUntil = holdUntilRef.current;
    if (holdUntil !== null && !worktreeListFetchedSince(holdUntil)) return;
    holdUntilRef.current = null;
    setPendingStatus(undefined);
  }, [savedStatus]);

  const handleWorktreeStatusChange = useCallback(
    async (next: WorktreeLifecycleStatus | null) => {
      const request = ++statusRequestRef.current;
      savedAtPickRef.current = savedStatusRef.current;
      holdUntilRef.current = null;
      setPendingStatus(next);
      try {
        // Queued per worktree, so the last pick is the last PATCH.
        await saveWorktreeStatus(branchId, next);
      } catch {
        // A later pick owns the row now; its own outcome decides what shows.
        if (request !== statusRequestRef.current) return;
        settledRequestRef.current = request;
        setPendingStatus(undefined);
        showToast(t('branchItem.statusChangeFailed'), 'error');
        return;
      }
      const savedAt = currentWorktreeStatusGeneration();
      try {
        await refreshList?.();
      } finally {
        if (request === statusRequestRef.current) {
          settledRequestRef.current = request;
          if (refreshList) {
            // `refresh` resolves even when the fetch fails, so ask the list
            // whether a fetch from after this save went through.
            holdUntilRef.current = savedAt;
            if (worktreeListFetchedSince(savedAt) && savedStatusRef.current !== savedAtPickRef.current) {
              // Fetched and already on screen (the list applies saves over
              // replies sent before them). If the new list has not rendered
              // yet, the effect above releases the pick when it does.
              holdUntilRef.current = null;
              setPendingStatus(undefined);
            }
          } else if (savedStatusRef.current !== savedAtPickRef.current) {
            // No list to re-fetch: the pick shows until the row data moves.
            setPendingStatus(undefined);
          }
        }
      }
    },
    [branchId, refreshList, showToast, t]
  );
  // ---- end #3594 ----

  return { worktreeStatus, handleWorktreeStatusChange };
}
