/**
 * `POST /api/worktrees/:id/mem/handoff/requests/:rid/end` `{ ifVersion, force? }` — the stop
 * declared, from the person's stop button only (§4.6 1, Issue #4227). **Kills nothing**: the
 * screen then calls the existing stop (kill-session, unchanged) and `end/observe`. With
 * `force` the undecided proposals are discarded and the request stays forced. Screen only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { isScreenRequest } from '@/lib/security/screen-request';
import { memError, memInternalError, readMemBody } from '@/lib/mem/service';
import { handoffError } from '@/lib/handoff/common';
import { handoffEnd } from '@/lib/handoff/end';

export const dynamic = 'force-dynamic';

const answer = (outcome: { status: number; body: unknown }) => NextResponse.json(outcome.body, { status: outcome.status });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; rid: string }> }) {
  try {
    const p = await params;
    if (!isScreenRequest(request)) return answer(handoffError('screen_only'));
    const body = await readMemBody(request);
    if (!body) return answer(memError('invalid_request'));
    return answer(await Promise.resolve(handoffEnd(getDbInstance(), request, canonicalWorktreeId(p.id), p.rid, body)));
  } catch (error: unknown) {
    return answer(memInternalError('handoff-end-failed', error));
  }
}
