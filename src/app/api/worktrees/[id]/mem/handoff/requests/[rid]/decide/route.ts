/**
 * `POST /api/worktrees/:id/mem/handoff/requests/:rid/decide` `{ ifVersion, decisions: [{ proposalId,
 * fingerprint, action: 'approve' | 'discard' }] }` — a person approves or discards the
 * proposals; the approved ones are confirmed against the item's version, one by one, each in
 * its own transaction (§4.5, Issue #4227). The only way a proposal becomes an item. Screen
 * only; mode `on`. Kills nothing.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { isScreenRequest } from '@/lib/security/screen-request';
import { memError, memInternalError, readMemBody } from '@/lib/mem/service';
import { handoffError } from '@/lib/handoff/common';
import { handoffDecide } from '@/lib/handoff/decide';

export const dynamic = 'force-dynamic';

const answer = (outcome: { status: number; body: unknown }) => NextResponse.json(outcome.body, { status: outcome.status });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; rid: string }> }) {
  try {
    const p = await params;
    if (!isScreenRequest(request)) return answer(handoffError('screen_only'));
    const body = await readMemBody(request);
    if (!body) return answer(memError('invalid_request'));
    return answer(await handoffDecide(getDbInstance(), request, canonicalWorktreeId(p.id), p.rid, body));
  } catch (error: unknown) {
    return answer(memInternalError('handoff-decide-failed', error));
  }
}
