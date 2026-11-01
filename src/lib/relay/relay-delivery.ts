/**
 * Getting B's answer into A's composer (Issue #2377).
 *
 * ## Two moments, one path
 *
 * Something has to notice that B finished. Two things do, and they are the two
 * `lib/polling/structured-history-gate`'s header describes:
 *
 *  - **Tools with a transcript** (claude, codex, antigravity, command-code, and
 *    opencode over its stream). Their reader answers `true` only for a turn the
 *    agent has CLOSED, which is a stronger statement than any amount of quiet,
 *    so the capture is delivered as soon as it lands. Both triggers of that
 *    capture — the Stop hook and the poller — reach the same function, which is
 *    why this module needs one hook and not two. For these five the transcript
 *    is also the ONLY thing a reply may be read from: the poller's own scrape
 *    of the same turn arrives first and carries junk (Issue #2401), so an
 *    unmarked row is stepped over and the marked one waited for.
 *  - **Tools without one** (copilot, gemini, vibe-local). What a finished turn
 *    leaves behind is the poller's copy of the SCREEN, judged by a string
 *    analysis of a frame that may still be being drawn. The Issue asks for
 *    「完了検知 + 数秒の静穏」, and {@link RELAY_SCRAPE_QUIET_MS} is that quiet:
 *    the newest row is re-read after the delay and only delivered once it has
 *    stopped moving.
 *
 * ## Deciding is not delivering
 *
 * A finished turn produces a STASH, not a send. A is frequently mid-turn when B
 * finishes, and typing into a running composer interrupts it — so the body waits
 * in the ledger (durable, survives a restart) and the pump retries it whenever
 * A is next able to take it. That separation is also what makes the double
 * detection harmless: `stashRelayPayload` is guarded on `pending_kind IS NULL`,
 * so two producers finding one turn cost one delivery.
 *
 * Nothing here throws. Every entry point is called from a poller tick, a hook
 * receiver or a timer, and in all three a failure must cost the relay, never the
 * caller.
 *
 * @module lib/relay/relay-delivery
 */

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { getDbInstance } from '@/lib/db/db-instance';
import {
  claimRelayPayloadDelivery,
  clearRelayHeldCandidates,
  clearRelayPending,
  clearRelayPendingReply,
  completeRelayPayloadDelivery,
  completeRelayPromptDelivery,
  completeRelayReplyDelivery,
  getRelayBinding,
  getRelayById,
  getRelayPendingPayload,
  holdRelayPayloadDelivery,
  listDeliverableRelayPayloads,
  listExpiredOpenRelays,
  listOpenRelaysTo,
  markRelayExpired,
  recoverInterruptedRelayDeliveries,
  releaseRelayPayloadDelivery,
  replaceRelayPromptWithPendingReply,
  stashRelayPayload,
  type RelayPayloadAttemptRef,
} from '@/lib/db/relay-db';
import { getLatestOpenPromptMessage, relayRequestId } from '@/lib/db/chat-db';
import { resolveReadersLocale } from '@/lib/push/model-change-push-notifier';
import { sendUserMessage } from '@/lib/session/send-user-message';
import type { SendAttemptReason, SendAttemptState } from '@/lib/session/send-attempt-types';
import { buildRelayExpiredMessage } from '@/lib/relay/relay-messages';
import { relayServerBootId } from '@/lib/relay/relay-boot';
import {
  findWorkerCompletions,
  findWorkerReply,
  notifyPromptForRelay,
  observationStillHolds,
  recoverBoundRelays,
  requiresTurnRow,
  senderLabel,
  stashBoundReply,
  stashPromptNotice,
  stashReplyForOpenRelays,
  type RelayWorkerRef,
} from '@/lib/relay/relay-bound-reply';
import { RELAY_SCRAPE_QUIET_MS } from '@/lib/relay/relay-policy';
import { findRelayHoldReason } from '@/lib/relay/relay-readiness';
import { resolveRelaySession } from '@/lib/relay/relay-session-ref';
import { writeRelaySystemLine } from '@/lib/relay/relay-system-line';
import {
  claimRelayDelivery,
  isRelayDeliveryClaimed,
  releaseRelayDelivery,
  resetRelayDeliveryClaims,
} from '@/lib/relay/relay-delivery-claims';
import { isOpenRelayState } from '@/lib/relay/types';
import { createLogger } from '@/lib/logger';
import { getOrInitGlobal } from '../global-state';

