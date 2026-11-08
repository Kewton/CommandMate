/**
 * `PATCH /api/worktrees/:id/mem/items/:itemId` — `{ instanceId, ifVersion, text?, closeWhen?, evidence? }`.
 * Only the author's incarnation may change it; a stale `ifVersion` is 409 with the
 * stored item. Mode `on` only. Issue #4221, design §3・§12.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { memError, memInternalError, memUpdateItem, readMemBody } from '@/lib/mem/service';

export const dynamic = 'force-dynamic';

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  try {
    const { id, itemId } = await params;
    const body = await readMemBody(request);
    const outcome = body
      ? await memUpdateItem(getDbInstance(), canonicalWorktreeId(id), itemId, body)
      : memError('invalid_request');
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    const outcome = memInternalError('mem-update-failed', error);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
}
