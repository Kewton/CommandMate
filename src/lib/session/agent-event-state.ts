/**
 * In-memory record of the structured lifecycle events an agent has reported,
 * and the session status they imply (#1549, #1722, promoted in #1723, extended
 * with the open-dialog state machine in #1725).
 *
 * The agent CLI telling us what it did is a different kind of fact from the
 * screen-scraped status: it is exact, but it only exists where hooks actually
 * fire. #1549 and #1722 therefore kept it strictly beside the detector's
 * output. #1723 promotes it to a first-class source — {@link
 * getStructuredSessionState} answers with a `SessionStatus`, and
 * `current-output-builder` prefers that answer to the scraper's — while
 * `detectSessionStatus()` stays a pure function of the terminal frame and stays
 * in charge wherever no event has arrived.
 *
 * Three things bound how far that trust extends, because a hook is an
 * unreliable channel by design (every failure is fail-open):
 *
 *  - **generation** — events are keyed by (worktree, tool, instance), a key a
 *    recreated session reuses, so a generation marker fences off the previous
 *    process's events. See {@link beginAgentEventGeneration}.
 *  - **age** — see {@link STRUCTURED_STATE_MAX_AGE_MS}, which bounds the damage
 *    of a `Stop` that never arrived.
 *  - **liveness** — a dead tmux session has no structured state; the caller
 *    establishes that before asking.
 *
 * #1725 adds a second, independent state alongside the status verdict: whether
 * a dialog is open. It is separate because it is released by different things —
 * there is no "the human answered" event, so the scraper has to be part of the
 * rule — and because `lastAgentEvent` holds only the newest event, which cannot
 * express "a dialog is still up" once anything else has arrived. See
 * {@link getStructuredPromptWaiting}.
 *
 * In-memory and not in SQLite for the same reason `auto-yes-state` is: the value
 * describes a live tmux session, and a session does not survive a server restart
 * for the timestamp to still be about. Losing it on restart is safe precisely
 * because the scraper is still there to answer.
 *
 * @module lib/session/agent-event-state
 */

import { buildCompositeKey } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';
import {
  MAX_EVENT_DETAIL_LENGTH,
  PERMISSION_REPLIED_DETAIL,
  type AgentEventType,
} from '@/lib/hooks/agent-event-types';
import type { AskUserQuestionSpec } from '@/lib/hooks/ask-user-question-payload';
import { ASK_USER_QUESTION_TOOL } from '@/lib/hooks/permission-request-payload';
// Issue #1899: type-only, so nothing in the source registry's module graph —
// `better-sqlite3` included — is pulled into this module at runtime.
import type { AgentSourceCapabilities } from '@/lib/hooks/sources/types';
// Issue #1903: the four-value vocabulary the verdicts below are read in.
import type { SessionStatus } from '@/lib/detection/status-detector';
// Issue #1784: the terminal-frame half of "which model / effort is this on".
import { mergeModelInfo, type ModelInfo } from '@/lib/detection/model-info-extractor';
import {
  agentEventToSessionStatus,
  HOOK_STATUS_REASON,
  type StructuredStatusVerdict,
} from '@/lib/session/status-mapping';
import type { StructuredPromptSource } from '@/lib/session/structured-prompt';
// Issue #1930: the turn model. Pure, so importing it here costs nothing at
// runtime beyond the two bounds it owns.
import {
  acceptExternalId,
  boundDecisionMessage,
  boundDecisionToolName,
  closesTurn,
  derivePublishedTurn,
  DIALOG_PENDING_MAX_MS,
  isDecisionLive,
  MAX_PENDING_DECISIONS_PER_TURN,
  SCRAPER_COMPLETION_POLLS,
  TURN_STALE_AFTER_MS,
  type PublishedTurn,
  type StructuredPendingDecision,
  type TurnCloseReason,
  type TurnRecord,
} from '@/lib/session/provisional-turn';

// =============================================================================
// In-memory State (globalThis, per the convention Issue #153 established)
// =============================================================================

/**
 * Every map below is reached through `globalThis`, not through the module
 * scope (Issue #1736).
 *
 * A bare `const … = new Map()` is one map *per module instance*, and this
 * server has more than one. Under `next dev` (`commandmate start --dev` /
 * `tsx server.ts`) each route handler is bundled separately, so
 * `/api/hooks/agent-event` and `/api/worktrees/:id/current-output` each got
 * their own copy of this module: the hook wrote a `Stop` into one map and the
 * reader looked for it in another, and every field this module feeds came back
 * null. Verified end-to-end on 2026-08-07 — a `POST` logged
 * `agent-event-received` while the `GET` that followed reported
 * `structuredEvents.lastEventType: null`. A production build shares the module
 * and was never affected, which is exactly what made it hard to see.
 *
 * That failure is silent, which is the reason it is called out here: nothing
 * errors, nothing warns, the payload is well-formed and simply always says
 * "no events" — the "I configured hooks and nothing happened" failure Epic
 * #1720 exists to remove.
 *
 * Hot reload is the second reason, and the one Issue #153 wrote the convention
 * for: an edit to any file in this module's import graph re-evaluates it, and a
 * module-scoped map would take the live sessions' state with it.
 *
 * `docs/module-reference.md` states the rule — "プロセス全体で共有する in-memory
 * 状態は globalThis 経由で持つ" — and lists the modules that follow it.
 */
declare global {
  // eslint-disable-next-line no-var
  var __agentEventLastStopAt: Map<string, number> | undefined;
  // eslint-disable-next-line no-var
  var __agentEventLast: Map<string, AgentEventRecord> | undefined;
  // eslint-disable-next-line no-var
  var __agentEventGenerationStartedAt: Map<string, number> | undefined;
  // eslint-disable-next-line no-var
  var __agentEventTurns: Map<string, TurnRecord> | undefined;
  // eslint-disable-next-line no-var
  var __agentEventDrops: Map<string, AgentEventDropCounts> | undefined;
  // eslint-disable-next-line no-var
  var __agentEventTurnSeq: { value: number } | undefined;
  // eslint-disable-next-line no-var
  var __agentEventAskUserQuestion: Map<string, AskUserQuestionEpisode> | undefined;
  // eslint-disable-next-line no-var
  var __agentEventRecentKeys: Map<string, number> | undefined;
  // eslint-disable-next-line no-var
  var __agentEventRecentIdentities: Map<string, Map<string, number>> | undefined;
  // eslint-disable-next-line no-var
  var __agentEventAwaitingInstruction: Map<string, AwaitingInstructionRecord> | undefined;
  // eslint-disable-next-line no-var
  var __agentEventLastModel: Map<string, string> | undefined;
  // eslint-disable-next-line no-var
  var __agentCapturedModelInfo: Map<string, ModelInfo> | undefined;
}

/** compositeKey -> epoch ms of the most recent stop event. */
const lastStopEventAt = globalThis.__agentEventLastStopAt ??
  (globalThis.__agentEventLastStopAt = new Map<string, number>());

/** compositeKey -> the most recent event of any kind. */
const lastAgentEvent = globalThis.__agentEventLast ??
  (globalThis.__agentEventLast = new Map<string, AgentEventRecord>());

/** compositeKey -> epoch ms the current generation began. See {@link beginAgentEventGeneration}. */
const generationStartedAt = globalThis.__agentEventGenerationStartedAt ??
  (globalThis.__agentEventGenerationStartedAt = new Map<string, number>());

/**
 * compositeKey -> the turn this instance is in, or the last one it was in
 * (Issue #1930).
 *
 * The map that replaced "the newest event is the verdict". `lastAgentEvent`
 * above is still written on every delivery and is still what
 * `structuredEvents.lastEventType` publishes — it answers "did anything reach
 * this server, and for the right instance?", which is a diagnostic question.
 * This map answers the state question, and the two deliberately disagree
 * whenever an event carries no verdict.
 *
 * The open dialogs #1725 kept in a map of their own live on the turn now
 * ({@link TurnRecord.pendingDecisions}), because a dialog only ever happens
 * *inside* a turn and holding them apart is what let a generation bump retire
 * one and not the other.
 */
const agentTurns = globalThis.__agentEventTurns ??
  (globalThis.__agentEventTurns = new Map<string, TurnRecord>());

/** compositeKey -> what this instance has had dropped, and why (Issue #1930). */
const dropCounts = globalThis.__agentEventDrops ??
  (globalThis.__agentEventDrops = new Map<string, AgentEventDropCounts>());

/**
 * Monotonic suffix for {@link TurnRecord.turnId}.
 *
 * Two turns can open in the same millisecond — a `post_tool_use` closing one
 * agent's turn while another's `user_prompt_submit` lands — and an id built from
 * the timestamp alone would then compare equal across instances. `wait` reads a
 * change of id as "a new turn began", so the collision would be a missed turn
 * boundary rather than a cosmetic clash.
 */
const turnSequence = globalThis.__agentEventTurnSeq ??
  (globalThis.__agentEventTurnSeq = { value: 0 });

/** compositeKey -> the `AskUserQuestion` call currently in flight (#1726). */
const askUserQuestion = globalThis.__agentEventAskUserQuestion ??
  (globalThis.__agentEventAskUserQuestion = new Map<string, AskUserQuestionEpisode>());

/** dedup key -> epoch ms it was first seen. See {@link isDuplicateAgentEvent}. */
const recentEventKeys = globalThis.__agentEventRecentKeys ??
  (globalThis.__agentEventRecentKeys = new Map<string, number>());

/**
 * compositeKey -> (identity key -> epoch ms it was first seen) (Issue #1899).
 *
 * Nested rather than flat so the bound is *per instance*, which the flat
 * {@link recentEventKeys} is not: one chatty agent must not be able to evict
 * another's ids and let a genuine re-delivery through on a quiet pane. See
 * {@link claimEventIdentity}.
 */
const recentEventIdentities = globalThis.__agentEventRecentIdentities ??
  (globalThis.__agentEventRecentIdentities = new Map<string, Map<string, number>>());

/** compositeKey -> the agent's own "I am waiting for instructions" (#1786). */
const awaitingInstruction = globalThis.__agentEventAwaitingInstruction ??
  (globalThis.__agentEventAwaitingInstruction = new Map<string, AwaitingInstructionRecord>());

/**
 * compositeKey -> the last non-null model this instance reported (Issue #1783).
 *
 * A *separate* map, not a field read off {@link lastAgentEvent}, and that is the
 * whole point of it. `lastAgentEvent` is replaced wholesale on every delivery,
 * and Claude puts the model on `SessionStart` and on nothing else — so the very
 * next `UserPromptSubmit` would overwrite the only record that ever knew it, and
 * the UI would show the model for the fraction of a second between session start
 * and the first prompt. Keeping the last *non-null* sighting separately is what
 * makes "which model is this session on" answerable at all for that tool.
 *
 * Never written with null: absent means "nothing has ever said", which is the
 * honest state for gemini, copilot, and any session that predates this server
 * process. See {@link getLastKnownAgentModel}.
 */
const lastAgentModel = globalThis.__agentEventLastModel ??
  (globalThis.__agentEventLastModel = new Map<string, string>());

