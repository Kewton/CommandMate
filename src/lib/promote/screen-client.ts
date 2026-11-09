/**
 * The promote API as the screen calls it (Issue #4225, design §4). Every write carries
 * the screen's mark; the CLI has no copy of this (`tests/unit/guards/mem-promote-screen-only-4225.test.ts`).
 * Answers a result rather than throwing. Nothing here reaches the database or `fs`.
 *
 * @module lib/promote/screen-client
 */

import { screenRequestHeaders } from '@/lib/security/screen-request';
import type { MemItemView } from '@/types/mem';
import type { PromoteEffect, PromoteOperationView, PromotePreviewView } from './model';

export const PROMOTE_SCREEN_TIMEOUT_MS = 30000;

export interface PromoteDecisionEntry {
  item: MemItemView;
  unreflected: boolean;
  operations: PromoteOperationView[];
}

/**
 * An unsettled operation whose item is closed or purged (5-2b P2-2), or any of the branch's
 * while its roots disagree on the mode (5-2c P2-1): still reconciled from the screen.
 */
export interface PromoteUnresolvedEntry {
  operation: PromoteOperationView;
  /** null: the item was purged. */
  item: MemItemView | null;
  itemVersion: number | null;
}

export interface PromoteListBody {
  ok: true;
  /** `'ambiguous'`: the roots of the same git disagree on the branch's mode (5-2c P2-1); only `unresolved` is listed. */
  mode: string;
  ambiguous?: { reason: string | null; roots: Array<{ repositoryId: string; name: string }> };
  branch: string;
  decisions: PromoteDecisionEntry[];
  unresolved: PromoteUnresolvedEntry[];
  worktrees: Array<{ id: string; path: string; name: string; branch: string | null }>;
}

export type PromoteCallResult<T> = { ok: true; body: T } | { ok: false; status: number; code?: string; reason?: string };

async function call<T>(url: string, init?: RequestInit): Promise<PromoteCallResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROMOTE_SCREEN_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = (await response.json()) as { ok?: boolean; code?: string; reason?: string };
    if (response.ok && body.ok === true) return { ok: true, body: body as T };
    return { ok: false, status: response.status ?? 0, code: body.code, reason: body.reason };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

const base = (repositoryId: string) => `/api/repositories/${encodeURIComponent(repositoryId)}/mem/decisions`;
const post = <T>(url: string, body: unknown) =>
  call<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...screenRequestHeaders() }, body: JSON.stringify(body) });

type OperationBody = { ok: true; operation: PromoteOperationView; item: MemItemView | null };

export const promoteApi = {
  list: (repositoryId: string, branch: string) => call<PromoteListBody>(`${base(repositoryId)}?branch=${encodeURIComponent(branch)}`),
  preview: (
    repositoryId: string,
    itemId: string,
    input: { worktreeId: string; effect: PromoteEffect; quoteConfirmed?: boolean; quoteText?: string }
  ) => post<{ ok: true; preview: PromotePreviewView }>(`${base(repositoryId)}/${encodeURIComponent(itemId)}/preview`, input),
  approve: (repositoryId: string, preview: PromotePreviewView) =>
    post<OperationBody>(`${base(repositoryId)}/${encodeURIComponent(preview.itemId)}/approve`, {
      previewId: preview.id,
      itemVersion: preview.itemVersion,
      baseFingerprint: preview.baseFingerprint,
      bodySha256: preview.bodySha256,
      acknowledgedOperationIds: preview.acknowledgedOperationIds,
    }),
  confirmReflected: (repositoryId: string, itemId: string, worktreeId: string, ifVersion: number) =>
    post<{ ok: true }>(`${base(repositoryId)}/${encodeURIComponent(itemId)}/confirm-reflected`, { worktreeId, ifVersion }),
  reconcile: (repositoryId: string, operationId: string) =>
    post<OperationBody>(`${base(repositoryId)}/operations/${encodeURIComponent(operationId)}/reconcile`, {}),
  abandon: (repositoryId: string, operationId: string) =>
    post<OperationBody>(`${base(repositoryId)}/operations/${encodeURIComponent(operationId)}/abandon`, { ifState: 'unknown' }),
  settleTransition: (repositoryId: string, operationId: string, worktreeId: string, ifVersion: number, acknowledgeDiff: boolean) =>
    post<OperationBody>(`${base(repositoryId)}/operations/${encodeURIComponent(operationId)}/settle-transition`, {
      worktreeId,
      ifVersion,
      acknowledgeDiff,
    }),
  /** 5-2c P2-3: the item is closed or purged and will not move; end the pending without moving it. */
  acknowledgeItemClosed: (repositoryId: string, operationId: string) =>
    post<OperationBody>(`${base(repositoryId)}/operations/${encodeURIComponent(operationId)}/settle-transition`, {
      acknowledgeItemClosed: true,
    }),
};
