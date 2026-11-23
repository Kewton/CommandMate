/**
 * POST /api/worktrees/:id/send and /terminal — the 409 `SEND_TARGET_CHANGED`
 * for a send its own fence stopped (Issue #4534 C1・C2).
 *
 * Its own module so `/terminal` does not load the send route's start step
 * (`send-session-start.ts` → `send-request.ts`): only what the answer needs.
 */

import { NextResponse } from 'next/server';
import type Database from 'better-sqlite3';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';
import { sendTargetChangedBody, type CurrentSendTarget, type SendFenceOutcome } from '@/lib/session/send-fence-outcome';
import { resolveSessionTarget } from '@/lib/session/resolve-session-target';

const logger = createLogger('api/send');

/** Where a send refused by its fence was going: the route's resolved triple, and what resolves now. */
export interface SendTargetChangedInput {
  db?: Database.Database;
  worktreeId: string;
  instanceId: string | undefined;
  cliToolId: CLIToolType;
}

/**
 * What the instance resolves to now (C1 `current`): null when the worktree or
 * the roster row is gone, when the check could not read, or when this read
 * fails too.
 */
export function currentSendTarget(input: SendTargetChangedInput, reason: string): CurrentSendTarget | null {
  if (input.db === undefined || reason === 'worktree-gone' || reason === 'target-gone' || reason === 'unreadable') return null;
  try {
    const now = resolveSessionTarget(input.db, input.worktreeId, { instanceId: input.instanceId ?? input.cliToolId });
    return { cliToolId: now.cliToolId, resolvedBy: now.resolvedBy };
  } catch {
    return null;
  }
}

/**
 * Issue #4534 (C1・C2): the 409 `SEND_TARGET_CHANGED` for a refusal of the
 * request's own fence (kind `target-changed`). `sendOutcome` is the fence's
 * proof: `not_sent` only when nothing of the body nor a dispatch had started.
 */
export function answerSendTargetChanged(fence: SendFenceOutcome, input: SendTargetChangedInput): NextResponse {
  const reason = (fence.refusal as { reason?: unknown } | null)?.reason;
  const body = sendTargetChangedBody(
    fence,
    { worktreeId: input.worktreeId, instanceId: input.instanceId ?? input.cliToolId, cliToolId: input.cliToolId },
    currentSendTarget(input, typeof reason === 'string' ? reason : 'unreadable')
  );
  logger.info('send-target-changed', { worktreeId: input.worktreeId, reason: body.reason, requestId: body.requestId, sendOutcome: body.sendOutcome });
  return NextResponse.json(body, { status: 409 });
}