/**
 * compositeKey -> what the terminal frame last showed for this instance (#1784).
 *
 * The second source, and a strictly different kind of fact from
 * {@link lastAgentModel}: that one is the agent naming itself over the hook
 * channel, this one is the TUI's own chrome read back off the screen. It is
 * kept apart rather than folded into the first map because the two have a
 * precedence between them ({@link getResolvedAgentModelInfo}) — merging on write
 * would let a scraped display name ("Gemini 3.7 Flash") overwrite the exact id
 * the agent reported, with nothing left to recover it from.
 *
 * Latched the same way and for a sharper reason: Claude prints its model in the
 * startup banner and nowhere else, and tmux keeps 2000 lines of history, so on
 * any session that has been talking for a while the banner is simply gone. The
 * screen going quiet is not the model changing, so the last non-null sighting
 * stands until the process it described does not (see
 * {@link beginAgentEventGeneration} / {@link discardAgentEventState}).
 */
const capturedModelInfo = globalThis.__agentCapturedModelInfo ??
  (globalThis.__agentCapturedModelInfo = new Map<string, ModelInfo>());

/**
 * How long two identical events count as one delivery.
 *
 * Issue #1722 injects hooks at session start, and `--settings` hooks are
 * *concatenated* with the user's own rather than replacing them, so anyone who
 * followed the #1549 manual setup now has two `Stop` hooks posting the same
 * turn. `applyAgentStopEvent` is idempotent for the timestamp, but
 * `applyTaskEvent` is not: each delivery writes its own `agent_idle` row, and a
 * reader counting rows would see one turn as two.
 *
 * A turn cannot end twice in three seconds, and both deliveries carry the same
 * `session_id`, so the window is generous relative to the real signal and tight
 * relative to anything it could wrongly swallow.
 */
export const AGENT_EVENT_DEDUP_WINDOW_MS = 3000;

/** Cap on retained dedup keys, so a long-lived server cannot grow one per turn. */
const MAX_RECENT_EVENT_KEYS = 512;

// =============================================================================
// Turn model (Issue #1930)
// =============================================================================

/**
 * What this instance has had dropped, and on whose authority (Issue #1930, S14).
 *
 * Every bound in this module discards something, and §7's discoverability rule
 * is that an automatic action visible only in the server log does not exist. So
 * each bound has a counter, the counters are published on `structuredEvents`,
 * and `commandmate capture --json` is where an operator finds out that the
 * reason their `stop` never landed is that something already claimed its id.
 *
 * Counters only ever grow within a generation; they are reset with the rest of
 * the instance state, because a tally that outlived the process it describes
 * would answer a question about a different session.
 */
export interface AgentEventDropCounts {
  /** Deliveries judged repeats, by the rule that judged them (#1899). */
  dedupDropped: { identity: number; timeWindow: number };
  /** Pending decisions discarded because the process that raised them was replaced. */
  decisionEvicted: number;
  /** External ids refused rather than truncated (S1). See {@link acceptExternalId}. */
  idsDiscarded: number;
  /** Pending decisions dropped at the retention bound (`releasedBy: dialog_timeout`). */
  dialogTimedOut: number;
  /** Pending decisions refused because the turn already held {@link MAX_PENDING_DECISIONS_PER_TURN}. */
  decisionOverflow: number;
}

/** A zeroed tally. */
function emptyDropCounts(): AgentEventDropCounts {
  return {
    dedupDropped: { identity: 0, timeWindow: 0 },
    decisionEvicted: 0,
    idsDiscarded: 0,
    dialogTimedOut: 0,
    decisionOverflow: 0,
  };
}

/** The live tally for one instance, created on first use. */
function dropsFor(key: string): AgentEventDropCounts {
  let counts = dropCounts.get(key);
  if (!counts) {
    counts = emptyDropCounts();
    dropCounts.set(key, counts);
    // The composite key is (worktree, tool, instance) and a long-lived server
    // accumulates worktrees; bounded like every other map here (DR4-009).
    trimOldestEntries(dropCounts, MAX_RECENT_EVENT_KEYS);
  }
  return counts;
}

/**
 * What this instance has had dropped, or a zeroed tally when nothing has.
 *
 * A copy, not the live object: this is published on the hot path and a caller
 * that could mutate it would be able to erase the evidence.
 */
export function getAgentEventDropCounts(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): AgentEventDropCounts {
  const counts = dropCounts.get(buildCompositeKey(worktreeId, cliToolId, instanceId));
  if (!counts) return emptyDropCounts();
  return { ...counts, dedupDropped: { ...counts.dedupDropped } };
}

/** Epoch ms the current generation began, or null when none was opened. */
function currentGeneration(key: string): number | null {
  return generationStartedAt.get(key) ?? null;
}

/**
 * The turn this instance is in, with the generation fence applied.
 *
 * A turn whose {@link TurnRecord.generationAt} is not the current generation was
 * opened by a process that has been replaced. It is not deleted — the fence is
 * cheap and deleting would lose the eviction tally — it is simply not this
 * instance's turn any more.
 */
function fencedTurn(key: string): TurnRecord | null {
  const turn = agentTurns.get(key);
  if (!turn) return null;
  if (turn.generationAt !== currentGeneration(key)) return null;
  return turn;
}

/**
 * {@link fencedTurn} with the staleness bound applied.
 *
 * The bound is applied by *closing* the turn rather than by hiding it, so
 * `capture --json` says `closedBy: 'stale'` instead of going quiet — "the agent
 * never reported the end of this turn" and "nothing has been reported at all"
 * are different problems and an operator has to be able to tell them apart.
 *
 * Writes on read, which this module already does for corroboration, and is
 * idempotent: the close is stamped from the event's own clock, so it does not
 * move with the reader's `now`.
 */
function effectiveTurn(key: string, now: number): TurnRecord | null {
  const turn = fencedTurn(key);
  if (turn === null) return null;
  if (turn.closedAt === null && now - turn.displayEvent.at >= TURN_STALE_AFTER_MS) {
    turn.closedAt = turn.displayEvent.at + TURN_STALE_AFTER_MS;
    turn.closedBy = 'stale';
  }
  return turn;
}

/** Next {@link TurnRecord.turnId}. See {@link turnSequence}. */
function nextTurnId(at: number): string {
  turnSequence.value += 1;
  return `turn-${at}-${turnSequence.value}`;
}

/**
 * Drop the decisions this turn is holding, counting them.
 *
 * The generation path is the one §4 D3 決定 2 names: a process that has been
 * replaced cannot have its approvals answered, and leaving them behind would
 * publish `waiting` for a pane whose dialog went away with the process that
 * drew it.
 */
function evictDecisions(key: string, turn: TurnRecord): void {
  if (turn.pendingDecisions.length === 0) return;
  dropsFor(key).decisionEvicted += turn.pendingDecisions.length;
  turn.pendingDecisions = [];
}

/**
 * The decisions still describing something, dropping the ones that are not.
 *
 * The retention bound of {@link DIALOG_PENDING_MAX_MS}, applied on read and
 * counted as `dialogTimedOut` so the release is visible. Kept here rather than
 * in a timer for the reason the rest of this module has no timers: the state
 * describes a live tmux session, and a reader is the only thing that ever needs
 * the answer.
 */
function livePendingDecisions(
  key: string,
  turn: TurnRecord,
  now: number
): StructuredPendingDecision[] {
  const live = turn.pendingDecisions.filter((decision) => isDecisionLive(decision, now));
  const dropped = turn.pendingDecisions.length - live.length;
  if (dropped > 0) {
    dropsFor(key).dialogTimedOut += dropped;
    turn.pendingDecisions = live;
  }
  return live;
}

/**
 * The approvals this instance is blocked on right now (Issue #1930).
 *
 * Published as `structuredEvents.pendingDecisions`; `#1932` is what teaches
 * `commandmate respond` to name one of these ids.
 *
 * @param now - Epoch ms; defaults to now
 */
export function getPendingDecisions(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  now: number = Date.now()
): StructuredPendingDecision[] {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const turn = effectiveTurn(key, now);
  if (turn === null) return [];
  return livePendingDecisions(key, turn, now);
}

/**
 * The turn record for one instance, fenced and aged, or null.
 *
 * The seam `current-output-builder` publishes from and the suites drive. The
 * returned object is the live record; nothing outside this module writes to it.
 *
 * @param now - Epoch ms; defaults to now
 */
export function getAgentTurn(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  now: number = Date.now()
): TurnRecord | null {
  return effectiveTurn(buildCompositeKey(worktreeId, cliToolId, instanceId), now);
}

/** {@link getAgentTurn} projected onto the four published fields. */
export function getPublishedAgentTurn(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  now: number = Date.now()
): PublishedTurn {
  return derivePublishedTurn(getAgentTurn(worktreeId, cliToolId, instanceId, now));
}

/**
 * Close the open turn on evidence that did not come from the agent (Issue #1930).
 *
 * The one seam for the two {@link TurnCloseReason} values nothing in the event
 * stream can produce:
 *
 *  - `scraper_evidence` — see {@link observeScraperCompletionEvidence}, which is
 *    the caller in this tree.
 *  - `resync_idle` — a source whose `capabilities.resync` lets it be re-read
 *    answering "not busy" after a dropped transport. The reconnect loop that
 *    would call it lives in `sources/opencode/subscription`, which is #1931's
 *    file and deliberately untouched here; the value is in the vocabulary and
 *    the seam accepts it, so wiring it is a call site rather than a new state.
 *
 * A no-op when no turn is open, which is the ordinary case: neither of these is
 * a statement about a session that already reported it finished.
 *
 * @param at - Epoch ms; defaults to now
 * @returns Whether a turn was closed
 */
export function closeAgentTurn(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  closedBy: Extract<TurnCloseReason, 'scraper_evidence' | 'resync_idle'>,
  at: number = Date.now()
): boolean {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const turn = fencedTurn(key);
  if (turn === null || turn.closedAt !== null) return false;
  turn.closedAt = at;
  turn.closedBy = closedBy;
  return true;
}

/**
 * Feed one poll's reading of the pane into the turn's completion counter
 * (Issue #1930).
 *
 * `completed` is the scraper's own verdict — `ready` with positive evidence —
 * NOT the merged one, which would be circular: the merge is what the structured
 * layer's `running` overrides, so reading it back would only ever confirm this
 * layer's own answer.
 *
 * See {@link SCRAPER_COMPLETION_POLLS} for why three, and for why closing here
 * does not complete a `commandmate wait`.
 *
 * @param at - Epoch ms; defaults to now
 * @returns Whether this poll closed the turn
 */
export function observeScraperCompletionEvidence(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  completed: boolean,
  at: number = Date.now()
): boolean {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const turn = fencedTurn(key);
  if (turn === null || turn.closedAt !== null) return false;

  if (!completed) {
    turn.scraperCompletionPolls = 0;
    return false;
  }

  turn.scraperCompletionPolls += 1;
  if (turn.scraperCompletionPolls < SCRAPER_COMPLETION_POLLS) return false;

  turn.closedAt = at;
  turn.closedBy = 'scraper_evidence';
  return true;
}

