/**
 * Issue #4345 1c: a page's remaining requests (its polls, the composer's send, the prompt answers,
 * the file operations, the detail screen's own panes) reach the gateway of
 * `@/lib/handoff/page-registration` (invariant 7) through one owner: the page's registration
 * **holder** (`useWorktreeDetailController`'s ref), handed to what the page draws by
 * `HandoffPageOwnerContext` (`@/hooks/useHandoffPageOwner`) and to the controller's own hooks as an
 * argument.
 *
 * The holder is read when a request leaves ({@link beginHandoffPageResponseReport}): the registration
 * the page holds at that moment (a page made again holds a new one; a request of the old mount stays
 * the old registration's), numbered in that registration's one count across entries — never a
 * poller's own sequence. The response is reported as soon as it is in hand, before its body is read
 * and before its status is folded into an `Error`, a toast, `null` or a fallback. Nothing is
 * reported without an owner (a surface drawn outside a worktree page — the sessions view, the
 * settings screen — or a page not registered yet), for a rejected request (status 0, an abort) or for
 * any status but the expiry (`isHandoffAuthExpiry`). The recovery stays the detail read's success only.
 *
 * 再指示 1: taking a 401 is apart from what the page may start. A new operation of the page — a
 * send, a kill, a confirmation that clears the draft — fixes its registration when it is pressed
 * ({@link beginHandoffPageOperation}) and starts only while that registration may start
 * (`handoffPageMayStart`: current, the session not expired, on its route), checked at the press and
 * again after each await before it starts. What was already sent goes on recording as before.
 *
 * @module lib/handoff/page-owner
 */

import {
  beginHandoffPageRequest,
  handoffPageMayStart,
  reportHandoffPageResponse,
  type HandoffAuthResponse,
  type HandoffPageRegistration,
} from '@/lib/handoff/page-registration';

/** The page's registration holder: `current` is the registration the page holds now (`null`: none). */
export interface HandoffPageOwner {
  readonly current: HandoffPageRegistration | null;
}

/** No page owns the request (a surface drawn outside a worktree page). */
export const NO_HANDOFF_PAGE_OWNER: HandoffPageOwner = Object.freeze({ current: null });

/** Reports one request's response to the gateway (the response's status only; never its body). */
export type HandoffPageResponseReport = (response: HandoffAuthResponse | null | undefined) => void;

/**
 * A request owned by `owner` leaves now: its owner and its number are fixed here. Answers the report
 * to call with its response as soon as it is in hand, or `undefined` when no page owns it (nothing
 * to report — callers pass nothing further, so a request without an owner is the same request).
 */
export function beginHandoffPageResponseReport(owner: HandoffPageOwner | null | undefined): HandoffPageResponseReport | undefined {
  const registration = owner?.current ?? null;
  if (registration === null) return undefined;
  const request = beginHandoffPageRequest(registration);
  return (response) => {
    if (response === null || response === undefined || typeof response !== 'object') return;
    reportHandoffPageResponse(request, response);
  };
}

/**
 * `fetch` for a request owned by `owner`: the same call (the same arguments — no `init` when none was
 * given), its response reported before it is returned. A rejection (no response) reports nothing and
 * rejects as before. A `fetch` that throws synchronously (a broken mock) throws as before.
 */
export function fetchForHandoffPage(owner: HandoffPageOwner | null | undefined, input: string, init?: RequestInit): Promise<Response> {
  const report = beginHandoffPageResponseReport(owner);
  const sent = init === undefined ? fetch(input) : fetch(input, init);
  // 再指示 1: with no owner, `fetch`'s own promise — the same call and the same timing (no extra
  // microtask), so a caller drawn outside a page behaves exactly as before.
  if (!report) return sent;
  return sent.then((response) => {
    report(response);
    return response;
  });
}

/**
 * For the `api-client` calls that read the body before they throw (`worktreeApi.sendMessage`,
 * `worktreeApi.uploadImageFile`): the response observer of a request owned by `owner`, begun now —
 * or `undefined` when no page owns it, so the caller passes nothing further (the call is the same).
 */
export function beginHandoffPageObserver(owner: HandoffPageOwner | null | undefined): { onResponse: (response: Response) => void } | undefined {
  const report = beginHandoffPageResponseReport(owner);
  return report ? { onResponse: (response) => report(response) } : undefined;
}

/** 再指示 1: a new operation of the page, its registration fixed when it was pressed. */
export interface HandoffPageOperation {
  /** The operation may start now (read at the press and again after each await). */
  readonly mayStart: () => boolean;
}

const OUTSIDE_A_PAGE: HandoffPageOperation = Object.freeze({ mayStart: () => true });

/**
 * 再指示 1: an operation owned by `owner` is pressed now. Outside a worktree page (no owner: the
 * settings screen, the sessions view) it is as before — always allowed. Inside one it may start
 * while the registration held at the press may (`handoffPageMayStart`): not once a 401 was taken (the
 * registry's expiry, whatever the page's own `isAuthExpired` says), not after the page was made again,
 * not while no registration is held.
 */
export function beginHandoffPageOperation(owner: HandoffPageOwner | null | undefined): HandoffPageOperation {
  if (!owner || owner === NO_HANDOFF_PAGE_OWNER) return OUTSIDE_A_PAGE;
  const registration = owner.current;
  return { mayStart: () => handoffPageMayStart(registration) };
}
