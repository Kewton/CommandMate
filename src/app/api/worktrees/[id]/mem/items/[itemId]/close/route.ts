/**
 * `POST /api/worktrees/:id/mem/items/:itemId/close` — `{ instanceId, reason? }`. A manual
 * close by the author (a withdrawal for an open decision). Mode `on` only.
 * Issue #4221, design §3.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { memCloseItem, memError, memInternalError, readMemBody } from '@/lib/mem/service';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  try {
    const { id, itemId } = await params;
    const body = await readMemBody(request);
    const outcome = body
      ? await memCloseItem(getDbInstance(), canonicalWorktreeId(id), itemId, body)
      : memError('invalid_request');
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    const outcome = memInternalError('mem-close-failed', error);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
}
