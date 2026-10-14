/**
 * The ownership token of one response poller chain, and the question "may the
 * code running now still act for this poller key?" (Issue #2223, #3663).
 *
 * In a module of its own, importing nothing from the poller, so that
 * `./pending-scraped-response` can ask the question without importing
 * `./response-poller-core` — which imports the checker that imports the held
 * scrape, and would close a new import cycle (#3482).
 */

import { AsyncLocalStorage } from 'async_hooks';
import { getOrInitGlobal } from '../global-state';

/**
 * Ownership token for one poller chain — one "generation" of a poller key.
 *
 * The chain's `setTimeout` callback holds this object directly, so it can ask
 * *"am I still the poller for this key?"* rather than *"is there a poller for
 * this key?"* — the question the pre-#2223 `activePollers.has(pollerKey)` guard
 * asked, and the reason a superseded tick could re-register itself over the
 * poller that replaced it.
 *
 * The two flags are deliberately distinct:
 *
 * - `superseded` — a newer chain took the key (restart or worktree-ID
 *   migration). The old tick must neither reschedule **nor** broadcast: its
 *   snapshot is of the turn that just ended and would arrive after the new
 *   chain's frames.
 * - `stopped` — this chain itself ended (`stopPolling`, max duration, session
 *   gone, a migration that moved or abandoned it). The tick must not
 *   reschedule, but its final snapshot is still the most recent screen and is
 *   still pushed, exactly as before #2223. A stopped tick also no longer owns
 *   anything held under its key (Issue #3663, {@link mayActForPollerKey}).
 */
export interface PollerOwner {
  readonly pollerKey: string;
  readonly generation: number;
  superseded: boolean;
  stopped: boolean;
  /**
   * This chain ended itself from inside its own tick — `checkForResponse()`
   * raised `stopPolling()` while it still owned the key (Issue #2230). The
   * tick's verdict decides what the stop means, so the response hash is not
   * touched until that verdict is in.
   */
  selfStopped: boolean;
  /**
   * The chain a worktree-ID migration handed this chain's turn to (Issue
   * #3663). Set only by the migration, on the owner it retires; read only to
   * find where the turn's dedup state went ({@link successorPollerKey}).
   */
  movedTo?: PollerOwner;
}

declare global {
  // eslint-disable-next-line no-var
  var __responsePollerOwnerStorage: AsyncLocalStorage<PollerOwner> | undefined;
}

/**
 * Carries the running tick's ownership token through `checkForResponse()`.
 *
 * On `globalThis` for the reason the coordinator is (#2223): the poller module
 * is evaluated once per bundle, and a token stored by one bundle's tick has to
 * be readable by the code another bundle's copy of the checker runs.
 */
export const pollerOwnerStorage = getOrInitGlobal(
  '__responsePollerOwnerStorage',
  () => new AsyncLocalStorage<PollerOwner>()
);

/** The ownership token of the tick the caller is running inside, if any. */
export function currentPollerOwner(): PollerOwner | undefined {
  return pollerOwnerStorage.getStore();
}

/**
 * Whether the code running now may change what is kept under `pollerKey`
 * (Issue #3663).
 *
 * Code outside any tick — a route, `session-cleanup`, the migration itself —
 * may. A tick may only for its own key, and only while its chain has not been
 * stopped. A chain that is merely `superseded` (a restart queued behind the
 * tick it is running) still owns the turn it is finishing: its hold is what the
 * restart's stop writes out (#2436), so it is not turned away here.
 */
export function mayActForPollerKey(pollerKey: string): boolean {
  const caller = currentPollerOwner();
  return caller === undefined || (caller.pollerKey === pollerKey && !caller.stopped);
}

/**
 * The key of the chain that now carries `owner`'s turn after one or more
 * worktree-ID migrations, or null when no migration moved it (Issue #3663).
 */
export function successorPollerKey(owner: PollerOwner): string | null {
  let successor = owner.movedTo;
  if (!successor) return null;
  while (successor.movedTo) successor = successor.movedTo;
  return successor.pollerKey;
}
