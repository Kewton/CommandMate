/**
 * useVisiblePolling Hook (Issue #4174)
 *
 * A poll that rests while the tab is hidden and reads once on coming back, the
 * behaviour #4160 gave `useGenerationStatus` and `AgentInstancesPane`: the timer
 * keeps running, a tick that lands while `document.visibilityState === 'hidden'`
 * asks nothing, and `visibilitychange` to `visible` reads at once.
 *
 * Every read is numbered. The read receives `claim()`, which it calls once its
 * answer (success or failure) is in hand and before touching state; `claim()`
 * returns `false` when that answer must not be taken:
 * - a later-numbered read has already been taken (a read held up while hidden
 *   that answers after the one made on coming back);
 * - the poll was torn down since the read was asked — unmount, or `read`
 *   changed identity (e.g. a different `appId`).
 *
 * `useFilePolling` stops the timer instead; this hook keeps #4160's shape so the
 * cadence after coming back stays the same as before going hidden.
 *
 * @returns `refresh()` — a read outside the timer (after a save or delete) that
 *          goes through the same numbering, so it cannot be overwritten by an
 *          older tick answering late. Called while hidden it asks nothing: the
 *          read made on coming back is the one that picks the change up.
 */

'use client';

import { useCallback, useEffect, useRef } from 'react';

/** Returns true when the answer in hand may be taken (and marks it taken). */
export type VisiblePollingClaim = () => boolean;

export function useVisiblePolling(
  read: (claim: VisiblePollingClaim) => Promise<void>,
  intervalMs: number,
): () => void {
  const readRef = useRef(read);
  readRef.current = read;
  /** Bumped on every teardown; a claim asked under an older epoch is refused. */
  const epochRef = useRef(0);
  const requestSeqRef = useRef(0);
  const adoptedSeqRef = useRef(0);

  const run = useCallback((): void => {
    const epoch = epochRef.current;
    const requestSeq = ++requestSeqRef.current;
    const claim: VisiblePollingClaim = () => {
      if (epoch !== epochRef.current) return false;
      if (requestSeq <= adoptedSeqRef.current) return false;
      adoptedSeqRef.current = requestSeq;
      return true;
    };
    void readRef.current(claim);
  }, []);

  const runUnlessHidden = useCallback((): void => {
    if (document.visibilityState !== 'hidden') run();
  }, [run]);

  useEffect(() => {
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') run();
    };
    runUnlessHidden();
    const timer = setInterval(runUnlessHidden, intervalMs);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      epochRef.current += 1;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
    // `read` is a dependency so a new target (another appId) restarts the poll
    // and refuses what the old target's reads answer.
  }, [read, intervalMs, run, runUnlessHidden]);

  return runUnlessHidden;
}
