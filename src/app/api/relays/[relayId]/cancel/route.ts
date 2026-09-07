/**
 * API Route: POST /api/relays/:relayId/cancel — withdraw a relay (Issue #2377).
 *
 * A separate endpoint rather than a `DELETE` on the collection, for the reason
 * `POST /api/tasks/:taskId/cancel` is one: cancelling is a decision about work
 * in flight, not the removal of a record. The row stays, in state `cancelled`,
 * because "somebody withdrew this" is the answer to "why did my reply never
 * arrive" and deleting it would leave that question unanswerable.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { withdrawRelay } from '@/lib/relay/relay-service';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/relay-cancel');

/** crypto.randomUUID() output; anything else was never a relay id. */
const RELAY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ relayId: string }> }
) {
  try {
    const { relayId } = await params;
    if (!RELAY_ID_PATTERN.test(relayId)) {
      return NextResponse.json({ error: 'Invalid relay ID format' }, { status: 400 });
    }

    const result = withdrawRelay(getDbInstance(), relayId);
    if (!result.ok && result.reason === 'not_found') {
      return NextResponse.json({ error: 'Relay not found' }, { status: 404 });
    }
    if (!result.ok) {
      // Reporting this as success would tell the caller they stopped a delivery
      // that in fact happened an hour ago.
      return NextResponse.json(
        {
          error: `Relay is already ${result.relay?.state} and cannot be cancelled`,
          code: 'RELAY_ALREADY_CLOSED',
        },
        { status: 409 }
      );
    }

    return NextResponse.json({ relay: result.relay }, { status: 200 });
  } catch (error: unknown) {
    logger.error('error-cancelling-relay:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to cancel relay' }, { status: 500 });
  }
}