/** The most recent structured event reported for one agent instance. */
export interface AgentEventRecord {
  /** Event kind, in this codebase's vocabulary rather than the CLI's spelling. */
  event: AgentEventType;
  /** Epoch ms the server received it. */
  at: number;
  /**
   * The event's subtype where it has one — `permission_prompt` / `idle_prompt`
   * for `notification`, `clear` for a `/clear`-driven `session_end` — else null.
   */
  detail: string | null;
  /**
   * The agent's own session id, or null.
   *
   * Recorded for correlation with the agent's transcript, never used as an
   * identity: `/clear` ends the session and starts a new one with a *different*
   * `session_id` while the instance, the worktree and the tmux pane all stay put
   * (Issue #1721, §1.1). Instance identity comes from the injected URL.
   */
  sessionId: string | null;
  /**
   * `Notification.message` — the agent's own human-facing line (Issue #1725).
   *
   * Display only, and the type cannot enforce that, so it is said here: the
   * observed values are `"Claude needs your permission to use Bash"` and
   * `"Claude is waiting for your input"`, English prose Claude is free to
   * reword. `notification_type` (stored in {@link detail}) is the machine key
   * (D3). Absent for every event that carries no message.
   */
  message?: string | null;
  /**
   * The model the agent reported running (Issue #1783), or null/absent.
   *
   * Absent for a caller that has nothing to say, null for one that looked and
   * found nothing — the two are treated identically here. What is *not* stored
   * on this record is the answer to "which model is this instance on": the
   * record is replaced on every event and most events carry no model, so that
   * question is answered by {@link getLastKnownAgentModel} instead.
   */
  model?: string | null;
  /**
   * The dialog this event opens or closes, as the agent's own id (Issue #1898).
   *
   * Set only by a source whose {@link AgentSourceCapabilities.eventIdentity}
   * names one — opencode's `per_…`, which is both the id in the
   * `permission.asked` frame and the id in the reply URL. Everything else
   * leaves it absent, and an absent id means "this event says nothing about
   * *which* dialog", which is why the release below matches permissively
   * rather than refusing to act.
   */
  decisionId?: string | null;
  /**
   * Whether the source states that no dialog is left open by this event
   * (Issue #1898).
   *
   * The caller computes it, because the caller is the only layer that knows
   * both what happened (a verdict was delivered, a `permission.replied` frame
   * arrived) and whether this source's
   * {@link AgentSourceCapabilities.permissionReplyReleasesPrompt} says that
   * settles anything. A hook source can never set it: its verdict goes into the
   * body of a request nobody hears the end of, so the dialog on screen has to
   * be released by something that can observe it.
   *
   * Absent is not `false` in meaning — it is "this source made no statement" —
   * but the two act the same here, and that is deliberate: the pre-#1898
   * behaviour is what an event with nothing to say must keep producing.
   */
  promptSettled?: boolean;
}

/**
 * Record that `instanceId` reported it stopped.
 *
 * @param at - Epoch ms; defaults to now. Passed explicitly by callers that need
 *   the stored value and their own record of the event to agree exactly.
 */
export function recordAgentStopEvent(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  at: number = Date.now()
): void {
  lastStopEventAt.set(buildCompositeKey(worktreeId, cliToolId, instanceId), at);
}

/**
 * @returns Epoch ms of the last stop event, or null when none has been received
 *   — which is the ordinary case for a session whose agent has no hook set up.
 */
export function getLastStopEventAt(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): number | null {
  return lastStopEventAt.get(buildCompositeKey(worktreeId, cliToolId, instanceId)) ?? null;
}

/**
 * What the source that delivered an event declares about itself (Issue #1903).
 *
 * Passed in by the caller rather than looked up here, for the reason the
 * `AgentSourceCapabilities` import at the top of this file already gives: the
 * registry's module graph reaches `better-sqlite3`, so this module reads
 * capabilities as *values it is handed*. `AgentEventDelivery.identityKind`
 * (#1899) is the same shape, and `AgentEventRecord.promptSettled` (#1898) is
 * the same division of labour one step further along.
 */
export interface RecordAgentEventOptions {
  /**
   * The source's declared
   * {@link AgentSourceCapabilities.sessionStartMayArriveLate} (#1924, §4 D3).
   *
   * Read by `session_start` and by nothing else, so a caller that only ever
   * records `notification`s has nothing to pass. Absent means `false` — the
   * pre-#1903 behaviour, which is what five of the six sources declare anyway —
   * and that default is deliberate rather than defensive: a receiver added
   * later that forgets this argument behaves like Claude, not like copilot.
   */
  sessionStartMayArriveLate?: AgentSourceCapabilities['sessionStartMayArriveLate'];
}

/** What {@link recordAgentEvent} did with one delivery (Issue #1903). */
export type AgentEventRecordOutcome =
  | { recorded: true }
  | {
      recorded: false;
      /** Why it was held. One value today; a union so a log line can name it. */
      skipped: 'late-session-start';
    };

/**
 * The verdicts that mean this instance is inside a turn (Issue #1903).
 *
 * `waiting` is in the list because a dialog only happens *during* a turn: the
 * agent asked for permission in the middle of the work it was doing, and the
 * turn it belongs to is as open as one reading `running`. Leaving it out would
 * fix the measured copilot window (`UserPromptSubmit` -> `SessionStart`) and
 * leave the same hole one event further in.
 *
 * `ready` (`stop` / `idle_prompt`) and null (no event, a previous generation, a
 * stale one, or an event with no verdict at all) both mean no turn is open.
 */
const OPEN_TURN_STATUSES: readonly SessionStatus[] = ['running', 'waiting'];

/**
 * Whether this `session_start` is the current turn's own, arriving late
 * (Issue #1903).
 *
 * copilot 1.0.80 fires `UserPromptSubmit` and *then* `SessionStart`, 12-15 s
 * later on a first turn — measured twice, and the payload says so itself: the
 * captured `SessionStart` carries `initial_prompt` with the text of the prompt
 * that was already submitted. Under the "newest event is the verdict" model
 * that arrival erased `running / hook_prompt_submit`, because
 * `agentEventToSessionStatus` answers null for `session_start`; the pane fell
 * back to the scraper, which reads a generating copilot frame as `ready`
 * (#1885), and a `commandmate wait` started inside that window exited 0 with
 * `basis=scraper_ready` while the agent was still thinking.
 *
 * The rule is the design policy's (§4 D3 decision 2): *an event carrying no
 * verdict does not close an open turn*. Here that is expressed as "it does not
 * replace the event the verdict is read from either", because this model has
 * one record where the turn model has two fields.
 *
 * Three conditions, and each one is load-bearing:
 *
 *  1. **The source declares it.** Not a tool id — flip copilot's capability to
 *     `false` and the late frame overwrites again, flip claude's to `true` and
 *     claude's would be held. #1901 reads `permissionHookPredictsDialog` the
 *     same way.
 *  2. **A turn is open**, judged by {@link getStructuredSessionState} *as of the
 *     arriving event's own timestamp* — which is how this inherits the
 *     generation fence and the {@link STRUCTURED_STATE_MAX_AGE_MS} bound rather
 *     than growing a second copy of either. A `session_start` on an idle
 *     instance, after a `stop`, or as the first event of a session is recorded
 *     exactly as it always was, generation bump included. That is what keeps
 *     `/clear` working: it arrives as `session_end` (verdict null, so the turn
 *     is no longer open) followed by `session_start`.
 *  3. **It does not name a different agent session.** A genuine restart inside
 *     the pane is a different `session_id`, and holding *that* frame would be
 *     the real cost of this rule — the instance would keep publishing the dead
 *     process's `running`. When either side is null the two are treated as the
 *     same session, because "no id" is the shape a hand-configured #1549 hook
 *     posts and the fix has to survive it; that residue is bounded by
 *     {@link STRUCTURED_STATE_MAX_AGE_MS}, after which the scraper takes the
 *     session back, and by `beginAgentEventGeneration` on every session
 *     CommandMate itself (re)starts.
 */
function isLateSessionStart(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  record: AgentEventRecord,
  options: RecordAgentEventOptions
): boolean {
  if (record.event !== 'session_start') return false;
  if (options.sessionStartMayArriveLate !== true) return false;

  const openTurn = getStructuredSessionState(worktreeId, cliToolId, instanceId, record.at);
  if (openTurn === null || !OPEN_TURN_STATUSES.includes(openTurn.status)) return false;

  const openSessionId =
    lastAgentEvent.get(buildCompositeKey(worktreeId, cliToolId, instanceId))?.sessionId ?? null;
  if (openSessionId === null || record.sessionId == null) return true;
  return record.sessionId === openSessionId;
}

/**
 * Record any structured event against an instance (Issue #1722).
 *
 * Deliberately does not touch `lastStopEventAt`: that timestamp belongs to
 * `applyAgentStopEvent`, which writes it alongside the task transition it drives
 * so the two cannot disagree.
 *
 * @param options - What the delivering source declares about itself (#1903)
 * @returns Whether the delivery was applied, so the caller can log a held one.
 *   Callers that do not care may ignore it; every pre-#1903 caller does.
 */
export function recordAgentEvent(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  record: AgentEventRecord,
  options: RecordAgentEventOptions = {}
): AgentEventRecordOutcome {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);

  if (isLateSessionStart(worktreeId, cliToolId, instanceId, record, options)) {
    // Issue #1903. Held, not discarded: the model latch below is not part of
    // the turn and never was. `SessionStart` is the one event Claude puts a
    // model on, so a source that both declares this capability and reports a
    // model would otherwise be the single case where the model is extracted and
    // then dropped on the floor. copilot reports none today (#1783), which is
    // exactly why this has to be decided here rather than left to be noticed.
    latchAgentModel(key, record);
    return { recorded: false, skipped: 'late-session-start' };
  }

  lastAgentEvent.set(key, record);
  latchAgentModel(key, record);
  applyAskUserQuestionTransition(key, record);
  if (record.event === 'session_start') {
    // The agent restarting inside a pane CommandMate never touched — `claude`
    // relaunched by hand, or a `/clear` (which emits SessionEnd then
    // SessionStart on a live session) — is a new generation just as much as a
    // new tmux session is. Recorded from the event's own timestamp, so the
    // event that opens a generation is never stale against it.
    generationStartedAt.set(key, record.at);
    // Issue #1930: and the turn the previous process was in ends with it. Done
    // here rather than inside the transition below so the two paths into a new
    // generation — this one and `beginAgentEventGeneration` — close the turn in
    // exactly one place.
    fenceTurnForNewGeneration(key, record.at);
  }
  // Issue #1930: after the generation is settled, so a turn opened by this
  // event belongs to the generation the event itself opened.
  applyTurnTransition(key, record);
  applyAwaitingInstructionTransition(key, record);
  return { recorded: true };
}

/**
 * End the open turn because the process that owned it has been replaced
 * (Issue #1930).
 *
 * The turn is closed and re-stamped into the new generation rather than
 * deleted, which is the difference between `capture --json` reporting
 * `closedBy: 'generation'` and reporting nothing at all. Its approvals go: they
 * were raised by a process that no longer exists, and answering one would
 * deliver a verdict into a slot nobody is holding.
 */
