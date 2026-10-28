/**
 * API Route: GET /api/relays/:relayId — one relay, open or closed (Issue #3957).
 *
 * The list route shows only open relays, which answers "what is outstanding"
 * and not "what happened to the one I opened". A relay that was delivered with
 * an overlap note, held for a reason or cancelled after a failed send is read
 * here — and it is what the CLI asks when the send's own answer was lost on
 * the way back (`commandmate relays --id <id>`).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getRelayById } from '@/lib/db/relay-db';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/relay');

/** crypto.randomUUID() output; anything else was never a relay id. */
const RELAY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ relayId: string }> }
) {
  try {
    const { relayId } = await params;
    if (!RELAY_ID_PATTERN.test(relayId)) {
      return NextResponse.json({ error: 'Invalid relay ID format' }, { status: 400 });
    }
    const relay = getRelayById(getDbInstance(), relayId);
    if (!relay) {
      return NextResponse.json({ error: 'Relay not found' }, { status: 404 });
    }
    return NextResponse.json({ relay }, { status: 200 });
  } catch (error: unknown) {
    logger.error('error-reading-relay:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to read relay' }, { status: 500 });
  }
}