// Issue #3996: the reply/notice decisions moved; their public names stay here.
export { findWorkerReply, recoverBoundRelays, type RelayWorkerRef };

const logger = createLogger('relay-delivery');

/** How many passes one pump makes when a pass promoted a reply (Issue #3957). */
const PUMP_PASSES_MAX = 3;

/** How many times the scrape path re-reads before it gives up on stability. */
const SCRAPE_STABILITY_ATTEMPTS = 3;

/**
 * How long the scrape path holds out for the transcript row.
 *
 * Issue #2386 measured the gap on codex 0.153.4 at 5.2 s: the scraper writes
 * the pane into the ledger in the millisecond before the send, and the rollout
 * reader writes the real answer about five seconds after the completion was
 * already announced. Three times the measured gap, the same window `ask` holds,
 * and spent only when the ledger has nothing marked yet — a worker whose
 * transcript already landed stashes on the first read.
 *
 * When it does elapse nothing is delivered. That is the safe direction and not
 * a lost answer: the relay is a STANDING instruction, so the transcript
 * reader's own `settled` announcement (or the next completion) still delivers,
 * and if neither ever comes the requester is told by the expiry notice rather
 * than by a footer line dressed up as the reply.
 */
const RELAY_TURN_ROW_GRACE_MS = 15_000;

/** How often the grace above re-reads the ledger. */
const RELAY_TURN_ROW_POLL_MS = 1_000;

/**
 * Relays being delivered right now, by id.
 *
 * On `globalThis` for the reason every shared map in this subsystem is (#1736):
 * under `next dev` the poller's bundle and the hook receiver's bundle would each
 * get a private copy of a module-scoped set, and a lock only one of two bundles
 * can see is not a lock.
 */
declare global {
  // eslint-disable-next-line no-var
  var __relayDeliveryInFlight: Set<string> | undefined;
  // eslint-disable-next-line no-var
  var __relayPumpRunning: boolean | undefined;
  // eslint-disable-next-line no-var
  var __relayRecoveredBootId: string | undefined;
  // eslint-disable-next-line no-var
  var __relayPumpAgain: boolean | undefined;
  // eslint-disable-next-line no-var
  var __relayAttemptsRecoveredBootId: string | undefined;
}

const inFlight = getOrInitGlobal('__relayDeliveryInFlight', () => new Set<string>());

/** Forget every in-flight delivery. Test seam. */
export function resetRelayDeliveryState(): void {
  inFlight.clear();
  resetRelayDeliveryClaims();
  globalThis.__relayPumpRunning = false;
  globalThis.__relayRecoveredBootId = undefined;
  globalThis.__relayAttemptsRecoveredBootId = undefined;
}

/**
 * The bound send was confirmed: judge what was held for it (Issue #3957).
 *
 * The EARLIEST turn at or after the boundary is taken — not the newest: when
 * two turns ended before the send was confirmed, the first one after the
 * boundary is the one this request started. It is re-read from the boundary
 * (the held candidates are the record of what was seen, ordered by the same
 * key), and the held list is dropped. The worker's open prompt is judged at the same moment: a dialog
 * that appeared after the boundary and is still open is told now (its opening
 * edge fired while the send was unconfirmed and will not fire again); one
 * already answered is not.
 *
 * Never throws; called by the send route right after it settled the send.
 */
