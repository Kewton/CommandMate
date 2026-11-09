/**
 * `GET /api/repositories/:id/mem/decisions?branch=<name>` — a branch's decisions with
 * their promote operations, and the worktrees the screen may choose from. Read only.
 * Issue #4225, design §4.2.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { memInternalError } from '@/lib/mem/service';
import { promoteError, promoteList } from '@/lib/promote/service';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const branch = new URL(request.url).searchParams.get('branch');
    const outcome = branch ? await promoteList(getDbInstance(), id, branch) : promoteError('invalid_request', { field: 'branch' });
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    const outcome = memInternalError('mem-promote-list-failed', error);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
}
