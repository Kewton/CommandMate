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
  appendRelayHeldCandidate,
  clearRelayHeldCandidates,
  clearRelayPending,
  clearRelayPendingReply,
  failOrphanedRelayBind,
  getRelayBinding,
  getRelayById,
  getRelayPendingPayload,
  getRelayPromptSignature,
  listExpiredOpenRelays,
  listOpenBoundRelays,
  listOpenRelaysTo,
  listRelaysWithPendingPayload,
  markRelayDelivered,
  markRelayExpired,
  markRelayPromptNotified,
  promoteRelayPendingReply,
  replaceRelayPromptWithPendingReply,
  replaceRelayPromptWithReply,
  setRelayHold,
  setRelayPendingReply,
  settleRelaySendState,
  stashRelayPayload,
  type RelayBinding,
  type RelayHeldCandidate,
  type RelayPendingReply,
} from '@/lib/db/relay-db';
import {
  ACTIVE_FILTER,
  getLatestOpenPromptMessage,
  getMessageById,
  getMessages,
  MODEL_CHANGE_REQUEST_ID_PREFIX,
  relayRequestId,
  RELAY_SYSTEM_REQUEST_ID_PREFIX,
} from '@/lib/db/chat-db';
import { isAnswerablePromptData, type ChatMessage } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { resolveReadersLocale } from '@/lib/push/model-change-push-notifier';
import { sendUserMessage } from '@/lib/session/send-user-message';
import {
  buildRelayExpiredMessage,
  buildRelayOverlapNote,
  buildRelayPromptMessage,
  buildRelayReplyMessage,
  type RelayPromptOption,
  type RelaySenderLabel,
} from '@/lib/relay/relay-messages';
import { RELAY_HOLD_REASONS } from '@/lib/relay/relay-bind';
import {
  bootOfObservationSource,
  relayObservationSource,
  relayServerBootId,
} from '@/lib/relay/relay-boot';
import { judgeRelayOverlap } from '@/lib/relay/relay-overlap';
import { getWaitingEpisode } from '@/lib/session/waiting-episode-state';
import { isApiAnswerableWaitNow } from '@/lib/session/prompt-waiting-composition';
import { getAgentEventSource } from '@/lib/hooks/sources/registry';
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
import { isOpenRelayState, type SessionRelay } from '@/lib/relay/types';
import { createLogger } from '@/lib/logger';
import { getOrInitGlobal } from '../global-state';

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

/** How many passes one pump makes when a pass promoted a reply (Issue #3957). */
const PUMP_PASSES_MAX = 3;

/** How many times the scrape path re-reads before it gives up on stability. */
const SCRAPE_STABILITY_ATTEMPTS = 3;

/**
 * The `request_id` shape a transcript reader mints for a finished turn.
 *
 * `claude-turn:<uuid>`, `codex-turn:<turn_id>`, `antigravity-turn:<id>`,
 * `command-code-turn:<id>` and opencode's `oc-turn:<message id>`. Matched as a
 * SHAPE rather than as a list of five literals for the reason `ask`'s copy of
 * this line gives (Issue #2386): the sixth reader lands INSIDE the filter
 * instead of silently outside it. A `:` cannot appear in any of the ids
 * themselves, so this cannot match a row that merely contains the text.
 *
 * Copied rather than imported, deliberately. `src/cli/commands/ask.ts` has the
 * same regexp, and importing it here would invert the dependency (lib reaching
 * into the CLI bundle); `AGENT_MARKDOWN_REQUEST_ID_PREFIXES` in
 * `src/types/agent-transcript.ts` is the LIST form this shape is chosen not to
 * be. One regexp in each layer is cheaper than either edge.
 */
const TURN_REQUEST_ID_PATTERN = /-turn:/;

/**
 * Request-id namespaces CommandMate writes ABOUT a session, not for it.
 *
 * `chat_messages` has no `system` role, so "reply from X" (Issue #2377) and
 * "the model changed" (Issue #2357) are both stored as assistant rows and told
 * apart by their request id. Neither is a word the worker said, and handing the
 * relay's own notice back to the session it came from is the smallest possible
 * loop. `ask` steps over exactly these two for the same reason.
 */
