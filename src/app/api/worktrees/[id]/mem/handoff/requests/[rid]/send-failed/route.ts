/**
 * `POST /api/worktrees/:id/mem/handoff/requests/:rid/send-failed` — the screen could not send the
 * request's text (§4.4, Issue #4227): the person may resend, end without proposals or stop
 * ending. Screen only; mode `on`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { isScreenRequest } from '@/lib/security/screen-request';
import { memInternalError } from '@/lib/mem/service';
import { handoffError } from '@/lib/handoff/common';
import { handoffSendFailed } from '@/lib/handoff/request';

export const dynamic = 'force-dynamic';

const answer = (outcome: { status: number; body: unknown }) => NextResponse.json(outcome.body, { status: outcome.status });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; rid: string }> }) {
  try {
    const p = await params;
    if (!isScreenRequest(request)) return answer(handoffError('screen_only'));
    return answer(await handoffSendFailed(getDbInstance(), request, canonicalWorktreeId(p.id), p.rid));
  } catch (error: unknown) {
    return answer(memInternalError('handoff-send-failed-failed', error));
  }
}
