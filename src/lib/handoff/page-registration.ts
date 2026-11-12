/**
 * The pages' registrations for the hand-off dialog (Issue #4317 PR1, design `mem-ui-4227.md`
 * §4.1.1; the pre-review `prereview-4317-reply.md` 1・2).
 *
 * A worktree page (its `useWorktreeDetailController`) registers while it is mounted. A
 * registration is an identity of its own, apart from the opening's token
 * (`HandoffOpeningToken`): every mount — React's StrictMode setup → cleanup → setup included —
 * makes a new one, and a page unregisters its own only.
 *
 * The invariants:
 * 1. {@link unregisterHandoffPage} removes the registration it names and nothing else: a late
 *    cleanup of the page left (B) never removes the page come to (A), and a registration once
 *    removed is never live again (no setup brings an old identity back).
 * 2. The current registration is the newest one still live. While none is live (a page left and
 *    the next not yet registered) or for one that is not the current one, the dialog starts
 *    nothing new — no close, stop or send — and is still drawn (`isCurrentHandoffRegistration`).
 *    What was already sent finishes for its own unit and destination: this module never cancels.
 * 3. The session's expiry outlives the pages: it is set by the current registration's 401 and
 *    cleared by the current registration's authenticated read only. A registration's start, its
 *    cleanup, a page's own initial `false`, its Retry and any answer of a registration that is not
 *    the current one leave it as it is. Within one registration the reads are taken in the order
 *    they left (`seq`), the 401 and the success alike: once a read's answer is taken, an older
 *    read's answer — 200 or 401 — moves nothing.
 * 4. (再指示 2) One condition starts anything new for a page's dialog: its registration is the
 *    current one and the session is not expired ({@link handoffPageMayStart}). A page's dialog is
 *    hidden for the expiry by {@link HandoffRegistryState.authExpired} only.
 *
 * This module holds no unit, opening nor callback of the store (`@/lib/handoff/close-rule`): it
 * imports nothing of it and writes nothing of it.
 *
 * @module lib/handoff/page-registration
 */

declare const REGISTRATION_BRAND: unique symbol;

/** The identity of one page's registration: made by {@link registerHandoffPage} only. */
export type HandoffPageRegistration = { readonly [REGISTRATION_BRAND]: true };

interface RegistrationEntry {
  readonly id: HandoffPageRegistration;
  readonly worktreeId: string;
}

export interface HandoffRegistryState {
  /** The live registrations, oldest first: the last is the current one. */
  readonly live: readonly RegistrationEntry[];
  /** The session expired (a 401 of the current page) and no authenticated read has answered since. */
  readonly authExpired: boolean;
}

const EMPTY: HandoffRegistryState = { live: [], authExpired: false };
let state: HandoffRegistryState = EMPTY;
const listeners = new Set<() => void>();
/**
 * 再指示 2: per registration, the `seq` of the newest read whose answer it reported (none: 0). Kept
 * beside the snapshot, so that a report that changes nothing draws nothing again.
 */
const authSeqOf = new WeakMap<HandoffPageRegistration, number>();

function commit(next: HandoffRegistryState): void {
  state = next;
  for (const listener of [...listeners]) listener();
}

/** For `useSyncExternalStore`. */
export function subscribeHandoffRegistry(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function handoffRegistrySnapshot(): HandoffRegistryState {
  return state;
}

/** A page of `worktreeId` mounted: a new registration, the current one from now on. */
export function registerHandoffPage(worktreeId: string): HandoffPageRegistration {
  const id = {} as HandoffPageRegistration;
  commit({ ...state, live: [...state.live, { id, worktreeId }] });
  return id;
}

/** The page's cleanup: its own registration goes; any other (a newer one) stays. */
export function unregisterHandoffPage(id: HandoffPageRegistration): void {
  if (!state.live.some((entry) => entry.id === id)) return;
  commit({ ...state, live: state.live.filter((entry) => entry.id !== id) });
}

/** `id` is live and the newest live one. `null` (a page not registered yet) is not. */
export function isCurrentHandoffRegistration(id: HandoffPageRegistration | null, snapshot: HandoffRegistryState = state): boolean {
  return id !== null && snapshot.live.length > 0 && snapshot.live[snapshot.live.length - 1].id === id;
}

/** The current registration is a page of `worktreeId` (none live: false). */
export function handoffPageCurrentFor(worktreeId: string, snapshot: HandoffRegistryState = state): boolean {
  const current = snapshot.live[snapshot.live.length - 1];
  return current !== undefined && current.worktreeId === worktreeId;
}

/**
 * 再指示 2: a page's dialog may start something new — `id` is the current registration and the
 * session is not expired (invariant 4). Read at the press and again after each await.
 */
export function handoffPageMayStart(id: HandoffPageRegistration | null, snapshot: HandoffRegistryState = state): boolean {
  return isCurrentHandoffRegistration(id, snapshot) && !snapshot.authExpired;
}

/**
 * A read of the page `id`, the `seq`-th it sent (increasing within the registration), answered:
 * `expired` (401) or `authenticated` (its detail read succeeded). Taken from the current
 * registration only, and only when newer than the read it took last (invariant 3).
 */
export function reportHandoffPageAuth(id: HandoffPageRegistration | null, outcome: 'expired' | 'authenticated', seq: number): void {
  if (id === null || !isCurrentHandoffRegistration(id)) return;
  if (seq <= (authSeqOf.get(id) ?? 0)) return;
  authSeqOf.set(id, seq);
  const authExpired = outcome === 'expired';
  if (state.authExpired !== authExpired) commit({ ...state, authExpired });
}

/** Tests only: the registry as at load. */
export function resetHandoffRegistryForTests(): void {
  commit(EMPTY);
}
