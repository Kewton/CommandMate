/**
 * Rule (4)(e) of the screen across the screens that write mem items (Issue #4227,
 * design `mem-ui-4227.md` §2.4.1; PM P3-3): while one of them has a write being sent or
 * a write whose result is unknown, the others write nothing either. The items panel
 * (G-1) and the hand-off's approval (G-4: approve / discard, which write items) share
 * this one lock. Writes that are not of items stay outside it (a notice's acknowledgement,
 * the mode's settings), and so do the hand-off's cancel and stop.
 *
 * One store per page (module state): each owner publishes its own state and reads the
 * strongest of the others'.
 *
 * @module components/mem/mem-write-lock
 */

import { useEffect, useSyncExternalStore } from 'react';

export type MemWriteLockState = 'sending' | 'unknown' | null;

const owners = new Map<string, Exclude<MemWriteLockState, null>>();
const listeners = new Set<() => void>();
let snapshot = 0;

function changed(): void {
  snapshot += 1;
  for (const listener of listeners) listener();
}

/** Set (or clear, with null) one owner's state. */
export function publishMemWriteLock(owner: string, state: MemWriteLockState): void {
  const before = owners.get(owner) ?? null;
  if (before === state) return;
  if (state === null) owners.delete(owner);
  else owners.set(owner, state);
  changed();
}

/** The others' state: `sending` over `unknown` over none. */
export function memWriteLockOfOthers(owner: string): MemWriteLockState {
  let found: MemWriteLockState = null;
  for (const [name, state] of owners) {
    if (name === owner) continue;
    if (state === 'sending') return 'sending';
    found = 'unknown';
  }
  return found;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Publishes `own` for `owner` while mounted (cleared when it unmounts) and answers the
 * others' state, re-rendering when it changes.
 */
export function useMemWriteLock(owner: string, own: MemWriteLockState): MemWriteLockState {
  useEffect(() => {
    publishMemWriteLock(owner, own);
  }, [owner, own]);
  useEffect(() => () => publishMemWriteLock(owner, null), [owner]);
  useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  return memWriteLockOfOthers(owner);
}
