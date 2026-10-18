/**
 * "A tmux session of this name was just created" (Issue #3796).
 *
 * The Auto-Yes poller that found no session waits `MAX_BACKOFF_MS` for its next
 * tick, and the push gate holds a prompt wait until that tick (#3791), so a
 * session created right after the poller looked was answered — or its human
 * notified — up to about 64 s late. {@link createSession} reports every session
 * it creates here, and a waiting poller listens for its own session's name and
 * ticks early.
 *
 * Synchronous and dependency-free on purpose: `tmux.ts` is the lowest layer and
 * must not import the poller (it would be a cycle). A listener that throws is
 * isolated from the others and from the session creation that fired it.
 *
 * @module lib/tmux/session-created-signal
 */

import { getOrInitGlobal } from '../global-state';

type SessionCreatedListener = () => void;

declare global {
  // eslint-disable-next-line no-var
  var __tmuxSessionCreatedListeners: Map<string, Set<SessionCreatedListener>> | undefined;
}

/**
 * sessionName -> listeners. globalThis for the reason every shared in-memory
 * state is (#1736): the creator (a route bundle) and the poller (the server's)
 * can hold separate copies of this module.
 */
const listeners = getOrInitGlobal(
  '__tmuxSessionCreatedListeners',
  () => new Map<string, Set<SessionCreatedListener>>(),
);

/**
 * Call `listener` the next time a session named `sessionName` is created.
 *
 * @returns Unsubscribe; calling it more than once does nothing
 */
export function onTmuxSessionCreated(sessionName: string, listener: SessionCreatedListener): () => void {
  let set = listeners.get(sessionName);
  if (set === undefined) {
    set = new Set();
    listeners.set(sessionName, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(sessionName);
    if (current === undefined) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(sessionName);
  };
}

/** Tell the listeners of `sessionName` that it was created. Each one is called once and dropped. */
export function notifyTmuxSessionCreated(sessionName: string): void {
  const set = listeners.get(sessionName);
  if (set === undefined) return;
  listeners.delete(sessionName);
  for (const listener of set) {
    try {
      listener();
    } catch {
      // A listener's failure must not fail the session creation that fired it.
    }
  }
}

/** Number of sessions someone is waiting for. Test seam. */
export function countTmuxSessionCreatedListeners(): number {
  let n = 0;
  for (const set of listeners.values()) n += set.size;
  return n;
}

/** Drop every listener. Test seam. */
export function clearTmuxSessionCreatedListeners(): void {
  listeners.clear();
}
