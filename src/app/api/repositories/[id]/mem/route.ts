/**
 * `GET /api/repositories/:id/mem?branch=<name>[&all=1]` — the items of a branch named
 * outright, for when its worktree is gone (§9.2). The mode is that branch's.
 * Issue #4221.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { memError, memInternalError, memList } from '@/lib/mem/service';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const query = new URL(request.url).searchParams;
    const branch = query.get('branch');
    const outcome = branch
      ? await memList(getDbInstance(), { via: 'repository', repositoryId: id, branch }, { all: query.get('all') === '1' })
      : memError('target_required', { field: 'branch' });
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    const outcome = memInternalError('mem-list-failed', error);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
}
