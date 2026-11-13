/**
 * `GET /api/repositories/:id/mem/decisions/:itemId/diff?worktreeId=&effect=` — the body a
 * promote of the decision would write, drawn for reading (`commandmate mem decisions <itemId>`).
 * A reference: no preview row is made, so it cannot be approved (approving is the screen's,
 * `…/preview` then `…/approve`). Writes nothing. Issue #4355, design §3.4.2・§4.2.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { memInternalError } from '@/lib/mem/service';
import { promoteReferenceDiff } from '@/lib/promote/reference-diff';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  try {
    const { id, itemId } = await params;
    const query = new URL(request.url).searchParams;
    const outcome = await promoteReferenceDiff(getDbInstance(), id, itemId, {
      worktreeId: query.get('worktreeId'),
      effect: query.get('effect'),
    });
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    const outcome = memInternalError('mem-promote-reference-diff-failed', error);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
}
