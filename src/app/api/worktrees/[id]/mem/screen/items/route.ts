/**
 * `POST /api/worktrees/:id/mem/screen/items` — `{ instanceId, kind, text, closeWhen?,
 * evidence?, key, expectBranch }`. A person adds an item from the screen: the writer is
 * `human`, the owner is the chosen instance. `key` is made once per press (a resend is
 * the same item); `expectBranch` is the branch the screen shows (null: detached) and a
 * HEAD moved to another one answers 409 `membership_changed`, writing nothing.
 *
 * Screen only (403 `screen_only` without the mark; a check, not a guarantee:
 * `lib/security/screen-request.ts`). Mode `on` only. Issue #4227, design §2.3.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { isScreenRequest } from '@/lib/security/screen-request';
import { memError, memInternalError, memWriteFromScreen, readMemBody } from '@/lib/mem/service';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isScreenRequest(request)) {
      const refused = memError('screen_only');
      return NextResponse.json(refused.body, { status: refused.status });
    }
    const body = await readMemBody(request);
    const outcome = body
      ? await memWriteFromScreen(getDbInstance(), request, canonicalWorktreeId(id), { op: 'add', author: 'human', body })
      : memError('invalid_request');
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    const outcome = memInternalError('mem-screen-add-failed', error);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
}
