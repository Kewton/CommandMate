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
  resolveRelayDeliveryHold,
  type ResolveRelayDeliveryHoldResult,
} from '@/lib/db/relay-db';
import { getMessages, parseRelayRequestId, relayRequestId } from '@/lib/db/chat-db';
import { normalizeUserTurnContent } from '@/lib/history/user-turn-recorder';
import type { ChatMessage } from '@/types/models';
import {
  isOpenRelayState,
  type RelayEndpoint,
  type RelayHoldAction,
  type SessionRelay,
  type SessionRelaySummary,
} from '@/lib/relay/types';
import {
  decideRelayCreation,
  isRelayRefusal,
  isSameEndpoint,
  MAX_RELAY_ROUNDS,
  RELAY_ROUNDS_WINDOW_MS,
  resolveRelayTtlMs,
  type RelayRefusal,
} from '@/lib/relay/relay-policy';
import { isRelayDeliveryClaimed } from '@/lib/relay/relay-delivery-claims';
import { relayWorktreeExists, resolveRelaySession } from '@/lib/relay/relay-session-ref';
import { writeRelaySystemLine } from '@/lib/relay/relay-system-line';
import { readUsageDeclaration } from '@/lib/tool-policy/declaration';
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
  /**
   * Issue #3957: the caller will pass the relay id to the send that asks the
   * question (`bind: true`), and the relay is answered from that send only.
   */
  bind?: boolean;
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
 * that is not a duplicate of a delivery, nor the reply to one of this session's
 * own relays, is the row a relay delivered (`request_id` = `relay:<id>`), then
 * whatever the session is doing now was set in motion by a relay, and a new
 * relay opened from here is a chain. An assistant row in between does not clear
 * it — the session replying is exactly the case the guard is about.
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
 * ## Why the reply to this session's own relay is stepped over
 *
 * Issue #4420: `relay-delivery` writes a relay row into the REQUESTER's history
 * only, and the one keyed `relay:<id>` is the reply. Taking it for a parent made
 * "ask → read the reply → ask again" a chain on the second ask. A reply is the
 * answer to this session's question, not a request to it, so a relay row whose
 * relay this session opened (`relay.from`, worktree and instance id as the
 * ledger holds them) is stepped over together with its echoes, and the scan
 * goes on to what is behind it. The window stays the five turns it was: replies
 * and their echoes count against it, so a parent behind more of them than that
 * is not seen (the fail-open direction this lookup already had; known limit Q-4
 * of docs/design/relay-rounds-window-4420.md). The pace of such round trips is
 * capped elsewhere, from the ledger ({@link countRecentReplyRounds}).
 *
 * Each ordinary row is compared with the relay row right behind it only (the
 * next older one): an echo is never older than its own row, and a row that is
 * not an echo of that one is somebody typing.
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

    // Ordinary rows newer than the next relay row: each must be its echo.
    let newer: ChatMessage[] = [];
    for (const row of recentUserRows) {
      if (row.messageType !== 'relay') {
        newer.push(row);
        continue;
      }
      if (newer.some((candidate) => !isEchoOfRelayRow(candidate, row))) return null;
      newer = [];

      // Stop at the first relay row that is not this session's own reply,
      // rather than searching on past it: a row that names a relay the ledger
      // no longer holds, or a notice with no key, is still the thing this
      // session was last told, and answering "no parent" for it is the
      // documented fail-open. Searching on would reach behind it for an older,
      // unrelated relay and report that one's depth instead.
      const relayId = parseRelayRequestId(row.requestId);
      if (!relayId) return null;
      const relay = getRelayById(db, relayId);
      // Issue #4420: the answer to this session's own question — step over it.
      if (relay && isSameEndpoint(relay.from, from)) continue;
      return relay?.hops ?? null;
    }
    return null;
  } catch (error) {
    logger.warn('relay-parent-lookup-failed', {
      worktreeId: from.worktreeId,
      instanceId: from.instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** What {@link countRecentReplyRounds} answers (Issue #4420). */
export interface RecentReplyRounds {
  /** Replies to this session's own relays within the window. */
  count: number;
  /** Epoch ms of the oldest and the newest of them, or null when there are none. */
  oldestAt: number | null;
  newestAt: number | null;
}

/**
 * How many replies to its own relays the session `from` has received within
 * {@link RELAY_ROUNDS_WINDOW_MS} before `now` — the input of the round-trip
 * ceiling, {@link MAX_RELAY_ROUNDS} (Issue #4420, 案 Q,
 * docs/design/relay-rounds-window-4420.md §2.1).
 *
 * One synchronous COUNT over the ledger, and nothing else: a relay `from`
 * opened (worktree and instance id as written) whose reply was delivered —
 * `sent_request_id` is set only by a delivered reply, and `delivered_at` is in
 * the window — or whose reply's delivery is held `uncertain` (counted from
 * `delivery_at`, as if it had arrived: the strict side). Nothing in the history
 * is read, so no person's line, echo, notice, window edge or row order decides
 * it. Expired, cancelled and notice-only relays carry no `sent_request_id` and
 * are not counted; a held reply a person discards stops counting, and one they
 * confirm counts from the confirmation (known limits Q-8, Q-9).
 *
 * Synchronous, so `openRelay` stays one synchronous stretch (#4466). A database
 * that cannot be read throws, and no relay is opened.
 */
export function countRecentReplyRounds(
  db: Database.Database,
  from: RelayEndpoint,
  now: number
): RecentReplyRounds {
  const since = now - RELAY_ROUNDS_WINDOW_MS;
  const row = db
    .prepare(`
      SELECT COUNT(*) AS n, MIN(at) AS oldest, MAX(at) AS newest FROM (
        SELECT CASE WHEN sent_request_id IS NOT NULL AND delivered_at >= @since
                    THEN delivered_at ELSE delivery_at END AS at
        FROM session_relays
        WHERE from_worktree_id = @worktreeId AND from_instance_id = @instanceId
          AND ((sent_request_id IS NOT NULL AND delivered_at >= @since)
               OR (delivery_state = 'uncertain' AND pending_kind = 'reply'
                   AND delivery_at >= @since))
      )
    `)
    .get({ since, worktreeId: from.worktreeId, instanceId: from.instanceId }) as {
    n: number;
    oldest: number | null;
    newest: number | null;
  };
  return { count: row.n, oldestAt: row.oldest, newestAt: row.newest };
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

  const now = input.now ?? Date.now();
  // Issue #4420: the pace of round trips, from the ledger (one COUNT).
  const rounds = countRecentReplyRounds(db, input.from, now);
  const verdict = decideRelayCreation({
    from: input.from,
    to: input.to,
    parentHops: findParentRelayHops(db, input.from),
    allowRelayChain: input.allowRelayChain === true,
    openBetween: countOpenRelaysBetween(db, input.from, input.to),
    replyRounds: rounds.count,
    // Issue #4437: rule 0 — each end's tool by the resolver the send route and
    // the delivery use, and the declaration as stated (no credentials read).
    tools: {
      from: resolveRelaySession(db, input.from).cliToolId,
      to: resolveRelaySession(db, input.to).cliToolId,
      declaration: readUsageDeclaration(),
    },
  });
  if (isRelayRefusal(verdict)) {
    if (verdict.toolPolicy) {
      logger.info('relay-tool-policy-denied', {
        from: `${input.from.worktreeId}/${input.from.instanceId}`,
        to: `${input.to.worktreeId}/${input.to.instanceId}`,
        endpoint: verdict.toolPolicy.endpoint,
        tool: verdict.toolPolicy.decision.tool,
      });
    }
    if (verdict.code === 'RELAY_HOPS_EXCEEDED' && rounds.count >= MAX_RELAY_ROUNDS) {
      // Issue #4420 (Q-11): every refusal on the pace, with what it saw — the
      // material for reviewing the window and the limit.
      logger.info('relay-rounds-refused', {
        session: `${input.from.worktreeId}/${input.from.instanceId}`,
        n: rounds.count,
        oldestReplyAt: rounds.oldestAt === null ? null : new Date(rounds.oldestAt).toISOString(),
        newestReplyAt: rounds.newestAt === null ? null : new Date(rounds.newestAt).toISOString(),
      });
    }
    return { ok: false, refusal: verdict };
  }

  const relay = createRelay(db, {
    from: input.from,
    to: input.to,
    hops: verdict.hops,
    expiresAt: now + resolveRelayTtlMs(input.ttlMs),
    now,
    bindMode: input.bind === true ? 'bound' : 'legacy',
  });

  logger.info('relay-opened', {
    relayId: relay.id,
    from: `${relay.from.worktreeId}/${relay.from.instanceId}`,
    to: `${relay.to.worktreeId}/${relay.to.instanceId}`,
    hops: relay.hops,
    bindMode: relay.bindMode,
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
  | {
      ok: false;
      reason: 'not_found' | 'already_closed' | 'delivering';
      relay: SessionRelay | null;
    };

/**
 * Withdraw a relay.
 *
 * "Already closed" is reported rather than swallowed: telling a caller it
 * cancelled a relay that in fact delivered its reply an hour ago is the one
 * answer that would make them stop looking for it.
 *
 * "Delivering" (#3732) is the same honesty one step earlier: the payload is
 * being typed into the requester's composer right now, and a send cannot be
 * taken back, so a cancel reported as a success would be a lie. Once the
 * attempt ends the claim is released — closed if it delivered a reply, still
 * open and cancellable if it was held or failed.
 */
export function withdrawRelay(
  db: Database.Database,
  relayId: string,
  now = Date.now()
): WithdrawRelayResult {
  const existing = getRelayById(db, relayId);
  if (!existing) return { ok: false, reason: 'not_found', relay: null };
  if (isOpenRelayState(existing.state) && isRelayDeliveryClaimed(relayId)) {
    return { ok: false, reason: 'delivering', relay: existing };
  }
  if (!cancelRelayRow(db, relayId, now)) {
    return { ok: false, reason: 'already_closed', relay: existing };
  }
  logger.info('relay-cancelled', { relayId });
  return { ok: true, relay: getRelayById(db, relayId) ?? existing };
}

/** What {@link resolveRelayHold} is asked (Issue #4082). */
export interface ResolveRelayHoldInput {
  relayId: string;
  payloadId: string;
  /** `deliveryHold.attemptId` as read; null never matches a hold. */
  attemptId: string | null;
  action: RelayHoldAction;
  now?: number;
}

/**
 * Settle an `uncertain` delivery hold: confirm it reached the requester, queue
 * it again, or discard it (Issue #4082). See `resolveRelayDeliveryHold` for the
 * state table and the refusals.
 *
 * Writes only. A retried payload or a promoted reply is sent by the pump — the
 * route asks for one — so the requester's readiness and input lock still
 * decide when, and only the delivery that takes it types it.
 *
 * @throws When the database refuses a write; nothing is committed then
 */
export function resolveRelayHold(
  db: Database.Database,
  input: ResolveRelayHoldInput
): ResolveRelayDeliveryHoldResult {
  const result = resolveRelayDeliveryHold(db, {
    relayId: input.relayId,
    payloadId: input.payloadId,
    attemptId: input.attemptId,
    action: input.action,
    sentRequestId: relayRequestId(input.relayId),
    now: input.now,
  });
  if (result.ok) {
    logger.info('relay-hold-resolved', {
      relayId: input.relayId,
      payloadId: input.payloadId,
      attemptId: input.attemptId,
      action: input.action,
      state: result.relay.state,
      requeued: result.requeued,
      promoted: result.promoted,
      replyDiscarded: result.discardedReply !== null,
      expired: result.expired,
    });
    // Issue #4082: a closed relay's waiting reply was dropped with the notice
    // in front of it. Told in the requester's history once (best-effort: the
    // settle is committed, and a failed line never undoes it).
    // Issue #4082: closed here because its deadline had passed — the same
    // `expired` line the sweep writes (same key, so never twice).
    if (result.expired) {
      const relay = result.relay;
      writeRelaySystemLine(
        db,
        relay.id,
        'expired',
        resolveRelaySession(db, relay.from),
        resolveRelaySession(db, relay.to),
        input.now ?? Date.now()
      );
    }
    if (result.discardedReply) {
      const relay = result.relay;
      const replyPayloadId = result.discardedReply.payloadId;
      writeRelaySystemLine(
        db,
        relay.id,
        'reply-discarded',
        resolveRelaySession(db, relay.from),
        resolveRelaySession(db, relay.to),
        input.now ?? Date.now(),
        { relayId: relay.id, payload: `reply:${replyPayloadId ?? '-'}` },
        replyPayloadId ?? input.payloadId
      );
    }
  } else {
    logger.info('relay-hold-resolve-refused', {
      relayId: input.relayId,
      action: input.action,
      refusal: result.refusal,
    });
  }
  return result;
}

/** The open relays at both ends of one session. */
export function readSessionRelays(
  db: Database.Database,
  endpoint: RelayEndpoint
): SessionRelaySummary {
  return getSessionRelaySummary(db, endpoint);
}