export function evaluateRelayAfterSend(relayId: string): void {
  try {
    const db = getDbInstance();
    const binding = getRelayBinding(db, relayId);
    if (!binding) return;
    const { relay } = binding;
    if (relay.sendState !== 'sent' || !isOpenRelayState(relay.state) || relay.inputBoundaryAt === null) return;
    const session = resolveRelaySession(db, relay.to);
    const worker: RelayWorkerRef = {
      worktreeId: session.worktreeId,
      cliToolId: session.cliToolId,
      instanceId: session.instanceId,
    };
    const boundary = relay.inputBoundaryAt;
    const now = Date.now();

    const decided = db.transaction((): boolean => {
      clearRelayHeldCandidates(db, relayId);
      if (!observationStillHolds(db, worker, binding)) return false;
      // Re-read from the boundary rather than trusting what was held: the
      // held list was read from `createdAt` (before the boundary existed) and
      // may have spent the scan's bound on rows before it. The order is the
      // same key either way — each turn's first row.
      const [first] = findWorkerCompletions(db, worker, boundary);
      return first ? stashBoundReply(db, worker, binding, first.row, now) : false;
    })();

    const prompted = decided ? false : notifyPromptForRelay(db, worker, relayId);
    if (decided || prompted) void pumpRelayDeliveries();
  } catch (error) {
    logger.warn('relay-after-send-failed', {
      relayId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}


/**
 * {@link recoverBoundRelays}, once per boot; and the delivery attempts the
 * previous boot left `attempting` are held as `uncertain` (Issue #4064).
 *
 * The second step is marked done only once it succeeded, and is safe to run
 * again (it never touches this boot's own attempts). Until it has run, the
 * rows it would hold are not listed for delivery anyway — `attempting` is
 * already a hold — so a failure here costs a label, never a second send.
 */
function ensureRelayRecovery(db: Database.Database): void {
  const boot = relayServerBootId();
  if (globalThis.__relayAttemptsRecoveredBootId !== boot) {
    try {
      const held = recoverInterruptedRelayDeliveries(db, boot);
      globalThis.__relayAttemptsRecoveredBootId = boot;
      if (held > 0) logger.info('relay-interrupted-deliveries-held', { held });
    } catch (error) {
      logger.warn('relay-delivery-recovery-failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (globalThis.__relayRecoveredBootId === boot) return;
  globalThis.__relayRecoveredBootId = boot;
  try {
    recoverBoundRelays(db);
  } catch (error) {
    logger.warn('relay-recovery-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Sleep, so the scrape path can wait out its quiet window. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Hold out for the transcript row this scrape got ahead of, then stash it.
 *
 * Called for a tool whose answers come out of a transcript, on the completion
 * edge the POLLER raised — which is the edge that fires early. #2386 measured
 * the reader landing about five seconds behind it, so re-reading beats both
 * giving up on the first look and delivering what is there instead.
 *
 * The re-read is {@link stashReplyForOpenRelays} and not
 * {@link findWorkerReply}, because "is there an answer yet" has to be asked per
 * relay against that relay's own `createdAt`: a marked row older than the relay
 * answered somebody else's question and must not end the wait. The stash itself
 * is guarded on `pending_kind IS NULL`, so asking repeatedly costs reads and
 * never a second payload.
 *
 * Returns having delivered nothing when the grace elapses. See
 * {@link RELAY_TURN_ROW_GRACE_MS} for why that is the safe direction.
 */
async function deliverWhenTranscriptCatchesUp(
  db: Database.Database,
  worker: RelayWorkerRef
): Promise<void> {
  const deadline = Date.now() + RELAY_TURN_ROW_GRACE_MS;
  for (;;) {
    if (stashReplyForOpenRelays(db, worker, Date.now()) > 0) {
      void pumpRelayDeliveries();
      return;
    }
    if (Date.now() >= deadline) break;
    await sleep(RELAY_TURN_ROW_POLL_MS);
  }
  logger.info('relay-scrape-row-not-transcript-backed', {
    worktreeId: worker.worktreeId,
    cliToolId: worker.cliToolId,
    instanceId: worker.instanceId,
    graceMs: RELAY_TURN_ROW_GRACE_MS,
  });
}

/**
 * B finished a turn. Deliver it, or arrange to.
 *
 * @param worker - The session that finished
 * @param options.settled - True when the completion came from the agent's own
 *   transcript, i.e. the turn is closed and no quiet window is needed
 */
export async function notifyRelayTurnCompleted(
  worker: RelayWorkerRef,
  options: { settled: boolean }
): Promise<void> {
  try {
    const db = getDbInstance();
    const waiting = listOpenRelaysTo(db, {
      worktreeId: worker.worktreeId,
      instanceId: worker.instanceId,
    });
    if (waiting.length === 0) return;

    if (options.settled) {
      if (stashReplyForOpenRelays(db, worker, Date.now()) > 0) void pumpRelayDeliveries();
      return;
    }

    // The scrape path, and it forks on who is allowed to write this worker's
    // answers. A tool with a transcript has an authoritative record, so the
    // scraped row this announcement is about is not a candidate at all — the
    // relay waits for the marked one instead of watching an unmarked one hold
    // still (Issue #2401).
    if (requiresTurnRow(worker.cliToolId)) {
      await deliverWhenTranscriptCatchesUp(db, worker);
      return;
    }

    // The scrape path. The row that is newest now may be a frame mid-draw, so
    // the delivery waits until the newest row stops changing — bounded, because
    // an agent that keeps writing is an agent whose next completion will trigger
    // this again anyway.
    let previousId: string | null = null;
    for (let attempt = 0; attempt < SCRAPE_STABILITY_ATTEMPTS; attempt += 1) {
      const before = findWorkerReply(db, worker, 0);
      previousId = before?.id ?? null;
      await sleep(RELAY_SCRAPE_QUIET_MS);
      const after = findWorkerReply(db, worker, 0);
      if ((after?.id ?? null) === previousId) {
        if (stashReplyForOpenRelays(db, worker, Date.now()) > 0) void pumpRelayDeliveries();
        return;
      }
    }
    logger.info('relay-scrape-never-settled', {
      worktreeId: worker.worktreeId,
      instanceId: worker.instanceId,
      attempts: SCRAPE_STABILITY_ATTEMPTS,
    });
  } catch (error) {
    logger.warn('relay-turn-completed-failed', {
      worktreeId: worker.worktreeId,
      instanceId: worker.instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * B stopped on a confirmation. Tell A, once per distinct dialog.
 *
 * The relay stays OPEN: answering the prompt lets B finish, and the reply is
 * delivered from the `prompt` state. What changes is that A now knows why
 * nothing has arrived, which is the whole difference between a delegation that
 * is slow and one that is stuck.
 */
export function notifyRelayPromptWaiting(worker: RelayWorkerRef): void {
  try {
    const db = getDbInstance();
    const relays = listOpenRelaysTo(db, {
      worktreeId: worker.worktreeId,
      instanceId: worker.instanceId,
    });
    if (relays.length === 0) return;

    const prompt = getLatestOpenPromptMessage(
      db,
      worker.worktreeId,
      worker.cliToolId,
      worker.instanceId
    );
    if (!prompt) return;

    let stashed = 0;
    for (const relay of relays) {
      // Issue #3957: a bound relay is told only about a dialog of its own send.
      if (stashPromptNotice(db, worker, relay, prompt)) stashed += 1;
    }
    if (stashed > 0) void pumpRelayDeliveries();
  } catch (error) {
    logger.warn('relay-prompt-notify-failed', {
      worktreeId: worker.worktreeId,
      instanceId: worker.instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Close every relay whose deadline has passed, telling A once.
 *
 * The stash goes in BEFORE the state changes, because `stashRelayPayload` only
 * accepts an open relay — and the once-ness the Issue asks for comes from
 * {@link markRelayExpired} being a guarded update, not from this ordering.
 */
export function sweepExpiredRelays(db: Database.Database, now = Date.now()): number {
  let expired = 0;
  for (const relay of listExpiredOpenRelays(db, now)) {
    // A send already under way for this relay cannot be taken back (#3732).
    // Expiring it now would leave A with both the reply and the expiry notice,
    // and the delivery's own cleanup would then wipe that notice. The next
    // sweep finds it closed (delivered) or, if the send was refused, still
    // open and expires it then.
    if (isRelayDeliveryClaimed(relay.id)) continue;
    try {
      const locale = resolveReadersLocale(db);
      // A payload that never went out is superseded by the expiry notice: A
      // asked for an answer, and what they are getting is the news that there
      // will not be one. Both slots (Issue #3957). Issue #4064: not a payload
      // under a delivery hold — it may have reached A, so it stays readable
      // (`clearRelayPending` refuses it), the expiry notice then finds the
      // slot taken and is not queued, and the relay is closed all the same.
      clearRelayPending(db, relay.id, now);
      clearRelayPendingReply(db, relay.id, now);
      const body = buildRelayExpiredMessage(
        locale,
        senderLabel(db, relay),
        relay.expiresAt - relay.createdAt
      );
      const stashed = stashRelayPayload(db, relay.id, 'expired', body, now);
      if (!markRelayExpired(db, relay.id, now)) {
        if (stashed) clearRelayPending(db, relay.id, now);
        continue;
      }
      expired += 1;
      writeRelaySystemLine(
        db,
        relay.id,
        'expired',
        resolveRelaySession(db, relay.from),
        resolveRelaySession(db, relay.to),
        now
      );
    } catch (error) {
      logger.warn('relay-expire-failed', {
        relayId: relay.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return expired;
}

/**
 * What one delivery attempt did. Exported for the suite.
 *
 * `uncertain` (Issue #4064): whether it reached A is not known, and the
 * payload is held — never sent again automatically.
 */
export type RelayDeliveryOutcome = 'delivered' | 'held' | 'skipped' | 'failed' | 'uncertain';

/** How a send's own attempt ended, as `onAttempt` reported it (Issue #4064). */
type ObservedAttempt = { state: SendAttemptState; reason: SendAttemptReason } | null;

/** The hold reason of a send that threw: what it last reported, if anything. */
function reasonForThrow(attempt: ObservedAttempt): string {
  if (attempt === null) return 'send-threw';
  return attempt.state === 'sent' ? 'threw-after-sent' : attempt.reason;
}

/**
 * Try to put one stashed payload into A's composer.
 *
 * The order — readiness, then claim, then send, then ledger — is deliberate.
 * Marking delivered first would lose the answer whenever the send failed, and
 * the send path has real refusals in it (`prompt_waiting`, a session that went
 * away mid-attempt).
 *
 * Issue #4064: the payload is taken DURABLY before the send
 * ({@link claimRelayPayloadDelivery}: `attempting`, under a fresh attempt id),
 * and only the caller whose write took it sends. How the send ended decides
 * what happens to it, read from the send's OWN attempt (`onAttempt`, not the
 * instance's shared `lastSend`):
 *
 *  - delivered → the slot is emptied (under the attempt id);
 *  - `prompt_waiting`, or `not-sent` → queued again, retried by the next pump;
 *  - anything else — `indeterminate` (`composer-residue` included), a throw
 *    after `sent`, a throw before any state — → held as `uncertain` with the
 *    reason. It is not listed again, it is not replaced, and the relay's later
 *    payloads (the second slot's reply too) wait behind it.
 *
 * A server that stops anywhere in between leaves `attempting`, which is a hold
 * too, and the next boot labels it `uncertain`. The in-flight set and the
 * in-process claim stay — they are what `withdrawRelay` and the expiry sweep
 * read — but they are no longer what prevents a second send.
 *
 * `kind`, `body` and `payloadId` are what the pump's listing saw, and that
 * listing is stale by the time the readiness check returns (#3732): an earlier
 * relay's send, or this one's own capture, may have let a cancel or an expiry
 * sweep run. So the row is read again AFTER the last await before the send,
 * and the send goes ahead only when it still carries the same payload — and,
 * for anything but an expiry notice, is still open. The claims are taken in
 * that same synchronous stretch, so no cancel can slip in between the check
 * and the send; from then on `withdrawRelay` answers `delivering`.
 */
async function deliverOne(
  db: Database.Database,
  relayId: string,
  kind: 'reply' | 'prompt' | 'expired',
  body: string,
  listedPayloadId: string | null
): Promise<RelayDeliveryOutcome> {
  const listed = getRelayById(db, relayId);
  if (!listed) return 'skipped';

  const listedRequester = resolveRelaySession(db, listed.from);
  const hold = await findRelayHoldReason(
    listedRequester.worktreeId,
    listedRequester.cliToolId,
    listedRequester.instanceId,
    db
  );
  if (hold) {
    logger.debug('relay-delivery-held', { relayId, kind, reason: hold });
    return 'held';
  }

  // Synchronous from here to the send: re-read, then claim.
  const current = getRelayPendingPayload(db, relayId);
  if (
    !current ||
    current.kind !== kind ||
    current.body !== body ||
    current.payloadId !== listedPayloadId
  ) {
    logger.info('relay-delivery-superseded', { relayId, kind });
    return 'skipped';
  }
  // An expiry notice is delivered from a CLOSED relay by design; everything
  // else is only owed while the relay is open.
  if (kind !== 'expired' && !isOpenRelayState(current.relay.state)) {
    logger.info('relay-delivery-closed', { relayId, kind, state: current.relay.state });
    return 'skipped';
  }
  const relay = current.relay;
  const requester = resolveRelaySession(db, relay.from);

  // Issue #4064: take the payload in the ledger before the first key. A write
  // that fails or finds the payload taken means no send.
  const attemptId = randomUUID();
  let payloadId: string | null;
  try {
    payloadId = claimRelayPayloadDelivery(db, {
      relayId,
      payloadId: current.payloadId,
      kind,
      body,
      attemptId,
      owner: relayServerBootId(),
      mintPayloadId: randomUUID(),
    });
  } catch (error) {
    logger.warn('relay-delivery-claim-failed', {
      relayId,
      kind,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'failed';
  }
  if (payloadId === null) {
    logger.info('relay-delivery-taken', { relayId, kind });
    return 'skipped';
  }
  const ref: RelayPayloadAttemptRef = { relayId, payloadId, attemptId };

  claimRelayDelivery(relayId);
  let requeued = false;
  try {
    let attempt: ObservedAttempt = null;
    let result: Awaited<ReturnType<typeof sendUserMessage>>;
    try {
      result = await sendUserMessage(db, {
        worktreeId: requester.worktreeId,
        content: body,
        cliToolId: requester.cliToolId,
        instanceId: requester.instanceId,
        messageType: 'relay',
        // The pointer back at the ledger. Also `session_relays.sent_request_id` for
        // a reply, which carries a UNIQUE index — so a second delivery of the same
        // relay cannot be recorded even if one were somehow attempted.
        requestId: kind === 'reply' ? relayRequestId(relay.id) : undefined,
        // Issue #4064: this send's own outcome, not the instance's last one.
        onAttempt: (observed) => {
          attempt = observed;
        },
      });
    } catch (error) {
      const reason = reasonForThrow(attempt);
      logger.warn('relay-delivery-uncertain', {
        relayId,
        kind,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      holdUncertain(db, ref, reason);
      return 'uncertain';
    }

    if (!result.ok) {
      const observed = attempt as ObservedAttempt;
      // Every failure `sendUserMessage` returns reports its attempt first; one
      // without (a caller's stub) is read as before (#4064 keeps that).
      const notSent = observed === null || observed.state === 'not-sent';
      if (!notSent) {
        logger.info('relay-delivery-uncertain', {
          relayId,
          kind,
          stage: result.stage,
          reason: observed.reason,
        });
        holdUncertain(db, ref, observed.reason);
        return 'uncertain';
      }
      logger.info('relay-delivery-refused', { relayId, kind, stage: result.stage });
      requeued = requeue(db, ref);
      return result.stage === 'prompt_waiting' ? 'held' : 'failed';
    }

    const now = Date.now();
    // Issue #4082: the attempt's result is recorded FIRST, and only while it
    // is still the attempt in progress. A stale one (held by another boot's
    // recovery, resolved, or replaced by a retry's new attempt) writes
    // nothing — no close, no emptied payload, no promotion, no system line —
    // so the newer attempt and the relay's later reply are left as they are.
    let completed: boolean;
    let promoted = false;
    if (kind === 'reply') {
      // Issue #4064: closing the relay (which empties the payload) and ending
      // the attempt commit together. A throw rolls both back: the row stays
      // `attempting` with its body and payload id — held, never re-sent — and
      // the next boot labels it.
      const result = completeRelayReplyDelivery(db, {
        ...ref,
        sentRequestId: relayRequestId(relay.id),
        now,
      });
      completed = result.completed;
      if (completed && !result.closed) {
        // Somebody closed it underneath us. The message is already in A's
        // composer, which is the outcome that mattered.
        logger.info('relay-already-closed-on-deliver', { relayId });
      }
    } else if (kind === 'prompt') {
      // Issue #3957: only the payload that was sent. A reply that waits in the
      // second slot survives, and is promoted now that the notice is out —
      // Issue #4082: in the same transaction as the attempt's end.
      // A throw here leaves the row `attempting` — held, never re-sent — and
      // the next boot labels it.
      ({ completed, promoted } = completeRelayPromptDelivery(db, { ...ref, now }));
    } else {
      completed = completeRelayPayloadDelivery(db, { ...ref, now });
    }
    if (!completed) {
      logger.warn('relay-delivery-result-stale', { relayId, kind, attemptId });
      return 'skipped';
    }
    if (promoted) globalThis.__relayPumpAgain = true;
    try {
      if (kind === 'reply') {
        writeRelaySystemLine(
          db,
          relay.id,
          'replied',
          requester,
          resolveRelaySession(db, relay.to),
          now,
          { overlap: relay.overlap, holdReason: relay.holdReason }
        );
      } else if (kind === 'prompt') {
        writeRelaySystemLine(
          db,
          relay.id,
          'waiting',
          requester,
          resolveRelaySession(db, relay.to),
          now
        );
      }
    } catch (error) {
      // Issue #4064: the send went out; a ledger write after it failing must
      // not turn into a second send. The attempt is closed already (above).
      logger.warn('relay-delivery-record-failed', {
        relayId,
        kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    logger.info('relay-delivered', { relayId, kind, to: `${requester.worktreeId}/${requester.instanceId}` });
    return 'delivered';
  } finally {
    // Issue #3957: a prompt notice that did not go out (refused, failed) is
    // back to unclaimed — and a reply that finished while it was being typed
    // waits in the second slot. The reply supersedes the notice exactly as it
    // would have had it arrived a moment later. Issue #4064: only a notice
    // known not to have gone out (queued again); one held as uncertain is
    // kept, and the reply waits behind it (the replacement refuses a held
    // notice in its own condition, too).
    // A failure here must not keep the claim below from being released: a
    // claim left behind refuses every cancel and every expiry of the relay.
    if (requeued && kind === 'prompt') {
      try {
        if (replaceRelayPromptWithPendingReply(db, relay.id, payloadId)) {
          logger.info('relay-prompt-superseded-after-failed-delivery', { relayId });
          globalThis.__relayPumpAgain = true;
        }
      } catch (error) {
        logger.warn('relay-prompt-supersede-failed', {
          relayId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // Delivered: a reply is closed now and a prompt notice leaves the relay
    // open on purpose, so either way a later cancel must be judged by the row.
    // Held, failed or uncertain: the relay can be withdrawn again (a cancel
    // stops later deliveries; it never takes back what may be in A's composer).
    releaseRelayDelivery(relayId);
  }
}

/** Queue a payload again after a send known not to have happened (Issue #4064). */
function requeue(db: Database.Database, ref: RelayPayloadAttemptRef): boolean {
  try {
    return releaseRelayPayloadDelivery(db, ref);
  } catch (error) {
    // Left `attempting`: held, not re-sent. Safe, if not what was wanted.
    logger.warn('relay-delivery-release-failed', {
      relayId: ref.relayId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Hold a payload whose delivery may have reached A (Issue #4064). */
function holdUncertain(db: Database.Database, ref: RelayPayloadAttemptRef, reason: string): void {
  try {
    holdRelayPayloadDelivery(db, { ...ref, reason });
  } catch (error) {
    // Left `attempting`, which is a hold already; the next boot labels it.
    logger.warn('relay-delivery-hold-failed', {
      relayId: ref.relayId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}


/**
 * Deliver every stashed payload that can be delivered now.
 *
 * Single-flight: a pump already running is the pump, and a second entry — the
 * timer firing while a first pass awaits a capture — would read the same rows
 * and race its own sends.
 */
export async function pumpRelayDeliveries(): Promise<void> {
  if (globalThis.__relayPumpRunning) return;
  globalThis.__relayPumpRunning = true;
  try {
    const db = getDbInstance();
    ensureRelayRecovery(db);
    // Issue #3957: a reply promoted out of the second slot during a pass is
    // delivered by one more pass rather than waiting for the next tick.
    for (let pass = 0; pass < PUMP_PASSES_MAX; pass += 1) {
      globalThis.__relayPumpAgain = false;
      // Issue #4064: a payload under a delivery hold is not listed, so a pass
      // (or the next pump) never types it again; other relays go on.
      for (const item of listDeliverableRelayPayloads(db)) {
        if (inFlight.has(item.relay.id)) continue;
        inFlight.add(item.relay.id);
        try {
          await deliverOne(db, item.relay.id, item.kind, item.body, item.payloadId);
        } catch (error) {
          logger.warn('relay-delivery-failed', {
            relayId: item.relay.id,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          inFlight.delete(item.relay.id);
        }
      }
      if (!globalThis.__relayPumpAgain) break;
    }
  } catch (error) {
    logger.warn('relay-pump-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    globalThis.__relayPumpRunning = false;
  }
}

/**
 * Ask for a delivery pass without waiting for it (Issue #4082): a resolved hold
 * queued a payload again or promoted a reply. A pump already running makes one
 * more pass for it; otherwise one starts. Never sends by itself — the payload
 * goes through {@link deliverOne}'s readiness, claim and input lock like any
 * other — and never throws.
 */
export function requestRelayPump(): void {
  globalThis.__relayPumpAgain = true;
  void pumpRelayDeliveries();
}

/** One tick of the background loop: sweep the deadlines, then deliver. */
export async function runRelayMaintenanceTick(): Promise<void> {
  try {
    ensureRelayRecovery(getDbInstance());
    sweepExpiredRelays(getDbInstance());
  } catch (error) {
    logger.warn('relay-sweep-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  await pumpRelayDeliveries();
}