const SYSTEM_ROW_REQUEST_ID_PREFIXES = [
  RELAY_SYSTEM_REQUEST_ID_PREFIX,
  MODEL_CHANGE_REQUEST_ID_PREFIX,
] as const;

/**
 * Whether this tool's reply is read out of a transcript rather than off a screen.
 *
 * For the six that answer `true` the ledger is authoritative: a row with no
 * turn marker was written by the SCRAPER, and for these tools a scraped row is
 * never the answer — it is a footer line, a half-drawn frame or the ANSI dump
 * the send path flushes (Issues #2398 / #2400). The relay may therefore hold
 * out for a marked row. For copilot, gemini and vibe-local the scraper's row is
 * the only record there will ever be, and demanding a marker would deliver
 * nothing, ever.
 *
 * A record and not a `Set`, so a ninth entry in `CLI_TOOL_IDS` fails `tsc` here
 * instead of quietly defaulting to "screen-scraped" — the idiom
 * `cli-tools/install-hints` uses for the same reason.
 *
 * Deliberately NOT `isPullTranscriptHistory`: that asks who does the READING,
 * so opencode (whose own server pushes) answers `false` even though its rows
 * carry `oc-turn:` like the other four. It also lives in `lib/polling`, whose
 * module graph reaches this file's triggers — importing it would close a cycle
 * the relay was built to avoid.
 */
const TRANSCRIPT_READER_TOOLS: Readonly<Record<CLIToolType, boolean>> = {
  claude: true,
  codex: true,
  antigravity: true,
  'command-code': true,
  opencode: true,
  copilot: false,
  gemini: false,
  'vibe-local': false,
  // Issue #2940: OpenCode V2's replies are written from its server
  // (`GET /api/session/{id}/message`) under `oc-turn:`, like opencode's.
  'opencode-v2': true,
};

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
}

const inFlight = getOrInitGlobal('__relayDeliveryInFlight', () => new Set<string>());

/** Forget every in-flight delivery. Test seam. */
export function resetRelayDeliveryState(): void {
  inFlight.clear();
  resetRelayDeliveryClaims();
  globalThis.__relayPumpRunning = false;
  globalThis.__relayRecoveredBootId = undefined;
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

/** Whether a row's `request_id` says a transcript reader wrote it. */
function isTurnRow(requestId: string | null | undefined): boolean {
  return typeof requestId === 'string' && TURN_REQUEST_ID_PATTERN.test(requestId);
}

/** Whether a row is CommandMate's own furniture rather than the worker's words. */
function isSystemRow(requestId: string | null | undefined): boolean {
  return typeof requestId === 'string'
    && SYSTEM_ROW_REQUEST_ID_PREFIXES.some((prefix) => requestId.startsWith(prefix));
}

/** Whether this worker's answer is only ever a transcript row. */
function requiresTurnRow(cliToolId: CLIToolType): boolean {
  return TRANSCRIPT_READER_TOOLS[cliToolId] === true;
}

/**
 * The newest thing B actually said, at or after `since`.
 *
 * Four kinds of row are stepped over, and each exclusion is load-bearing:
 * prompt rows (a question is not an answer, and the confirmation notice is a
 * separate delivery), CommandMate's own system rows (delivering "Reply from X"
 * back to X is the smallest possible loop), empty bodies — and, for a tool that
 * keeps a transcript, every row the SCRAPER wrote.
 *
 * That last one is Issue #2401. Until it was added the filter looked only at
 * shape, never at provenance, so the newest row won whatever had written it:
 * a codex footer line, a partial scrape, or the raw ANSI the send path flushes
 * lands in the ledger with `request_id IS NULL` and, being newest, WAS the
 * reply — forwarded to the requesting agent as the worker's own answer, which
 * it then summarises. #2386 fixed the identical hole in `ask` by demanding the
 * turn marker; the relay looked exempt only because its 15-second pump usually
 * gave the transcript time to land, and a race the timing usually wins is still
 * a race.
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
  const requireTurnRow = requiresTurnRow(worker.cliToolId);

  // `getMessages` answers newest-first, so the first candidate IS the newest.
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    if (message.messageType === 'prompt') continue;
    if (isSystemRow(message.requestId)) continue;
    if (requireTurnRow && !isTurnRow(message.requestId)) continue;
    if (message.content.trim() === '') continue;
    return message.timestamp.getTime() < since ? null : message;
  }
  return null;
}

/** The options of B's open dialog, in the shape the notice lists them. */
function promptOptionsOf(message: ChatMessage): RelayPromptOption[] {
  const data = message.promptData;
  // #3184: type narrowing only — the stored row's screen `options` are listed;
  // a stored degraded record never carries a decision id, so it has none.
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
    // Issue #3957: a bound relay is answered from its own send's boundary, and
    // only once that send is confirmed.
    if (relay.bindMode === 'bound') {
      if (stashForBoundRelay(db, worker, relay, now)) stashed += 1;
      continue;
    }
    // `createdAt` and not "the last time we looked": a reply written BEFORE the
    // relay existed answered somebody else's question, and delivering it would
    // hand session A the previous turn — the exact failure a bare `capture`
    // after a `wait` has always had.
    const reply = findWorkerReply(db, worker, relay.createdAt);
    if (!reply) continue;

    const body = buildRelayReplyMessage(senderLabel(db, relay), reply.content);
    if (stashReply(db, relay.id, { candidateId: reply.id, body, overlap: null, basis: 'legacy' }, now)) {
      stashed += 1;
    }
  }
  return stashed;
}