function fenceTurnForNewGeneration(key: string, at: number): void {
  const turn = agentTurns.get(key);
  if (!turn) return;
  evictDecisions(key, turn);

  // A turn that had ALREADY ended is left where it is, which means the fence in
  // `fencedTurn` hides it from here on. That asymmetry is deliberate: the
  // previous process's `Stop` is not this process's, and re-stamping it into the
  // new generation would publish `ready` — "the agent finished" — for a session
  // nobody has typed into yet. Before #1930 the same protection came from
  // comparing the event's timestamp against the generation.
  if (turn.closedAt !== null) return;

  // An OPEN turn is closed and carried across, so `capture --json` can say
  // `closedBy: 'generation'` rather than going quiet. `getStructuredSessionState`
  // reads that reason as "nothing is known", so it publishes no verdict either
  // way; what it buys is an operator being able to tell "the session was
  // restarted under this turn" from "nothing was ever reported".
  turn.closedAt = at;
  turn.closedBy = 'generation';
  turn.generationAt = at;
}

/**
 * Issue #1783: latch, never clear. An event without a model is the ordinary
 * case (Claude sends one on `SessionStart` alone), and reading it as "the model
 * is now unknown" would blank the display on the very next event.
 */
function latchAgentModel(key: string, record: AgentEventRecord): void {
  if (typeof record.model === 'string' && record.model !== '') {
    lastAgentModel.set(key, record.model.slice(0, MAX_EVENT_DETAIL_LENGTH));
  }
}

/** The agent's own report that it is sitting at the composer (Issue #1786). */
export interface AwaitingInstructionRecord {
  /** Epoch ms the `Notification(idle_prompt)` was received. */
  at: number;
  /** `Notification.message` — the agent's own line, or null. Display only. */
  message: string | null;
}

/**
 * The third state: "this turn is over and nobody has told me what to do next"
 * (Issue #1786).
 *
 * | event                             | effect on awaiting_instruction |
 * |-----------------------------------|--------------------------------|
 * | `notification(idle_prompt)`       | **set**                        |
 * | `user_prompt_submit`              | release                        |
 * | `session_start` / `session_end`   | release                        |
 * | everything else                   | unchanged                      |
 *
 * It is a boolean beside the status rather than a fifth `SessionStatus`, because
 * `idle_prompt` already maps to `ready` (`agentEventToSessionStatus`) and
 * `ready` means "you can send a message" everywhere in this codebase — the
 * sidebar, `deriveCliStatus`, `getNextAction`, `commandmate wait`. Widening that
 * vocabulary to carry "and it is *asking* you to" would have every consumer of
 * the four values re-decide what they mean; the boolean asks nothing of anyone
 * who does not want it.
 *
 * `stop` deliberately does NOT set it. `Stop` fires when the turn ends, which is
 * most of the time the agent has simply finished a step of its own plan;
 * `Notification(idle_prompt)` is Claude's separate, later "waiting for your
 * input" signal, and using the turn boundary instead would mark every
 * intermediate stop as a request for instructions.
 *
 * `pre_tool_use` / `post_tool_use` / `notification(permission_prompt)` leave it
 * alone, and that is not a gap: a tool call or a dialog can only happen inside a
 * turn, and the turn's own `user_prompt_submit` has already released it. Adding
 * them would only paper over a `UserPromptSubmit` that never arrived — and an
 * operator whose `UserPromptSubmit` hook is missing has no `Notification` hook
 * either, so there would be nothing to release.
 *
 * There is deliberately no age bound here, unlike every other state in this
 * module. Those bound the damage of an event that may never arrive (a lost
 * `Stop`, a dialog answered with no event to say so). This one is released by
 * events that cannot be missed while the fact is still true: typing into the
 * composer — from the app or straight into the tmux pane — raises
 * `UserPromptSubmit`, and ending the session raises `SessionEnd`. An agent that
 * has been idle for six hours genuinely is still awaiting instructions, and
 * expiring the flag would erase the notification #1790 exists to send. The
 * generation fence in {@link isAwaitingInstruction} still applies, so the flag
 * never survives the process that reported it.
 */
function applyAwaitingInstructionTransition(key: string, record: AgentEventRecord): void {
  switch (record.event) {
    case 'notification':
      if (record.detail === 'idle_prompt') {
        awaitingInstruction.set(key, { at: record.at, message: record.message ?? null });
      }
      return;
    case 'user_prompt_submit':
    case 'session_start':
    case 'session_end':
      awaitingInstruction.delete(key);
      return;
    case 'stop':
    case 'pre_tool_use':
    case 'post_tool_use':
      return;
    default:
      // exhaustive check: a new AgentEventType must decide its transition here
      record.event satisfies never;
      return;
  }
}

/**
 * The agent's own "waiting for your input", or null (Issue #1786).
 *
 * Fenced by generation like the rest of this module: an `idle_prompt` from the
 * Claude process that used to live in this pane is not this one's.
 */
export function getAwaitingInstruction(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
): AwaitingInstructionRecord | null {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const record = awaitingInstruction.get(key);
  if (!record) return null;

  const generation = generationStartedAt.get(key);
  if (generation !== undefined && record.at < generation) return null;

  return record;
}

/** {@link getAwaitingInstruction} as the boolean the list API publishes. */
export function isAwaitingInstruction(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
): boolean {
  return getAwaitingInstruction(worktreeId, cliToolId, instanceId) !== null;
}

/**
 * The turn transition: what one delivery does to {@link TurnRecord}
 * (Issue #1930, §4 D3 決定 2).
 *
 * | event                              | turn                    | dialog   | display |
 * |------------------------------------|-------------------------|----------|---------|
 * | `user_prompt_submit`               | **opens a new one**     | release  | yes     |
 * | `pre_tool_use`                     | continues, else opens   | unchanged| yes     |
 * | `post_tool_use`                    | continues, else opens   | release  | yes     |
 * | `stop` (this session)              | **closes** `stop`       | release  | yes     |
 * | `stop` (another session)           | unchanged               | unchanged| no      |
 * | `session_end`                      | **closes** `session_end`| release  | no      |
 * | `session_start`                    | new generation (above)  | evicted  | no      |
 * | `notification(permission_prompt)`  | unchanged               | **open** | only to bootstrap |
 * | `notification(permission_replied)` | unchanged               | release  | no      |
 * | `notification(idle_prompt)`        | unchanged               | release  | yes     |
 * | `notification(anything else)`      | unchanged               | unchanged| no      |
 *
 * Four rows are the whole point of the Issue, and each of them was a defect
 * under "the newest event is the verdict":
 *
 *  - **`user_prompt_submit` opens a new turn, the tool-call events continue the
 *    open one.** That is what makes {@link TurnRecord.turnId} an identity: #1926
 *    re-stamped it on every `pre_tool_use`, so a consumer reading a changed id
 *    as "a new turn began" false-positived several times inside one turn. `wait`
 *    reads it that way now.
 *  - **A `stop` naming another session changes nothing.** opencode publishes
 *    `session.idle` for every session its server holds, other processes'
 *    included (#1758 §5.6).
 *  - **`session_start` / `session_end` / an unknown notification /
 *    `permission_replied` do not become the displayed event.** An event carrying
 *    no verdict must not erase one. #1903 fixed the single measured instance
 *    (copilot's late `SessionStart`) by holding the delivery; the rule is
 *    general here, and the capability it reads is still the only reason a
 *    `session_start` is held rather than recorded.
 *  - **`notification(permission_prompt)` does not become the displayed event
 *    when a turn already exists.** The dialog is a fact about the *pane*, and
 *    it is published by the decision ledger below. Letting it overwrite the
 *    display is how the pre-#1898 `waiting` outlived the approval that caused
 *    it: released, the record still said `waiting`, because the only thing it
 *    could read was the event that opened the dialog.
 *
 * `idle_prompt` is the one row that publishes `ready` **without** closing the
 * turn, and that is a measurement rather than an oversight: #1839 caught Claude
 * emitting it 62 s into a turn that ran nothing, so it cannot be a turn
 * boundary. `wait`'s gate stays armed through it; what changes is only what the
 * pane displays.
 */
function applyTurnTransition(key: string, record: AgentEventRecord): void {
  const generation = currentGeneration(key);
  // An event stamped before the current generation was produced by a process
  // that has been replaced. Refusing it here is what makes re-recording a stale
  // `user_prompt_submit` at its original timestamp a no-op.
  if (generation !== null && record.at < generation) return;

  switch (record.event) {
    case 'user_prompt_submit':
      openTurn(key, record, generation, { continueOpen: false });
      releaseAllDecisions(key);
      return;
    case 'post_tool_use':
      openTurn(key, record, generation, { continueOpen: true });
      // The tool call the dialog was gating has finished, so somebody answered
      // it (Issue #1726). This is the release #1725 could not have: it had no
      // event meaning "the human answered", only `Stop` meaning "the turn
      // ended", which can be minutes later.
      releaseAllDecisions(key);
      return;
    case 'pre_tool_use':
      // Deliberately leaves the dialog alone (Issue #1726). It is the
      // `AskUserQuestion` invocation, and a picker being *about to be drawn* is
      // not a fact this state can carry.
      openTurn(key, record, generation, { continueOpen: true });
      return;
    case 'stop':
      applyStopToTurn(key, record, generation);
      return;
    case 'session_end':
      applySessionEndToTurn(key, record);
      releaseAllDecisions(key);
      return;
    case 'session_start':
      // The generation was opened by `recordAgentEvent` before this ran, and
      // `fenceTurnForNewGeneration` closed the turn with it. Nothing further:
      // the frame carries no verdict, so it is not the displayed event either.
      return;
    case 'notification':
      applyNotificationToTurn(key, record, generation);
      return;
    default:
      // exhaustive check: a new AgentEventType must decide its transition here
      record.event satisfies never;
      return;
  }
}

/** The three fields the turn keeps from a record. */
function displayOf(record: AgentEventRecord): TurnRecord['displayEvent'] {
  return { event: record.event, at: record.at, detail: record.detail };
}

/**
 * Open a turn for this event, or move the display onto an open one.
 *
 * @param continueOpen - Whether an already-open turn of the same session is
 *   this event's turn. False for `user_prompt_submit`, which IS a new turn.
 */
function openTurn(
  key: string,
  record: AgentEventRecord,
  generation: number | null,
  { continueOpen }: { continueOpen: boolean }
): void {
  const turn = fencedTurn(key);
  const openHere =
    turn !== null &&
    turn.closedAt === null &&
    turn.openedAt !== null &&
    closesTurn(turn, record.sessionId);

  if (continueOpen && openHere) {
    turn.displayEvent = displayOf(record);
    // A hand-configured relay posts no session id, so a turn can learn one
    // partway through. Learning it is what lets a later `stop` be matched.
    turn.sessionId ??= record.sessionId;
    turn.scraperCompletionPolls = 0;
    return;
  }

  // A dialog-only record (openedAt null) is not a turn; its decisions belong to
  // the turn that is opening now, because that is when they were raised.
  const carried = turn !== null && turn.openedAt === null && turn.closedAt === null
    ? turn.pendingDecisions
    : [];

  agentTurns.set(key, {
    turnId: nextTurnId(record.at),
    sessionId: record.sessionId,
    openedAt: record.at,
    closedAt: null,
    closedBy: null,
    generationAt: generation,
    displayEvent: displayOf(record),
    pendingDecisions: carried,
    scraperCompletionPolls: 0,
  });
  boundTurnMap();
}

