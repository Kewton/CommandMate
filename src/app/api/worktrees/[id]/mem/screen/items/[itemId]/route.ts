/**
 * `PATCH /api/worktrees/:id/mem/screen/items/:itemId` — `{ instanceId, ifVersion, text?,
 * closeWhen?, evidence? }`. A person edits an item of this worktree's branch from the
 * screen. A stale `ifVersion` is 409 `version_conflict` with the stored item, so the
 * screen can lay the draft, what it read and what is there now side by side.
 *
 * Screen only (403 `screen_only`). Mode `on` only. Issue #4227, design §2.3・§2.4.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { isScreenRequest } from '@/lib/security/screen-request';
import { memError, memInternalError, memWriteFromScreen, readMemBody } from '@/lib/mem/service';

export const dynamic = 'force-dynamic';

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  try {
    const { id, itemId } = await params;
    if (!isScreenRequest(request)) {
      const refused = memError('screen_only');
      return NextResponse.json(refused.body, { status: refused.status });
    }
    const body = await readMemBody(request);
    const outcome = body
      ? await memWriteFromScreen(getDbInstance(), request, canonicalWorktreeId(id), { op: 'update', author: 'human', itemId, body })
      : memError('invalid_request');
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    const outcome = memInternalError('mem-screen-update-failed', error);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
}
