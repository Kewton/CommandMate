/**
 * `POST /api/worktrees/:id/mem/handoff/requests/:rid/proposals/:pid/rebase` `{ ifVersion,
 * fingerprint }` — a proposal in conflict moves onto the item's current version (§4.5.1,
 * Issue #4227): a new revision and fingerprint, to be shown and approved again. Confirms
 * nothing. Screen only; mode `on`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { isScreenRequest } from '@/lib/security/screen-request';
import { memError, memInternalError, readMemBody } from '@/lib/mem/service';
import { handoffError } from '@/lib/handoff/common';
import { handoffRebase } from '@/lib/handoff/proposals';

export const dynamic = 'force-dynamic';

const answer = (outcome: { status: number; body: unknown }) => NextResponse.json(outcome.body, { status: outcome.status });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; rid: string; pid: string }> }) {
  try {
    const p = await params;
    if (!isScreenRequest(request)) return answer(handoffError('screen_only'));
    const body = await readMemBody(request);
    if (!body) return answer(memError('invalid_request'));
    return answer(await handoffRebase(getDbInstance(), request, canonicalWorktreeId(p.id), p.rid, p.pid, body));
  } catch (error: unknown) {
    return answer(memInternalError('handoff-rebase-failed', error));
  }
}