/**
 * Stash a decided reply, minding the prompt notice that may hold the slot
 * (Issue #3957).
 *
 * The slot is free: the reply takes it. A prompt notice holds it and is not
 * being typed: the reply REPLACES it — the dialog it describes has been
 * answered, and delivering the stale notice would start a new turn on the
 * requester for nothing. The notice is being typed: the reply waits in the
 * second slot and is promoted once the notice is out. A reply already holds
 * it: nothing (two producers, one delivery).
 */
function stashReply(
  db: Database.Database,
  relayId: string,
  reply: Omit<RelayPendingReply, 'payloadId'>,
  now: number
): boolean {
  const decided: RelayPendingReply = { ...reply, payloadId: randomUUID() };
  if (
    stashRelayPayload(db, relayId, 'reply', decided.body, now, {
      payloadId: decided.payloadId,
      overlap: decided.overlap ?? undefined,
    })
  ) {
    return true;
  }
  const current = getRelayPendingPayload(db, relayId);
  if (!current || current.kind !== 'prompt') return false;
  if (!isRelayDeliveryClaimed(relayId)) {
    if (replaceRelayPromptWithReply(db, relayId, current.payloadId, decided, now)) return true;
  }
  return setRelayPendingReply(db, relayId, decided, now);
}

/**
 * Whether the session's observation still matches the one the send recorded.
 *
 * A mismatch is a relaunch or a restart since the boundary; the relay is held
 * with the reason and its observation marked invalid, so no later reply from
 * the new process is matched to it either.
 */
function observationStillHolds(
  db: Database.Database,
  worker: RelayWorkerRef,
  binding: RelayBinding
): boolean {
  if (binding.relay.obsState === 'invalid') return false;
  const now = relayObservationSource(worker.worktreeId, worker.cliToolId, worker.instanceId);
  if (binding.obsSource === now) return true;
  const restarted = bootOfObservationSource(binding.obsSource) !== relayServerBootId();
  setRelayHold(
    db,
    binding.relay.id,
    restarted ? RELAY_HOLD_REASONS.serverRestarted : RELAY_HOLD_REASONS.generationChanged,
    { invalidate: true }
  );
  logger.info('relay-observation-mismatch', { relayId: binding.relay.id, restarted });
  return false;
}

