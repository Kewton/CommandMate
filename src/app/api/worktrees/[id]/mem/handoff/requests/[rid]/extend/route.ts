/**
 * `POST /api/worktrees/:id/mem/handoff/requests/:rid/extend` `{ ifVersion }` — 5 more minutes for
 * the agent, twice at most (§4.4, Issue #4227). Screen only; mode `on`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { isScreenRequest } from '@/lib/security/screen-request';
import { memError, memInternalError, readMemBody } from '@/lib/mem/service';
import { handoffError } from '@/lib/handoff/common';
import { handoffExtend } from '@/lib/handoff/request';

export const dynamic = 'force-dynamic';

const answer = (outcome: { status: number; body: unknown }) => NextResponse.json(outcome.body, { status: outcome.status });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; rid: string }> }) {
  try {
    const p = await params;
    if (!isScreenRequest(request)) return answer(handoffError('screen_only'));
    const body = await readMemBody(request);
    if (!body) return answer(memError('invalid_request'));
    return answer(await handoffExtend(getDbInstance(), request, canonicalWorktreeId(p.id), p.rid, body));
  } catch (error: unknown) {
    return answer(memInternalError('handoff-extend-failed', error));
  }
}
