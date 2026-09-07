/**
 * Opening and withdrawing a relay (Issue #2377).
 *
 * The write half of the ledger's public surface: `POST /api/relays` and
 * `POST /api/relays/:id/cancel` are thin wrappers around the two functions
 * here, and `commandmate send --reply-to` reaches them through those routes.
 * The delivery half — what happens when B finishes — is `relay-delivery`.
 *
 * ## Why the loop guard is read here and not in the CLI
 *
 * "Was the last thing this session was told a relayed message?" is a question
 * about `chat_messages`, and the CLI has no database. Asking the server also
 * makes the answer the same one the delivery path will use, which matters:
 * the guard and the thing it guards must not have two ideas about which relay
 * is in play.
 *
 * @module lib/relay/relay-service
 */

import type Database from 'better-sqlite3';
import {
  countOpenRelaysBetween,
  createRelay,
  cancelRelay as cancelRelayRow,
  getRelayById,
  getSessionRelaySummary,
} from '@/lib/db/relay-db';
import { getMessages, parseRelayRequestId } from '@/lib/db/chat-db';
import { normalizeUserTurnContent } from '@/lib/history/user-turn-recorder';
import type { ChatMessage } from '@/types/models';
import type { RelayEndpoint, SessionRelay, SessionRelaySummary } from '@/lib/relay/types';
import {
  decideRelayCreation,
  isRelayRefusal,
  resolveRelayTtlMs,
  type RelayRefusal,
} from '@/lib/relay/relay-policy';
import { relayWorktreeExists, resolveRelaySession } from '@/lib/relay/relay-session-ref';
import { writeRelaySystemLine } from '@/lib/relay/relay-system-line';
import { createLogger } from '@/lib/logger';

const logger = createLogger('relay-service');

/** What {@link openRelay} is asked for. */
export interface OpenRelayInput {
  /** The session that asked, and is owed the answer. */
  from: RelayEndpoint;
  /** The session that was asked. */
  to: RelayEndpoint;
  /** Whether the caller passed `--allow-relay-chain`. */
  allowRelayChain?: boolean;
  /** Requested lifetime in ms; clamped by {@link resolveRelayTtlMs}. */
  ttlMs?: number;
  /** Epoch ms; injectable so a suite does not race the wall clock. */
  now?: number;
}

/** A refusal that names which endpoint was not found. */
export interface RelayEndpointMissing {
  code: 'RELAY_WORKTREE_NOT_FOUND';
  message: string;
  worktreeId: string;
}

/** Everything {@link openRelay} can answer. */
export type OpenRelayResult =
  | { ok: true; relay: SessionRelay }
  | { ok: false; refusal: RelayRefusal | RelayEndpointMissing };

/**
 * How many of the requesting session's recent turns the parent lookup reads.
 *
 * Bounded in **user turns** rather than rows — `limitUnit: 'pairs'` — because a
 * single codex turn can emit dozens of assistant rows, and a row-counted window
 * would slide the user rows this lookup is entirely about out of range. Five is
 * far above the one echo a delivery actually produces (see
 * {@link isEchoOfRelayRow}) and small enough that an unrelated relay from
 * further back in the transcript can never be mistaken for the parent.
 */
const PARENT_RELAY_LOOKBACK_TURNS = 5;

/**
 * Whether `candidate` is a transcript reader's second copy of `relayRow`.
 *
 * Issue #2387. A delivery writes ONE `relay` user row, and then the agent's own
 * transcript reader writes the same prompt a second time — measured at 662ms
 * later — as an ordinary `normal` row keyed `<tool>-prompt:<id>`. The
 * de-duplication in `recordUserTurn` cannot suppress it: that path only claims
 * rows with **no** `request_id`, and a relay row carries `relay:<id>` precisely
 * so the ledger can be read back from it. Same worktree, same tool, same
 * instance, same body — the timestamp and the body are the whole signature.
 *
 * Compared through `normalizeUserTurnContent` because that is the function the
 * duplicating writer itself put the text through, so "the same body" means here
 * exactly what it meant there. A candidate that fails the comparison is a
 * genuinely different message and ends the chain, which is what keeps a human
 * taking the session over from being read as a relay still in flight.
 */
function isEchoOfRelayRow(candidate: ChatMessage, relayRow: ChatMessage): boolean {
  if (candidate.timestamp.getTime() < relayRow.timestamp.getTime()) return false;
  return (
    normalizeUserTurnContent(candidate.content) === normalizeUserTurnContent(relayRow.content)
  );
}

