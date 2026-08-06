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
import type { AgentEventType } from '@/lib/hooks/agent-event-types';
import { agentEventToSessionStatus, type StructuredStatusVerdict } from '@/lib/session/status-mapping';
import {
  MAX_STRUCTURED_PROMPT_MESSAGE_LENGTH,
  type StructuredPromptSource,
} from '@/lib/session/structured-prompt';

/** compositeKey -> epoch ms of the most recent stop event. */
const lastStopEventAt = new Map<string, number>();

/** compositeKey -> the most recent event of any kind. */
const lastAgentEvent = new Map<string, AgentEventRecord>();

/** compositeKey -> epoch ms the current generation began. See {@link beginAgentEventGeneration}. */
const generationStartedAt = new Map<string, number>();

/** compositeKey -> the open dialog the structured layer knows about (#1725). */
const promptWaiting = new Map<string, StructuredPromptWaitingState>();

/** dedup key -> epoch ms it was first seen. See {@link isDuplicateAgentEvent}. */
const recentEventKeys = new Map<string, number>();

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
  if (record.event === 'session_start') {
    // The agent restarting inside a pane CommandMate never touched — `claude`
    // relaunched by hand, or a `/clear` (which emits SessionEnd then
    // SessionStart on a live session) — is a new generation just as much as a
    // new tmux session is. Recorded from the event's own timestamp, so the
    // event that opens a generation is never stale against it.
    generationStartedAt.set(key, record.at);
  }
  applyPromptWaitingTransition(key, record);
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
 * @param at - Epoch ms; defaults to now
 */
export function isDuplicateAgentEvent(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  event: AgentEventType,
  sessionId: string | null | undefined,
  at: number = Date.now()
): boolean {
  if (!sessionId) return false;

  const key = [buildCompositeKey(worktreeId, cliToolId, instanceId), event, sessionId].join(' ');
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
}
