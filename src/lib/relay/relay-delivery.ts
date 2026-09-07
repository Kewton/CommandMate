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
 *    why this module needs one hook and not two.
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

import type Database from 'better-sqlite3';
import { getDbInstance } from '@/lib/db/db-instance';
import {
  clearRelayPending,
  getRelayById,
  getRelayPromptSignature,
  listExpiredOpenRelays,
  listOpenRelaysTo,
  listRelaysWithPendingPayload,
  markRelayDelivered,
  markRelayExpired,
  markRelayPromptNotified,
  stashRelayPayload,
} from '@/lib/db/relay-db';
import {
  getLatestOpenPromptMessage,
  getMessages,
  relayRequestId,
  RELAY_SYSTEM_REQUEST_ID_PREFIX,
} from '@/lib/db/chat-db';
import { isAnswerablePromptData, type ChatMessage } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { resolveReadersLocale } from '@/lib/push/model-change-push-notifier';
import { sendUserMessage } from '@/lib/session/send-user-message';
import {
  buildRelayExpiredMessage,
  buildRelayPromptMessage,
  buildRelayReplyMessage,
  type RelayPromptOption,
  type RelaySenderLabel,
} from '@/lib/relay/relay-messages';
import { RELAY_SCRAPE_QUIET_MS } from '@/lib/relay/relay-policy';
import { findRelayHoldReason } from '@/lib/relay/relay-readiness';
import { resolveRelaySession } from '@/lib/relay/relay-session-ref';
import { writeRelaySystemLine } from '@/lib/relay/relay-system-line';
import type { SessionRelay } from '@/lib/relay/types';
import { createLogger } from '@/lib/logger';

const logger = createLogger('relay-delivery');

/**
 * How many assistant rows back the reply is looked for.
 *
 * A turn can write several rows (a narration then a summary), and the relay
 * wants the last one that is actually the agent talking. Bounded because an
 * unbounded read of a long-lived worktree's history is a large query for one
 * line of answer.
 */
const REPLY_LOOKBACK_MESSAGES = 40;

/** How many times the scrape path re-reads before it gives up on stability. */
const SCRAPE_STABILITY_ATTEMPTS = 3;

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
}

const inFlight = (globalThis.__relayDeliveryInFlight ??= new Set<string>());

/** Forget every in-flight delivery. Test seam. */
export function resetRelayDeliveryState(): void {
  inFlight.clear();
  globalThis.__relayPumpRunning = false;
}

/** The session that finished a turn, as the triggers describe it. */
export interface RelayWorkerRef {
  worktreeId: string;
  cliToolId: CLIToolType;
  /** Already resolved; the primary instance's id IS its tool id (#868). */
  instanceId: string;
}

function senderLabel(db: Database.Database, relay: SessionRelay): RelaySenderLabel {
  const worker = resolveRelaySession(db, relay.to);
  return { alias: worker.alias, worktreeId: worker.worktreeId };
}

/**
 * The newest thing B actually said, at or after `since`.
 *
 * Three kinds of row are stepped over, and each exclusion is load-bearing:
 * prompt rows (a question is not an answer, and the confirmation notice is a
 * separate delivery), relay SYSTEM rows (this session's own transcript
 * furniture — delivering "Reply from X" back to X is the smallest possible
 * loop), and empty bodies.
 */
export function findWorkerReply(
  db: Database.Database,
  worker: RelayWorkerRef,
  since: number
): ChatMessage | null {
  const messages = getMessages(db, worker.worktreeId, {
    limit: REPLY_LOOKBACK_MESSAGES,
    cliToolId: worker.cliToolId,
    instanceId: worker.instanceId,
    matchResolvedInstance: true,
  });

  // `getMessages` answers newest-first, so the first candidate IS the newest.
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    if (message.messageType === 'prompt') continue;
    if (message.requestId?.startsWith(RELAY_SYSTEM_REQUEST_ID_PREFIX)) continue;
    if (message.content.trim() === '') continue;
    return message.timestamp.getTime() < since ? null : message;
  }
  return null;
}

/** The options of B's open dialog, in the shape the notice lists them. */
function promptOptionsOf(message: ChatMessage): RelayPromptOption[] {
  const data = message.promptData;
  if (!isAnswerablePromptData(data)) return [];
  if (data.type === 'yes_no') {
    return data.options.map((label) => ({ key: label, label }));
  }
  return data.options.map((option) => ({
    key: String(option.number),
    label: option.label,
  }));
}

/**
 * Stash B's finished reply against every relay that is waiting for it.
 *
 * @returns How many relays took a payload from this call
 */
function stashReplyForOpenRelays(
  db: Database.Database,
  worker: RelayWorkerRef,
  now: number
): number {
  const relays = listOpenRelaysTo(db, {
    worktreeId: worker.worktreeId,
    instanceId: worker.instanceId,
  });
  if (relays.length === 0) return 0;

  let stashed = 0;
  for (const relay of relays) {
    // `createdAt` and not "the last time we looked": a reply written BEFORE the
    // relay existed answered somebody else's question, and delivering it would
    // hand session A the previous turn — the exact failure a bare `capture`
    // after a `wait` has always had.
    const reply = findWorkerReply(db, worker, relay.createdAt);
    if (!reply) continue;

    const body = buildRelayReplyMessage(senderLabel(db, relay), reply.content);
    if (stashRelayPayload(db, relay.id, 'reply', body, now)) stashed += 1;
  }
  return stashed;
}

