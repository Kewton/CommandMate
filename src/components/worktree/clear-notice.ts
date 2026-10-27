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
  useEffect(() => {
    setState(null);
  }, [targetKey]);
  const setNotice = useCallback((notice: ClearComposerNotice | null, key: string) => {
    if (key !== keyRef.current) return;
    setState(notice ? { key, notice } : null);
  }, []);
  const notice = state && state.key === targetKey ? state.notice : null;
  const dismiss = useCallback(() => setState(null), []);
  return { notice, setNotice, dismiss };
}
