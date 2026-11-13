/**
 * Issue #4345 1c: a page's remaining requests (its polls, the composer's send, the prompt answers,
 * the file operations, the detail screen's own panes) reach the gateway of
 * `@/lib/handoff/page-registration` (invariant 7) through one owner: the page's registration
 * **holder** (`useWorktreeDetailController`'s ref), handed to what the page draws by
 * `HandoffPageOwnerContext` (`@/hooks/useHandoffPageOwner`) and to the controller's own hooks as an
 * argument.
 *
 * The holder is read when a request leaves: the registration the page holds at that moment (a page
 * made again holds a new one; a request of the old mount stays the old registration's), numbered in
 * that registration's one count across entries — never a poller's own sequence. The response is
 * reported as soon as it is in hand, before its body is read and before its status is folded into an
 * `Error`, a toast, `null` or a fallback. Nothing is reported without an owner (a surface drawn
 * outside a worktree page — the sessions view, the settings screen — or a page not registered yet),
 * for a rejected request (status 0, an abort) or for any status but the expiry
 * (`isHandoffAuthExpiry`). The recovery stays the detail read's success only.
 *
 * 再指示 2 (K1): the same gateway is also the gate. A page's request that starts something new
 * (`operation`: by default any method but GET / HEAD) is sent only while its registration may start
 * (`handoffPageMayStart`) — checked right before each `fetch` (each attempt of a retry), with the
 * registration the press fixed ({@link beginHandoffPageOperation}'s token) or, with no press (an
 * automatic resend), the one held as it leaves. Refused, nothing is sent and the caller gets
 * `HandoffPageOperationRefusedError` ("not sent", no status). A read (`read`, a POST that only
 * renders named so) is never stopped; a record of what was sent (`record`) leaves with the capability
 * an allowed operation hands over. Outside a page (no owner) nothing is gated: the same call as before.
 *
 * @module lib/handoff/page-owner
 */

import {
  assertHandoffPageRequestMayLeave,
  beginHandoffPageOperationFor,
  beginHandoffPageRequest,
  reportHandoffPageResponse,
  type HandoffAuthResponse,
  type HandoffPageOperation,
  type HandoffPageRecordCapability,
  type HandoffPageRegistration,
  type HandoffPageRequest,
  type HandoffPageRequestKind,
} from '@/lib/handoff/page-registration';
import { worktreeApi, type ApiResponseObserver } from '@/lib/api-client';

export {
  HandoffPageOperationRefusedError,
  isHandoffPageOperationRefused,
  type HandoffPageOperation,
  type HandoffPageRecordCapability,
  type HandoffPageRequestKind,
} from '@/lib/handoff/page-registration';

/** The page's registration holder: `current` is the registration the page holds now (`null`: none). */
export interface HandoffPageOwner {
  readonly current: HandoffPageRegistration | null;
}

/** No page owns the request (a surface drawn outside a worktree page). */
export const NO_HANDOFF_PAGE_OWNER: HandoffPageOwner = Object.freeze({ current: null });

/** Reports one request's response to the gateway (the response's status only; never its body). */
export type HandoffPageResponseReport = (response: HandoffAuthResponse | null | undefined) => void;

/** 再指示 2: what a page's request is, beside its owner. */
export interface HandoffPageRequestOptions {
  /** Default: `read` for GET / HEAD (no `init`: GET), `operation` for any other method. */
  readonly kind?: HandoffPageRequestKind;
  /** The press's token (its registration decides). None: the registration held as it leaves. */
  readonly operation?: HandoffPageOperation | null;
  /** For a `record`: the capability an allowed operation handed over. */
  readonly record?: HandoffPageRecordCapability | null;
}

const outsideAPage = (owner: HandoffPageOwner | null | undefined): owner is null | undefined =>
  !owner || owner === NO_HANDOFF_PAGE_OWNER;

/** 再指示 2: GET / HEAD read; anything else starts something (a POST that only renders says `read`). */
export function handoffPageRequestKindOf(init: RequestInit | undefined, options?: HandoffPageRequestOptions): HandoffPageRequestKind {
  if (options?.kind) return options.kind;
  if (options?.record) return 'record';
  const method = (init?.method ?? 'GET').toUpperCase();
  return method === 'GET' || method === 'HEAD' ? 'read' : 'operation';
}

/** 再指示 2: the request of `owner` (inside a page) as it leaves: its registration, number and kind. */
function beginOwned(owner: HandoffPageOwner, kind: HandoffPageRequestKind, options?: HandoffPageRequestOptions): HandoffPageRequest {
  return beginHandoffPageRequest(options?.operation ? options.operation.registration : owner.current, {
    kind,
    inside: true,
    operation: options?.operation ?? null,
    record: options?.record ?? null,
  });
}

function reporterOf(request: HandoffPageRequest): HandoffPageResponseReport | undefined {
  if (request.registration === null) return undefined;
  return (response) => {
    if (response === null || response === undefined || typeof response !== 'object') return;
    reportHandoffPageResponse(request, response);
  };
}

/**
 * A read owned by `owner` leaves now (the caller sends it itself, at once): its owner and its number
 * are fixed here. Answers the report to call with its response as soon as it is in hand, or
 * `undefined` when no page owns it. 再指示 2: for reads (a GET, MARP's POST); a request named
 * `operation` is gated here, before the caller sends it (throws `HandoffPageOperationRefusedError`).
 */
