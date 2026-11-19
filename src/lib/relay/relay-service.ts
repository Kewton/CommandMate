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
 * How many of the requesting session's recent turns the parent lookup reads,
 * when nothing but echoes stands in front of the parent.
 *
 * Bounded in **user turns** rather than rows — `limitUnit: 'pairs'` — because a
 * single codex turn can emit dozens of assistant rows, and a row-counted window
 * would slide the user rows this lookup is entirely about out of range. Five is
 * far above the one echo a delivery actually produces (see
 * {@link isEchoOfRelayRow}).
 *
 * Issue #4420: the walk also reads past the replies to this session's own
 * relays, so the window grows by room for {@link MAX_RELAY_ROUNDS} of them, each
 * with an echo — see {@link RELAY_LINEAGE_LOOKBACK_TURNS}. What keeps an
 * unrelated relay from further back from being taken for the parent is not the
 * window but the walk: it only ever steps over echoes and this session's own
 * replies, and stops at anything else.
 */
const PARENT_RELAY_LOOKBACK_TURNS = 5;

/**
 * The turns {@link scanRelayLineage} reads (Issue #4420).
 *
 * Room for the parent lookback plus {@link MAX_RELAY_ROUNDS} replies with up to
 * three rows each (the reply, an echo, a notice). A walk that reaches the end
 * of this read without meeting a row that ends it cannot say what is behind it,
 * and is answered as "at the limit" — the safe direction for both the parent
 * and the count (design §4 I7).
 */
const RELAY_LINEAGE_LOOKBACK_TURNS = PARENT_RELAY_LOOKBACK_TURNS + 4 * MAX_RELAY_ROUNDS;

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
 * Newest first, and among rows with the SAME timestamp the ordinary rows before
 * the relay rows (Issue #4420, I7).
 *
 * SQLite's `ORDER BY timestamp DESC` leaves ties in no stated order. An echo is
 * never older than its relay row ({@link isEchoOfRelayRow}), so at a tie it is
 * the newer of the two; a person's row at a tie is read as newer too, which
 * ends the chain rather than hiding behind it. The sort is stable, so ties
 * between two relay rows keep the reader's order — both ways round the walk
 * reaches the same answer (a reply is stepped over, a request is the parent).
 */
function newestFirstNormalBeforeRelay(rows: ChatMessage[]): ChatMessage[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const byTime = b.row.timestamp.getTime() - a.row.timestamp.getTime();
      if (byTime !== 0) return byTime;
      const aRelay = a.row.messageType === 'relay' ? 1 : 0;
      const bRelay = b.row.messageType === 'relay' ? 1 : 0;
      if (aRelay !== bRelay) return aRelay - bRelay;
      return a.index - b.index;
    })
    .map(({ row }) => row);
}

/** What one walk of the requesting session's history says (Issue #4420). */
export interface RelayLineage {
  /** Depth of the relay this session is answering, or null (see {@link findParentRelayHops}). */
  parentHops: number | null;
  /** Replies to this session's own relays received in a row (see {@link countConsecutiveReplyRounds}). */
  replyRounds: number;
}

/**
 * Walk the requesting session's newest user rows once, for both halves of the
 * loop guard (Issues #2377, #2387, #4420).
 *
 * The rows are cut into groups: each relay row together with the ordinary rows
 * newer than it and older than the next newer relay row. Every ordinary row in
 * a group must be an echo of THAT relay row and of no other (I8); one that is
 * not is somebody typing, and ends the walk (#2377: a person taking the session
 * over ends the chain). Then the relay row is read:
 *
 * - **a reply to a relay this session opened** (`relay.from` is this session):
 *   counted as one round trip and stepped over — it is the answer to this
 *   session's own question, not a request to it (I1), and what is behind it is
 *   still read (I2);
 * - **a notice with no ledger key** (a `prompt` / `expired` delivery): as
 *   before #4420, the parent is "none" if not already found (I4); the count
 *   neither grows nor resets, and the walk goes on;
 * - **anything else** — a relay this session is the `to` of, or a key whose
 *   relay has gone: the parent, exactly as the first relay row used to be (a
 *   gone relay answers null: the documented fail-open, unchanged); the count
 *   stops here.
 *
 * The walk ends at the first row that ends it; reaching the end of the read
 * instead is answered as "at the limit" ({@link RELAY_LINEAGE_LOOKBACK_TURNS}).
 * A ledger that cannot be read answers `{ parentHops: null, replyRounds: 0 }`,
 * the direction the guard has always failed in.
 */