/** Sleep, so the scrape path can wait out its quiet window. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
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

    const locale = resolveReadersLocale(db);
    const options = promptOptionsOf(prompt);
    const question = isAnswerablePromptData(prompt.promptData)
      ? prompt.promptData.question
      : (prompt.promptData?.question ?? prompt.content);

    let stashed = 0;
    for (const relay of relays) {
      // The dialog's own row id is the signature: a wait that lasts twenty
      // minutes is ONE row, so A is told once however many polls observe it.
      if (getRelayPromptSignature(db, relay.id) === prompt.id) continue;
      const body = buildRelayPromptMessage(locale, senderLabel(db, relay), {
        question,
        options,
      });
      if (stashRelayPayload(db, relay.id, 'prompt', body)) {
        // The signature is recorded HERE, before the delivery, and not after it:
        // it is what stops every later poll of the same twenty-minute dialog
        // from stashing the same notice again while A is still busy. The state
        // moving to `prompt` is an OPEN state, so the reply that follows once
        // the dialog is answered can still be stashed and delivered.
        markRelayPromptNotified(db, relay.id, prompt.id);
        stashed += 1;
      }
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
    try {
      const locale = resolveReadersLocale(db);
      // A payload that never went out is superseded by the expiry notice: A
      // asked for an answer, and what they are getting is the news that there
      // will not be one.
      clearRelayPending(db, relay.id, now);
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

/** What one delivery attempt did. Exported for the suite. */
export type RelayDeliveryOutcome = 'delivered' | 'held' | 'skipped' | 'failed';

/**
 * Try to put one stashed payload into A's composer.
 *
 * The order — readiness, then send, then ledger — is deliberate. Marking first
 * would lose the answer whenever the send failed, and the send path has real
 * refusals in it (`prompt_waiting`, a session that went away mid-attempt). A
 * repeat delivery is prevented by the in-flight set within a process and by
 * `markRelayDelivered`'s guarded update across one, which is the idempotency the
 * Issue asks for by name.
 */
async function deliverOne(
  db: Database.Database,
  relayId: string,
  kind: 'reply' | 'prompt' | 'expired',
  body: string
): Promise<RelayDeliveryOutcome> {
  const relay = getRelayById(db, relayId);
  if (!relay) return 'skipped';

  const requester = resolveRelaySession(db, relay.from);
  const hold = await findRelayHoldReason(
    requester.worktreeId,
    requester.cliToolId,
    requester.instanceId
  );
  if (hold) {
    logger.debug('relay-delivery-held', { relayId, kind, reason: hold });
    return 'held';
  }

  const result = await sendUserMessage(db, {
    worktreeId: requester.worktreeId,
    content: body,
    cliToolId: requester.cliToolId,
    instanceId: requester.instanceId,
    messageType: 'relay',
    // The pointer back at the ledger. Also `session_relays.sent_request_id` for
    // a reply, which carries a UNIQUE index — so a second delivery of the same
    // relay cannot be recorded even if one were somehow attempted.
    requestId: kind === 'reply' ? relayRequestId(relay.id) : undefined,
  });

  if (!result.ok) {
    logger.info('relay-delivery-refused', { relayId, kind, stage: result.stage });
    return result.stage === 'prompt_waiting' ? 'held' : 'failed';
  }

  const now = Date.now();
  if (kind === 'reply') {
    if (!markRelayDelivered(db, relay.id, relayRequestId(relay.id), now)) {
      // Somebody closed it underneath us. The message is already in A's
      // composer, which is the outcome that mattered.
      logger.info('relay-already-closed-on-deliver', { relayId });
    }
    writeRelaySystemLine(
      db,
      relay.id,
      'replied',
      requester,
      resolveRelaySession(db, relay.to),
      now
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
  clearRelayPending(db, relay.id, now);
  logger.info('relay-delivered', { relayId, kind, to: `${requester.worktreeId}/${requester.instanceId}` });
  return 'delivered';
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
    for (const item of listRelaysWithPendingPayload(db)) {
      if (inFlight.has(item.relay.id)) continue;
      inFlight.add(item.relay.id);
      try {
        await deliverOne(db, item.relay.id, item.kind, item.body);
      } catch (error) {
        logger.warn('relay-delivery-failed', {
          relayId: item.relay.id,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        inFlight.delete(item.relay.id);
      }
    }
  } catch (error) {
    logger.warn('relay-pump-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    globalThis.__relayPumpRunning = false;
  }
}

/** One tick of the background loop: sweep the deadlines, then deliver. */
export async function runRelayMaintenanceTick(): Promise<void> {
  try {
    sweepExpiredRelays(getDbInstance());
  } catch (error) {
    logger.warn('relay-sweep-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  await pumpRelayDeliveries();
}
