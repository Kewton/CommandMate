/**
 * API Route: GET /api/worktrees/:id/verify/runs/:runId
 * Returns one verification run with its gate results (Issue #1543).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getVerificationRun, getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/verify-run');

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; runId: string }> }
) {
  try {
    const { id, runId } = await params;
    if (!isValidWorktreeId(id)) {
      return NextResponse.json({ error: 'Invalid worktree ID format' }, { status: 400 });
    }

    if (!/^[1-9]\d*$/.test(runId)) {
      return NextResponse.json({ error: 'Invalid run ID format' }, { status: 400 });
    }

    const db = getDbInstance();
    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json({ error: `Worktree '${id}' not found` }, { status: 404 });
    }

    const run = getVerificationRun(db, Number(runId));
    // Run ids are global, so a run belonging to another worktree is reported as
    // absent here rather than returned under this worktree's URL.
    if (!run || run.worktreeId !== id) {
      return NextResponse.json({ error: 'Verification run not found' }, { status: 404 });
    }

    return NextResponse.json({ run }, { status: 200 });
  } catch (error: unknown) {
    logger.error('error-fetching-verification-run:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to fetch verification run' }, { status: 500 });
  }
}
