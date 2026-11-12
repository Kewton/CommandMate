/**
 * `GET /api/worktrees/:id/mem/brief?instance=&budget=&format=text|json&all=1` — the brief
 * of one instance: the state CommandMate derives and the branch's mem items, within a
 * UTF-8 byte budget. A read: no notice is reserved or acknowledged, and `on` evaluates
 * the close conditions as `mem list` does. `off` answers 409 `disabled`.
 * Issue #4223, design `docs/design/brief-4223.md` §5.6・§6.
 * `&sessionStart=1` (Issue #4224, `commandmate brief --session-start`): an empty text marked
 * `deferred: 'send'` when the send path briefs the conversation instead.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { briefForRoute } from '@/lib/brief/service';
import { memInternalError } from '@/lib/mem/service';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const query = new URL(request.url).searchParams;
    const outcome = await briefForRoute(getDbInstance(), canonicalWorktreeId(id), {
      instance: query.get('instance'),
      budget: query.get('budget'),
      format: query.get('format'),
      all: query.get('all'),
      sessionStart: query.get('sessionStart'),
    });
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    const outcome = memInternalError('mem-brief-failed', error);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
}
