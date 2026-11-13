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
 * @module lib/handoff/page-owner
 */

import {
  beginHandoffPageRequest,
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
 * rejects as before.
 */
export async function fetchForHandoffPage(owner: HandoffPageOwner | null | undefined, input: string, init?: RequestInit): Promise<Response> {
  const report = beginHandoffPageResponseReport(owner);
  const response = init === undefined ? await fetch(input) : await fetch(input, init);
  report?.(response);
  return response;
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
