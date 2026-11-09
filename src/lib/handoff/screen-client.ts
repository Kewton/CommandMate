/**
 * The hand-off API as the screen calls it (Issue #4227, design `mem-ui-4227.md` §4.3・
 * §7.2). Every write carries the screen's mark; the CLI has no copy of this (it has
 * `propose` and `done` only). Answers a result rather than throwing: status 0 is a
 * result that is not known (a timeout, a lost connection), which the screen keeps and
 * sends again as it was (rule (4), §2.4.1). Nothing here reaches the database or `fs`.
 *
 * @module lib/handoff/screen-client
 */

import { screenRequestHeaders } from '@/lib/security/screen-request';
import type {
  HandoffCreateResponse,
  HandoffDecideResponse,
  HandoffEndResponse,
  HandoffReadResponse,
} from './types';

export const HANDOFF_SCREEN_TIMEOUT_MS = 30000;

export type HandoffResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; code?: string; body?: Record<string, unknown> };

async function call<T>(url: string, init?: RequestInit): Promise<HandoffResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HANDOFF_SCREEN_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    let body: Record<string, unknown> = {};
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    if (response.ok && body.ok !== false) return { ok: true, status: response.status, body: body as T };
    return { ok: false, status: response.status ?? 0, code: typeof body.code === 'string' ? body.code : undefined, body };
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

export const handoffApi = {
  create: (worktreeId: string, instanceId: string) => call<HandoffCreateResponse>(base(worktreeId), post({ instanceId })),
  read: (worktreeId: string, requestId: string) => call<HandoffReadResponse>(one(worktreeId, requestId)),
  sent: (worktreeId: string, requestId: string) => call<HandoffReadResponse>(`${one(worktreeId, requestId)}/sent`, post()),
  sendFailed: (worktreeId: string, requestId: string) => call<HandoffReadResponse>(`${one(worktreeId, requestId)}/send-failed`, post()),
  extend: (worktreeId: string, requestId: string, ifVersion: number) =>
    call<HandoffReadResponse>(`${one(worktreeId, requestId)}/extend`, post({ ifVersion })),
  decide: (worktreeId: string, requestId: string, input: { ifVersion: number; decisions: HandoffDecision[] }) =>
    call<HandoffDecideResponse>(`${one(worktreeId, requestId)}/decide`, post(input)),
  rebase: (worktreeId: string, requestId: string, proposalId: string, input: { ifVersion: number; fingerprint: string }) =>
    call<HandoffReadResponse>(`${one(worktreeId, requestId)}/proposals/${encodeURIComponent(proposalId)}/rebase`, post(input)),
  cancel: (worktreeId: string, requestId: string) => call<HandoffReadResponse>(`${one(worktreeId, requestId)}/cancel`, post()),
  end: (worktreeId: string, requestId: string, input: { ifVersion: number; force?: boolean }) =>
    call<HandoffEndResponse>(`${one(worktreeId, requestId)}/end`, post(input)),
  observe: (worktreeId: string, requestId: string, endToken: string) =>
    call<HandoffReadResponse>(`${one(worktreeId, requestId)}/end/observe`, post({ endToken })),
  /**
   * The request's text, sent as any message of the screen is (the send route), with
   * `brief: 'skip'`: a conversation that ends gets no brief and its boundary stays (§4.2).
   */
  sendText: (worktreeId: string, text: string, target: { cliToolId: string; instanceId: string }) =>
    call<unknown>(`/api/worktrees/${encodeURIComponent(worktreeId)}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text, cliToolId: target.cliToolId, instanceId: target.instanceId, brief: 'skip' }),
    }),
};
