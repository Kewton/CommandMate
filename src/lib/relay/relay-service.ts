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
import { getLastUserMessageForInstance, parseRelayRequestId } from '@/lib/db/chat-db';
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
 * The depth of the relay whose delivery this session is currently answering.
 *
 * Read from the newest USER row of the requesting session: if that row is the
 * one a relay delivered (`request_id` = `relay:<id>`), then whatever the session
 * is doing now was set in motion by a relay, and a new relay opened from here is
 * a chain. An assistant row in between does not clear it — the session replying
 * is exactly the case the guard is about.
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
    const lastUser = getLastUserMessageForInstance(
      db,
      from.worktreeId,
      resolved.cliToolId,
      from.instanceId
    );
    if (!lastUser || lastUser.messageType !== 'relay') return null;

    const parentId = parseRelayRequestId(lastUser.requestId);
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
