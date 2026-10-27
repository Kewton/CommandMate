'use client';

/**
 * The parent-side home of the unsent bar's Clear result (Issue #3954). Kept apart
 * from UnsentComposerBar so a parent can use it without the bar's module.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClearComposerNotice } from '@/components/worktree/UnsentComposerBar';

/** The destination a Clear (and its result) belongs to. */
export function clearTargetKey(worktreeId: string, cliToolId: string, instanceId?: string): string {
  return JSON.stringify([worktreeId, cliToolId, instanceId ?? cliToolId]);
}

/**
 * The parent's home for the Clear result (Issue #3954): bound to one destination,
 * dropped when the destination changes, and a late answer for another destination
 * is ignored. A plain re-fetch of the pane does not clear it.
 */
export function useClearNotice(targetKey: string) {
  const [state, setState] = useState<{ key: string; notice: ClearComposerNotice } | null>(null);
  const keyRef = useRef(targetKey);
  keyRef.current = targetKey;
  // Advanced by Run, a dismissal and every new Clear: an answer to an older
  // Clear is not adopted, even from the same destination.
  const generationRef = useRef(0);
  useEffect(() => {
    generationRef.current += 1;
    setState(null);
  }, [targetKey]);
  /**
   * `null` removes the notice and starts a new generation (returned, for the
   * caller's next result); a notice is adopted only for the current destination
   * and, when `generation` is given, the current generation.
   */
  const setNotice = useCallback(
    (notice: ClearComposerNotice | null, key: string, generation?: number): number => {
      if (notice === null) {
        generationRef.current += 1;
        if (key === keyRef.current) setState(null);
        return generationRef.current;
      }
      if (key === keyRef.current && (generation === undefined || generation === generationRef.current)) {
        setState({ key, notice });
      }
      return generationRef.current;
    },
    [],
  );
  const notice = state && state.key === targetKey ? state.notice : null;
  const dismiss = useCallback(() => {
    generationRef.current += 1;
    setState(null);
  }, []);
  return { notice, setNotice, dismiss };
}
