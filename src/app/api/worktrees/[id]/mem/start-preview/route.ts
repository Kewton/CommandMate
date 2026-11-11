/**
 * `GET /api/worktrees/:id/mem/start-preview?instance=` — G-3's preview (Issue #4227
 * G-PR3, design `mem-ui-4227.md` §3.1): whether the screen asks before the first send after a
 * boundary (attended, mode `on` / `derived`, `injectOnStart`, a `pending` boundary) and its
 * three lines. A read: no mark is needed, no boundary, notice or reservation is taken.
 * Not under `mem/screen/` (those are the person's writes, each with the mark — the guard
 * `mem-screen-write-4227` keeps that directory to them).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { memInternalError } from '@/lib/mem/service';
import { handoffStartPreview } from '@/lib/handoff/preview';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const instance = new URL(request.url).searchParams.get('instance');
    const outcome = await handoffStartPreview(getDbInstance(), canonicalWorktreeId(id), instance);
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    const outcome = memInternalError('mem-start-preview-failed', error);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
}