export function beginHandoffPageResponseReport(
  owner: HandoffPageOwner | null | undefined,
  options: HandoffPageRequestOptions = { kind: 'read' },
): HandoffPageResponseReport | undefined {
  if (outsideAPage(owner)) return undefined;
  const request = beginOwned(owner, options.kind ?? 'read', options);
  assertHandoffPageRequestMayLeave(request);
  return reporterOf(request);
}

/**
 * `fetch` for a request owned by `owner`: the same call (the same arguments — no `init` when none was
 * given), its response reported before it is returned. A rejection (no response) reports nothing and
 * rejects as before. 再指示 2: an operation the page may not start is not sent — the promise rejects
 * with `HandoffPageOperationRefusedError` and `fetch` is never called. With no owner: `fetch`'s own
 * promise (the same call and the same timing, nothing gated).
 */
export function fetchForHandoffPage(
  owner: HandoffPageOwner | null | undefined,
  input: string,
  init?: RequestInit,
  options?: HandoffPageRequestOptions,
): Promise<Response> {
  if (outsideAPage(owner)) return init === undefined ? fetch(input) : fetch(input, init);
  const request = beginOwned(owner, handoffPageRequestKindOf(init, options), options);
  try {
    assertHandoffPageRequestMayLeave(request);
  } catch (error) {
    return Promise.reject(error);
  }
  const sent = init === undefined ? fetch(input) : fetch(input, init);
  const report = reporterOf(request);
  if (!report) return sent;
  return sent.then((response) => {
    report(response);
    return response;
  });
}

/**
 * For the `api-client` calls that read the body before they throw: the observer of a request owned by
 * `owner` — `beforeFetch` (再指示 2: the gate, before each attempt; `operation` unless named) and
 * `onResponse` (the report) — or `undefined` when no page owns it, so the caller passes nothing further.
 */
export function beginHandoffPageObserver(
  owner: HandoffPageOwner | null | undefined,
  options?: HandoffPageRequestOptions,
): Required<ApiResponseObserver> | undefined {
  if (outsideAPage(owner)) return undefined;
  const request = beginOwned(owner, options?.kind ?? (options?.record ? 'record' : 'operation'), options);
  const report = reporterOf(request);
  return {
    beforeFetch: () => assertHandoffPageRequestMayLeave(request),
    onResponse: (response) => report?.(response),
  };
}

/**
 * 再指示 2: the composer's send (`worktreeApi.sendMessage`) as a page's operation — gated and reported
 * through the gateway when a page owns it; exactly the call it was (three arguments) outside one.
 * Rejects with `HandoffPageOperationRefusedError` when not sent.
 */
export function sendMessageForHandoffPage(
  owner: HandoffPageOwner | null | undefined,
  worktreeId: string,
  content: string,
  options?: Parameters<typeof worktreeApi.sendMessage>[2],
  operation?: HandoffPageOperation | null,
): ReturnType<typeof worktreeApi.sendMessage> {
  const observer = beginHandoffPageObserver(owner, operation ? handoffPageOperationOptions(operation) : undefined);
  return observer
    ? worktreeApi.sendMessage(worktreeId, content, options, observer)
    : worktreeApi.sendMessage(worktreeId, content, options);
}

/** 再指示 2: the attachment's upload (`worktreeApi.uploadImageFile`) as a page's operation. */
export function uploadImageFileForHandoffPage(
  owner: HandoffPageOwner | null | undefined,
  worktreeId: string,
  file: File,
): Promise<{ path: string }> {
  const observer = beginHandoffPageObserver(owner);
  return observer ? worktreeApi.uploadImageFile(worktreeId, file, observer) : worktreeApi.uploadImageFile(worktreeId, file);
}

/** 再指示 1: the token of an operation pressed outside any page. */
const OUTSIDE_A_PAGE: HandoffPageOperation = Object.freeze({
  registration: null,
  mayStart: () => true,
  record: () => null,
});

/**
 * 再指示 1・2: an operation owned by `owner` is pressed now. Outside a worktree page (no owner: the
 * settings screen, the sessions view) it is as before — always allowed, nothing gated. Inside one it
 * may start while the registration held at the press may (`handoffPageMayStart`): not once a 401 was
 * taken (the registry's expiry, whatever the page's own `isAuthExpired` says), not after the page was
 * made again, not while no registration is held. The token is what the press hands to the gate
 * ({@link handoffPageOperationOptions}): the press's early check (to keep the draft) and the gate's
 * (the guarantee) read the same registration.
 */
export function beginHandoffPageOperation(owner: HandoffPageOwner | null | undefined): HandoffPageOperation {
  if (outsideAPage(owner)) return OUTSIDE_A_PAGE;
  return beginHandoffPageOperationFor(owner.current);
}

/** 再指示 2: the options that hand `operation` to the gate (none for the outside-a-page token). */
export function handoffPageOperationOptions(operation: HandoffPageOperation): HandoffPageRequestOptions | undefined {
  return operation === OUTSIDE_A_PAGE ? undefined : { operation };
}
