/**
 * useNewOutputIndicator (Issue #1120).
 *
 * Push-driven "new terminal output" signal for the mobile terminal tab badge.
 * Sets a flag when a `terminal_snapshot` or `message` push arrives for the
 * worktree while the terminal tab is NOT active, and clears it when the terminal
 * tab becomes active. Replaces the dead-coded polling badge with a push signal.
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import { useRealtime } from '@/hooks/useRealtimeConnection';
import type { RealtimeEvent } from '@/lib/realtime/types';

export interface UseNewOutputIndicatorOptions {
  worktreeId: string;
  /** True when the terminal view is currently active (badge suppressed/cleared). */
  active: boolean;
}

export function useNewOutputIndicator({ worktreeId, active }: UseNewOutputIndicatorOptions): boolean {
  const { addListener } = useRealtime();
  const [hasNewOutput, setHasNewOutput] = useState(false);
  const activeRef = useRef(active);
  activeRef.current = active;

  // Clear the badge whenever the terminal view is (re)opened.
  useEffect(() => {
    if (active) setHasNewOutput(false);
  }, [active]);

  useEffect(() => {
    return addListener((event: RealtimeEvent) => {
      const eventWorktreeId = (event as { worktreeId?: string }).worktreeId;
      if (eventWorktreeId !== worktreeId) return;
      if (event.type !== 'terminal_snapshot' && event.type !== 'message') return;
      // Viewing the terminal already → nothing new to flag.
      if (activeRef.current) return;
      setHasNewOutput(true);
    });
  }, [addListener, worktreeId]);

  return active ? false : hasNewOutput;
}
