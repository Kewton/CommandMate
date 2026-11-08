/**
 * `POST /api/worktrees/:id/mem/now` — `{ instanceId, text, closeWhen?, evidence? }`.
 * The instance's `now` (the #2427 note of its session) gets a new item; what it held
 * is kept as superseded. Mode `on` only. Issue #4221, design §3.1・§10.2.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { memError, memInternalError, memWriteNow, readMemBody } from '@/lib/mem/service';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readMemBody(request);
    const outcome = body ? await memWriteNow(getDbInstance(), canonicalWorktreeId(id), body) : memError('invalid_request');
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    const outcome = memInternalError('mem-now-failed', error);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
}
