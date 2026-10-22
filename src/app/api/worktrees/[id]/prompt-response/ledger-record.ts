/**
 * The prompt-response route's record in the Auto-Yes confirmation ledger
 * (Issue #3820, design `docs/design/auto-yes-measurement-3820.md` §2.1, §2.5).
 *
 * One request that reached the session is one confirmation with one send:
 * `ok` for a 200 `success: true`, `failed` for anything else (`success: false`,
 * a 500) — never an answer. The basis is `browser` when the body carried the
 * browser Auto-Yes's `origin`, `human` otherwise. `answeredBy` in the prompt
 * history is untouched (`human` for both, as before).
 *
 * Read from the response the route is about to return, so the record cannot
 * disagree with what the caller is told; and it cannot change that response —
 * the ledger never throws, and reading a clone of the body is caught here.
 *
 * @module app/api/worktrees/[id]/prompt-response/ledger-record
 */

import type { NextResponse } from 'next/server';
import { recordLedgerPromptResponse } from '@/lib/polling/auto-yes-confirmation-ledger';
import { AUTO_YES_BROWSER_ORIGIN } from '@/lib/prompt-response-body-builder';
import type { PromptResponseContext } from './context';
import type { ValidatedPromptResponse } from './request-validation';

/** Whether the response says the answer was taken. */
async function wasTaken(response: NextResponse): Promise<boolean> {
  if (response.status !== 200) return false;
  const body: unknown = await response.clone().json().catch(() => null);
  return typeof body === 'object' && body !== null && (body as { success?: unknown }).success === true;
}

/**
 * Record `response` as the outcome of `request` and hand it back unchanged.
 */
export async function notePromptResponseInLedger(
  ctx: PromptResponseContext,
  request: ValidatedPromptResponse,
  response: NextResponse,
): Promise<NextResponse> {
  try {
    const ok = await wasTaken(response);
    recordLedgerPromptResponse(
      { worktreeId: ctx.id, cliToolId: ctx.cliToolId, instanceId: ctx.instanceId },
      {
        basis: request.origin === AUTO_YES_BROWSER_ORIGIN ? 'browser' : 'human',
        promptType: request.bodyPromptType ?? 'unknown',
        result: ok ? 'ok' : 'failed',
      },
    );
  } catch {
    // The record never changes the response.
  }
  return response;
}