/**
 * Apply a `stop` — the only event that is the agent saying its turn is over.
 *
 * A `stop` for another session leaves everything alone; see {@link closesTurn}.
 * A `stop` with no turn open still records one, because "this instance last
 * reported it stopped at T" is the fact `ready` is published from, and the
 * opening it never saw is published as null rather than guessed.
 */
function applyStopToTurn(
  key: string,
  record: AgentEventRecord,
  generation: number | null
): void {
  const turn = fencedTurn(key);
  if (turn !== null && turn.closedAt === null && turn.openedAt !== null) {
    if (!closesTurn(turn, record.sessionId)) return;
    turn.closedAt = record.at;
    turn.closedBy = 'stop';
    turn.displayEvent = displayOf(record);
    releaseAllDecisions(key);
    return;
  }

  agentTurns.set(key, {
    turnId: nextTurnId(record.at),
    sessionId: record.sessionId,
    openedAt: null,
    closedAt: record.at,
    closedBy: 'stop',
    generationAt: generation,
    displayEvent: displayOf(record),
    pendingDecisions: [],
    scraperCompletionPolls: 0,
  });
  boundTurnMap();
}

/**
 * `session_end`: the agent session this instance was talking to is gone.
 *
 * **Overwrites an existing close reason**, which is the one place in this
 * module where a later event rewrites an earlier verdict, and #1723's contract
 * is why. `/clear` emits `SessionEnd(reason=clear)` on a session that is alive
 * and about to keep going, and the turn before it may perfectly well have ended
 * with a `Stop`. Leaving that `Stop` standing would keep publishing "the agent
 * finished" about a conversation that no longer exists — the integration pin is
 * `current-output-structured-status-1723`, which asserts the session goes back
 * to the scraper the moment `SessionEnd` lands.
 *
 * `closedBy: 'session_end'` publishes no verdict of its own (see
 * {@link getStructuredSessionState}), so this is a retirement rather than a
 * different answer.
 */
function applySessionEndToTurn(key: string, record: AgentEventRecord): void {
  const turn = fencedTurn(key);
  if (turn === null) return;
  if (!closesTurn(turn, record.sessionId)) return;
  turn.closedAt = record.at;
  turn.closedBy = 'session_end';
}

/**
 * The notification rows of the transition table.
 *
 * Matched on `notification_type` ({@link AgentEventRecord.detail}), never on the
 * human-facing `message` (D3): the observed messages are English prose the agent
 * is free to reword.
 */
function applyNotificationToTurn(
  key: string,
  record: AgentEventRecord,
  generation: number | null
): void {
  if (record.detail === 'permission_prompt') {
    if (record.promptSettled === true) {
      // Issue #1898: adjudicated before it was recorded, and the verdict
      // reached the agent. There is no dialog and there never was one for a
      // human to answer — opening a record for it published `waiting` for the
      // whole of the tool call that followed (measured at eight seconds).
      releaseSettledDecision(key, record);
      return;
    }
    openDecision(key, generation, {
      source: 'notification',
      at: record.at,
      message: record.message ?? null,
      toolName: null,
      decisionId: record.decisionId ?? null,
      bootstrapDisplay: displayOf(record),
    });
    return;
  }

  if (record.detail === PERMISSION_REPLIED_DETAIL) {
    // Issue #1898. The agent's own statement that the dialog is gone — whoever
    // answered it. Not a word this build reads a status from, so it decides
    // nothing; all it does is retire the record.
    if (record.promptSettled === true) releaseSettledDecision(key, record);
    return;
  }

  if (record.detail === 'idle_prompt') {
    // The agent reporting it is sitting at the composer waiting for input is the
    // agent saying nothing is in front of that composer.
    releaseAllDecisions(key);
    const turn = fencedTurn(key);
    if (turn !== null && turn.closedAt === null) {
      turn.displayEvent = displayOf(record);
      return;
    }
    if (turn !== null) return;
    // Nothing to attach it to — the first thing this instance ever said, or the
    // first since a generation. It still carries a verdict (`ready`), and #1723
    // publishes it, so a display-only record is opened to hold it. `openedAt`
    // stays null: an agent sitting at its composer is not in a turn, and a
    // record that claimed otherwise would gate `wait` on a turn nobody opened.
    agentTurns.set(key, {
      turnId: nextTurnId(record.at),
      sessionId: record.sessionId,
      openedAt: null,
      closedAt: null,
      closedBy: null,
      generationAt: generation,
      displayEvent: displayOf(record),
      pendingDecisions: [],
      scraperCompletionPolls: 0,
    });
    boundTurnMap();
    return;
  }

  // An unrecognised notification type is not evidence of anything, and guessing
  // would be worse than the scraper.
}

/**
 * Open, or refresh, a dialog record on this instance's turn.
 *
 * `bootstrapDisplay` is used only when there is no record at all to hang the
 * decision on. That record is deliberately **not** an open turn — its
 * `openedAt` is null — so releasing the decision hands the pane back to the
 * scraper rather than asserting `running` for a turn nobody ever saw open.
 */
function openDecision(
  key: string,
  generation: number | null,
  input: {
    source: StructuredPromptSource;
    at: number;
    message: string | null;
    toolName: string | null;
    decisionId: string | null;
    bootstrapDisplay: TurnRecord['displayEvent'];
  }
): void {
  let turn = fencedTurn(key);
  if (turn === null) {
    turn = {
      turnId: nextTurnId(input.at),
      sessionId: null,
      openedAt: null,
      closedAt: null,
      closedBy: null,
      generationAt: generation,
      displayEvent: input.bootstrapDisplay,
      pendingDecisions: [],
      scraperCompletionPolls: 0,
    };
    agentTurns.set(key, turn);
    boundTurnMap();
  } else if (turn.closedAt !== null) {
    // The dialog is being raised after the turn it would have belonged to
    // ended — a `PermissionRequest` racing a `Stop`, or a re-check landing
    // late. Re-open a dialog-only record rather than resurrecting the turn.
    turn = {
      turnId: nextTurnId(input.at),
      sessionId: null,
      openedAt: null,
      closedAt: null,
      closedBy: null,
      generationAt: generation,
      displayEvent: input.bootstrapDisplay,
      pendingDecisions: [],
      scraperCompletionPolls: 0,
    };
    agentTurns.set(key, turn);
    boundTurnMap();
  }

  // Issue #1930 / S1: an id that fails validation is DISCARDED, not truncated —
  // a truncated id compares equal to a different id sharing its prefix, and the
  // reply to one approval would then retire another's record.
  const decisionId = input.decisionId === null ? null : acceptExternalId(input.decisionId);
  if (input.decisionId !== null && decisionId === null) dropsFor(key).idsDiscarded += 1;

  const confirmed = input.source === 'notification';
  // Which record, if any, this report is a second sighting of.
  //
  //  - an id matches its own record;
  //  - an id with no record of its own may still be *confirming* the anonymous
  //    prediction that forecast it. That is the measured pair: a
  //    `PermissionRequest` this server declined to decide fires ~6 s before the
  //    `Notification(permission_prompt)` that proves the dialog, and the
  //    request carries no id;
  //  - an anonymous report merges only with another anonymous one. A source
  //    that publishes no ids therefore keeps exactly one dialog record per
  //    instance, which is what #1725 did and the honest limit for it — matching
  //    an anonymous report against an *identified* record would let one
  //    approval's forecast confirm a different approval's dialog.
  const existing =
    decisionId !== null
      ? (turn.pendingDecisions.find((decision) => decision.decisionId === decisionId) ??
        turn.pendingDecisions.find(
          (decision) => decision.decisionId === null && decision.source === 'permission-request'
        ))
      : turn.pendingDecisions.find((decision) => decision.decisionId === null);

  if (existing) {
    // The same dialog, reported twice: `PermissionRequest` predicted it and the
    // `Notification` then proved it. Keep the earliest `at` — that is when the
    // human was first blocked, and it is what the scraper-release grace and the
    // age bound are measured from — and take the confirmation.
    existing.message = boundDecisionMessage(input.message) ?? existing.message;
    existing.toolName = boundDecisionToolName(input.toolName) ?? existing.toolName;
    existing.decisionId ??= decisionId;
    if (confirmed) {
      existing.source = 'notification';
      existing.confirmedAt ??= input.at;
    }
    return;
  }

  if (turn.pendingDecisions.length >= MAX_PENDING_DECISIONS_PER_TURN) {
    // S14(d). Counted rather than dropped in silence: an agent raising more
    // approvals than this in one turn is a fact an operator has to be able to
    // see, and the oldest is the one a human has been looking at.
    dropsFor(key).decisionOverflow += 1;
    return;
  }

  turn.pendingDecisions.push({
    decisionId,
    at: input.at,
    source: input.source,
    message: boundDecisionMessage(input.message),
    toolName: boundDecisionToolName(input.toolName),
    confirmedAt: confirmed ? input.at : null,
    scraperCorroborated: false,
    recorded: false,
  });
}

/** Retire every dialog this instance was holding. */
function releaseAllDecisions(key: string): void {
  const turn = fencedTurn(key);
  if (turn !== null) turn.pendingDecisions = [];
}

/**
 * Retire the record a verdict was delivered for (Issue #1898).
 *
 * Matched on {@link AgentEventRecord.decisionId} when both sides have one: an
 * agent that can run two approvals at once would otherwise have the reply to
 * the first retire the record for the second. When either side is anonymous the
 * release is unconditional — an unmatched id is a source that publishes none,
 * and refusing to act there would leave the pre-#1898 stall in place for it.
 */
function releaseSettledDecision(key: string, record: AgentEventRecord): void {
  const turn = fencedTurn(key);
  if (turn === null || turn.pendingDecisions.length === 0) return;
  const settledId = record.decisionId === null || record.decisionId === undefined
    ? null
    : acceptExternalId(record.decisionId);
  if (settledId === null) {
    turn.pendingDecisions = [];
    return;
  }
  turn.pendingDecisions = turn.pendingDecisions.filter(
    (decision) => decision.decisionId !== null && decision.decisionId !== settledId
  );
}

/** Keep the turn map bounded the way every other map in this module is. */
function boundTurnMap(): void {
  trimOldestEntries(agentTurns, MAX_RECENT_EVENT_KEYS);
}

/**
 * @returns The last structured event reported by this instance, or null when it
 *   has reported none.
 */
export function getLastAgentEvent(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): AgentEventRecord | null {
  return lastAgentEvent.get(buildCompositeKey(worktreeId, cliToolId, instanceId)) ?? null;
}

