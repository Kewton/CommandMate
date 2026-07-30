/**
 * API Route: GET /api/metrics/vibe?days=7
 * Eval metrics over tasks / verification runs / task events (Issue #1551).
 *
 * Read-only aggregation, so there is nothing to validate beyond the window.
 * Authentication is the middleware's job, as with every other /api route.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { computeVibeMetrics, MAX_METRICS_DAYS } from '@/lib/metrics/vibe-metrics';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/metrics-vibe');

const DEFAULT_DAYS = 7;

export async function GET(request: NextRequest) {
  try {
    const daysParam = new URL(request.url).searchParams.get('days');
    let days = DEFAULT_DAYS;
    if (daysParam !== null) {
      const parsed = Number(daysParam);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_METRICS_DAYS) {
        return NextResponse.json(
          { error: `days must be an integer 1..${MAX_METRICS_DAYS}` },
          { status: 400 }
        );
      }
      days = parsed;
    }

    const metrics = computeVibeMetrics(getDbInstance(), { days });
    return NextResponse.json({ metrics }, { status: 200 });
  } catch (error: unknown) {
    logger.error('error-computing-vibe-metrics:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to compute vibe metrics' }, { status: 500 });
  }
}
