/**
 * `POST /api/worktrees/:id/mem/purge` — `{ branch, closedOnly?, kind?, before?, includeDecisions?, confirm? }`.
 * Without `confirm: true` nothing is deleted and the counts are answered. Any mode.
 * Issue #4221, design §8.3.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { memError, memInternalError, memPurge, readMemBody } from '@/lib/mem/service';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readMemBody(request);
    if (!body) {
      const refused = memError('invalid_request');
      return NextResponse.json(refused.body, { status: refused.status });
    }
    const branch = typeof body.branch === 'string' ? body.branch : '';
    const outcome = await memPurge(getDbInstance(), { via: 'worktree', worktreeId: canonicalWorktreeId(id), branch }, body);
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    const outcome = memInternalError('mem-purge-failed', error);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
}
