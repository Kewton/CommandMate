/**
 * API Route: GET/POST /api/relays — the relay ledger (Issue #2377).
 *
 * `GET` answers the two questions every reader of a relay has: what does this
 * session owe, and what is it waiting for. `POST` opens one, and is where
 * `commandmate send --reply-to` lands.
 *
 * The loop guard lives behind `POST` rather than in the CLI because its input is
 * `chat_messages` — "was the last thing this session was told a relayed
 * message?" — which no CLI can read. See `lib/relay/relay-service`.
 *
 * Every refusal carries a stable `code`; the CLI branches on it and exits 2, so
 * a chain that was blocked reads as a decision rather than as an HTTP failure.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { countRelays, listOpenRelaysForWorktree } from '@/lib/db/relay-db';
import { openRelay, readSessionRelays } from '@/lib/relay/relay-service';
import { resolveRelayTtlMs } from '@/lib/relay/relay-policy';
import { isValidInstanceId } from '@/lib/cli-tools/types';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/relays');

/** Longest metrics window a `days` query may ask for. */
const MAX_RELAY_METRICS_DAYS = 90;

/** One endpoint as the request body spells it. */
interface RelayEndpointBody {
  worktreeId?: unknown;
  instanceId?: unknown;
}

interface CreateRelayBody {
  from?: RelayEndpointBody;
  to?: RelayEndpointBody;
  allowRelayChain?: unknown;
  ttlMs?: unknown;
}

/** Validate one endpoint, canonicalising the worktree id the way sends do. */
function readEndpoint(
  value: RelayEndpointBody | undefined,
  label: string
): { worktreeId: string; instanceId: string } | string {
  if (!value || typeof value.worktreeId !== 'string' || value.worktreeId.trim() === '') {
    return `${label}.worktreeId is required`;
  }
  if (typeof value.instanceId !== 'string' || !isValidInstanceId(value.instanceId)) {
    return `${label}.instanceId must be an alphanumeric/underscore/hyphen identifier`;
  }
  return {
    worktreeId: canonicalWorktreeId(value.worktreeId.trim()),
    instanceId: value.instanceId,
  };
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const rawWorktree = searchParams.get('worktree');
    const instanceId = searchParams.get('instance');
    const daysParam = searchParams.get('days');

    if (instanceId !== null && !isValidInstanceId(instanceId)) {
      return NextResponse.json({ error: 'Invalid instance parameter' }, { status: 400 });
    }

    let since: number | undefined;
    if (daysParam !== null) {
      const days = Number(daysParam);
      if (!Number.isInteger(days) || days < 1 || days > MAX_RELAY_METRICS_DAYS) {
        return NextResponse.json(
          { error: `days must be an integer 1..${MAX_RELAY_METRICS_DAYS}` },
          { status: 400 }
        );
      }
      since = Date.now() - days * 24 * 60 * 60 * 1000;
    }

    const db = getDbInstance();
    const worktreeId = rawWorktree ? canonicalWorktreeId(rawWorktree) : null;

    // The two-sided view is only meaningful for one session; a worktree-wide
    // query answers with everything open at either of its ends instead.
    const sided =
      worktreeId && instanceId
        ? readSessionRelays(db, { worktreeId, instanceId })
        : { owed: [], awaiting: [] };
    const open = worktreeId ? listOpenRelaysForWorktree(db, worktreeId) : [];

    return NextResponse.json(
      {
        owed: sided.owed,
        awaiting: sided.awaiting,
        open,
        counts: countRelays(db, {
          worktreeId: worktreeId ?? undefined,
          instanceId: worktreeId && instanceId ? instanceId : undefined,
          since,
        }),
      },
      { status: 200 }
    );
  } catch (error: unknown) {
    logger.error('error-listing-relays:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to list relays' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body: CreateRelayBody = await request.json();

    const from = readEndpoint(body.from, 'from');
    if (typeof from === 'string') {
      return NextResponse.json({ error: from }, { status: 400 });
    }
    const to = readEndpoint(body.to, 'to');
    if (typeof to === 'string') {
      return NextResponse.json({ error: to }, { status: 400 });
    }

    const ttlMs =
      typeof body.ttlMs === 'number' ? resolveRelayTtlMs(body.ttlMs) : undefined;

    const result = openRelay(getDbInstance(), {
      from,
      to,
      allowRelayChain: body.allowRelayChain === true,
      ttlMs,
    });

    if (!result.ok) {
      const { code, message } = result.refusal;
      // 404 for "that worktree does not exist", 409 for the four policy
      // refusals: the request was well formed and the server is healthy, the
      // arrangement it asks for is simply one the ledger will not hold.
      const status = code === 'RELAY_WORKTREE_NOT_FOUND' ? 404 : 409;
      return NextResponse.json({ error: message, code }, { status });
    }

    return NextResponse.json({ relay: result.relay }, { status: 201 });
  } catch (error: unknown) {
    logger.error('error-creating-relay:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to create relay' }, { status: 500 });
  }
}
