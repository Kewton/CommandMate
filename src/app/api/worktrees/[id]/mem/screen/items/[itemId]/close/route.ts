/**
 * `POST /api/worktrees/:id/mem/screen/items/:itemId/close` — `{ instanceId, ifVersion,
 * reason?, confirmUnreflected? }`. A person closes an item: the version is compared and
 * the item closed in one transaction (409 `version_conflict` if someone changed it
 * since). A recorded decision needs `confirmUnreflected: true` (409
 * `confirmation_required` without it) and is closed as `withdrawn` — the CLI's
 * `mem close` still refuses it.
 *
 * Screen only (403 `screen_only`). Mode `on` only. Issue #4227, design §2.3・§6 S2.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { isScreenRequest } from '@/lib/security/screen-request';
import { memError, memInternalError, memWriteFromScreen, readMemBody } from '@/lib/mem/service';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  try {
    const { id, itemId } = await params;
    if (!isScreenRequest(request)) {
      const refused = memError('screen_only');
      return NextResponse.json(refused.body, { status: refused.status });
    }
    const body = await readMemBody(request);
    const outcome = body
      ? await memWriteFromScreen(getDbInstance(), request, canonicalWorktreeId(id), { op: 'close', author: 'human', itemId, body })
      : memError('invalid_request');
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    const outcome = memInternalError('mem-screen-close-failed', error);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
}
