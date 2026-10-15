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
}

declare global {
  // eslint-disable-next-line no-var
  var __responsePollerOwnerStorage: AsyncLocalStorage<PollerOwner> | undefined;
  // eslint-disable-next-line no-var
  var __responsePollerSnapshotStorage: AsyncLocalStorage<PollerOwner> | undefined;
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
 * (Issue #3663), or save a reply under it at once (Issue #3684).
 *
 * What is turned away is exactly one thing: a tick whose chain has been
 * stopped, acting on its OWN key. Code outside any tick — a route,
 * `session-cleanup`, the migration itself — may. So may code acting on another
 * key from inside a tick: the relay a worker's tick fires on completion
 * delivers to the requester and restarts the requester's poller in the
 * worker's async context, and that restart's stop must write the requester's
 * held reply (the same line `stopPollingByKey`'s stale-stop check draws). A
 * chain that is merely `superseded` (a restart queued behind the
 * tick it is running) still owns the turn it is finishing: its hold is what the
 * restart's stop writes out (#2436), so it is not turned away here.
 */
export function mayActForPollerKey(pollerKey: string): boolean {
  const caller = currentPollerOwner();
  return caller === undefined || caller.pollerKey !== pollerKey || !caller.stopped;
}

/**
 * The poller key of an agent instance (Issue #3705) — the same spelling as
 * `getPollerKey` in `./response-poller-core`, which delegates here, so that the
 * transcript readers, the user-turn recorder, the cursor advance and the
 * Markdown log can name the key they write under without importing the core.
 */
export function pollerKeyOf(worktreeId: string, cliToolId: string, instanceId?: string): string {
  return `${worktreeId}:${instanceId ?? cliToolId}`;
}

/**
 * {@link mayActForPollerKey} for an agent instance (Issue #3705).
 *
 * Asked by the writers a tick reaches through an `await` of its own — the four
 * transcript readers, `recordUserTurn`, `advanceCapturedLineForTranscriptTurn` —
 * after their last `await` and before their first write. The Stop hook, a
 * route and every other caller outside a tick are not turned away, and neither
 * is a tick acting for another instance.
 */
export function mayActForAgentInstance(target: {
  worktreeId: string;
  cliToolId: string;
  instanceId?: string;
}): boolean {
  return mayActForPollerKey(pollerKeyOf(target.worktreeId, target.cliToolId, target.instanceId));
}

/**
 * Carries the ownership token of the tick whose terminal snapshot is being
 * built (Issue #3705).
 *
 * A storage of its own rather than {@link pollerOwnerStorage}: only the core
 * enters it, around `broadcastTerminalSnapshot`, so a snapshot started by a
 * route or by the Auto-Yes poller — or by code that merely inherited a tick's
 * context — is never asked about an owner it does not carry.
 */
export const snapshotOwnerStorage = getOrInitGlobal(
  '__responsePollerSnapshotStorage',
  () => new AsyncLocalStorage<PollerOwner>()
);

/**
 * Whether the snapshot being built now may still write and publish
 * (Issue #3705).
 *
 * Asked after every `await` of the snapshot — in `broadcastTerminalSnapshot`,
 * `buildCurrentOutput` and the chat-turn progress it detaches — not only when
 * the tick decides to start one: a successor that takes the key while the
 * capture is in flight would otherwise have its screen, its status latch and
 * its progress frames overwritten by the turn that just ended. A chain that was
 * merely stopped and has no successor still publishes its final snapshot, as
 * before #2223. Outside a snapshot the core started, always true.
 */
export function maySnapshotPublish(): boolean {
  const owner = snapshotOwnerStorage.getStore();
  return owner === undefined || !owner.superseded;
}

/**
 * Thrown by `buildCurrentOutput` when {@link maySnapshotPublish} turns it away
 * mid-build (Issue #3705), so that nothing after the `await` it resumed from —
 * the status latch, the unclassified-frame row, the structured prompt row, the
 * progress frame — is written. `broadcastTerminalSnapshot` catches it.
 */
export class RetiredSnapshotError extends Error {
  constructor() {
    super('terminal snapshot of a superseded poller tick');
    this.name = 'RetiredSnapshotError';
  }
}
