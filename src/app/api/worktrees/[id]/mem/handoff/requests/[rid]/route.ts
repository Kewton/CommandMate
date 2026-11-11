/**
 * `GET /api/worktrees/:id/mem/handoff/requests/:rid` — the request, its proposals (with each
 * item as stored now, through mem's exit check) and what changed on the branch without a
 * proposal (Issue #4227, design §4.3). No mark: the screen and the agent's CLI read it. The
 * read judges the request (expiry, a changed session) and may end an old one; it writes no
 * item and nothing of a newer conversation, and kills nothing.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { memInternalError } from '@/lib/mem/service';
import { handoffRead } from '@/lib/handoff/request';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string; rid: string }> }) {
  try {
    const { id, rid } = await params;
    const outcome = handoffRead(getDbInstance(), canonicalWorktreeId(id), rid);
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    const outcome = memInternalError('handoff-read-failed', error);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
}
