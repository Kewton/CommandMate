/**
 * `GET /api/repositories/:id/mem/decisions/branches` — the branches the decision screen
 * chooses from, each with the shared counts of its decisions (I6). Read only; no screen mark.
 * Issue #4355, design §3.1.2・§4.1.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { memInternalError } from '@/lib/mem/service';
import { listDecisionBranches } from '@/lib/promote/decision-branches';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const outcome = await listDecisionBranches(getDbInstance(), id);
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    const outcome = memInternalError('mem-promote-branches-failed', error);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
}
