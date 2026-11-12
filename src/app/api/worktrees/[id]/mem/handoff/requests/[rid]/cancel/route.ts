/**
 * `POST /api/worktrees/:id/mem/handoff/requests/:rid/cancel` — "stop ending" (§4.4, Issue #4227):
 * undecided proposals are discarded; what was confirmed stays. Screen only; any mode.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { isScreenRequest } from '@/lib/security/screen-request';
import { memInternalError } from '@/lib/mem/service';
import { handoffError } from '@/lib/handoff/common';
import { handoffCancel } from '@/lib/handoff/request';

export const dynamic = 'force-dynamic';

const answer = (outcome: { status: number; body: unknown }) => NextResponse.json(outcome.body, { status: outcome.status });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; rid: string }> }) {
  try {
    const p = await params;
    if (!isScreenRequest(request)) return answer(handoffError('screen_only'));
    return answer(await Promise.resolve(handoffCancel(getDbInstance(), request, canonicalWorktreeId(p.id), p.rid)));
  } catch (error: unknown) {
    return answer(memInternalError('handoff-cancel-failed', error));
  }
}
