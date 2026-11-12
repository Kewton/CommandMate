/**
 * `POST /api/worktrees/:id/mem/handoff/requests/:rid/proposals` `{ instanceId, op, itemId?, baseVersion?,
 * kind?, text?, closeWhen?, evidence?, promoteTo?, reason? }` — the agent proposes one mem
 * update (`commandmate handoff propose`, Issue #4227, design §4.3). Never confirms: a person
 * decides on the screen. The request's own instance only (409 `not_requested`); mode `on`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { memError, memInternalError, readMemBody } from '@/lib/mem/service';
import { handoffPropose } from '@/lib/handoff/proposals';

export const dynamic = 'force-dynamic';

const answer = (outcome: { status: number; body: unknown }) => NextResponse.json(outcome.body, { status: outcome.status });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; rid: string }> }) {
  try {
    const p = await params;
    const body = await readMemBody(request);
    if (!body) return answer(memError('invalid_request'));
    return answer(await handoffPropose(getDbInstance(), canonicalWorktreeId(p.id), p.rid, body));
  } catch (error: unknown) {
    return answer(memInternalError('handoff-propose-failed', error));
  }
}
