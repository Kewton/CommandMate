/**
 * `POST /api/worktrees/:id/mem/handoff/requests/:rid/done` `{ instanceId }` — the agent's proposals
 * are all in (`commandmate handoff done`, Issue #4227): the request is `reviewing`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { memError, memInternalError, readMemBody } from '@/lib/mem/service';
import { handoffDone } from '@/lib/handoff/proposals';

export const dynamic = 'force-dynamic';

const answer = (outcome: { status: number; body: unknown }) => NextResponse.json(outcome.body, { status: outcome.status });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; rid: string }> }) {
  try {
    const p = await params;
    const body = await readMemBody(request);
    if (!body) return answer(memError('invalid_request'));
    return answer(await handoffDone(getDbInstance(), canonicalWorktreeId(p.id), p.rid, body));
  } catch (error: unknown) {
    return answer(memInternalError('handoff-done-failed', error));
  }
}
