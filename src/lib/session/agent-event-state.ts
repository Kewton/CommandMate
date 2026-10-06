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
// Issue #1899: type-only, so nothing in the source registry's module graph —
// `better-sqlite3` included — is pulled into this module at runtime.
import type { AgentSourceCapabilities } from '@/lib/hooks/sources/types';
// Issue #1903: the four-value vocabulary the verdicts below are read in.
import type { SessionStatus } from '@/lib/detection/status-detector';
// Issue #3375: the state this module used to hold in one file now lives in the
// modules below, one per concern. Each owns its maps; this module drives them
// from `recordAgentEvent` and the generation / discard / test-seam resets, and
// re-exports their public names so every existing import keeps working.
import type { AgentEventRecord } from '@/lib/session/agent-event-record';
import {
  dropCounts,
  recentEventIdentities,
  recentEventKeys,
} from '@/lib/session/agent-event-dedup';
import {
  capturedModelInfo,
  lastAgentModel,
  lastAgentModelAt,
  latchAgentModel,
  modelBaseline,
  observeAgentModel,
  reportedEffort,
} from '@/lib/session/agent-event-model';
import {
  DIALOG_PENDING_MAX_MS,
  type StructuredPendingDecision,
} from '@/lib/session/provisional-turn';
import {
  agentTurns,
  applyTurnTransition,
  currentGeneration,
  fenceTurnForNewGeneration,
  generationStartedAt,
  getPendingDecisions,
  openDecision,
  releaseAllDecisions,
  reopenedTurns,
} from '@/lib/session/agent-event-turn';
import { getStructuredSessionState } from '@/lib/session/agent-event-structured-state';
import {
  applyAwaitingInstructionTransition,
  awaitingInstruction,
} from '@/lib/session/agent-event-awaiting-instruction';
import {
  applyAskUserQuestionTransition,
  askUserQuestion,
} from '@/lib/session/agent-event-ask-user-question';
import { getOrInitGlobal } from '../global-state';

export type { AgentEventRecord } from '@/lib/session/agent-event-record';
export {
  AGENT_EVENT_DEDUP_WINDOW_MS,
  agentEventKeyClaimedAt,
  classifyAgentEventDelivery,
  getAgentEventDropCounts,
  getRecentEventIdentityCount,
  getRecentEventKeyCount,
  isDuplicateAgentEvent,
  LIFECYCLE_AGENT_EVENT_TYPES,
  shortSessionTag,
  type AgentEventDedupBasis,
  type AgentEventDedupVerdict,
  type AgentEventDelivery,
  type AgentEventDropCounts,
} from '@/lib/session/agent-event-dedup';
export {
  AGENT_MODEL_EFFORT_SUFFIX_PATTERN,
  getAgentModelBaseline,
  getLastCapturedModelInfo,
  getLastKnownAgentEffort,
  getLastKnownAgentModel,
  getLastReportedAgentEffort,
  getResolvedAgentModelInfo,
  isSameAgentModelName,
  onAgentModelChange,
  recordAgentReportedEffort,
  recordAgentReportedModel,
  recordCapturedModelInfo,
  type AgentModelBaseline,
  type AgentModelChange,
  type AgentModelChangeListener,
  type AgentModelSource,
} from '@/lib/session/agent-event-model';
export {
  closeAgentTurn,
  getAgentTurn,
  getPendingDecisions,
  getPublishedAgentTurn,
  joinOpenTurnFromDuplicate,
  observeScraperCompletionEvidence,
} from '@/lib/session/agent-event-turn';
export {
  getStructuredSessionState,
  STRUCTURED_STATE_MAX_AGE_MS,
  type StructuredSessionState,
} from '@/lib/session/agent-event-structured-state';
export {
  getAwaitingInstruction,
  isAwaitingInstruction,
  type AwaitingInstructionRecord,
} from '@/lib/session/agent-event-awaiting-instruction';
export {
  clearAskUserQuestion,
  getAskUserQuestion,
  recordAskUserQuestion,
  type AskUserQuestionEpisode,
} from '@/lib/session/agent-event-ask-user-question';

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
}

/** compositeKey -> epoch ms of the most recent stop event. */
const lastStopEventAt = getOrInitGlobal('__agentEventLastStopAt', () => new Map<string, number>());

