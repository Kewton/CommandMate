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
import { MAX_EVENT_DETAIL_LENGTH, type AgentEventType } from '@/lib/hooks/agent-event-types';
import type { AskUserQuestionSpec } from '@/lib/hooks/ask-user-question-payload';
import { ASK_USER_QUESTION_TOOL } from '@/lib/hooks/permission-request-payload';
// Issue #1784: the terminal-frame half of "which model / effort is this on".
import { mergeModelInfo, type ModelInfo } from '@/lib/detection/model-info-extractor';
import { agentEventToSessionStatus, type StructuredStatusVerdict } from '@/lib/session/status-mapping';
import {
  MAX_STRUCTURED_PROMPT_MESSAGE_LENGTH,
  type StructuredPromptSource,
} from '@/lib/session/structured-prompt';

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
  var __agentEventPromptWaiting: Map<string, StructuredPromptWaitingState> | undefined;
  // eslint-disable-next-line no-var
  var __agentEventAskUserQuestion: Map<string, AskUserQuestionEpisode> | undefined;
  // eslint-disable-next-line no-var
  var __agentEventRecentKeys: Map<string, number> | undefined;
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

/** compositeKey -> the open dialog the structured layer knows about (#1725). */
const promptWaiting = globalThis.__agentEventPromptWaiting ??
  (globalThis.__agentEventPromptWaiting = new Map<string, StructuredPromptWaitingState>());

/** compositeKey -> the `AskUserQuestion` call currently in flight (#1726). */
const askUserQuestion = globalThis.__agentEventAskUserQuestion ??
  (globalThis.__agentEventAskUserQuestion = new Map<string, AskUserQuestionEpisode>());

