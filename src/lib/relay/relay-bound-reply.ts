/**
 * Reading B's reply out of the ledger and stashing it for A (Issue #2377,
 * bound relays Issue #3957).
 *
 * Split out of `relay-delivery` (Issue #3996): everything here decides WHAT is
 * owed to a relay — the reply, the prompt notice, the bound relay's recovery
 * after a restart — and nothing here sends. The send, the pump and the state
 * they share stay in `relay-delivery`, which re-exports this module's public
 * names, and this module never imports it back.
 *
 * @module lib/relay/relay-bound-reply
 */

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import {
  appendRelayHeldCandidate,
  failOrphanedRelayBind,
  getRelayBinding,
  getRelayById,
  getRelayPendingPayload,
  getRelayPromptSignature,
  listOpenBoundRelays,
  listOpenRelaysTo,
  markRelayPromptNotified,
  promoteRelayPendingReply,
  replaceRelayPromptWithReply,
  setRelayHold,
  setRelayPendingReply,
  settleRelaySendState,
  stashRelayPayload,
  type RelayBinding,
  type RelayPendingReply,
} from '@/lib/db/relay-db';
import {
  ACTIVE_FILTER,
  getLatestOpenPromptMessage,
  getMessageById,
  getMessages,
  MODEL_CHANGE_REQUEST_ID_PREFIX,
  RELAY_SYSTEM_REQUEST_ID_PREFIX,
} from '@/lib/db/chat-db';
import { isAnswerablePromptData, type ChatMessage } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { resolveReadersLocale } from '@/lib/push/model-change-push-notifier';
import {
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
import { resolveRelaySession } from '@/lib/relay/relay-session-ref';
import { isRelayDeliveryClaimed } from '@/lib/relay/relay-delivery-claims';
import { isOpenRelayState, type SessionRelay } from '@/lib/relay/types';
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

/** The session that finished a turn, as the triggers describe it. */
export interface RelayWorkerRef {
  worktreeId: string;
  cliToolId: CLIToolType;
  /** Already resolved; the primary instance's id IS its tool id (#868). */
  instanceId: string;
}

export function senderLabel(db: Database.Database, relay: SessionRelay): RelaySenderLabel {
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
export function requiresTurnRow(cliToolId: CLIToolType): boolean {
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
export function stashReplyForOpenRelays(
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
    if (stashReply(db, relay.id, { candidateId: reply.id, body, overlap: null, basis: 'legacy' }, now) !== null) {
      stashed += 1;
    }
  }
  return stashed;
}

/**
 * What {@link stashReply} did with a decided reply: it took a slot
 * (`stashed`), a reply that finished earlier took the slot in its place
 * (`earlier-reply`, Issue #4082), or nothing changed (null).
 */
type StashOutcome = 'stashed' | 'earlier-reply' | null;

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
 *
 * Issue #4082: when a reply already waits in the second slot (it finished
 * while the notice was held, and the hold was retried), the replacement puts
 * THAT reply first and drops this later one — the first reply to finish is
 * the one kept, as the second slot always kept it.
 */
function stashReply(
  db: Database.Database,
  relayId: string,
  reply: Omit<RelayPendingReply, 'payloadId'>,
  now: number
): StashOutcome {
  const decided: RelayPendingReply = { ...reply, payloadId: randomUUID() };
  if (
    stashRelayPayload(db, relayId, 'reply', decided.body, now, {
      payloadId: decided.payloadId,
      overlap: decided.overlap ?? undefined,
    })
  ) {
    return 'stashed';
  }
  const current = getRelayPendingPayload(db, relayId);
  if (!current || current.kind !== 'prompt') return null;
  if (!isRelayDeliveryClaimed(relayId)) {
    const replaced = replaceRelayPromptWithReply(db, relayId, current.payloadId, decided, now);
    if (replaced === 'reply') return 'stashed';
    if (replaced === 'waiting-reply') {
      logger.info('relay-earlier-reply-kept', { relayId, laterCandidateId: reply.candidateId });
      return 'earlier-reply';
    }
  }
  return setRelayPendingReply(db, relayId, decided, now) ? 'stashed' : null;
}

/**
 * Whether the session's observation still matches the one the send recorded.
 *
 * A mismatch is a relaunch or a restart since the boundary; the relay is held
 * with the reason and its observation marked invalid, so no later reply from
 * the new process is matched to it either.
 */
export function observationStillHolds(
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
    // From the boundary once it is written: rows before it are never taken,
    // and must not use up the scan's bound. `timestamp` is the turn's ORDER
    // (its first row), the same key the confirmation re-reads by.
    for (const turn of findWorkerCompletions(db, worker, relay.inputBoundaryAt ?? relay.createdAt)) {
      appendRelayHeldCandidate(
        db,
        relay.id,
        { messageId: turn.row.id, timestamp: turn.orderAt, requestId: turn.row.requestId ?? null },
        now
      );
    }
    return false;
  }
  if (relay.sendState !== 'sent' || relay.inputBoundaryAt === null) return false;
  const binding = getRelayBinding(db, relay.id);
  if (!binding || !observationStillHolds(db, worker, binding)) return false;
  // The earliest turn that finished after the boundary, for the same reason.
  const [first] = findWorkerCompletions(db, worker, relay.inputBoundaryAt);
  if (!first) return false;
  return stashBoundReply(db, worker, binding, first.row, now);
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
  timestamp: number;
}