/**
 * The last model this instance reported running, or null (Issue #1783).
 *
 * "Last **non-null**", which is the only useful reading: three of the four tools
 * that publish a model publish it on some events and not others, and Claude
 * publishes it on exactly one. Reading `getLastAgentEvent()?.model` would
 * therefore answer null for almost every moment of almost every session.
 *
 * Deliberately **not** bounded by {@link STRUCTURED_STATE_MAX_AGE_MS}, unlike
 * every other reader in this module. That bound exists because a *status* that
 * nothing has refreshed is a claim about right now that may have expired — a
 * lost `Stop` leaving the layer asserting `running` forever. A model is not that
 * kind of claim: an eight-hour turn is on the same model at the end as at the
 * start, and expiring it would blank the display on precisely the long-running
 * sessions this is most useful for. What *is* honoured is identity: a new
 * generation or a discarded session drops the value, because the process that
 * reported it is gone. See {@link beginAgentEventGeneration} /
 * {@link discardAgentEventState}.
 *
 * In-memory only — nothing is written to `session_states`. After a server
 * restart codex and antigravity repopulate on their next event; Claude stays
 * null until its next `SessionStart`, a gap Phase 2 (#1784) closes from the
 * terminal frame.
 */
export function getLastKnownAgentModel(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): string | null {
  return lastAgentModel.get(buildCompositeKey(worktreeId, cliToolId, instanceId)) ?? null;
}

/**
 * Latch what a terminal capture showed for this instance (Issue #1784).
 *
 * Called from the status-detection poll with the text that poll already
 * captured — no `capture-pane` is issued for this, so the feature costs nothing
 * in tmux round-trips.
 *
 * **Each half latches independently.** A Codex footer carries a model on every
 * frame but an effort only on some formats; a Claude banner carries both and
 * then scrolls away entirely. Writing `{model, effort}` wholesale would let the
 * frame that stopped showing one of them blank a value the other frame proved.
 * Nothing is ever written as null: absent means "no frame has ever shown this",
 * which is the honest state for gemini/copilot and for any session whose chrome
 * this module has no rule for.
 *
 * @param info - {@link import('@/lib/detection/model-info-extractor').extractModelInfo}'s answer
 */
export function recordCapturedModelInfo(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  info: ModelInfo
): void {
  if (!info.model && !info.effort) return;
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const previous = capturedModelInfo.get(key);
  capturedModelInfo.set(key, {
    model: info.model ? info.model.slice(0, MAX_EVENT_DETAIL_LENGTH) : (previous?.model ?? null),
    effort: info.effort ?? previous?.effort ?? null,
  });
}

/**
 * The last model/effort a terminal capture showed, both halves possibly null.
 *
 * The raw scraped value, before precedence is applied — {@link
 * getResolvedAgentModelInfo} is what callers publishing to the UI or the API
 * want. Exported for the tests and for anything that needs to tell "the screen
 * said" apart from "the agent said".
 */
export function getLastCapturedModelInfo(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): ModelInfo {
  const record = capturedModelInfo.get(buildCompositeKey(worktreeId, cliToolId, instanceId));
  return { model: record?.model ?? null, effort: record?.effort ?? null };
}

/**
 * The model and reasoning effort to publish for this instance (Issue #1784).
 *
 * The single answer both surfaces should read: it folds the hook channel
 * (#1783) together with the screen under the precedence documented on
 * {@link mergeModelInfo} — hooks win for the model, the screen is the only
 * source of effort for codex/claude, and antigravity's effort is derived from
 * the id it reports rather than from its (renderer-truncated) status bar.
 *
 * Both halves may be null, and routinely are: no tool publishes an effort over
 * hooks, and most tools publish neither. Callers omit the key rather than
 * emitting null — see `CliToolSessionStatus`.
 */
export function getResolvedAgentModelInfo(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): ModelInfo {
  return mergeModelInfo(
    cliToolId,
    getLastKnownAgentModel(worktreeId, cliToolId, instanceId),
    getLastCapturedModelInfo(worktreeId, cliToolId, instanceId)
  );
}

/**
 * The reasoning effort this instance is running at, or null (Issue #1784).
 *
 * Convenience reader over {@link getResolvedAgentModelInfo} for callers that
 * want only the effort — `capture --json` and `instances` (#1785) among them.
 */
export function getLastKnownAgentEffort(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): string | null {
  return getResolvedAgentModelInfo(worktreeId, cliToolId, instanceId).effort;
}

/**
 * How long a structured verdict is trusted after the event that produced it
 * (Issue #1723; one expression since #1930).
 *
 * The turn model owns the number now — see `provisional-turn`'s
 * {@link TURN_STALE_AFTER_MS}, which documents why it is 30 minutes. This name
 * is kept because it is what `status-evidence` and the #1723/#1725/#1903 suites
 * read, and because "the age bound on a verdict" and "how long a turn may run
 * unheard-from" really are the same fact rather than two that happen to agree.
 */
export const STRUCTURED_STATE_MAX_AGE_MS = TURN_STALE_AFTER_MS;

/** A structured verdict about one instance, with the event that produced it. */
export interface StructuredSessionState extends StructuredStatusVerdict {
  /** The event this verdict was derived from. */
  event: AgentEventType;
  /** Epoch ms the event was received. */
  at: number;
  /** The event's subtype, or null. */
  detail: string | null;
}

/**
 * Open a new generation for this instance, invalidating everything reported
 * before now (Issue #1723).
 *
 * Called from the session *creation* path, not from every start: a
 * `startClaudeSession()` that finds a healthy session and returns is the same
 * generation, and bumping there would throw away a still-valid verdict on
 * every reconnect.
 *
 * The failure this prevents is specific. Events live in a Map keyed by
 * (worktree, tool, instance) — a key a recreated session reuses exactly — so
 * without a generation the last `user_prompt_submit` of the *previous* Claude
 * process would be read as the current one's, and a freshly started session
 * would report `running` before anybody had typed anything into it.
 *
 * @param at - Epoch ms; defaults to now
 */
export function beginAgentEventGeneration(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  at: number = Date.now()
): void {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  generationStartedAt.set(key, at);
  // Issue #1930: the turn the previous process was in ends with that process,
  // and the approvals it was holding go with it — they were raised against a
  // slot nobody is holding open any more. The turn record is kept, closed as
  // `closedBy: 'generation'`, so `capture --json` can say why it ended instead
  // of going quiet. The dialogs #1725 kept in a map of their own live on that
  // record now, which is what makes this one call retire both.
  fenceTurnForNewGeneration(key, at);
  // Same reasoning for the question that dialog was asking (Issue #1726).
  askUserQuestion.delete(key);
  // And for "waiting for your input" (Issue #1786): a new process has not asked
  // for anything yet.
  awaitingInstruction.delete(key);
  // And for the model (Issue #1783): a new generation is a new agent process,
  // which may have been launched on a different model entirely. Latching across
  // one would show the *previous* process's model with nothing to correct it —
  // Claude only re-reports on `SessionStart`, which lands moments later anyway.
  // A `/clear` is deliberately not affected: it reaches `recordAgentEvent` as
  // `session_end` + `session_start`, never this function.
  lastAgentModel.delete(key);
  // Issue #1784: same argument for what the screen showed. The latch exists to
  // survive the banner scrolling away *within* one process; carrying it across
  // a relaunch would show the old process's effort with no frame left that
  // could contradict it. The next poll re-reads a live footer immediately.
  capturedModelInfo.delete(key);
  // Issue #1899: the ids claimed for this key were issued by the process that
  // has just been replaced. Unlike the time-window keys, they never expire on
  // their own, so a generation is the only thing that retires them.
  recentEventIdentities.delete(key);
}

/**
 * @returns Epoch ms the current generation began, or null when no generation
 *   has been opened — the ordinary case for a session that predates this
 *   server process, whose events are then judged on age alone.
 */
export function getAgentEventGenerationStartedAt(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): number | null {
  return generationStartedAt.get(buildCompositeKey(worktreeId, cliToolId, instanceId)) ?? null;
}

/**
 * Discard the structured state for one instance — the session it described is
 * gone (Issue #1723).
 *
 * `lastStopEventAt` is deliberately left alone. It is #1549's observational
 * timestamp with its own published meaning ("when did this agent last say it
 * stopped"), it decides nothing, and clearing it here would silently change
 * what the field has always reported.
 */
export function discardAgentEventState(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): void {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  lastAgentEvent.delete(key);
  generationStartedAt.delete(key);
  // Issue #1930: the turn, and with it the dialogs it was holding. Not counted
  // as an eviction — the session is gone, so there is nobody left to tell.
  agentTurns.delete(key);
  dropCounts.delete(key);
  askUserQuestion.delete(key);
  awaitingInstruction.delete(key);
  // Issue #1783: the session that was on this model no longer exists.
  lastAgentModel.delete(key);
  // Issue #1784: nor does the pane its footer was read from.
  capturedModelInfo.delete(key);
  // Issue #1899: nor do the frame ids that session issued.
  recentEventIdentities.delete(key);
}

/**
 * The status this instance's turn implies, or null when it implies nothing
 * (Issue #1723, re-derived from the turn model in #1930).
 *
 * Null is the answer for every session on a machine where hooks never fire,
 * which is what keeps the unconfigured environment on exactly the behaviour it
 * had before #1723. It is also the answer when:
 *
 *  - the turn belongs to a previous generation, i.e. to an agent process that
 *    used to live in this pane;
 *  - nothing has been heard about it for {@link STRUCTURED_STATE_MAX_AGE_MS};
 *  - the turn ended for a reason that says nothing about whether the pane is
 *    free — `session_end` (a `/clear` mid-turn), `stale`, `generation`, or the
 *    two the *screen* closed it on (`scraper_evidence`, `resync_idle`). Only
 *    the agent's own `Stop` publishes `ready` over this channel; everything
 *    else hands the pane back to the scraper, which is the layer those closures
 *    came from in the first place;
 *  - no decision stands and the displayed event carries no verdict.
 *
 * ## The derivation, in the order it is applied
 *
 * | condition                                   | verdict                       |
 * |---------------------------------------------|-------------------------------|
 * | an unanswered decision is live              | `waiting`                     |
 * | the turn was closed by `stop`               | `ready` / `hook_stop`         |
 * | the turn was closed by anything else        | null                          |
 * | the displayed event carries a verdict       | that verdict                  |
 * | a turn is open and it does not              | `running` / `hook_prompt_submit` |
 * | otherwise                                   | null                          |
 *
 * §4 D3's `running ⟺ open turn ∧ 未裁定なし ∧ 現世代` falls out of the first,
 * fourth and fifth rows together with the generation fence — with one measured
 * exception written into the table above it: `notification(idle_prompt)`
 * publishes `ready` **without** closing the turn (#1839 caught Claude emitting
 * it 62 s into a turn that ran nothing, so it cannot be a boundary). A reader
 * that needs the boundary rather than the display reads `closedAt`.
 *
 * Whether the tmux session is alive is NOT checked here — the caller
 * (`buildCurrentOutput`) has already answered that with the CLI tool's own
 * `isRunning()` and returned early, and asking twice would mean a second tmux
 * round-trip on the hot path for an answer it is holding.
 *
 * @param now - Epoch ms; defaults to now
 */
