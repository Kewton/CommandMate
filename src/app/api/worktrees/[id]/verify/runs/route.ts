/**
 * API Route: GET /api/worktrees/:id/verify/runs
 * Lists recent verification runs for a worktree, newest first (Issue #1543).
 *
 * Gate results are deliberately omitted: a list view wants verdicts, and
 * log tails are large enough that including them would make the common case
 * pay for the detail view.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById, listVerificationRuns } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { createLogger } from '@/lib/logger';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';

const logger = createLogger('api/verify-runs');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: requestedWorktreeId } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);
    if (!isValidWorktreeId(id)) {
      return NextResponse.json({ error: 'Invalid worktree ID format' }, { status: 400 });
    }

    const db = getDbInstance();
    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json({ error: `Worktree '${id}' not found` }, { status: 404 });
    }

    const limitParam = new URL(request.url).searchParams.get('limit');
    let limit = DEFAULT_LIMIT;
    if (limitParam !== null) {
      const parsed = Number(limitParam);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
        return NextResponse.json(
          { error: `limit must be an integer 1..${MAX_LIMIT}` },
          { status: 400 }
        );
      }
      limit = parsed;
    }

    return NextResponse.json({ runs: listVerificationRuns(db, id, limit) }, { status: 200 });
  } catch (error: unknown) {
    logger.error('error-listing-verification-runs:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to list verification runs' }, { status: 500 });
  }
}
