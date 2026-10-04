'use client';

/**
 * useSessionStartingGate — what a pane shows while its agent is launching
 * (Issue #3179).
 *
 * The server publishes `startingSince` from `beginAgentSession` until the
 * launch returns, throws, outruns the tool's readiness wait or meets a dialog
 * it does not answer. While it is set every surface shows "<agent> を起動中…"
 * in place of the pane and keeps the Navigate pad, the answer sheet, the stop
 * button and the mode control down.
 *
 * The notice carries a "ターミナルを見る" link, and that choice is shared by
 * every surface showing the same instance: the chat surface's link switches the
 * screen to the terminal surface, and the terminal surface must then show the
 * pane rather than the notice again. So it lives in a module store keyed by the
 * instance AND the launch's start time — a later launch of the same instance is
 * a new launch and shows the notice afresh.
 *
 * @module hooks/useSessionStartingGate
 */

import { useCallback, useSyncExternalStore } from 'react';

/** `${scopeKey}@${startingSince}` for every launch the user chose to look at. */
const revealedLaunches = new Set<string>();
const listeners = new Set<() => void>();
/** A launch lasts seconds; this only keeps a long-lived tab from accumulating keys. */
const MAX_REVEALED_LAUNCHES = 64;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function launchKey(scopeKey: string, startingSince: number): string {
  return `${scopeKey}@${startingSince}`;
}

/**
 * Show the pane, rather than the starting notice, for this launch.
 *
 * @param scopeKey - The instance, as `useSessionStartingGate` was given it
 * @param startingSince - The launch's start time
 */
export function revealStartingTerminal(scopeKey: string, startingSince: number): void {
  const key = launchKey(scopeKey, startingSince);
  if (revealedLaunches.has(key)) return;
  if (revealedLaunches.size >= MAX_REVEALED_LAUNCHES) {
    const oldest = revealedLaunches.values().next().value;
    if (oldest !== undefined) revealedLaunches.delete(oldest);
  }
  revealedLaunches.add(key);
  for (const listener of listeners) listener();
}

/** Forget every reveal. For tests. */
export function resetRevealedStartingTerminals(): void {
  revealedLaunches.clear();
  for (const listener of listeners) listener();
}

/**
 * Build the scope key for one agent instance on one worktree.
 *
 * @param worktreeId - Worktree ID
 * @param instanceId - Instance ID (the tool id for the primary instance)
 */
export function sessionStartingScopeKey(worktreeId: string, instanceId: string): string {
  return `${worktreeId}:${instanceId}`;
}

export interface SessionStartingGate {
  /** The launch's start time, or null (an absent value normalised to null). */
  startingSince: number | null;
  /** A launch is in progress: the pads, the sheet, stop and mode stay down. */
  starting: boolean;
  /** Show the starting notice in place of the pane (not revealed by the user). */
  noticeVisible: boolean;
  /** The notice's "ターミナルを見る" link. */
  revealTerminal: () => void;
}

/**
 * @param scopeKey - {@link sessionStartingScopeKey} of the pane's instance
 * @param rawStartingSince - The pane's `startingSince`; anything but a number
 *   (null, or undefined from a caller or server that predates the field) is
 *   "not starting"
 */
export function useSessionStartingGate(
  scopeKey: string,
  rawStartingSince: number | null | undefined,
): SessionStartingGate {
  const startingSince = typeof rawStartingSince === 'number' ? rawStartingSince : null;
  const revealed = useSyncExternalStore(
    subscribe,
    () => startingSince !== null && revealedLaunches.has(launchKey(scopeKey, startingSince)),
    () => false,
  );
  const revealTerminal = useCallback(() => {
    if (startingSince !== null) revealStartingTerminal(scopeKey, startingSince);
  }, [scopeKey, startingSince]);
  const starting = startingSince !== null;
  return { startingSince, starting, noticeVisible: starting && !revealed, revealTerminal };
}
