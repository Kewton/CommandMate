/**
 * `POST /api/worktrees/:id/mem/handoff/requests` `{ instanceId }` — the screen's "end" on a branch
 * set to be attended with mode `on` asks the agent for its hand-off (Issue #4227, design
 * `mem-ui-4227.md` §4.1 ①・§4.3). Answers the request and the fixed text the screen sends.
 * 409 `request_open` (with it) when one is live, `session_unknown` with no conversation,
 * `unattended` with `popup` off. Screen only (403 `screen_only`). Kills nothing.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { isScreenRequest } from '@/lib/security/screen-request';
import { memError, memInternalError, readMemBody } from '@/lib/mem/service';
import { handoffError } from '@/lib/handoff/common';
import { handoffCreate } from '@/lib/handoff/request';

export const dynamic = 'force-dynamic';

const answer = (outcome: { status: number; body: unknown }) => NextResponse.json(outcome.body, { status: outcome.status });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const p = await params;
    if (!isScreenRequest(request)) return answer(handoffError('screen_only'));
    const body = await readMemBody(request);
    if (!body) return answer(memError('invalid_request'));
    return answer(await handoffCreate(getDbInstance(), request, canonicalWorktreeId(p.id), body));
  } catch (error: unknown) {
    return answer(memInternalError('handoff-create-failed', error));
  }
}
