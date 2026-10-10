/**
 * useNewTaskScreenTarget (Issue #3511)
 *
 * The worktree screen reports the worktree and the agent it has selected, so
 * New task opened there starts on them. Cleared when the screen unmounts: on a
 * list screen the dialog starts on the last destination sent to instead.
 */

'use client';

import { useEffect } from 'react';
import { useSetNewTaskScreenTarget } from '@/contexts/NewTaskContext';

export function useNewTaskScreenTarget(
  worktreeId: string,
  instanceId: string | null | undefined,
): void {
  const setScreenTarget = useSetNewTaskScreenTarget();

  useEffect(() => {
    setScreenTarget(instanceId ? { worktreeId, instanceId } : null);
  }, [setScreenTarget, worktreeId, instanceId]);

  useEffect(() => () => setScreenTarget(null), [setScreenTarget]);
}
