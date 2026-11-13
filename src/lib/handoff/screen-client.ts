/**
 * The hand-off API as the screen calls it (Issue #4227, design `mem-ui-4227.md` §4.3・
 * §7.2). Every write carries the screen's mark; the CLI has no copy of this (it has
 * `propose` and `done` only). Answers a result rather than throwing: status 0 is a
 * result that is not known (a timeout, a lost connection), which the screen keeps and
 * sends again as it was (rule (4), §2.4.1). Nothing here reaches the database or `fs`.
 *
 * Issue #4345 1b: every request takes the page registration that owns it (`owner`, the dialog's
 * `registration` — the page that shows the dialog, never one looked up from the request's
 * worktree) and reports its answer through the gateway of `@/lib/handoff/page-registration`: its
 * place in the registration's one order is taken right before it leaves
 * (`beginHandoffPageRequest`) and its response is reported as soon as it is in hand — before the
 * body is read and before the status is folded into a result or `null`
 * (`reportHandoffPageResponse`). Only a 401 or the redirect to `/login` is the expiry; nothing
 * here recovers the session (only the page's detail read does). Left out (`undefined`) or `null`,
 * nothing is reported. Reporting starts or stops nothing: what the caller does with the result is
 * unchanged, so a write already sent is still recorded for its own unit and destination.
 *
 * @module lib/handoff/screen-client
 */

import { screenRequestHeaders } from '@/lib/security/screen-request';
import {
  beginHandoffPageRequest,
  isHandoffAuthExpiry,
  reportHandoffPageResponse,
  type HandoffPageRegistration,
} from '@/lib/handoff/page-registration';
import type {
  HandoffCreateResponse,
  HandoffDecideResponse,
  HandoffEndResponse,
  HandoffReadResponse,
} from './types';
import type { StartPreviewResponse } from './preview';

export const HANDOFF_SCREEN_TIMEOUT_MS = 30000;

export type HandoffResult<T> =
  | { ok: true; status: number; body: T }
  | {
      ok: false;
      status: number;
      code?: string;
      body?: Record<string, unknown>;
      /** Issue #4345 1b: the answer was the session's expiry and the registry took it for `owner`. */
      expired?: boolean;
    };

/**
 * Issue #4345 1b: the page registration a request belongs to (the dialog's `registration`).
 * `undefined` / `null`: none — the answer is not reported.
 */
export type HandoffRequestOwner = HandoffPageRegistration | null | undefined;

async function call<T>(url: string, init: RequestInit | undefined, owner: HandoffRequestOwner): Promise<HandoffResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HANDOFF_SCREEN_TIMEOUT_MS);
  // Issue #4345 1b: the owner and the order are fixed as the request leaves.
  const authRequest = beginHandoffPageRequest(owner ?? null);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    // Issue #4345 1b: reported before the body is read (a body that is not JSON or never ends
    // loses nothing) and before the status is folded into the result.
    const expired = reportHandoffPageResponse(authRequest, response);
    // The middleware's redirect to /login (followed by `fetch`, a 200 of HTML): the expiry, never a
    // success with an empty body. Its body is not read.
    if (response.redirected && isHandoffAuthExpiry(response)) return { ok: false, status: 401, expired };
    let body: Record<string, unknown> = {};
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    if (response.ok && body.ok !== false) return { ok: true, status: response.status, body: body as T };
    return {
      ok: false,
      status: response.status ?? 0,
      code: typeof body.code === 'string' ? body.code : undefined,
      body,
      ...(expired ? { expired } : {}),
    };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

const base = (worktreeId: string) => `/api/worktrees/${encodeURIComponent(worktreeId)}/mem/handoff/requests`;
const one = (worktreeId: string, requestId: string) => `${base(worktreeId)}/${encodeURIComponent(requestId)}`;
const post = (body?: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...screenRequestHeaders() },
  body: JSON.stringify(body ?? {}),
});

export interface HandoffDecision {
  proposalId: string;
  fingerprint: string;
  action: 'approve' | 'discard';
}

/**
 * Issue #4345 1b: each call takes, last, the page registration it belongs to ({@link HandoffRequestOwner}),
 * read by the caller when its operation starts — never the registration current when it answers.
 */
