/**
 * `POST /api/worktrees/:id/mem/suggest` — `{ instanceId?, full, hook? }`. The prompts to
 * update mem (Issue #4226, design `docs/design/mem-prompt-4226.md` §3.1). `full: true`
 * runs B's evaluation (it may close what is met, as `mem list` does); `full: false`
 * (quiet) asks no condition and records what it showed. Both have side effects, so POST.
 *
 * The route's awaits are `params`, the body (W1 of the design's table) and `memSuggest`,
 * in that order, and nothing but the JSON answer comes after `memSuggest`
 * (`tests/unit/guards/mem-suggest-await-table-4226.test.ts`).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { memError, memInternalError, readMemBody } from '@/lib/mem/service';
import { memSuggest } from '@/lib/mem-suggest/service';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readMemBody(request);
    if (!body) {
      const refused = memError('invalid_request');
      return NextResponse.json(refused.body, { status: refused.status });
    }
    const outcome = await memSuggest(getDbInstance(), canonicalWorktreeId(id), body);
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error: unknown) {
    const outcome = memInternalError('mem-suggest-failed', error);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
}
