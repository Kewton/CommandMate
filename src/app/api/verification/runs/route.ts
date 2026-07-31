/**
 * API Route: GET /api/verification/runs?worktreeId=&days=&limit=
 * Verification run history across worktrees, newest first (Issue #1593).
 *
 * The sibling route under /api/worktrees/:id/verify/runs answers "what happened
 * in this worktree"; this one answers "what happened in this repository", which
 * is the question verify.yaml tuning (#1594) actually asks.
 *
 * Each run carries its gate verdicts but no log bodies — see
 * VerificationGateSummary. A listing of 500 runs with log tails attached would
 * be megabytes, and the detail route already serves the one run you care about.
 *
 * `worktreeId` is a filter, not a path segment, so an id that matches nothing
 * yields an empty list rather than a 404. Authentication is the middleware's
 * job, as with every other /api route.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import {
  listVerificationRunsForPeriod,
  DEFAULT_RUN_HISTORY_LIMIT,
  MAX_RUN_HISTORY_LIMIT,
  MAX_RUN_HISTORY_DAYS,
} from '@/lib/db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/verification-runs');

/** Parse a bounded integer query param. Returns undefined when absent. */
function parseBounded(
  value: string | null,
  min: number,
  max: number
): { ok: true; value: number | undefined } | { ok: false } {
  if (value === null) return { ok: true, value: undefined };
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return { ok: false };
  return { ok: true, value: parsed };
}

export async function GET(request: NextRequest) {
  try {
    const params = new URL(request.url).searchParams;

    const worktreeId = params.get('worktreeId');
    if (worktreeId !== null && !isValidWorktreeId(worktreeId)) {
      return NextResponse.json({ error: 'Invalid worktree ID format' }, { status: 400 });
    }

    const days = parseBounded(params.get('days'), 1, MAX_RUN_HISTORY_DAYS);
    if (!days.ok) {
      return NextResponse.json(
        { error: `days must be an integer 1..${MAX_RUN_HISTORY_DAYS}` },
        { status: 400 }
      );
    }

    const limit = parseBounded(params.get('limit'), 1, MAX_RUN_HISTORY_LIMIT);
    if (!limit.ok) {
      return NextResponse.json(
        { error: `limit must be an integer 1..${MAX_RUN_HISTORY_LIMIT}` },
        { status: 400 }
      );
    }

    const runs = listVerificationRunsForPeriod(getDbInstance(), {
      worktreeId: worktreeId ?? undefined,
      days: days.value,
      limit: limit.value ?? DEFAULT_RUN_HISTORY_LIMIT,
    });

    return NextResponse.json({ runs }, { status: 200 });
  } catch (error: unknown) {
    logger.error('error-listing-verification-run-history:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to list verification runs' }, { status: 500 });
  }
}