/**
 * A completion reached a bound relay (Issue #3957).
 *
 * Before the send is confirmed it is only HELD — appended to the candidates,
 * never replacing an earlier one — because the send may still fail, and a
 * reply that ended while the body queued for the lock is not this request's.
 * Once `sent`, the reply is read from the boundary and stashed with its
 * overlap. `failed` / `unknown` take nothing.
 */
function stashForBoundRelay(
  db: Database.Database,
  worker: RelayWorkerRef,
  relay: SessionRelay,
  now: number
): boolean {
  if (relay.sendState === 'awaiting' || relay.sendState === 'input_started') {
    // Every finished turn since the relay opened, oldest first — not only the
    // newest: a transcript reader that backfills two turns saves both and
    // announces once, and holding only the newest would lose the earlier one.
    for (const reply of findWorkerCompletions(db, worker, relay.createdAt)) {
      appendRelayHeldCandidate(
        db,
        relay.id,
        { messageId: reply.id, timestamp: reply.timestamp.getTime(), requestId: reply.requestId ?? null },
        now
      );
    }
    return false;
  }
  if (relay.sendState !== 'sent' || relay.inputBoundaryAt === null) return false;
  const binding = getRelayBinding(db, relay.id);
  if (!binding || !observationStillHolds(db, worker, binding)) return false;
  // The earliest turn that finished after the boundary, for the same reason.
  const [reply] = findWorkerCompletions(db, worker, relay.inputBoundaryAt);
  if (!reply) return false;
  return stashBoundReply(db, worker, binding, reply, now);
}

/**
 * How many completion rows one read collects at most (Issue #3957).
 *
 * A safety bound, not a window: the rows are read OLDEST first from the lower
 * bound, so reaching it can only drop the LATEST turns, never the earliest —
 * and the earliest is the only one ever taken. A newest-first window (the
 * 40 rows {@link findWorkerReply} reads) is the opposite: a backfill of more
 * rows than it holds pushes the earliest turn out and the next one is taken.
 */
const COMPLETION_SCAN_MAX_ROWS = 500;

interface CompletionRowRef {
  id: string;
  request_id: string | null;
}

/**
 * Every finished turn of B at or after `since`, oldest first, as one row per
 * turn (Issue #3957).
 *
 * The same row filter as {@link findWorkerReply}, applied in SQL so that user
 * rows, prompt rows and CommandMate's own rows do not use up the bound, and
 * ordered by time then insertion (rowid). A transcript tool's turn is its
 * `-turn:` request id, represented by its NEWEST row (the summary after the
 * narration, read by the request id without a bound — see
 * {@link latestRowOfTurn}); a row with no request id (a scrape-only tool) is a
 * turn of its own.
 */
function findWorkerCompletions(
  db: Database.Database,
  worker: RelayWorkerRef,
  since: number
): ChatMessage[] {
  const requireTurnRow = requiresTurnRow(worker.cliToolId);
  const systemClauses = SYSTEM_ROW_REQUEST_ID_PREFIXES.map(() => 'request_id NOT LIKE ?').join(' AND ');
  const rows = db
    .prepare(`
      SELECT id, request_id FROM chat_messages
      WHERE worktree_id = ? ${ACTIVE_FILTER}
        AND COALESCE(cli_tool_id, 'claude') = ?
        AND COALESCE(instance_id, cli_tool_id, 'claude') = ?
        AND role = 'assistant' AND COALESCE(message_type, 'normal') != 'prompt'
        AND (request_id IS NULL OR (${systemClauses}))
        ${requireTurnRow ? "AND request_id LIKE '%-turn:%'" : ''}
        AND TRIM(content, ' ' || char(9, 10, 13)) != ''
        AND timestamp >= ?
      ORDER BY timestamp ASC, rowid ASC
      LIMIT ?
    `)
    .all(
      worker.worktreeId,
      worker.cliToolId,
      worker.instanceId,
      ...SYSTEM_ROW_REQUEST_ID_PREFIXES.map((prefix) => `${prefix}%`),
      since,
      COMPLETION_SCAN_MAX_ROWS
    ) as CompletionRowRef[];

  const turns: ChatMessage[] = [];
  const seenTurns = new Set<string>();
  for (const row of rows) {
    if (row.request_id !== null) {
      if (seenTurns.has(row.request_id)) continue;
      seenTurns.add(row.request_id);
      const latest = latestRowOfTurn(db, worker, row.request_id);
      if (latest) turns.push(latest);
      continue;
    }
    const message = getMessageById(db, row.id);
    if (message) turns.push(message);
  }
  return turns;
}

