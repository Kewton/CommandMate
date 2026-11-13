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
 * 5. (PR2) A page publishes what its dialog shows — its target and its `onClose` / `onStop` (the
 *    page's own close through the rule and its existing stop) — on its registration
 *    ({@link publishHandoffPageView}). The one host beside the shell (`HandoffDialogHost`) draws
 *    the current registration's; a registration gone takes its view with it (the host never uses
 *    the last callback of a page that is not registered any more).
 *
 * 6. (PR2 再指示 1) The route takes part in that one condition: once the host beside the shell has
 *    reported the path's detail route ({@link reportHandoffRoute}), a registration may start
 *    something new only while its worktree is that route's ({@link handoffRegistrationOnRoute}) —
 *    the same test the host draws by. A continuation that awaited under B's page, B still registered
 *    while the path is already A's, starts no send, kill nor opening; what was sent still finishes
 *    for its own unit and destination. Before any host has reported (`route` `undefined`: a page
 *    driven without the shell, as in its unit tests) the route takes no part; `AppShellGate` mounts
 *    the host always.
 *
 * 7. (Issue #4345 1a) One gateway takes a page's requests' answers to the session's expiry
 *    ({@link beginHandoffPageRequest} → {@link reportHandoffPageResponse} /
 *    {@link reportHandoffPageAuthenticated}). The owner and the order are fixed when a request
 *    leaves: the registration current for the page then, and the next number of that registration's
 *    one count — across every entry (the detail read, the end's mode read), so a 401 of one entry
 *    and a 200 of another compare. A response is reported before its body is read or its status
 *    folded into anything else (an `ApiError`, a fallback, `null`), and only its status, `redirected`
 *    and `url` are looked at. A 401 (or a redirect to `/login`) is the expiry; nothing else is —
 *    a 403, a 409, a 5xx, no response (status 0, an abort) say nothing of the session. The only
 *    recovery stays the detail read's success, reported by that read itself
 *    ({@link reportHandoffPageAuthenticated}); another entry's 200 recovers nothing. Taking a report
 *    is apart from {@link handoffPageMayStart}: a request that left while the session was expired
 *    (the detail read that recovers it) or off the route is still taken — only the current
 *    registration and the order decide (invariant 3).
 *
 * This module holds no unit, opening nor callback of the store (`@/lib/handoff/close-rule`): it
 * imports nothing of it as a value and writes nothing of it.
 *
 * @module lib/handoff/page-registration
 */

import type { SessionStopResult } from '@/lib/handoff/close-rule';

declare const REGISTRATION_BRAND: unique symbol;

/** The identity of one page's registration: made by {@link registerHandoffPage} only. */
export type HandoffPageRegistration = { readonly [REGISTRATION_BRAND]: true };

/** PR2: what a page's dialog shows, as the page publishes it (its target `null`: nothing open). */
export interface HandoffPageView {
  readonly target: { readonly cliToolId: string; readonly instanceId: string; readonly label: string } | null;
  /** The page's close of the hand-off (through the rule: `closeHandoffBy('dialog')`). */
  readonly onClose: () => void;
  /** The page's existing stop for the target. */
  readonly onStop: () => Promise<SessionStopResult>;
}

export interface RegistrationEntry {
  readonly id: HandoffPageRegistration;
  readonly worktreeId: string;
  /** PR2: `null` until the page has published one. */
  readonly view: HandoffPageView | null;
}

export interface HandoffRegistryState {
  /** The live registrations, oldest first: the last is the current one. */
  readonly live: readonly RegistrationEntry[];
  /** The session expired (a 401 of the current page) and no authenticated read has answered since. */
  readonly authExpired: boolean;
  /**
   * PR2 再指示 1: the worktree whose detail route the path is, as the host reported it (`null`: not
   * a detail route, or the path not known; `undefined`: no host has reported yet).
   */
  readonly route?: string | null;
}

const EMPTY: HandoffRegistryState = { live: [], authExpired: false, route: undefined };
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
  commit({ ...state, live: [...state.live, { id, worktreeId, view: null }] });
  return id;
}

/**
 * PR2: the page of the live registration `id` publishes what its dialog shows. Nothing for a
 * registration not live (a late publish of a page left never comes back).
 */
export function publishHandoffPageView(id: HandoffPageRegistration, view: HandoffPageView): void {
  const entry = state.live.find((candidate) => candidate.id === id);
  if (!entry) return;
  const old = entry.view;
  if (old && old.target === view.target && old.onClose === view.onClose && old.onStop === view.onStop) return;
  commit({ ...state, live: state.live.map((candidate) => (candidate.id === id ? { ...candidate, view } : candidate)) });
}

/** PR2: the current registration (the newest live one), or `null` while none is live. */
export function currentHandoffPage(snapshot: HandoffRegistryState = state): RegistrationEntry | null {
  return snapshot.live.length > 0 ? snapshot.live[snapshot.live.length - 1] : null;
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
 * PR2 再指示 1: the host reports the detail route of the path (`null`: none). Nothing changes for the
 * same route reported again.
 */
export function reportHandoffRoute(route: string | null): void {
  if (state.route === route) return;
  commit({ ...state, route });
}

/**
 * PR2 再指示 1: a registration of `worktreeId` belongs to the route `route` (the host's test of what
 * it draws as the route's page, and part of {@link handoffPageMayStart}). `undefined`: no host has
 * reported, the route takes no part (invariant 6).
 */
export function handoffRegistrationOnRoute(worktreeId: string, route: string | null | undefined): boolean {
  return route === undefined || worktreeId === route;
}

/**
 * 再指示 2: a page's dialog may start something new — `id` is the current registration, the
 * session is not expired (invariant 4) and (PR2 再指示 1) its worktree is the route's (invariant 6).
 * Read at the press and again after each await.
 */
export function handoffPageMayStart(id: HandoffPageRegistration | null, snapshot: HandoffRegistryState = state): boolean {
  if (!isCurrentHandoffRegistration(id, snapshot) || snapshot.authExpired) return false;
  return handoffRegistrationOnRoute(snapshot.live[snapshot.live.length - 1].worktreeId, snapshot.route);
}

/**
 * A read of the page `id`, the `seq`-th it sent (increasing within the registration), answered:
 * `expired` (401) or `authenticated` (its detail read succeeded). Taken from the current
 * registration only, and only when newer than the read it took last (invariant 3). Answers
 * whether it was taken.
 */
export function reportHandoffPageAuth(id: HandoffPageRegistration | null, outcome: 'expired' | 'authenticated', seq: number): boolean {
  if (id === null || !isCurrentHandoffRegistration(id)) return false;
  if (seq <= (authSeqOf.get(id) ?? 0)) return false;
  authSeqOf.set(id, seq);
  const authExpired = outcome === 'expired';
  if (state.authExpired !== authExpired) commit({ ...state, authExpired });
  return true;
}

/**
 * Issue #4345 1a: one request of a page, as it left — its owner (the page's registration then;
 * `null`: none, nothing is taken) and its number in that registration's one count across entries.
 */
export interface HandoffPageRequest {
  readonly registration: HandoffPageRegistration | null;
  readonly seq: number;
}

/** Issue #4345 1a: per registration, the number of the last request that left (any entry). */
const startedSeqOf = new WeakMap<HandoffPageRegistration, number>();

/**
 * Issue #4345 1a: a request of the page registered as `id` leaves now — call it before the request
 * is sent, with the registration the page holds at that moment (never one read when it answers).
 */
export function beginHandoffPageRequest(id: HandoffPageRegistration | null): HandoffPageRequest {
  if (id === null) return { registration: null, seq: 0 };
  const seq = (startedSeqOf.get(id) ?? 0) + 1;
  startedSeqOf.set(id, seq);
  return { registration: id, seq };
}

/** What the gateway reads of a response: never its body. */
export type HandoffAuthResponse = Pick<Response, 'status'> & Partial<Pick<Response, 'redirected' | 'url'>>;

/**
 * Issue #4345 1a: the response says the session expired — a 401, or the middleware's redirect to
 * `/login` that `fetch` followed (the same test as `detectAuthRedirect` in `@/lib/api-client`).
 */
export function isHandoffAuthExpiry(response: HandoffAuthResponse): boolean {
  if (response.status === 401) return true;
  return response.redirected === true && (response.url ?? '').includes('/login');
}

/**
 * Issue #4345 1a: the request `request` answered `response`. Call it as soon as the response is in
 * hand — before its body is read and before its status is turned into anything else. Its expiry is
 * taken under the request's own registration and number (invariant 7); any other status changes
 * nothing. Answers whether the response was the expiry and the registry took it (再指示 1: the
 * caller keeps that verdict for the rest of its own operation, since a later recovery does not
 * undo what this request saw).
 */
export function reportHandoffPageResponse(request: HandoffPageRequest, response: HandoffAuthResponse): boolean {
  if (!isHandoffAuthExpiry(response)) return false;
  return reportHandoffPageAuth(request.registration, 'expired', request.seq);
}

/**
 * Issue #4345 1a: the page's detail read `request` succeeded (its body read) — the one recovery
 * (invariant 3). No other entry calls it.
 */
export function reportHandoffPageAuthenticated(request: HandoffPageRequest): void {
  reportHandoffPageAuth(request.registration, 'authenticated', request.seq);
}

/** Tests only: the registry as at load. */
export function resetHandoffRegistryForTests(): void {
  commit(EMPTY);
}
