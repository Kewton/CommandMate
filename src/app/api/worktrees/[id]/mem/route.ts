/**
 * `GET /api/worktrees/:id/mem` — the items of the worktree's branch (`?branch=` names
 * another branch, `?all=1` includes closed ones) and every session's `now` on it.
 * Issue #4221, design §4・§12.2. `off` answers 409 `disabled` and no items.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { memInternalError, memList } from '@/lib/mem/service';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const query = new URL(request.url).searchParams;
    const branch = query.get('branch');
    const outcome = await memList(
      getDbInstance(),
      { via: 'worktree', worktreeId: canonicalWorktreeId(id), ...(branch ? { branch } : {}) },
      { all: query.get('all') === '1' }
    );
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    const outcome = memInternalError('mem-list-failed', error);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
}
