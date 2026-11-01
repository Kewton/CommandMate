/**
 * API Route: POST /api/relays/:relayId/resolve — settle an `uncertain`
 * delivery hold (Issue #4082).
 *
 * Body: `{ payloadId, attemptId, action: 'confirm' | 'retry' | 'discard' }`,
 * the payload and attempt read off the relay's `deliveryHold`. The hold is
 * settled only while it still names that payload and that attempt, so an
 * operation read off an older screen (the payload was retried since) and a
 * second operation on the same hold are refused.
 *
 *  - 200 `{ relay, action, requeued, promoted }` — settled. For `retry` this
 *    means "queued for delivery again", not "delivered": the pump sends it
 *    when the requester can take it.
 *  - 400 — malformed id or body.
 *  - 404 — no such relay.
 *  - 409 — stale payload/attempt, a delivery in progress (`attempting`), no
 *    hold, a hold without an attempt id, or an action the hold does not allow
 *    (a closed relay's reply/prompt retried, a deadline passed).
 *  - 500 — the database refused a write; nothing was committed.
 *
 * `confirm` and `discard` type nothing.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { resolveRelayHold } from '@/lib/relay/relay-service';
import { requestRelayPump } from '@/lib/relay/relay-delivery';
import { RELAY_HOLD_ACTIONS, type RelayHoldAction } from '@/lib/relay/types';
import type { RelayHoldRefusal } from '@/lib/db/relay-db';
import { readJsonObjectBody } from '@/lib/api/read-json-body';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/relay-resolve');

/** crypto.randomUUID() output; anything else was never a relay id. */
const RELAY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Longest payload / attempt id accepted; the ledger mints UUIDs. */
const MAX_ID_LENGTH = 200;

interface ResolveBody {
  payloadId?: unknown;
  attemptId?: unknown;
  action?: unknown;
}

/** The stable `code` per refusal; the CLI branches on it. */
const REFUSAL_CODES: Record<Exclude<RelayHoldRefusal, 'not_found'>, string> = {
  no_hold: 'RELAY_HOLD_NOT_FOUND',
  attempting: 'RELAY_HOLD_ATTEMPTING',
  stale: 'RELAY_HOLD_STALE',
  not_allowed: 'RELAY_HOLD_NOT_ALLOWED',
};

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ relayId: string }> }
) {
  try {
    const { relayId } = await params;
    if (!RELAY_ID_PATTERN.test(relayId)) {
      return NextResponse.json({ error: 'Invalid relay ID format' }, { status: 400 });
    }
    const parsed = await readJsonObjectBody<ResolveBody>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    if (!isId(body.payloadId)) {
      return NextResponse.json({ error: 'payloadId must be a non-empty string' }, { status: 400 });
    }
    // `null` is well formed — it is what a hold without an attempt id reads
    // as — and is refused below with 409, never matched.
    if (body.attemptId !== null && !isId(body.attemptId)) {
      return NextResponse.json({ error: 'attemptId must be a non-empty string' }, { status: 400 });
    }
    if (typeof body.action !== 'string' || !RELAY_HOLD_ACTIONS.includes(body.action as RelayHoldAction)) {
      return NextResponse.json(
        { error: `action must be one of: ${RELAY_HOLD_ACTIONS.join(', ')}` },
        { status: 400 }
      );
    }
    const action = body.action as RelayHoldAction;

    const result = resolveRelayHold(getDbInstance(), {
      relayId,
      payloadId: body.payloadId,
      attemptId: body.attemptId as string | null,
      action,
    });
    if (!result.ok) {
      if (result.refusal === 'not_found') {
        return NextResponse.json({ error: 'Relay not found' }, { status: 404 });
      }
      return NextResponse.json(
        { error: result.message, code: REFUSAL_CODES[result.refusal], relay: result.relay },
        { status: 409 }
      );
    }

    // A queued payload or a promoted reply goes out through the pump.
    if (result.requeued || result.promoted) requestRelayPump();

    return NextResponse.json(
      { relay: result.relay, action, requeued: result.requeued, promoted: result.promoted },
      { status: 200 }
    );
  } catch (error: unknown) {
    logger.error('error-resolving-relay-hold:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to resolve relay hold' }, { status: 500 });
  }
}
