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
  MAX_RELAY_LINEAGE_ROWS,
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
 * How many user turns the first read of {@link scanRelayLineage} asks for
 * (Issue #4420, I10).
 *
 * Not a window: when the walk has not reached a settled end (an ordinary row,
 * the start of the history, a parent, or {@link MAX_RELAY_ROUNDS} replies) by
 * the last row read, the read is repeated with twice as many turns, up to
 * {@link MAX_RELAY_LINEAGE_ROWS}. Bounded in **user turns** — `limitUnit:
 * 'pairs'` — because a single codex turn can emit dozens of assistant rows.
 * Thirty-two covers the common case (a few replies since the person last typed)
 * in one read.
 */
const RELAY_LINEAGE_FIRST_READ_TURNS = 32;

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
 * Newest first. Among rows with the SAME timestamp, the ordinary rows before the
 * relay rows, and the relay rows newest-inserted first (Issue #4420, I7 / I10).
 *
 * SQLite's `ORDER BY timestamp DESC` leaves ties in no stated order. An echo is
 * never older than its relay row ({@link isEchoOfRelayRow}), so at a tie it is
 * read as the newer of the two; a person's row at a tie is read as newer too,
 * which ends the chain rather than hiding behind it. Relay rows at a tie are put
 * in insertion order (`rowid`, the order the delivery wrote them), so a reply,
 * a notice and a vanished relay's row sharing a millisecond are always walked
 * the same way.
 */
function sortNewestFirst(rows: ChatMessage[], insertedAt: Map<string, number>): ChatMessage[] {
  return [...rows].sort((a, b) => {
    const byTime = b.timestamp.getTime() - a.timestamp.getTime();
    if (byTime !== 0) return byTime;
    const aRelay = a.messageType === 'relay' ? 1 : 0;
    const bRelay = b.messageType === 'relay' ? 1 : 0;
    if (aRelay !== bRelay) return aRelay - bRelay;
    return (insertedAt.get(b.id) ?? 0) - (insertedAt.get(a.id) ?? 0);
  });
}

/** Insertion order of the rows read, for {@link sortNewestFirst}'s ties. */
function readInsertionOrder(db: Database.Database, rows: ChatMessage[]): Map<string, number> {
  const order = new Map<string, number>();
  for (let i = 0; i < rows.length; i += 500) {
    const ids = rows.slice(i, i + 500).map((row) => row.id);
    const found = db
      .prepare(`SELECT id, rowid AS seq FROM chat_messages WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as Array<{ id: string; seq: number }>;
    for (const { id, seq } of found) order.set(id, seq);
  }
  return order;
}

/** What one walk of the requesting session's history says (Issue #4420). */
export interface RelayLineage {
  /** Depth of the relay this session is answering, or null (see {@link findParentRelayHops}). */
  parentHops: number | null;
  /** Replies to this session's own relays received in a row (see {@link countConsecutiveReplyRounds}). */
  replyRounds: number;
  /**
   * I10: the walk met {@link MAX_RELAY_LINEAGE_ROWS} user rows without a settled
   * end, so what lies behind is unknown. `replyRounds` is then the number
   * actually confirmed, and the policy refuses (fail-closed) with a sentence
   * that says so.
   */
  truncated: boolean;
}

/** One walk over rows already read: settled, or it ran out of rows. */
type WalkOutcome = { settled: true; lineage: RelayLineage } | { settled: false; lineage: RelayLineage };

/**
 * Walk user rows newest-first once (see {@link scanRelayLineage}).
 *
 * `complete` says the rows are the whole history, so running out of them is the
 * start of the history — a settled end. Otherwise running out is not an end
 * (I10): an ordinary row still waiting for the relay row it may be an echo of,
 * or a chain of replies and notices, says nothing about what is behind it.
 */
function walkRelayLineage(
  db: Database.Database,
  from: RelayEndpoint,
  rows: ChatMessage[],
  complete: boolean
): WalkOutcome {
  // I8 at a tie: an ordinary row may be the echo of a relay row with its own
  // timestamp, wherever that row sits among the tie.
  const relayRowsAt = new Map<number, ChatMessage[]>();
  for (const row of rows) {
    if (row.messageType !== 'relay') continue;
    const at = row.timestamp.getTime();
    relayRowsAt.set(at, [...(relayRowsAt.get(at) ?? []), row]);
  }
  const isEchoFor = (candidate: ChatMessage, relayRow: ChatMessage): boolean =>
    isEchoOfRelayRow(candidate, relayRow)
    || (relayRowsAt.get(candidate.timestamp.getTime()) ?? []).some((tied) =>
      isEchoOfRelayRow(candidate, tied)
    );

  let parentHops: number | null = null;
  let parentDecided = false;
  let replyRounds = 0;
  let pending: ChatMessage[] = [];
  const lineage = (): RelayLineage => ({
    parentHops: parentDecided ? parentHops : null,
    replyRounds,
    truncated: false,
  });
  const settled = (): WalkOutcome => ({ settled: true, lineage: lineage() });

  for (const row of rows) {
    if (row.messageType !== 'relay') {
      pending.push(row);
      continue;
    }
    if (pending.some((candidate) => !isEchoFor(candidate, row))) return settled();
    pending = [];

    const relayId = parseRelayRequestId(row.requestId);
    if (!relayId) {
      // A notice: "no parent" as before #4420 (I4); neither counted nor an end.
      if (!parentDecided) {
        parentHops = null;
        parentDecided = true;
      }
      continue;
    }
    const relay = getRelayById(db, relayId);
    if (relay && isSameEndpoint(relay.from, from)) {
      replyRounds += 1;
      // At the ceiling the verdict is a refusal whatever lies behind.
      if (replyRounds >= MAX_RELAY_ROUNDS) return settled();
      continue;
    }
    if (!parentDecided) {
      parentHops = relay?.hops ?? null;
      parentDecided = true;
    }
    return settled();
  }

  // Ordinary rows left over with the whole history read have no relay row
  // behind them to be an echo of: somebody typed them — an end.
  if (complete) return settled();
  return { settled: false, lineage: lineage() };
}

/**
 * Walk the requesting session's newest user rows, for both halves of the loop
 * guard (Issues #2377, #2387, #4420).
 *
 * The rows are cut into groups: each relay row together with the ordinary rows
 * newer than it and older than the next newer relay row. Every ordinary row in
 * a group must be an echo of THAT relay row (or of a relay row with the very
 * same timestamp) and of no other (I8); one that is not is somebody typing, and
 * ends the walk (#2377: a person taking the session over ends the chain). Then
 * the relay row is read:
 *
 * - **a reply to a relay this session opened** (`relay.from` is this session,
 *   worktree and instance id as written — an alias or another instance is not
 *   this session, and is read as a parent, the fail-closed side): counted as one
 *   round trip and stepped over — it is the answer to this session's own
 *   question, not a request to it (I1), and what is behind it is still read
 *   (I2). At {@link MAX_RELAY_ROUNDS} the walk stops: the verdict is a refusal;
 * - **a notice with no ledger key** (a `prompt` / `expired` delivery): as
 *   before #4420, the parent is "none" if not already found (I4); the count
 *   neither grows nor resets, and the walk goes on;
 * - **anything else** — a relay this session is the `to` of, or a key whose
 *   relay has gone: the parent, exactly as the first relay row used to be (a
 *   gone relay answers null: the documented fail-open, unchanged); the count
 *   stops here.
 *
 * ## Read to a settled end (I10)
 *
 * The walk is decided only at a settled end: one of the rows above that ends
 * it, or the start of the history. Running out of rows read is not an end —
 * the read is repeated, synchronously, with twice as many turns
 * ({@link RELAY_LINEAGE_FIRST_READ_TURNS} first), up to
 * {@link MAX_RELAY_LINEAGE_ROWS} user rows. A walk that still has not settled
 * there answers `truncated: true` with the replies it did confirm, and the
 * policy refuses (fail-closed) saying exactly that.
 *
 * A ledger that cannot be read answers `{ parentHops: null, replyRounds: 0 }`,
 * the direction the guard has always failed in.
 */
export function scanRelayLineage(db: Database.Database, from: RelayEndpoint): RelayLineage {
  try {
    const resolved = resolveRelaySession(db, from);
    let turns = RELAY_LINEAGE_FIRST_READ_TURNS;
    for (;;) {
      // One past the ceiling, so "exactly the ceiling" is told from "more".
      const limit = Math.min(turns, MAX_RELAY_LINEAGE_ROWS + 1);
      const userRows = getMessages(db, from.worktreeId, {
        limit,
        limitUnit: 'pairs',
        cliToolId: resolved.cliToolId,
        instanceId: from.instanceId,
        matchResolvedInstance: true,
      }).filter((message) => message.role === 'user');
      // Fewer user rows (= turns, what `limitUnit: 'pairs'` bounds) than asked
      // for: this is the whole history.
      const complete = userRows.length < limit;
      const rows = sortNewestFirst(userRows, readInsertionOrder(db, userRows));
      // Not cut at the ceiling: a tie group is read whole (`pairs` includes every
      // row at the cutoff's timestamp), so an echo is never parted from its row.
      const walked = walkRelayLineage(db, from, rows, complete);
      if (walked.settled) return walked.lineage;
      if (limit > MAX_RELAY_LINEAGE_ROWS) return { ...walked.lineage, truncated: true };
      turns *= 2;
    }
  } catch (error) {
    logger.warn('relay-parent-lookup-failed', {
      worktreeId: from.worktreeId,
      instanceId: from.instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { parentHops: null, replyRounds: 0, truncated: false };
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
    historyTruncated: lineage.truncated,
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