export function getStructuredSessionState(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  now: number = Date.now()
): StructuredSessionState | null {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const turn = effectiveTurn(key, now);
  if (turn === null) return null;

  const display = turn.displayEvent;
  if (now - display.at >= STRUCTURED_STATE_MAX_AGE_MS) return null;
  const seen = { event: display.event, at: display.at, detail: display.detail };

  const pending = livePendingDecisions(key, turn, now);
  if (pending.length > 0) {
    // The two kinds of evidence stay apart in the reason token, exactly as
    // `structuredWaitingReason` keeps them apart for the payload: a
    // `Notification` is proof a dialog exists, a `PermissionRequest` this
    // server declined to decide is the prediction that one is about to.
    const reason =
      pending[0].source === 'notification'
        ? HOOK_STATUS_REASON.PERMISSION_PROMPT
        : HOOK_STATUS_REASON.PERMISSION_REQUEST;
    return { status: 'waiting', reason, ...seen };
  }

  if (turn.closedAt !== null) {
    if (turn.closedBy === 'stop') {
      return { status: 'ready', reason: HOOK_STATUS_REASON.STOP, ...seen };
    }
    return null;
  }

  const verdict = agentEventToSessionStatus(display.event, display.detail);
  // A `waiting` read off the displayed event is a dialog nothing is holding any
  // more — the ledger above is what answers that question now. The turn is
  // still open, so the agent is still working.
  if (verdict === null || verdict.status === 'waiting') {
    if (turn.openedAt === null) return null;
    return { status: 'running', reason: HOOK_STATUS_REASON.PROMPT_SUBMIT, ...seen };
  }

  return { ...verdict, ...seen };
}

/**
 * How long a `permission-request`-sourced record survives without
 * corroboration (Issue #1725; one expression since #1930).
 *
 * The turn model owns the number — see `provisional-turn`'s
 * {@link DIALOG_PENDING_MAX_MS}, whose doc has the measurement. Kept under this
 * name for `permission-decision-service`, which cites it, and for the #1725
 * suite.
 */
export const STRUCTURED_PROMPT_PROVISIONAL_MAX_AGE_MS = DIALOG_PENDING_MAX_MS.predicted;

/**
 * An open dialog the structured layer knows about (Issue #1725).
 *
 * The same object as {@link StructuredPendingDecision} since Issue #1930, which
 * moved the dialogs onto the turn they were raised in. The alias is kept because
 * `prompt-waiting-composition`, the `send` guard and `current-output-builder`
 * all name this type, and because the two names describe the same record from
 * the two ends it is read from: "the dialog blocking this pane" and "an approval
 * this turn is holding".
 */
export type StructuredPromptWaitingState = StructuredPendingDecision;

/**
 * Report that a dialog is open because the agent asked us to adjudicate one and
 * we declined to (Issue #1725, Auto-Yes v2's no-decision path).
 *
 * Provisional: see {@link STRUCTURED_PROMPT_PROVISIONAL_MAX_AGE_MS}.
 *
 * Called by `permission-decision-service` and by opencode's ingest, both of
 * which have already applied the `permissionHookPredictsDialog` capability gate
 * (#1901) — this function is told, it does not decide.
 *
 * @param at - Epoch ms; defaults to now
 */
export function reportPermissionRequestPending(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  toolName: string | null,
  at: number = Date.now(),
): void {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  openDecision(key, currentGeneration(key), {
    source: 'permission-request',
    at,
    message: null,
    toolName,
    decisionId: null,
    // A forecast carries no event of its own, so the record it bootstraps is
    // described by the thing it is forecasting. `structuredEvents.lastEventType`
    // is unaffected — that reads `getLastAgentEvent`, which nothing here writes.
    bootstrapDisplay: { event: 'notification', at, detail: 'permission_prompt' },
  });
}

/**
 * The open dialog this instance's structured events imply, or null.
 *
 * Bounded exactly like {@link getStructuredSessionState}: a record from a
 * previous generation is not this session's, and one past its retention bound
 * has outlived the fact it describes. An unconfirmed `permission-request`
 * record expires far sooner — see {@link DIALOG_PENDING_MAX_MS}.
 *
 * The oldest live decision, because that is the one a human has been looking
 * at, and because it is the record #1725 published when there could only ever
 * be one. The returned object is the live record, not a copy:
 * `prompt-waiting-composition` marks corroboration and the history write on it.
 *
 * @param now - Epoch ms; defaults to now
 */
export function getStructuredPromptWaiting(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  now: number = Date.now(),
): StructuredPromptWaitingState | null {
  return getPendingDecisions(worktreeId, cliToolId, instanceId, now)[0] ?? null;
}

/**
 * Record that the scraper has seen a blocking frame while this dialog is open
 * (Issue #1725).
 *
 * Two effects, both needed: it confirms a provisional record, and it arms the
 * only release rule the scraper is entitled to apply. See
 * {@link StructuredPendingDecision.scraperCorroborated}.
 *
 * @param at - Epoch ms; defaults to now
 */
export function corroborateStructuredPromptWaiting(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  at: number = Date.now(),
): void {
  const state = getStructuredPromptWaiting(worktreeId, cliToolId, instanceId, at);
  if (!state) return;
  state.scraperCorroborated = true;
  state.confirmedAt ??= at;
}

/** Note that this episode's prompt-history row has been written. */
export function markStructuredPromptRecorded(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
): void {
  const state = getStructuredPromptWaiting(worktreeId, cliToolId, instanceId);
  if (state) state.recorded = true;
}

/**
 * Release the prompt-waiting record — the dialog is gone (Issue #1725).
 *
 * Called from the turn transition above and from `prompt-waiting-composition`
 * when the scraper reports that the frame it corroborated has cleared.
 *
 * Releases every decision this instance is holding, not only the first. The
 * scraper's statement is about the *pane*, and a pane with no dialog on it has
 * no dialogs on it — retiring one and leaving the rest would publish `waiting`
 * for a frame the scraper has just said is clear.
 */
export function clearStructuredPromptWaiting(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
): void {
  releaseAllDecisions(buildCompositeKey(worktreeId, cliToolId, instanceId));
}

/**
 * The `AskUserQuestion` call the agent has in flight (Issue #1726).
 *
 * Held apart from {@link StructuredPromptWaitingState} because it answers a
 * different question. That one says *whether* a human is blocked, and decides
 * `sessionStatus`; this one says *what they were asked*, and decides nothing —
 * it only supplies option text to a prompt some other layer has already
 * established is on screen. The split is what keeps the role table from the
 * Issue honest: the scraper detects the screen (#1708), this record describes
 * its contents.
 */
export interface AskUserQuestionEpisode {
  /** Epoch ms the invocation was reported. */
  at: number;
  /** The questions and their options, verbatim from `tool_input`. */
  spec: AskUserQuestionSpec;
}

/**
 * When the in-flight question is released (Issue #1726).
 *
 * | event                             | effect on the question |
 * |-----------------------------------|------------------------|
 * | `pre_tool_use(AskUserQuestion)`   | unchanged (this IS it) |
 * | `pre_tool_use(any other tool)`    | release                |
 * | `post_tool_use`                   | release                |
 * | `notification(permission_prompt)` | **unchanged**          |
 * | `notification(idle_prompt)`       | release                |
 * | `notification(other)`             | unchanged              |
 * | `stop`                            | release                |
 * | `user_prompt_submit`              | release                |
 * | `session_start` / `session_end`   | release                |
 *
 * `PostToolUse` is the precise release — "this tool call is over" — and `Stop`
 * is the backstop for a delivery that never arrives. Issue #1726's text proposed
 * `PostToolUse` and the #1721 spike recorded it as never observed, so this Issue
 * measured it directly on a live v2.1.223 session (2026-08-06):
 *
 * ```
 * 15:36:04.112  PreToolUse   AskUserQuestion
 * 15:36:28.643  PostToolUse  AskUserQuestion   <- the human answered
 * 15:36:29.992  Stop
 * ```
 *
 * It fires, 1.3 s ahead of `Stop` here — and much further ahead whenever the
 * agent keeps working after the answer, which is the case that matters: `Stop`
 * alone would leave a finished question in place for the whole rest of the turn.
 *
 * A `PostToolUse` for any other tool releases as well: the agent could not have
 * finished another tool call while this question was still on screen.
 *
 * **`Notification(permission_prompt)` keeping the question is a live
 * measurement, not a guess.** The #1721 report says the picker emits no events
 * while it is displayed (§5.6), and a first cut of this module read that as "any
 * event means the picker is gone". Driving a real v2.1.223 session through the
 * server on 2026-08-06 disproved it:
 *
 * ```
 * 15:29:18.099  PreToolUse(AskUserQuestion)
 * 15:29:18.109  PermissionRequest(AskUserQuestion) -> no decision
 * 15:29:24.128  Notification(permission_prompt)      <- picker still on screen
 * ```
 *
 * The notification lands ~6 s after the dialog is drawn (§5.5's timing exactly),
 * which is *inside* the window §5.6 was counting rather than outside it. Under
 * the first rule it deleted the question six seconds after it arrived, and the
 * options went back to being the screen's — which is the whole feature, silently
 * off, on every real session.
 *
 * `idle_prompt` still releases: the agent reporting it is sitting at the
 * composer is the agent saying no picker is in front of it. An unrecognised
 * notification type changes nothing, because nothing is known about it.
 */
function applyAskUserQuestionTransition(key: string, record: AgentEventRecord): void {
  switch (record.event) {
    case 'pre_tool_use':
      // A `PreToolUse` for anything else means the agent has moved on to another
      // tool, so whatever question was in flight has been answered. Only
      // reachable when the operator's own settings.json registers a wider
      // matcher than the injected `AskUserQuestion` one — the two files are
      // concatenated, not substituted (#1722).
      if (record.detail !== ASK_USER_QUESTION_TOOL) askUserQuestion.delete(key);
      return;
    case 'notification':
      if (record.detail === 'idle_prompt') askUserQuestion.delete(key);
      return;
    case 'post_tool_use':
    case 'stop':
    case 'user_prompt_submit':
    case 'session_start':
    case 'session_end':
      askUserQuestion.delete(key);
      return;
    default:
      // exhaustive check: a new AgentEventType must decide its transition here
      record.event satisfies never;
      return;
  }
}

/**
 * Record the `AskUserQuestion` invocation reported for one instance.
 *
 * Idempotent by construction: the same call is reported twice on every session
 * — once by `PreToolUse` and once by the `PermissionRequest` that
 * `AskUserQuestion` also raises with a byte-identical `tool_input` — and the
 * second delivery simply overwrites the first with the same content.
 *
 * @param at - Epoch ms; defaults to now
 */
export function recordAskUserQuestion(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  spec: AskUserQuestionSpec,
  at: number = Date.now(),
): void {
  askUserQuestion.set(buildCompositeKey(worktreeId, cliToolId, instanceId), { at, spec });
}

/**
 * The `AskUserQuestion` call in flight for this instance, or null.
 *
 * Bounded exactly like {@link getStructuredSessionState}: a record from a
 * previous generation belongs to a Claude process that no longer exists, and one
 * older than {@link STRUCTURED_STATE_MAX_AGE_MS} has outlived the screen it
 * describes. There is no provisional bound — unlike a `PermissionRequest`, a
 * `PreToolUse(AskUserQuestion)` is not a prediction that a dialog *might*
 * appear: allowing the permission request does not dismiss the picker (§5.6), so
 * the picker is drawn unconditionally.
 *
 * @param now - Epoch ms; defaults to now
 */
export function getAskUserQuestion(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  now: number = Date.now(),
): AskUserQuestionEpisode | null {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const episode = askUserQuestion.get(key);
  if (!episode) return null;

  const generation = generationStartedAt.get(key);
  if (generation !== undefined && episode.at < generation) return null;

  if (now - episode.at >= STRUCTURED_STATE_MAX_AGE_MS) return null;

  return episode;
}