/** compositeKey -> the most recent event of any kind. */
const lastAgentEvent = getOrInitGlobal('__agentEventLast', () => new Map<string, AgentEventRecord>());

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
    observeAgentModel(worktreeId, cliToolId, instanceId, 'hook', record.at);
    return { recorded: false, skipped: 'late-session-start' };
  }

  lastAgentEvent.set(key, record);
  if (record.event === 'session_start') {
    // Issue #2357: a new agent process, whatever model it names first is its
    // STARTING model — recorded below, announced to nobody. Dropped before the
    // latch so the comparison in `observeAgentModel` has nothing to compare
    // against. `/clear` (session_end + session_start on the same process, same
    // model) passes through here unchanged: same name, no edge either way.
    modelBaseline.delete(key);
  }
  latchAgentModel(key, record);
  observeAgentModel(worktreeId, cliToolId, instanceId, 'hook', record.at);
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
  lastAgentModelAt.delete(key);
  // Issue #1784: same argument for what the screen showed. The latch exists to
  // survive the banner scrolling away *within* one process; carrying it across
  // a relaunch would show the old process's effort with no frame left that
  // could contradict it. The next poll re-reads a live footer immediately.
  capturedModelInfo.delete(key);
  // Issue #2048: and the variant the agent named, for exactly #1783's reason —
  // the new process may have been launched with a different one, or with none.
  reportedEffort.delete(key);
  // Issue #2357: and the model this instance was last seen on. The next value
  // is a new process's starting model (`null → value`), not a change from the
  // process that was replaced.
  modelBaseline.delete(key);
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
  lastAgentModelAt.delete(key);
  // Issue #1784: nor does the pane its footer was read from.
  capturedModelInfo.delete(key);
  // Issue #2048: nor the variant that session was running at.
  reportedEffort.delete(key);
  // Issue #2357: nor the model it was last seen on.
  modelBaseline.delete(key);
  // Issue #1899: nor do the frame ids that session issued.
  recentEventIdentities.delete(key);
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
    // A forecast has no payload behind it: the hook that fires it names the
    // tool and nothing else, so there are no `Allow always` rules to state yet.
    // The `Notification` that confirms this record supplies them (Issue #2031).
    patterns: null,
    decisionId: null,
    // A forecast carries no event of its own, so the record it bootstraps is
    // described by the thing it is forecasting. `structuredEvents.lastEventType`
    // is unaffected — that reads `getLastAgentEvent`, which nothing here writes.
    bootstrapDisplay: { event: 'notification', at, detail: 'permission_prompt' },
  });
}

/**
 * Report that a QUESTION dialog is open, naming the decision it is answered by
 * (Issue #2100).
 *
 * ## Why this is not {@link reportPermissionRequestPending}
 *
 * That function is a *forecast*: `source: 'permission-request'`, no id, no
 * payload, and `confirmedAt: null`, which bounds the record at
 * {@link DIALOG_PENDING_MAX_MS}`.predicted` — 20 seconds — until something
 * corroborates it. It was the only exported way to say "a human is blocked", so
 * opencode's ingest called it for `question.asked` too, and that one call cost
 * three separate facts:
 *
 *  1. the `que_…` the frame carried was **discarded** (`decisionId: null`), so
 *     `current-output-builder`'s addressable-decision gate could never pass and
 *     `promptData.decisionId` was null while the server was holding the id;
 *  2. `source` read `permission-request` — "a dialog is about to be drawn" — for
 *     an event that is the agent's own proof that one **is** drawn;
 *  3. the record **expired after 20 s**. Measured on 1.18.23: at t+20 s
 *     `pendingDecisions` emptied, `dedupDropped.dialogTimedOut` incremented and
 *     `sessionStatus` flipped from `waiting` back to `ready` with the question
 *     still on screen and the agent still blocked — opencode publishes no
 *     `session.idle` at all while a question is pending (§27.4).
 *
 * A question is proof, so it is opened as `'notification'`: confirmed on
 * arrival, bounded by `DIALOG_PENDING_MAX_MS.confirmed`, and released by the
 * `post_tool_use` the answer produces exactly as an approval is.
 *
 * Names no tool and no event word — both arrive as values, from the ingest that
 * owns them — so this module keeps the property that it can be read without
 * knowing which agent is on the other end.
 *
 * @param toolName - The marker `pendingDecisionKind` recovers the kind from
 * @param decisionId - The agent's own id for the question, or null when the
 *   payload named none (the record is then anonymous, as before)
 * @param detail - The event detail a bootstrapped display record carries
 * @param at - Epoch ms; defaults to now
 */
export function reportQuestionPending(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  input: { toolName: string; decisionId: string | null; detail: string },
  at: number = Date.now(),
): void {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  openDecision(key, currentGeneration(key), {
    source: 'notification',
    at,
    // The question TEXT is not the dialog's `message`: it is published as
    // `promptData.askUserQuestion`, from the episode `recordAskUserQuestion`
    // holds, so that one parse feeds the summary and the answerable numbers.
    message: null,
    toolName: input.toolName,
    // A question grants nothing that outlives it — there is no `Allow always`
    // to state the size of.
    patterns: null,
    decisionId: input.decisionId,
    bootstrapDisplay: { event: 'notification', at, detail: input.detail },
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
  reopenedTurns.clear();
  dropCounts.clear();
  askUserQuestion.clear();
  awaitingInstruction.clear();
  // Issue #1783. CI runs with `fileParallelism: false`, so every suite in the
  // repo shares this process — a model latched by one test would otherwise be
  // read by another, in file order, and only in CI.
  lastAgentModel.clear();
  lastAgentModelAt.clear();
  // Issue #1784: and the same for the scraped half.
  capturedModelInfo.clear();
  // Issue #2048: and for the variant the agent reported.
  reportedEffort.clear();
  // Issue #2357: and for the model each instance was last seen on. The
  // listener set is deliberately NOT cleared — a subscription belongs to the
  // process, not to a session, and a suite that armed one expects it to stay.
  modelBaseline.clear();
}