export const handoffApi = {
  create: (worktreeId: string, instanceId: string, owner?: HandoffRequestOwner) =>
    call<HandoffCreateResponse>(base(worktreeId), post({ instanceId }), owner),
  read: (worktreeId: string, requestId: string, owner?: HandoffRequestOwner) => call<HandoffReadResponse>(one(worktreeId, requestId), undefined, owner),
  sent: (worktreeId: string, requestId: string, owner?: HandoffRequestOwner) =>
    call<HandoffReadResponse>(`${one(worktreeId, requestId)}/sent`, post(), owner),
  sendFailed: (worktreeId: string, requestId: string, owner?: HandoffRequestOwner) =>
    call<HandoffReadResponse>(`${one(worktreeId, requestId)}/send-failed`, post(), owner),
  extend: (worktreeId: string, requestId: string, ifVersion: number, owner?: HandoffRequestOwner) =>
    call<HandoffReadResponse>(`${one(worktreeId, requestId)}/extend`, post({ ifVersion }), owner),
  decide: (worktreeId: string, requestId: string, input: { ifVersion: number; decisions: HandoffDecision[] }, owner?: HandoffRequestOwner) =>
    call<HandoffDecideResponse>(`${one(worktreeId, requestId)}/decide`, post(input), owner),
  rebase: (
    worktreeId: string,
    requestId: string,
    proposalId: string,
    input: { ifVersion: number; fingerprint: string },
    owner?: HandoffRequestOwner
  ) => call<HandoffReadResponse>(`${one(worktreeId, requestId)}/proposals/${encodeURIComponent(proposalId)}/rebase`, post(input), owner),
  cancel: (worktreeId: string, requestId: string, owner?: HandoffRequestOwner) =>
    call<HandoffReadResponse>(`${one(worktreeId, requestId)}/cancel`, post(), owner),
  end: (worktreeId: string, requestId: string, input: { ifVersion: number; force?: boolean }, owner?: HandoffRequestOwner) =>
    call<HandoffEndResponse>(`${one(worktreeId, requestId)}/end`, post(input), owner),
  observe: (worktreeId: string, requestId: string, endToken: string, owner?: HandoffRequestOwner) =>
    call<HandoffReadResponse>(`${one(worktreeId, requestId)}/end/observe`, post({ endToken }), owner),
  /**
   * The request's text, sent as any message of the screen is (the send route), with
   * `brief: 'skip'`: a conversation that ends gets no brief and its boundary stays (§4.2).
   */
  sendText: (worktreeId: string, text: string, target: { cliToolId: string; instanceId: string }, owner?: HandoffRequestOwner) =>
    call<unknown>(
      `/api/worktrees/${encodeURIComponent(worktreeId)}/send`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, cliToolId: target.cliToolId, instanceId: target.instanceId, brief: 'skip' }),
      },
      owner
    ),
};

/** Issue #4227 G-PR3 (design §3.1): the preview is given up after this (D1's provider timeout). */
export const START_PREVIEW_TIMEOUT_MS = 2000;

/**
 * G-3's preview of the instance's next send (`GET …/mem/start-preview`). null when it could not
 * be read in time or was not answered (a non-200, e.g. 409 `boundary_changed`: the boundary
 * moved under the server's read). G-PR6 (design §3.2): a plain send reads this first and on null
 * sends NOTHING — the draft stays, with the reason and "try again" — never `auto` in place of a
 * choice it may owe.
 * A read that says unattended (`show:false`, `attended:false`) sends as it always did.
 * Issue #4345 1b: `owner` (the page registration the send belongs to) gets the answer reported
 * through the gateway before it is folded into `null` (a 401, or the redirect to `/login`, expires
 * the session for that registration); left out, nothing is reported.
 */
export async function fetchStartPreview(worktreeId: string, instanceId: string, owner?: HandoffRequestOwner): Promise<StartPreviewResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), START_PREVIEW_TIMEOUT_MS);
  const authRequest = beginHandoffPageRequest(owner ?? null);
  try {
    const url = `/api/worktrees/${encodeURIComponent(worktreeId)}/mem/start-preview?instance=${encodeURIComponent(instanceId)}`;
    const response = await fetch(url, { signal: controller.signal });
    reportHandoffPageResponse(authRequest, response);
    if (!response.ok || isHandoffAuthExpiry(response)) return null;
    const body = (await response.json()) as StartPreviewResponse;
    return body && body.ok === true && typeof body.show === 'boolean' ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether a body is a command to the tool, which carries no brief (D1 §4.1): the server's
 * `isSlashCommandBody` (`session-boundary.ts`, not loadable in the browser), pinned equal by
 * `tests/unit/lib/handoff/handoff-start-preview-client-4227.test.ts`.
 */
export function isCommandBody(content: string): boolean {
  const word = content.trim().split(/\s/, 1)[0] ?? '';
  return /^\/[^\s]+$/.test(word) || word.startsWith('!');
}