/** dedup key -> epoch ms it was first seen. See {@link isDuplicateAgentEvent}. */
const recentEventKeys = globalThis.__agentEventRecentKeys ??
  (globalThis.__agentEventRecentKeys = new Map<string, number>());

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
 * Record any structured event against an instance (Issue #1722).
 *
 * Deliberately does not touch `lastStopEventAt`: that timestamp belongs to
 * `applyAgentStopEvent`, which writes it alongside the task transition it drives
 * so the two cannot disagree.
 */
export function recordAgentEvent(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  record: AgentEventRecord
): void {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  lastAgentEvent.set(key, record);
  // Issue #1783: latch, never clear. An event without a model is the ordinary
  // case (Claude sends one on `SessionStart` alone), and reading it as "the
  // model is now unknown" would blank the display on the very next event.
  if (typeof record.model === 'string' && record.model !== '') {
    lastAgentModel.set(key, record.model.slice(0, MAX_EVENT_DETAIL_LENGTH));
  }
  applyAskUserQuestionTransition(key, record);
  if (record.event === 'session_start') {
    // The agent restarting inside a pane CommandMate never touched — `claude`
    // relaunched by hand, or a `/clear` (which emits SessionEnd then
    // SessionStart on a live session) — is a new generation just as much as a
    // new tmux session is. Recorded from the event's own timestamp, so the
    // event that opens a generation is never stale against it.
    generationStartedAt.set(key, record.at);
  }
  applyPromptWaitingTransition(key, record);
  applyAwaitingInstructionTransition(key, record);
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
 * The `prompt_waiting` half of the state machine, driven by the same events
 * (Issue #1725).
 *
 * | event                             | effect on prompt_waiting |
 * |-----------------------------------|--------------------------|
 * | `notification(permission_prompt)` | **open**, confirmed      |
 * | `notification(idle_prompt)`       | release                  |
 * | `notification(other/none)`        | unchanged                |
 * | `stop`                            | release                  |
 * | `user_prompt_submit`              | release                  |
 * | `session_start` / `session_end`   | release                  |
 * | `pre_tool_use`                    | unchanged                |
 * | `post_tool_use`                   | release                  |
 *
 * `pre_tool_use` leaves this half alone on purpose (Issue #1726). It is the
 * `AskUserQuestion` invocation, and a picker being *about to be drawn* is not
 * the kind of fact this state can carry: nothing marks the picker as answered
 * (§5.6 measured total silence through the selection and confirmation screens),
 * so an open record from this source would keep asserting `waiting` for up to
 * {@link STRUCTURED_STATE_MAX_AGE_MS} after a human answered in the terminal.
 * Whether that screen is up stays the scraper's question; what Issue #1726 adds
 * is the *content* of the question, kept in a separate record that decides no
 * status. The `PermissionRequest` `AskUserQuestion` also raises still opens a
 * provisional record here, exactly as it did in #1725 — unchanged.
 *
 * The release set is the one the spike could actually justify. `Stop` is
 * *measured*: answering an `AskUserQuestion` resumed the turn and delivered a
 * `Stop` (§5.6, received 23 → 24). `PostToolUse` — which Issue #1725's text
 * proposed — was **not** observed at all in the spike, so it is not wired up
 * here; the route does not even map it to a lifecycle event.
 * `user_prompt_submit` is release by construction: a prompt was typed at the
 * composer, so no dialog was in front of it. `session_start` / `session_end`
 * are generation changes, and a dialog does not survive one.
 *
 * `idle_prompt` releases for the same reason it maps to `ready`: the agent
 * reporting it is sitting at the composer waiting for input is the agent saying
 * nothing is in front of that composer.
 *
 * What is deliberately absent is a timer that closes it. There is no event for
 * "the human answered the dialog" — Claude emits none (§5.6) — so the other
 * half of the release rule lives in `current-output-builder`, where the scraper
 * can be asked whether the frame it saw a moment ago is still blocking.
 */
function applyPromptWaitingTransition(key: string, record: AgentEventRecord): void {
  switch (record.event) {
    case 'notification':
      if (record.detail === 'permission_prompt') {
        openPromptWaiting(key, {
          source: 'notification',
          message: record.message ?? null,
          at: record.at,
        });
      } else if (record.detail === 'idle_prompt') {
        promptWaiting.delete(key);
      }
      return;
    case 'stop':
    case 'user_prompt_submit':
    case 'session_start':
    case 'session_end':
      promptWaiting.delete(key);
      return;
    case 'post_tool_use':
      // The tool call the dialog was gating has finished, so somebody answered
      // it (Issue #1726). This is the release #1725 could not have: it had no
      // event meaning "the human answered", only `Stop` meaning "the turn
      // ended", which can be minutes later.
      promptWaiting.delete(key);
      return;
    case 'pre_tool_use':
      return;
    default:
      // exhaustive check: a new AgentEventType must decide its transition here
      record.event satisfies never;
      return;
  }
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
 * (Issue #1723).
 *
 * Hooks are fail-open by design: a timeout or a refused connection costs the
 * event and never the agent's turn (`agent-hooks-live-verification.md` §1.1).
 * A *lost* `Stop` is therefore possible, and without a bound it would leave
 * this layer asserting `running` for a session that finished — `commandmate
 * wait` would then poll until `--timeout` on a session the scraper could have
 * called done. The bound converts "forever" into "at most this long", after
 * which the scraper takes the session back.
 *
 * Deliberately generous. A single agent turn running past 30 minutes is
 * ordinary for the workloads this tool exists to babysit, and expiring a live
 * verdict mid-turn costs the whole benefit of the two-layer split. Expiry is
 * not a failure mode: it is exactly the pre-#1723 behaviour.
 */
export const STRUCTURED_STATE_MAX_AGE_MS = 30 * 60 * 1000;

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
  // A dialog belongs to the process that drew it (Issue #1725). The generation
  // bound in `getStructuredPromptWaiting` would already hide it, but leaving the
  // record behind means a later `corroborate`/`markRecorded` would mutate a
  // dead episode.
  promptWaiting.delete(key);
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
  promptWaiting.delete(key);
  askUserQuestion.delete(key);
  awaitingInstruction.delete(key);
  // Issue #1783: the session that was on this model no longer exists.
  lastAgentModel.delete(key);
  // Issue #1784: nor does the pane its footer was read from.
  capturedModelInfo.delete(key);
}

/**
 * The status this instance's structured events imply, or null when they imply
 * nothing (Issue #1723).
 *
 * Null is the answer for every session on a machine where hooks never fire,
 * which is what keeps the unconfigured environment on exactly the behaviour it
 * had before this Issue. It is also the answer when:
 *
 *  - the last event carries no verdict (`session_start`, `session_end`, a
 *    `Notification` of an unrecognised type) — see `agentEventToSessionStatus`;
 *  - the event predates the current generation, i.e. it belongs to a previous
 *    Claude process in a reused pane;
 *  - the event is older than {@link STRUCTURED_STATE_MAX_AGE_MS}.
 *
 * Whether the tmux session is alive is NOT checked here — the caller
 * (`buildCurrentOutput`) has already answered that question with the CLI tool's
 * own `isRunning()` and returned early, and asking twice would mean a second
 * tmux round-trip on the hot path for an answer it is holding.
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
  const record = lastAgentEvent.get(key);
  if (!record) return null;

  const generation = generationStartedAt.get(key);
  if (generation !== undefined && record.at < generation) return null;

  if (now - record.at >= STRUCTURED_STATE_MAX_AGE_MS) return null;

  const verdict = agentEventToSessionStatus(record.event, record.detail);
  if (verdict === null) return null;

  return { ...verdict, event: record.event, at: record.at, detail: record.detail };
}

/**
 * How long a `permission-request`-sourced record survives without
 * corroboration (Issue #1725).
 *
 * The two sources differ in kind. `Notification(permission_prompt)` fires ~6 s
 * *after* the dialog is drawn and only when one is (§5.5): its arrival is proof.
 * A no-decision `PermissionRequest` fires *before* the dialog, so it is a
 * prediction — an accurate one (D5 measured `{}` landing in the ordinary TUI
 * approval flow), but a prediction about a version of Claude, a permission mode
 * and a rule set this server does not get to see in full.
 *
 * A prediction that nothing confirms must expire, because the cost of it
 * sticking is a `wait --on-prompt agent` that exits 10 on a session with no
 * dialog in it — a worker aborted for nothing. 20 s is generous against both
 * confirmations: the `Notification` lands at ~6 s, and the scraper reads the
 * pane through a 5 s capture cache on a 5 s poll. Expiring is not a failure
 * mode; it is the pre-#1725 behaviour for a dialog neither layer ever saw.
 */
export const STRUCTURED_PROMPT_PROVISIONAL_MAX_AGE_MS = 20_000;

/** An open dialog the structured layer knows about (Issue #1725). */
export interface StructuredPromptWaitingState {
  /** Epoch ms the dialog was first reported. */
  at: number;
  /** Which signal reported it. */
  source: StructuredPromptSource;
  /** The agent's own human-facing line, or null. Display only (D3). */
  message: string | null;
  /** Tool the pre-empted permission request named, or null. */
  toolName: string | null;
  /**
   * Epoch ms something independent established that a dialog is really there:
   * a `Notification(permission_prompt)`, or the scraper reading the frame as
   * `waiting`. Null while the record is still only a prediction.
   */
  confirmedAt: number | null;
  /**
   * Whether the scraper has itself seen a blocking frame during this episode.
   *
   * This is what makes "the scraper observed the prompt disappear" a rule that
   * can be applied at all. A scraper that never saw the dialog cannot report it
   * gone — and that case is not hypothetical, it is the whole reason this Issue
   * exists — so only a layer that once said `waiting` is allowed to say
   * `not waiting` and be believed.
   */
  scraperCorroborated: boolean;
  /** Whether a prompt-history row has been written for this episode. */
  recorded: boolean;
}

/** Open, or refresh, the prompt-waiting record for one instance. */
function openPromptWaiting(
  key: string,
  input: {
    source: StructuredPromptSource;
    message: string | null;
    toolName?: string | null;
    at: number;
  },
): void {
  const existing = promptWaiting.get(key);
  const confirmed = input.source === 'notification';

  if (existing) {
    // The same dialog, reported twice: `PermissionRequest` predicted it and the
    // `Notification` then proved it. Keep the earliest `at` — that is when the
    // human was first blocked, and it is what the scraper-release grace and the
    // age bound are measured from — and take the confirmation.
    existing.message = input.message ?? existing.message;
    existing.toolName = input.toolName ?? existing.toolName;
    if (confirmed) {
      existing.source = 'notification';
      existing.confirmedAt ??= input.at;
    }
    return;
  }

  promptWaiting.set(key, {
    at: input.at,
    source: input.source,
    message: input.message
      ? input.message.slice(0, MAX_STRUCTURED_PROMPT_MESSAGE_LENGTH)
      : null,
    toolName: input.toolName ?? null,
    confirmedAt: confirmed ? input.at : null,
    scraperCorroborated: false,
    recorded: false,
  });
}

/**
 * Report that a dialog is open because the agent asked us to adjudicate one and
 * we declined to (Issue #1725, Auto-Yes v2's no-decision path).
 *
 * Provisional: see {@link STRUCTURED_PROMPT_PROVISIONAL_MAX_AGE_MS}.
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
  openPromptWaiting(buildCompositeKey(worktreeId, cliToolId, instanceId), {
    source: 'permission-request',
    message: null,
    toolName,
    at,
  });
}

/**
 * The open dialog this instance's structured events imply, or null.
 *
 * Bounded exactly like {@link getStructuredSessionState}: a record from a
 * previous generation is not this session's, and one older than
 * {@link STRUCTURED_STATE_MAX_AGE_MS} has outlived the fact it describes. An
 * unconfirmed `permission-request` record expires far sooner — see
 * {@link STRUCTURED_PROMPT_PROVISIONAL_MAX_AGE_MS}.
 *
 * The returned object is the live record, not a copy: `current-output-builder`
 * marks corroboration and the history write on it.
 *
 * @param now - Epoch ms; defaults to now
 */
export function getStructuredPromptWaiting(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  now: number = Date.now(),
): StructuredPromptWaitingState | null {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const state = promptWaiting.get(key);
  if (!state) return null;

  const generation = generationStartedAt.get(key);
  if (generation !== undefined && state.at < generation) return null;

  if (now - state.at >= STRUCTURED_STATE_MAX_AGE_MS) return null;

  if (
    state.confirmedAt === null &&
    now - state.at >= STRUCTURED_PROMPT_PROVISIONAL_MAX_AGE_MS
  ) {
    return null;
  }

  return state;
}

/**
 * Record that the scraper has seen a blocking frame while this dialog is open
 * (Issue #1725).
 *
 * Two effects, both needed: it confirms a provisional record, and it arms the
 * only release rule the scraper is entitled to apply. See
 * {@link StructuredPromptWaitingState.scraperCorroborated}.
 *
 * @param at - Epoch ms; defaults to now
 */
export function corroborateStructuredPromptWaiting(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  at: number = Date.now(),
): void {
  const state = promptWaiting.get(buildCompositeKey(worktreeId, cliToolId, instanceId));
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
  const state = promptWaiting.get(buildCompositeKey(worktreeId, cliToolId, instanceId));
  if (state) state.recorded = true;
}

/**
 * Release the prompt-waiting record — the dialog is gone (Issue #1725).
 *
 * Called from the event transitions above and from `current-output-builder`
 * when the scraper reports that the frame it corroborated has cleared.
 */
export function clearStructuredPromptWaiting(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
): void {
  promptWaiting.delete(buildCompositeKey(worktreeId, cliToolId, instanceId));
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

/** Drop every recorded event. Test seam. */
export function clearAgentStopEvents(): void {
  lastStopEventAt.clear();
  lastAgentEvent.clear();
  recentEventKeys.clear();
  generationStartedAt.clear();
  promptWaiting.clear();
  askUserQuestion.clear();
  awaitingInstruction.clear();
  // Issue #1783. CI runs with `fileParallelism: false`, so every suite in the
  // repo shares this process — a model latched by one test would otherwise be
  // read by another, in file order, and only in CI.
  lastAgentModel.clear();
  // Issue #1784: and the same for the scraped half.
  capturedModelInfo.clear();
}