/** The newest row a turn wrote, by its request id — no row bound. */
function latestRowOfTurn(
  db: Database.Database,
  worker: RelayWorkerRef,
  requestId: string
): ChatMessage | null {
  const row = db
    .prepare(`
      SELECT id FROM chat_messages
      WHERE worktree_id = ? ${ACTIVE_FILTER}
        AND COALESCE(cli_tool_id, 'claude') = ?
        AND COALESCE(instance_id, cli_tool_id, 'claude') = ?
        AND role = 'assistant' AND request_id = ?
        AND TRIM(content, ' ' || char(9, 10, 13)) != ''
      ORDER BY timestamp DESC, rowid DESC
      LIMIT 1
    `)
    .get(worker.worktreeId, worker.cliToolId, worker.instanceId, requestId) as { id: string } | undefined;
  return row ? getMessageById(db, row.id) : null;
}

/** The newest row of the turn a held candidate pointed at (it may have grown since). */
function latestRowOfCandidate(
  db: Database.Database,
  worker: RelayWorkerRef,
  candidate: RelayHeldCandidate
): ChatMessage | null {
  if (candidate.requestId) {
    const turn = latestRowOfTurn(db, worker, candidate.requestId);
    if (turn) return turn;
  }
  return getMessageById(db, candidate.messageId);
}

/** Judge the overlap of one reply and stash it, note and all. */
function stashBoundReply(
  db: Database.Database,
  worker: RelayWorkerRef,
  binding: RelayBinding,
  reply: ChatMessage,
  now: number
): boolean {
  const verdict = judgeRelayOverlap(db, binding, worker, reply);
  const note = buildRelayOverlapNote(resolveReadersLocale(db), verdict.overlap);
  const body = buildRelayReplyMessage(senderLabel(db, binding.relay), reply.content, note);
  const stashed = stashReply(
    db,
    binding.relay.id,
    { candidateId: reply.id, body, overlap: verdict.overlap, basis: verdict.basis },
    now
  );
  if (stashed) {
    logger.info('relay-reply-decided', {
      relayId: binding.relay.id,
      candidateId: reply.id,
      overlap: verdict.overlap,
      basis: verdict.basis,
    });
  }
  return stashed;
}

/**
 * The bound send was confirmed: judge what was held for it (Issue #3957).
 *
 * The EARLIEST held candidate at or after the boundary is taken — not the
 * newest: when two turns ended before the send was confirmed, the first one
 * after the boundary is the one this request started. Earlier candidates are
 * dropped. The worker's open prompt is judged at the same moment: a dialog
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
      const held = binding.heldCandidates;
      clearRelayHeldCandidates(db, relayId);
      if (!observationStillHolds(db, worker, binding)) return false;
      // Earliest by the row's own time; arrival order breaks ties (one
      // announcement can hold several turns).
      const ordered = held
        .map((candidate, index) => ({ candidate, index }))
        .sort((a, b) => a.candidate.timestamp - b.candidate.timestamp || a.index - b.index)
        .map(({ candidate }) => candidate);
      const seenTurns = new Set<string>();
      for (const candidate of ordered) {
        if (candidate.timestamp < boundary) continue;
        if (candidate.requestId) {
          if (seenTurns.has(candidate.requestId)) continue;
          seenTurns.add(candidate.requestId);
        }
        const row = latestRowOfCandidate(db, worker, candidate);
        if (!row) continue;
        return stashBoundReply(db, worker, binding, row, now);
      }
      return false;
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
 * Whether a prompt row may be told to this relay's requester (Issue #3957).
 *
 * A legacy relay: as before. A bound one: only once its send is confirmed,
 * with a valid observation, and only for a dialog that appeared at or after
 * its boundary — one shown before the request went in belongs to somebody
 * else's turn.
 */