/** One finished turn: the row its body is read from, and where it sits in order. */
interface WorkerCompletion {
  /** The turn's newest row (its body). */
  row: ChatMessage;
  /** The turn's FIRST row at or after the bound (epoch ms): the order key. */
  orderAt: number;
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
export function findWorkerCompletions(
  db: Database.Database,
  worker: RelayWorkerRef,
  since: number
): WorkerCompletion[] {
  const requireTurnRow = requiresTurnRow(worker.cliToolId);
  const systemClauses = SYSTEM_ROW_REQUEST_ID_PREFIXES.map(() => 'request_id NOT LIKE ?').join(' AND ');
  const rows = db
    .prepare(`
      SELECT id, request_id, timestamp FROM chat_messages
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

  // Already in turn order: a turn is placed by its first row, and its body is
  // its newest row — kept apart so the order never follows the body.
  const turns: WorkerCompletion[] = [];
  const seenTurns = new Set<string>();
  for (const row of rows) {
    if (row.request_id !== null) {
      if (seenTurns.has(row.request_id)) continue;
      seenTurns.add(row.request_id);
      const latest = latestRowOfTurn(db, worker, row.request_id);
      if (latest) turns.push({ row: latest, orderAt: row.timestamp });
      continue;
    }
    const message = getMessageById(db, row.id);
    if (message) turns.push({ row: message, orderAt: row.timestamp });
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

/** Judge the overlap of one reply and stash it, note and all. */
export function stashBoundReply(
  db: Database.Database,
  worker: RelayWorkerRef,
  binding: RelayBinding,
  reply: ChatMessage,
  now: number
): boolean {
  const verdict = judgeRelayOverlap(db, binding, worker, reply);
  const note = buildRelayOverlapNote(resolveReadersLocale(db), verdict.overlap);
  const body = buildRelayReplyMessage(senderLabel(db, binding.relay), reply.content, note);
  const outcome = stashReply(
    db,
    binding.relay.id,
    { candidateId: reply.id, body, overlap: verdict.overlap, basis: verdict.basis },
    now
  );
  if (outcome === 'stashed') {
    logger.info('relay-reply-decided', {
      relayId: binding.relay.id,
      candidateId: reply.id,
      overlap: verdict.overlap,
      basis: verdict.basis,
    });
  }
  // An earlier reply taking the slot is still a payload for the pump.
  return outcome !== null;
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
export function notifyPromptForRelay(db: Database.Database, worker: RelayWorkerRef, relayId: string): boolean {
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
export function stashPromptNotice(
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
