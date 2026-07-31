/**
 * API Route: GET /api/verification/runs/:runId
 * One verification run with every gate result and its log tail (Issue #1593).
 *
 * Run ids are globally unique, so this route resolves one without knowing which
 * worktree it belongs to — which is what a history listing hands its caller.
 * The worktree-scoped sibling stays as-is for callers that already have an id
 * and want the run confirmed to belong to it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getVerificationRun } from '@/lib/db';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/verification-run');

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  try {
    const { runId } = await params;
    if (!/^[1-9]\d*$/.test(runId)) {
      return NextResponse.json({ error: 'Invalid run ID format' }, { status: 400 });
    }

    const run = getVerificationRun(getDbInstance(), Number(runId));
    if (!run) {
      return NextResponse.json({ error: 'Verification run not found' }, { status: 404 });
    }

    return NextResponse.json({ run }, { status: 200 });
  } catch (error: unknown) {
    logger.error('error-fetching-verification-run-detail:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to fetch verification run' }, { status: 500 });
  }
}
