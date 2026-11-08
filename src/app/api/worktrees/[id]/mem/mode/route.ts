/**
 * `GET /api/worktrees/:id/mem/mode` — the mode of the worktree's branch (or `?branch=`)
 * and the rule that decided it. Read-only: the mode is changed from the screen only
 * (`/api/repositories/:id/mem-settings`). Issue #4221, design §4・§12.2.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { memInternalError, memMode } from '@/lib/mem/service';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const branch = new URL(request.url).searchParams.get('branch');
    const outcome = await memMode(getDbInstance(), {
      via: 'worktree',
      worktreeId: canonicalWorktreeId(id),
      ...(branch ? { branch } : {}),
    });
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    const outcome = memInternalError('mem-mode-failed', error);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
}
