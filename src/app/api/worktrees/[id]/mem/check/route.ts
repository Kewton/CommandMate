/**
 * `POST /api/worktrees/:id/mem/check` — `{ instanceId?, branch? }`. Evaluates the close
 * conditions of the worktree's branch and closes what is met. `off` / `derived` answer
 * 409 `disabled` and ask nothing. Issue #4222, design §4.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { memCheck, memError, memInternalError, readMemBody } from '@/lib/mem/service';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readMemBody(request);
    if (!body) {
      const refused = memError('invalid_request');
      return NextResponse.json(refused.body, { status: refused.status });
    }
    const branch = typeof body.branch === 'string' && body.branch.length > 0 ? body.branch : undefined;
    const outcome = await memCheck(
      getDbInstance(),
      { via: 'worktree', worktreeId: canonicalWorktreeId(id), ...(branch ? { branch } : {}) },
      body
    );
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    const outcome = memInternalError('mem-check-failed', error);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
}