/**
 * The depth of the relay whose delivery this session is currently answering.
 *
 * Read from the newest USER rows of the requesting session: if the newest one
 * that is not a duplicate of a delivery is the row a relay delivered
 * (`request_id` = `relay:<id>`), then whatever the session is doing now was set
 * in motion by a relay, and a new relay opened from here is a chain. An
 * assistant row in between does not clear it — the session replying is exactly
 * the case the guard is about.
 *
 * ## Why this reads a window and not the single newest row
 *
 * Issue #2387: it used to ask `getLastUserMessageForInstance` for the one newest
 * user row and require *that* row to be a relay. The transcript reader's echo
 * (see {@link isEchoOfRelayRow}) becomes the newest row 662ms after every
 * delivery, so from then on the parent was invisible and every chained relay was
 * recorded at `hops = 1`. Both halves of #2377's guard went with it: the depth
 * ceiling never counted past one, and the default refusal only fired inside that
 * sub-second window — a chain blocked or permitted by how fast the operator was.
 *
 * So the window is scanned newest-first for the relay row, and every user row
 * NEWER than it must be an echo of it. Skipping unconditionally would be the
 * cheaper fix and the wrong one: an ordinary message typed after the delivery is
 * the operator taking the session over, and #2377 decided that ends the chain.
 *
 * `getMessages` — already the reader `relay-delivery` uses for the other side of
 * the ledger — rather than a new query, so the two halves of the guard keep
 * reading `chat_messages` through one filter, `matchResolvedInstance` included.
 *
 * Null when the session was not asked by a relay, when the relay it names has
 * since been deleted, or when the ledger cannot be read: the fail-open direction
 * is "this is not a chain", because the alternative is refusing an ordinary
 * first delegation because a lookup failed.
 */
export function findParentRelayHops(
  db: Database.Database,
  from: RelayEndpoint
): number | null {
  try {
    const resolved = resolveRelaySession(db, from);
    // `getMessages` answers newest-first, and bounds by turns, so the user rows
    // survive however many assistant rows the turn in front of them emitted.
    const recentUserRows = getMessages(db, from.worktreeId, {
      limit: PARENT_RELAY_LOOKBACK_TURNS,
      limitUnit: 'pairs',
      cliToolId: resolved.cliToolId,
      instanceId: from.instanceId,
      matchResolvedInstance: true,
    }).filter((message) => message.role === 'user');

    const parentIndex = recentUserRows.findIndex((row) => row.messageType === 'relay');
    if (parentIndex === -1) return null;

    // Stop at the FIRST relay row rather than searching on past it: a row that
    // names a relay the ledger no longer holds is still the thing this session
    // was last told, and answering "no parent" for it is the documented
    // fail-open. Searching on would reach behind it for an older, unrelated
    // relay and report that one's depth instead.
    const parentRow = recentUserRows[parentIndex];
    for (let i = 0; i < parentIndex; i += 1) {
      if (!isEchoOfRelayRow(recentUserRows[i], parentRow)) return null;
    }

    const parentId = parseRelayRequestId(parentRow.requestId);
    if (!parentId) return null;
    return getRelayById(db, parentId)?.hops ?? null;
  } catch (error) {
    logger.warn('relay-parent-lookup-failed', {
      worktreeId: from.worktreeId,
      instanceId: from.instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Open a relay, or say why not.
 *
 * The system line is written on success and only on success — a refused relay
 * must not leave "delegated, waiting for the reply" in a transcript that will
 * never see a reply.
 */
export function openRelay(db: Database.Database, input: OpenRelayInput): OpenRelayResult {
  for (const worktreeId of [input.from.worktreeId, input.to.worktreeId]) {
    if (!relayWorktreeExists(db, worktreeId)) {
      return {
        ok: false,
        refusal: {
          code: 'RELAY_WORKTREE_NOT_FOUND',
          message: `Worktree '${worktreeId}' not found`,
          worktreeId,
        },
      };
    }
  }

  const verdict = decideRelayCreation({
    from: input.from,
    to: input.to,
    parentHops: findParentRelayHops(db, input.from),
    allowRelayChain: input.allowRelayChain === true,
    openBetween: countOpenRelaysBetween(db, input.from, input.to),
  });
  if (isRelayRefusal(verdict)) return { ok: false, refusal: verdict };

  const now = input.now ?? Date.now();
  const relay = createRelay(db, {
    from: input.from,
    to: input.to,
    hops: verdict.hops,
    expiresAt: now + resolveRelayTtlMs(input.ttlMs),
    now,
  });

  logger.info('relay-opened', {
    relayId: relay.id,
    from: `${relay.from.worktreeId}/${relay.from.instanceId}`,
    to: `${relay.to.worktreeId}/${relay.to.instanceId}`,
    hops: relay.hops,
  });

  writeRelaySystemLine(
    db,
    relay.id,
    'requested',
    resolveRelaySession(db, relay.from),
    resolveRelaySession(db, relay.to),
    now
  );

  return { ok: true, relay };
}

/** What {@link withdrawRelay} answers. */
export type WithdrawRelayResult =
  | { ok: true; relay: SessionRelay }
  | { ok: false; reason: 'not_found' | 'already_closed'; relay: SessionRelay | null };

/**
 * Withdraw a relay.
 *
 * "Already closed" is reported rather than swallowed: telling a caller it
 * cancelled a relay that in fact delivered its reply an hour ago is the one
 * answer that would make them stop looking for it.
 */
export function withdrawRelay(
  db: Database.Database,
  relayId: string,
  now = Date.now()
): WithdrawRelayResult {
  const existing = getRelayById(db, relayId);
  if (!existing) return { ok: false, reason: 'not_found', relay: null };
  if (!cancelRelayRow(db, relayId, now)) {
    return { ok: false, reason: 'already_closed', relay: existing };
  }
  logger.info('relay-cancelled', { relayId });
  return { ok: true, relay: getRelayById(db, relayId) ?? existing };
}

/** The open relays at both ends of one session. */
export function readSessionRelays(
  db: Database.Database,
  endpoint: RelayEndpoint
): SessionRelaySummary {
  return getSessionRelaySummary(db, endpoint);
}