function promptBelongsToRelay(
  db: Database.Database,
  worker: RelayWorkerRef,
  relay: SessionRelay,
  prompt: ChatMessage
): boolean {
  if (relay.bindMode !== 'bound') return true;
  if (relay.sendState !== 'sent' || relay.inputBoundaryAt === null) return false;
  if (prompt.timestamp.getTime() < relay.inputBoundaryAt) return false;
  const binding = getRelayBinding(db, relay.id);
  return binding !== null && observationStillHolds(db, worker, binding);
}

/**
 * Re-judge the worker's open dialog for one bound relay just confirmed.
 *
 * "Still open" is the waiting episode, not merely an unanswered row: the
 * opening edge that would have told the relay fired before the send was
 * confirmed, and a dialog closed since must not be reported.
 */
function notifyPromptForRelay(db: Database.Database, worker: RelayWorkerRef, relayId: string): boolean {
  const episode = getWaitingEpisode(worker.worktreeId, worker.cliToolId, worker.instanceId);
  if (!episode || episode.kind !== 'prompt') return false;
  if (
    isApiAnswerableWaitNow(
      worker.worktreeId,
      worker.cliToolId,
      worker.instanceId,
      getAgentEventSource(worker.cliToolId).capabilities.eventIdentity
    )
  ) {
    return false;
  }
  const prompt = getLatestOpenPromptMessage(db, worker.worktreeId, worker.cliToolId, worker.instanceId);
  if (!prompt) return false;
  const relay = getRelayById(db, relayId);
  if (!relay || !isOpenRelayState(relay.state)) return false;
  return stashPromptNotice(db, worker, relay, prompt);
}

/** Stash one prompt notice for one relay, once per dialog. */
function stashPromptNotice(
  db: Database.Database,
  worker: RelayWorkerRef,
  relay: SessionRelay,
  prompt: ChatMessage
): boolean {
  if (!promptBelongsToRelay(db, worker, relay, prompt)) return false;
  // The dialog's own row id is the signature: a wait that lasts twenty
  // minutes is ONE row, so A is told once however many polls observe it.
  if (getRelayPromptSignature(db, relay.id) === prompt.id) return false;
  const locale = resolveReadersLocale(db);
  const options = promptOptionsOf(prompt);
  // #3184: type narrowing only, to read `question` off the closed union.
  const question = isAnswerablePromptData(prompt.promptData)
    ? prompt.promptData.question
    : (prompt.promptData?.question ?? prompt.content);
  const body = buildRelayPromptMessage(locale, senderLabel(db, relay), { question, options });
  if (!stashRelayPayload(db, relay.id, 'prompt', body)) return false;
  // The signature is recorded HERE, before the delivery, and not after it:
  // it is what stops every later poll of the same twenty-minute dialog
  // from stashing the same notice again while A is still busy. The state
  // moving to `prompt` is an OPEN state, so the reply that follows once
  // the dialog is answered can still be stashed and delivered.
  markRelayPromptNotified(db, relay.id, prompt.id);
  return true;
}

/**
 * After a restart, settle every bound relay the previous boot left mid-send
 * (Issue #3957). Once per boot; cheap when there is nothing to do.
 *
 *  - `awaiting`, not reserved: left alone (nobody has sent yet).
 *  - `awaiting`, reserved by another boot: that boot died before the boundary,
 *    i.e. before the first key — proven unsent, so the relay is cancelled.
 *  - `input_started` by another boot: whether the body went in cannot be
 *    told; held as `unknown`.
 *  - `sent` with a decided payload: delivered as usual.
 *  - `sent` without one, observed by another boot: the turn record that
 *    reply would be judged against is gone; held, observation invalid.
 */