/** Drop the in-flight question for one instance. */
export function clearAskUserQuestion(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
): void {
  askUserQuestion.delete(buildCompositeKey(worktreeId, cliToolId, instanceId));
}

/**
 * Whether this event is a second copy of one already handled, and should be
 * dropped.
 *
 * Only events that name a `sessionId` can be deduplicated, and calling this
 * *claims* the key: a first call answers false and marks it, so the caller must
 * ask once per request and act on the answer. Events with no session id are
 * never suppressed — a caller that omits it (the #1549 relay run without a hook
 * payload, a hand-rolled `curl`) has given us nothing to tell two deliveries of
 * one turn from two genuine turns, and inventing a match there would silently
 * drop real events.
 *
 * The subtype is part of the key (Issue #1726). It has to be, now that
 * `pre_tool_use` exists: that event's subtype is the tool name, several tool
 * calls a second is ordinary, and a key without it would read a `Bash` call and
 * the `AskUserQuestion` that follows it as one delivery and drop the second. The
 * same correction applies to two `Notification`s of different types inside the
 * window, which were previously collapsed as well.
 *
 * @param at - Epoch ms; defaults to now
 * @param detail - The event's subtype, when it has one
 */
export function isDuplicateAgentEvent(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  event: AgentEventType,
  sessionId: string | null | undefined,
  at: number = Date.now(),
  detail: string | null = null
): boolean {
  if (!sessionId) return false;

  const key = [
    buildCompositeKey(worktreeId, cliToolId, instanceId),
    event,
    detail ?? '',
    sessionId,
  ].join(' ');
  const seenAt = recentEventKeys.get(key);
  if (seenAt !== undefined && at - seenAt < AGENT_EVENT_DEDUP_WINDOW_MS) {
    return true;
  }

  recentEventKeys.set(key, at);
  pruneRecentEventKeys(at);
  return false;
}

/** Drop keys past the window, then the oldest survivors if still over the cap. */
function pruneRecentEventKeys(now: number): void {
  for (const [key, seenAt] of recentEventKeys) {
    if (now - seenAt >= AGENT_EVENT_DEDUP_WINDOW_MS) {
      recentEventKeys.delete(key);
    }
  }
  // Map iterates in insertion order, so the head is the oldest.
  while (recentEventKeys.size > MAX_RECENT_EVENT_KEYS) {
    const oldest = recentEventKeys.keys().next();
    if (oldest.done) break;
    recentEventKeys.delete(oldest.value);
  }
}

/** How many dedup keys are currently retained. Test seam for the bound above. */
export function getRecentEventKeyCount(): number {
  return recentEventKeys.size;
}

// =============================================================================
// Identity de-duplication (Issue #1899)
// =============================================================================

/**
 * Event words whose repeat is a fact about the session, not a re-delivery
 * (Issue #1899; design §4 D3 decision 2).
 *
 * These are the two words that end something, and neither of them carries an
 * id on any source measured so far. `session.idle` — opencode's `stop` — is
 * `{ "sessionID": "ses_…" }` and nothing else, which is exactly why
 * `sources/opencode/turn-gate` exists. With no id, a generic deduper has only
 * the clock, and the clock cannot tell a second turn from a second delivery:
 * #1899 measured a real `stop` 2.5 s after the previous one being dropped,
 * which leaves the newest event at `user_prompt_submit`, the instance reading
 * `running`, and `commandmate wait` blocked until the 30-minute staleness
 * bound.
 *
 * **The exemption is conditional on the source declaring an identity**, and
 * that condition is the whole safety argument. A source that declares one is a
 * source with a real deduper elsewhere — on the SSE path, `TurnGate`, which
 * arms on `session.status(busy)` and completes on the first `session.idle`
 * after arming, so the abort double-idle (19 ms apart, §5.3.2) never reaches
 * the ingest at all. Push hooks have no such gate: #1722's concatenated
 * settings really do post two `Stop`s for one turn, and
 * {@link isDuplicateAgentEvent} — which is what every hook receiver still
 * calls — is left untouched for them.
 */
export const LIFECYCLE_AGENT_EVENT_TYPES: readonly AgentEventType[] = ['stop', 'session_end'];

/** Which rule judged a delivery a repeat. */
export type AgentEventDedupBasis = 'identity' | 'time-window';

/** One delivery, described as far as its source can describe it. */
export interface AgentEventDelivery {
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId: string | undefined;
  event: AgentEventType;
  /** The event's subtype, when it has one. */
  detail: string | null;
  /** The source's own conversation id. Only the time-window rule reads it. */
  sessionId: string | null | undefined;
  /** Epoch ms. */
  at: number;
  /**
   * The frame's own id — `AgentEventSource.eventIdentityOf` — or null when
   * this frame publishes none.
   */
  identity: string | null;
  /**
   * What the source declares in {@link AgentSourceCapabilities.eventIdentity}.
   * `null` selects the time window, which is every push source today.
   */
  identityKind: AgentSourceCapabilities['eventIdentity'];
}

/** Whether to drop this delivery, and on whose authority. */
export type AgentEventDedupVerdict =
  | { duplicate: false }
  | { duplicate: true; by: AgentEventDedupBasis };

/**
 * Whether this delivery is a second copy of one already handled (Issue #1899).
 *
 * The tool-agnostic replacement for calling {@link isDuplicateAgentEvent}
 * directly, and it branches on the source's declared capability rather than on
 * its name — flip opencode's `eventIdentity` to `null` and every case below
 * falls back to the 3-second window it used before this Issue.
 *
 * Three rules, in order:
 *
 *  1. **The frame has an id** — key on it, with no time bound at all. An id is
 *     a claim about identity that a clock cannot improve on: two approvals
 *     1 s apart are two approvals, and the same approval replayed by
 *     `resyncPending` four minutes later is still one approval. That second
 *     half is what the ingest's window was reaching for ("a frame delivered
 *     twice by a re-sync racing the live stream") and never actually covered,
 *     since a re-sync is not obliged to land within three seconds.
 *  2. **No id, but the word ends something** — never suppressed. See
 *     {@link LIFECYCLE_AGENT_EVENT_TYPES}.
 *  3. **Anything else** — the time window, unchanged. That is every push
 *     source, and the identity-declaring source's `session.created` /
 *     `session.error`, which publish no id either but are not turn boundaries.
 *
 * Calling this *claims* the key, exactly as {@link isDuplicateAgentEvent} does:
 * ask once per delivery and act on the answer.
 */
export function classifyAgentEventDelivery(
  delivery: AgentEventDelivery
): AgentEventDedupVerdict {
  const composite = buildCompositeKey(
    delivery.worktreeId,
    delivery.cliToolId,
    delivery.instanceId
  );

  if (delivery.identityKind !== null) {
    // Issue #1930 / S1: the id is the agent's, and it becomes a Map key. One
    // that fails validation is DISCARDED — the delivery then takes the
    // no-id path below, which is a path this function already has — rather than
    // truncated, because a truncated id compares equal to a different id that
    // shares its prefix and would drop a real event as a repeat.
    const identity = delivery.identity === null ? null : acceptExternalId(delivery.identity);
    if (delivery.identity !== null && identity === null) dropsFor(composite).idsDiscarded += 1;

    if (identity !== null) {
      if (claimEventIdentity(delivery, identity)) {
        dropsFor(composite).dedupDropped.identity += 1;
        return { duplicate: true, by: 'identity' };
      }
      return { duplicate: false };
    }
    if (LIFECYCLE_AGENT_EVENT_TYPES.includes(delivery.event)) {
      return { duplicate: false };
    }
  }

  const duplicate = isDuplicateAgentEvent(
    delivery.worktreeId,
    delivery.cliToolId,
    delivery.instanceId,
    delivery.event,
    delivery.sessionId,
    delivery.at,
    delivery.detail
  );
  if (!duplicate) return { duplicate: false };
  dropsFor(composite).dedupDropped.timeWindow += 1;
  return { duplicate: true, by: 'time-window' };
}

/**
 * Claim `(event, detail, identity)` for one instance, answering whether it was
 * already claimed.
 *
 * `event` and `detail` are in the key and are not decoration: opencode asks an
 * approval under `properties.id` and answers it under `properties.requestID`
 * with **the same `per_…` value** (#1898), so a key made of the identity alone
 * would read `permission.replied` as a repeat of `permission.asked` and drop
 * the one frame that releases the dialog. The same shape covers
 * `pre_tool_use` / `post_tool_use`, which share a `callID`.
 *
 * `sessionId` is deliberately *not* in the key. An id is unique within the
 * agent that issued it, and folding in a field that is null on some deliveries
 * would let the same frame through twice.
 */
function claimEventIdentity(delivery: AgentEventDelivery, identity: string): boolean {
  const composite = buildCompositeKey(
    delivery.worktreeId,
    delivery.cliToolId,
    delivery.instanceId
  );

  let claimed = recentEventIdentities.get(composite);
  if (!claimed) {
    claimed = new Map<string, number>();
    recentEventIdentities.set(composite, claimed);
    // Bound the instances as well as the entries per instance: the composite
    // key is (worktree, tool, instance) and a long-lived server accumulates
    // worktrees (DR4-009).
    trimOldestEntries(recentEventIdentities, MAX_RECENT_EVENT_KEYS);
  }

  const key = [delivery.event, delivery.detail ?? '', identity].join(' ');
  if (claimed.has(key)) return true;

  claimed.set(key, delivery.at);
  trimOldestEntries(claimed, MAX_RECENT_EVENT_KEYS);
  return false;
}

/** Drop the oldest entries until the map fits. Maps iterate in insertion order. */
function trimOldestEntries<V>(entries: Map<string, V>, max: number): void {
  while (entries.size > max) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
}

/**
 * How many identities are retained for one instance, or across all of them when
 * no instance is named. Test seam for the bound above.
 */
export function getRecentEventIdentityCount(
  worktreeId?: string,
  cliToolId?: CLIToolType,
  instanceId?: string
): number {
  if (worktreeId === undefined || cliToolId === undefined) {
    let total = 0;
    for (const claimed of recentEventIdentities.values()) total += claimed.size;
    return total;
  }
  return recentEventIdentities.get(buildCompositeKey(worktreeId, cliToolId, instanceId))?.size ?? 0;
}

/** Drop every recorded event. Test seam. */
export function clearAgentStopEvents(): void {
  lastStopEventAt.clear();
  lastAgentEvent.clear();
  recentEventKeys.clear();
  recentEventIdentities.clear();
  generationStartedAt.clear();
  // Issue #1930: the turns, the dialogs they hold, and the tally of what was
  // dropped from them.
  agentTurns.clear();
  dropCounts.clear();
  askUserQuestion.clear();
  awaitingInstruction.clear();
  // Issue #1783. CI runs with `fileParallelism: false`, so every suite in the
  // repo shares this process — a model latched by one test would otherwise be
  // read by another, in file order, and only in CI.
  lastAgentModel.clear();
  // Issue #1784: and the same for the scraped half.
  capturedModelInfo.clear();
}