export function scanRelayLineage(db: Database.Database, from: RelayEndpoint): RelayLineage {
  try {
    const resolved = resolveRelaySession(db, from);
    const userRows = newestFirstNormalBeforeRelay(
      getMessages(db, from.worktreeId, {
        limit: RELAY_LINEAGE_LOOKBACK_TURNS,
        limitUnit: 'pairs',
        cliToolId: resolved.cliToolId,
        instanceId: from.instanceId,
        matchResolvedInstance: true,
      }).filter((message) => message.role === 'user')
    );

    let parentHops: number | null = null;
    let parentDecided = false;
    let replyRounds = 0;
    let pending: ChatMessage[] = [];
    const decideParent = (hops: number | null): void => {
      if (parentDecided) return;
      parentHops = hops;
      parentDecided = true;
    };
    const done = (): RelayLineage => ({ parentHops: parentDecided ? parentHops : null, replyRounds });

    for (const row of userRows) {
      if (row.messageType !== 'relay') {
        pending.push(row);
        continue;
      }
      if (pending.some((candidate) => !isEchoOfRelayRow(candidate, row))) return done();
      pending = [];

      const relayId = parseRelayRequestId(row.requestId);
      if (!relayId) {
        decideParent(null);
        continue;
      }
      const relay = getRelayById(db, relayId);
      if (relay && isSameEndpoint(relay.from, from)) {
        replyRounds += 1;
        if (parentDecided && replyRounds >= MAX_RELAY_ROUNDS) return done();
        continue;
      }
      decideParent(relay?.hops ?? null);
      return done();
    }

    // Ordinary rows left over sit behind every relay row read: nothing they can
    // be an echo of, so they end the walk like any other row a person typed.
    if (pending.length > 0) return done();
    // Fewer user rows (= turns, what `limitUnit: 'pairs'` bounds) than asked
    // for: this is the start of the history.
    if (userRows.length < RELAY_LINEAGE_LOOKBACK_TURNS) return done();
    // The read ran out mid-walk: what lies behind is unknown — at the limit.
    return { ...done(), replyRounds: Math.max(replyRounds, MAX_RELAY_ROUNDS) };
  } catch (error) {
    logger.warn('relay-parent-lookup-failed', {
      worktreeId: from.worktreeId,
      instanceId: from.instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { parentHops: null, replyRounds: 0 };
  }
}

/**
 * The depth of the relay whose delivery this session is currently answering.
 *
 * Read from the newest USER rows of the requesting session by
 * {@link scanRelayLineage}: if the first relay row that is not a reply to this
 * session's own relay — with only echoes and such replies in front of it — is
 * a relay row naming a relay, then whatever the session is doing now was set in
 * motion by a relay, and a new relay opened from here is a chain. An assistant
 * row in between does not clear it — the session replying is exactly the case
 * the guard is about.
 *
 * ## Why this reads a window and not the single newest row
 *
 * Issue #2387: it used to ask `getLastUserMessageForInstance` for the one newest
 * user row and require *that* row to be a relay. The transcript reader's echo
 * (see {@link isEchoOfRelayRow}) becomes the newest row 662ms after every
 * delivery, so from then on the parent was invisible and every chained relay was
 * recorded at `hops = 1`. So the window is scanned newest-first, and every
 * ordinary row on the way must be an echo: an ordinary message typed after the
 * delivery is the operator taking the session over, and #2377 decided that ends
 * the chain.
 *
 * ## Why the reply to this session's own relay is stepped over
 *
 * Issue #4420: `relay-delivery` writes a relay row into the REQUESTER's history
 * only, and the one keyed `relay:<id>` is the reply. Taking it for a parent made
 * "ask → read the reply → ask again" a chain on the second ask. A reply is the
 * answer to this session's question, not a request to it; such replies are
 * counted instead ({@link countConsecutiveReplyRounds}) and capped there.
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
  return scanRelayLineage(db, from).parentHops;
}

/**
 * How many replies to its own relays this session has received in a row, with
 * no ordinary row in between (Issue #4420) — the input of the round-trip
 * ceiling, {@link MAX_RELAY_ROUNDS}. See {@link scanRelayLineage} for what
 * counts, what is stepped over and what ends the count.
 */
export function countConsecutiveReplyRounds(
  db: Database.Database,
  from: RelayEndpoint
): number {
  return scanRelayLineage(db, from).replyRounds;
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

  // Issue #4420: one walk answers both the parent and the round-trip count.
  const lineage = scanRelayLineage(db, input.from);
  const verdict = decideRelayCreation({
    from: input.from,
    to: input.to,
    parentHops: lineage.parentHops,
    allowRelayChain: input.allowRelayChain === true,
    openBetween: countOpenRelaysBetween(db, input.from, input.to),
    replyRounds: lineage.replyRounds,
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
    return { ok: false, refusal: verdict };
  }

  const now = input.now ?? Date.now();
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