export function recoverBoundRelays(db: Database.Database, now = Date.now()): number {
  const boot = relayServerBootId();
  let recovered = 0;
  for (const binding of listOpenBoundRelays(db)) {
    const { relay } = binding;
    if (relay.sendState === 'awaiting') {
      if (binding.bindAttemptId === null || binding.bindOwner === boot) continue;
      if (failOrphanedRelayBind(db, relay.id, binding.bindAttemptId, RELAY_HOLD_REASONS.serverRestartedBeforeInput, now)) {
        recovered += 1;
      }
      continue;
    }
    if (relay.sendState === 'input_started') {
      if (binding.bindOwner === boot || binding.bindAttemptId === null) continue;
      if (
        settleRelaySendState(db, {
          relayId: relay.id,
          attemptId: binding.bindAttemptId,
          from: ['input_started'],
          to: 'unknown',
          holdReason: RELAY_HOLD_REASONS.serverRestarted,
          now,
        })
      ) {
        recovered += 1;
      }
      continue;
    }
    if (relay.sendState === 'sent') {
      if (binding.pendingKind !== null) continue;
      if (binding.pendingReply !== null) {
        if (promoteRelayPendingReply(db, relay.id, now)) recovered += 1;
        continue;
      }
      if (bootOfObservationSource(binding.obsSource) === boot || relay.obsState === 'invalid') continue;
      setRelayHold(db, relay.id, RELAY_HOLD_REASONS.serverRestarted, { invalidate: true, now });
      recovered += 1;
    }
  }
  if (recovered > 0) logger.info('relay-bound-recovered', { recovered });
  return recovered;
}

/** {@link recoverBoundRelays}, once per boot. */
function ensureRelayRecovery(db: Database.Database): void {
  const boot = relayServerBootId();
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
      // will not be one. Both slots (Issue #3957).
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
 *
 * `kind` and `body` are what the pump's listing saw, and that listing is stale
 * by the time the readiness check returns (#3732): an earlier relay's send, or
 * this one's own capture, may have let a cancel or an expiry sweep run. So the
 * row is read again AFTER the last await before the send, and the send goes
 * ahead only when it still carries the same payload — and, for anything but an
 * expiry notice, is still open. The claim is taken in that same synchronous
 * stretch, so no cancel can slip in between the check and the send; from then
 * on `withdrawRelay` answers `delivering`.
 */
async function deliverOne(
  db: Database.Database,
  relayId: string,
  kind: 'reply' | 'prompt' | 'expired',
  body: string
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
  if (!current || current.kind !== kind || current.body !== body) {
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

  claimRelayDelivery(relayId);
  let delivered = false;
  try {
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
    // Issue #3957: only the payload that was sent. A reply that replaced it
    // or waits in the second slot survives, and the second slot is promoted
    // now that the notice is out.
    clearRelayPending(db, relay.id, now, current.payloadId);
    if (kind === 'prompt' && promoteRelayPendingReply(db, relay.id, now)) {
      globalThis.__relayPumpAgain = true;
    }
    logger.info('relay-delivered', { relayId, kind, to: `${requester.worktreeId}/${requester.instanceId}` });
    delivered = true;
    return 'delivered';
  } finally {
    // Issue #3957: a prompt notice that did not go out (refused, failed,
    // threw) is back to unclaimed — and a reply that finished while it was
    // being typed waits in the second slot. The reply supersedes the notice
    // exactly as it would have had it arrived a moment later.
    // A failure here must not keep the claim below from being released: a
    // claim left behind refuses every cancel and every expiry of the relay.
    if (!delivered && kind === 'prompt') {
      try {
        if (replaceRelayPromptWithPendingReply(db, relay.id, current.payloadId)) {
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
    // Held or failed: nothing reached A, so the relay can be withdrawn again.
    releaseRelayDelivery(relayId);
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
