/**
 * `POST /api/worktrees/:id/mem/items` — add one item:
 * `{ instanceId, kind, text, closeWhen?, promoteTo?, quote?, quoteAt?, evidence?, key? }`.
 * Mode `on` only; `key` makes a retry return the first answer. Issue #4221, design §5.4.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { memAddItem, memError, memInternalError, readMemBody } from '@/lib/mem/service';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readMemBody(request);
    const outcome = body ? await memAddItem(getDbInstance(), canonicalWorktreeId(id), body) : memError('invalid_request');
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    const outcome = memInternalError('mem-add-failed', error);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
}
