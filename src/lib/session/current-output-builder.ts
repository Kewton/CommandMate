/**
 * Shared builder for the "current terminal output" payload (Issue #1120).
 *
 * Extracted from the GET /api/worktrees/[id]/current-output route so the exact
 * same payload can be produced by the server-side response poller and pushed
 * over WebSocket (terminal streaming), keeping the pull (HTTP) and push (WS)
 * paths byte-for-byte consistent (DRY).
 */

import type Database from 'better-sqlite3';
import { getSessionState, createMessage } from '@/lib/db';
import { observeUnclassifiedFrame } from '@/lib/detection/unclassified-frame-tracker';
import { UNCLASSIFIED_PROMPT_TYPE, type UnclassifiedFrameRecord } from '@/types/models';
import { createLogger } from '@/lib/logger';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { captureSessionOutput } from '@/lib/session/cli-session';
import {
  detectSessionStatus,
  STATUS_REASON,
  SELECTION_LIST_REASONS,
  type SessionStatus,
} from '@/lib/detection/status-detector';
import {
  getAutoYesState,
  getLastServerResponseTimestamp,
  isPollerActive,
  buildCompositeKey,
} from '@/lib/polling/auto-yes-manager';
import {
  getLastPolicySuppression,
  type AutoYesPolicySuppression,
} from '@/lib/polling/auto-yes-suppression-state';
import { STATUS_CAPTURE_LINES } from '@/config/status-capture-config';
import { CACHE_MAX_CAPTURE_LINES, isCaptureWindowSaturated } from '@/lib/tmux/tmux-capture-cache';
import {
  clearStructuredPromptWaiting,
  corroborateStructuredPromptWaiting,
  getLastAgentEvent,
  getLastStopEventAt,
  getStructuredPromptWaiting,
  getStructuredSessionState,
  markStructuredPromptRecorded,
  type StructuredPromptWaitingState,
  type StructuredSessionState,
} from '@/lib/session/agent-event-state';
import {
  buildStructuredPromptData,
  buildStructuredPromptHistoryRecord,
  type StructuredPromptSource,
  type StructuredPromptWaitingData,
} from '@/lib/session/structured-prompt';
import { HOOK_STATUS_REASON } from '@/lib/session/status-mapping';
import type { PromptData } from '@/types/models';

/**
 * The last structured lifecycle event this instance reported (Issue #1722).
 *
 * Diagnostic, and the shape says so: one event, not a log. It exists so an
 * operator can answer "are the injected hooks reaching this server at all, and
 * for the right instance?" without reading server logs.
 *
 * It is the raw event, NOT the verdict. Since Issue #1723 the same event may
 * also have decided `sessionStatus` — `sessionStatusReason` starting with
 * `hook_` is how you tell that it did — but the two are reported separately on
 * purpose: an event arrives here even when the merge declined to act on it, and
 * that gap is the measurement the Epic is collecting.
 */
export interface StructuredEventsPayload {
  /** e.g. `stop`, `user_prompt_submit`, `notification`. */
  lastEventType: string | null;
  /** Epoch ms. */
  lastEventAt: number | null;
  /** Subtype where the event has one: `permission_prompt`, `clear`, … */
  lastEventDetail: string | null;
  /**
   * Epoch ms the structured layer first learned a dialog was open, or null when
   * it knows of none (Issue #1725).
   *
   * Diagnostic, and the one field that answers "is `isPromptWaiting` true
   * because of the screen or because of the agent?" without guessing from
   * `sessionStatusReason`. Null on a session that is not running.
   */
  promptWaitingSince: number | null;
  /** `notification` / `permission-request`, or null. See above. */
  promptWaitingSource: StructuredPromptSource | null;
}

export interface CurrentOutputPayload {
  isRunning: boolean;
  cliToolId: CLIToolType;
  sessionStatus: string;
  sessionStatusReason: string;
  content: string;
  fullOutput?: string;
  realtimeSnippet?: string;
  lineCount: number;
  lastCapturedLine?: number;
  isComplete?: boolean;
  isGenerating?: boolean;
  thinking?: boolean;
  thinkingMessage?: string | null;
  isPromptWaiting?: boolean;
  /**
   * The prompt to answer, or null.
   *
   * Since Issue #1725 this is a union: either the scraper's parsed prompt, or
   * the degraded {@link StructuredPromptWaitingData} published for a dialog only
   * the structured layer can see. Readers that answer by option number must
   * check `type` — the degraded form carries none, by construction.
   */
  promptData?: PromptData | StructuredPromptWaitingData | null;
  autoYes?: {
    enabled: boolean;
    expiresAt: number | null;
    stopReason?: string;
    /**
     * Last answer the contract's autoYes policy withheld for this session, or
     * null when it never withheld one (Issue #1684). Refreshed every poll while
     * the suppressed prompt stays on screen, so `at` being current together
     * with `isPromptWaiting` means the suppression is the reason the session is
     * waiting right now.
     */
    lastSuppression: AutoYesPolicySuppression | null;
  };
  isSelectionListActive?: boolean;
  isPagerActive?: boolean;
  isUnclassifiedActive?: boolean;
  lastServerResponseTimestamp?: number | null;
  serverPollerActive?: boolean;
  /**
   * Epoch ms of the last `POST /api/hooks/agent-event` stop event, or null when
   * the agent has no hook wired up (Issue #1549).
   *
   * Still exposed only — this timestamp itself decides nothing. Since Issue
   * #1723 the *event* behind it can drive `sessionStatus`, but through
   * `getStructuredSessionState`, which applies the generation and age bounds
   * this raw field has never had.
   */
  lastStopEventAt: number | null;
  /**
   * Last structured event of any kind, or nulls when none has arrived
   * (Issue #1722). See {@link StructuredEventsPayload}.
   */
  structuredEvents: StructuredEventsPayload;
}

const logger = createLogger('current-output-builder');

/**
 * Write the "detection failed on this frame" row (Issue #1708).
 *
 * Stored as a `prompt` message so `capture --prompts` — the audit trail that
 * exists precisely to answer "why did this stall?" — lists it alongside the
 * prompts that WERE detected. It must never read as one of them, so the
 * promptData carries `type: 'unclassified'` and `status: 'unclassified'`; the
 * latter is also what keeps it out of `markPendingPromptsAsAnswered()`, whose
 * SQL selects `status = 'pending'`. A frame nobody could read must not end up
 * stamped "(answered via terminal)" the moment the flag clears.
 *
 * Not broadcast: this is a record for after the fact, and the prompt-answering
 * UI has nothing to render for a frame with no parsed options.
 *
 * REACH, stated plainly because it is a real limit: this is driven by
 * observation, not by the server's own loops. `buildCurrentOutput` has exactly
 * two callers — the current-output route and `broadcastTerminalSnapshot`, which
 * returns immediately when the room has no subscribers. So a row is written
 * while `commandmate wait` is polling (every POLL_INTERVAL_MS), while a browser
 * has the terminal open, or on a `capture --json`. A stall that nobody is
 * watching at all writes nothing, and `capture --prompts` afterwards will not
 * show it. That is tolerable because the stalls this exists to explain are the
 * ones something WAS waiting on — but it means the Auto-Yes poller running
 * alone is not enough. Feeding the tracker from that loop would need a second
 * producer of `isUnclassifiedActive`, i.e. either duplicating its definition or
 * adding a detectSessionStatus pass to a hot path; deliberately not done here.
 *
 * Best effort — a failed insert must never break the payload the caller is
 * waiting on. The tracker has already marked the run as recorded, so a failure
 * costs this one row, not a retry storm.
 */
function recordUnclassifiedFrame(
  db: Database.Database,
  params: {
    worktreeId: string;
    cliToolId: CLIToolType;
    instanceId: string;
    dwellMs: number;
    sessionStatus: string;
    sessionStatusReason: string;
  },
): void {
  const dwellSeconds = Math.round(params.dwellMs / 1000);
  const statusReason = `${params.sessionStatus}/${params.sessionStatusReason}`;
  const question =
    `Unclassified interactive frame (${statusReason}) held for ${dwellSeconds}s. ` +
    `The detection layer could not parse it, so no prompt was published and ` +
    `nothing could answer it. Inspect the raw pane with ` +
    `\`commandmate capture ${params.worktreeId} --pane\`.`;

  const record: UnclassifiedFrameRecord = {
    type: UNCLASSIFIED_PROMPT_TYPE,
    status: 'unclassified',
    question,
    options: [],
    dwellSeconds,
    sessionStatusReason: statusReason,
  };

  try {
    createMessage(db, {
      worktreeId: params.worktreeId,
      role: 'assistant',
      content: question,
      messageType: 'prompt',
      // Not a PromptData: nothing may answer this row, which is why the record
      // type is kept out of that union (see UnclassifiedFrameRecord). The column
      // is shared, so the cast is confined to this one write.
      promptData: record as unknown as PromptData,
      timestamp: new Date(),
      cliToolId: params.cliToolId,
      instanceId: params.instanceId,
    });
    logger.info('unclassified-frame-recorded', {
      worktreeId: params.worktreeId,
      cliToolId: params.cliToolId,
      dwellSeconds,
      statusReason,
    });
  } catch (error: unknown) {
    logger.warn('unclassified-frame-record-failed', {
      worktreeId: params.worktreeId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Write the "the agent said a dialog is open and we could not read it" row
 * (Issue #1725, continuing #1708's proposal 2).
 *
 * Written once per waiting episode, and ONLY while the scraper is publishing no
 * prompt of its own. Both halves matter:
 *
 *  - once, because `buildCurrentOutput` runs on every poll and a row per poll
 *    would turn one blocked dialog into a wall of identical history;
 *  - only when the scraper is blind, because when it is not, the existing
 *    prompt writers already record that prompt with its options and its answer.
 *    A second row would double-count the audit trail `capture --prompts` prints
 *    and put a "nobody could read this" line next to the parsed prompt that
 *    proves somebody could.
 *
 * So a row here means exactly one thing, which is the thing #1708 asked to be
 * recorded: a prompt existed and the detection layer did not see it.
 *
 * Best effort, for the same reason as {@link recordUnclassifiedFrame}: the
 * caller is waiting on a payload, and a failed insert must cost this row and
 * nothing else.
 */
function recordStructuredPrompt(
  db: Database.Database,
  params: {
    worktreeId: string;
    cliToolId: CLIToolType;
    instanceId: string;
    state: StructuredPromptWaitingState;
  },
): void {
  const record = buildStructuredPromptHistoryRecord(params.worktreeId, params.state);

  try {
    createMessage(db, {
      worktreeId: params.worktreeId,
      role: 'assistant',
      content: record.question,
      summary: `structured prompt · source=${params.state.source}${
        params.state.toolName ? ` · tool=${params.state.toolName}` : ''
      }`,
      messageType: 'prompt',
      // Not a PromptData: it has no options and nothing may answer it by
      // number. The column is shared, so the cast is confined to this write —
      // the same arrangement UnclassifiedFrameRecord uses.
      promptData: record as unknown as PromptData,
      timestamp: new Date(),
      cliToolId: params.cliToolId,
      instanceId: params.instanceId,
    });
    logger.info('structured-prompt-recorded', {
      worktreeId: params.worktreeId,
      cliToolId: params.cliToolId,
      instanceId: params.instanceId,
      source: params.state.source,
      toolName: params.state.toolName,
    });
  } catch (error: unknown) {
    logger.warn('structured-prompt-record-failed', {
      worktreeId: params.worktreeId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** What `detectSessionStatus()` said about this frame, as this module uses it. */
export interface ScraperVerdict {
  status: SessionStatus;
  reason: string;
  /** The agent is producing output right now. */
  thinking: boolean;
  /** The frame is interactive but could not be classified (#1497 / #1708). */
  isUnclassifiedActive: boolean;
}

export interface MergedStatusVerdict extends ScraperVerdict {
  /** True when the structured layer, not the scraper, decided `status`. */
  structuredApplied: boolean;
}

/**
 * Prefer the agent's own account of what it is doing over the screen scrape
 * (Issue #1723).
 *
 * Pure, and exported so the whole precedence table can be tested without a tmux
 * session behind it.
 *
 * ## Why the scraper still wins in two cases
 *
 * **`waiting` on the scraper's side always wins.** A frame the detector reads
 * as a prompt, a selection list or a pager is a frame a human has to act on,
 * and this Issue deliberately does not touch `isPromptWaiting` / `promptData` /
 * `isSelectionListActive` (they are #1725's). Letting a structured `running`
 * overwrite `sessionStatus` while those three still said "answer me" would
 * publish a self-contradicting payload. It is also the empirically necessary
 * rule: the live capture found that Claude emits **no event at all** while an
 * `AskUserQuestion` selection or "Ready to submit your answers?" screen is up
 * (`agent-hooks-live-verification.md` §5.6), so the newest structured fact
 * there is the `user_prompt_submit` that opened the turn — `running` — while
 * the truth on screen is "waiting for a human". That is precisely the #1708
 * stall, and the scraper is the only layer that can see it.
 *
 * **A structured `waiting` is applied only through the prompt-waiting state**
 * (Issue #1725). #1723 recorded `Notification(permission_prompt)` and stopped
 * there, for a reason that had to be answered before it could be promoted:
 * nothing marks a permission prompt as *answered*, so a verdict read off the
 * last event alone would stick until the next `Stop` and describe a session
 * that went back to work minutes ago. `getStructuredPromptWaiting` is that
 * answer — it is released by `Stop` / `user_prompt_submit` / a generation
 * change, by the scraper reporting the frame it corroborated has cleared, and
 * by expiry. So the `waiting` promoted here is the one that survives all of
 * those, passed in explicitly; the raw `structured.status === 'waiting'` still
 * decides nothing on its own.
 *
 * ## The one flag this touches beyond `sessionStatus`
 *
 * `isUnclassifiedActive` is cleared only for the `Stop`-arrived-but-the-pane-
 * still-looks-busy case (structured `ready` over scraper `running`). That case
 * is the entire point of the Issue for `commandmate wait`, whose completion
 * check is `sessionStatus === 'ready' && isUnclassifiedActive !== true` — leave
 * the flag up and the structured `ready` buys nothing.
 *
 * Everywhere else the flag is left exactly as the scraper set it, which is not
 * timidity but two specific behaviours that must survive:
 *
 *  - a static overlay left on screen after a turn (`/help`, #1497) reads as
 *    `ready`/`no_recent_output` while the structured layer also says `ready` —
 *    the two agree, the structured layer adds nothing, and clearing the flag
 *    would take away the navigation hatch the user needs to escape;
 *  - a frame nobody can classify while the structured layer says `running` is
 *    still a frame nobody can classify. `wait`'s unclassified dwell (exit 10)
 *    is the last hatch for a screen that produces no events at all, and #1708
 *    exists because it was missing. A structured `running` does not prove a
 *    human is not needed — see the AskUserQuestion case above.
 */
export function mergeStructuredStatus(
  scraper: ScraperVerdict,
  structured: StructuredSessionState | null,
  promptWaiting: StructuredPromptWaitingState | null = null,
): MergedStatusVerdict {
  if (scraper.status === 'waiting') {
    return { ...scraper, structuredApplied: false };
  }

  // Issue #1725, the OR rule at the status level: the scraper reads this frame
  // as running or ready, and the agent has told us a dialog is in front of it.
  // Publishing `running` next to `isPromptWaiting: true` would be a payload
  // that contradicts itself, and every consumer of `sessionStatus` — the
  // sidebar dot, `deriveSessionStatus`, the worktrees API — would show a worker
  // that needs a human as one that is busy.
  if (promptWaiting !== null) {
    return {
      status: 'waiting',
      reason:
        promptWaiting.source === 'notification'
          ? HOOK_STATUS_REASON.PERMISSION_PROMPT
          : HOOK_STATUS_REASON.PERMISSION_REQUEST,
      thinking: false,
      isUnclassifiedActive: scraper.isUnclassifiedActive,
      structuredApplied: true,
    };
  }

  if (structured === null || structured.status === 'waiting') {
    return { ...scraper, structuredApplied: false };
  }

  const thinking = structured.status === 'running';
  return {
    status: structured.status,
    reason: structured.reason,
    thinking,
    isUnclassifiedActive:
      structured.status === 'ready' && scraper.status === 'running'
        ? false
        : scraper.isUnclassifiedActive,
    structuredApplied: true,
  };
}

/**
 * Build the current-output payload for a worktree session.
 *
 * @param db - Database instance
 * @param worktreeId - Worktree ID (assumed already validated by the caller)
 * @param cliToolId - CLI tool ID
 * @param instanceId - Optional agent instance ID (defaults to the primary instance)
 */
export async function buildCurrentOutput(
  db: Database.Database,
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
): Promise<CurrentOutputPayload> {
  const resolvedInstanceId = instanceId ?? cliToolId;
  const manager = CLIToolManager.getInstance();
  const cliTool = manager.getTool(cliToolId);

  const stopEventAt = getLastStopEventAt(worktreeId, cliToolId, instanceId);
  const lastEvent = getLastAgentEvent(worktreeId, cliToolId, instanceId);
  const structuredEvents: StructuredEventsPayload = {
    lastEventType: lastEvent?.event ?? null,
    lastEventAt: lastEvent?.at ?? null,
    lastEventDetail: lastEvent?.detail ?? null,
    promptWaitingSince: null,
    promptWaitingSource: null,
  };

  const running = await cliTool.isRunning(worktreeId, instanceId);
  if (!running) {
    return {
      isRunning: false,
      content: '',
      lineCount: 0,
      cliToolId,
      sessionStatus: 'idle',
      sessionStatusReason: 'session_not_running',
      lastStopEventAt: stopEventAt,
      structuredEvents,
    };
  }

  const sessionState = getSessionState(db, worktreeId, resolvedInstanceId);
  const lastCapturedLine = sessionState?.lastCapturedLine || 0;

  const output = await captureSessionOutput(worktreeId, cliToolId, STATUS_CAPTURE_LINES, instanceId);
  const lines = output.split('\n');
  const totalLines = lines.length;

  // Issue #1670: `content` is "everything the poller has not saved yet", which
  // only works while `lastCapturedLine` indexes into `lines`. Once the capture is
  // clipped by the window the cursor is stale by an unknown amount, and slicing at
  // it collapses `content` to the last row or two — which is what `commandmate
  // capture <id>` prints, so a long-lived codex session returned an empty capture.
  // The window can only have slid forward, so 0 is the sole safe clamp; the result
  // is a superset (it may repeat already-saved rows) and never drops new output.
  //
  // The effective window is the smaller of what this path asks for and what the
  // capture layer will ever fetch — captureSessionOutput() reads at most
  // CACHE_MAX_CAPTURE_LINES regardless of the request.
  const captureWindowSaturated = isCaptureWindowSaturated(
    totalLines,
    Math.min(STATUS_CAPTURE_LINES, CACHE_MAX_CAPTURE_LINES),
  );
  const newLines = captureWindowSaturated ? lines : lines.slice(Math.max(0, lastCapturedLine));
  const newContent = newLines.join('\n');

  const compositeKey = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const lastServerResponseTimestamp = getLastServerResponseTimestamp(compositeKey);
  const lastOutputTimestamp = lastServerResponseTimestamp ? new Date(lastServerResponseTimestamp) : undefined;

  const statusResult = detectSessionStatus(output, cliToolId, lastOutputTimestamp);
  const thinking = statusResult.status === 'running' && statusResult.reason === STATUS_REASON.THINKING_INDICATOR;
  const scraperPromptWaiting = statusResult.hasActivePrompt;
  const isSelectionListActive =
    statusResult.status === 'waiting' && SELECTION_LIST_REASONS.has(statusResult.reason);
  const isPagerActive = statusResult.reason === STATUS_REASON.CODEX_PAGER;
  // Issue #1497: the detection-independent nav hatch (#1017/#1494) is gated on
  // isUnclassifiedActive. A static, unrecognized TUI overlay (e.g. Claude `/help`)
  // whose frame stops changing degrades from `running`/`default` to `ready`/
  // `no_recent_output` once the Auto-Yes poller has stamped lastOutputTimestamp
  // (its sole writer, auto-yes-poller.ts). That is still an interactive-but-
  // unclassified frame — a real idle prompt (`❯`) is classified earlier as
  // `input_prompt`, never as `no_recent_output` — so treat the timed-out fallback
  // as unclassified too and keep the hatch open instead of stranding the user.
  const isUnclassifiedActive =
    (statusResult.status === 'running' && statusResult.reason === STATUS_REASON.DEFAULT) ||
    (statusResult.status === 'ready' && statusResult.reason === STATUS_REASON.NO_RECENT_OUTPUT);

  // Issue #1723: the two-layer merge. Everything above this line is the string
  // analysis, unchanged and still the only source on a machine where no hook
  // ever fires — `getStructuredSessionState` answers null there, and
  // `mergeStructuredStatus` then returns the scraper's verdict untouched.
  const structured = getStructuredSessionState(worktreeId, cliToolId, instanceId);

  // Issue #1725: the open-dialog half of the same merge, resolved before the
  // status merge because it decides one of its inputs.
  //
  // The release rule is asymmetric on purpose. The scraper is allowed to say
  // "that prompt is gone" only about a prompt it once saw, because the case
  // this whole Issue exists for is the scraper being BLIND to the dialog: if
  // "the scraper reports no prompt" released the state on its own, the
  // structured layer would be silenced in exactly the situation it was added
  // for, and the payload would go back to the #1708 stall. So a frame the
  // scraper reads as `waiting` arms the release (and confirms a provisional
  // record), and only after that does a non-waiting frame clear it.
  //
  // This is also what the push/pull timing demands. The structured fact arrives
  // over HTTP the moment the agent posts it, while the scraper reads a pane
  // through a 5 s capture cache (`CACHE_TTL_MS`), so "the event is here and the
  // scraper has not seen the dialog yet" is a state that always exists — and
  // under a rule that let the scraper's silence win, that state would be a lost
  // detection every single time.
  let promptWaiting = getStructuredPromptWaiting(worktreeId, cliToolId, instanceId);
  if (promptWaiting !== null) {
    if (statusResult.status === 'waiting') {
      corroborateStructuredPromptWaiting(worktreeId, cliToolId, instanceId);
    } else if (promptWaiting.scraperCorroborated) {
      clearStructuredPromptWaiting(worktreeId, cliToolId, instanceId);
      promptWaiting = null;
    }
  }
  if (promptWaiting !== null) {
    structuredEvents.promptWaitingSince = promptWaiting.at;
    structuredEvents.promptWaitingSource = promptWaiting.source;
  }

  const merged = mergeStructuredStatus(
    { status: statusResult.status, reason: statusResult.reason, thinking, isUnclassifiedActive },
    structured,
    promptWaiting,
  );

  // The OR rule, stated once: either layer seeing a prompt is a prompt. Neither
  // false may cancel the other's true — the structured layer is blind to the
  // AskUserQuestion screens (#1721 §5.6) and the scraper is blind to whatever
  // the next Claude release renders differently, and the whole point of running
  // two layers is that a gap in one is covered by the other.
  const isPromptWaiting = scraperPromptWaiting || promptWaiting !== null;
  const promptData: PromptData | StructuredPromptWaitingData | null = scraperPromptWaiting
    ? statusResult.promptDetection.promptData ??
      (promptWaiting ? buildStructuredPromptData(worktreeId, promptWaiting) : null)
    : promptWaiting
      ? buildStructuredPromptData(worktreeId, promptWaiting)
      : null;

  // Issue #1723 §3: the field data this Epic is being built on. Every line is
  // one poll where the screen and the agent disagreed about what the agent was
  // doing, which is the only way to answer "how wrong was the scraper?" with a
  // number instead of an anecdote. Emitted only on disagreement — a session
  // where the two layers agree is silent — and including the disagreements this
  // merge deliberately does NOT act on (`applied: false`), because those are
  // exactly the cases the next Issues in the Epic have to decide about.
  if (structured !== null && structured.status !== statusResult.status) {
    logger.info('detection-divergence', {
      worktreeId,
      cliToolId,
      instanceId: resolvedInstanceId,
      scraperStatus: statusResult.status,
      scraperReason: statusResult.reason,
      structuredStatus: structured.status,
      structuredReason: structured.reason,
      structuredEvent: structured.event,
      structuredEventAt: structured.at,
      applied: merged.structuredApplied,
    });
  }

  // Issue #1708: a frame nothing could classify left no trace anywhere. Both
  // prompt-history writers (response-checker's pending row and
  // recordAnsweredPrompt) are gated on `promptDetection.isPrompt === true`, so
  // the only evidence a worker had stalled was the live pane — and `capture
  // --prompts` answered "No prompt history." for a session that had been stuck
  // for 900s. Record the failure itself, once, after it has persisted.
  //
  // Recorded here because this is the one place the flag is computed, and both
  // the HTTP pull and the WebSocket push run through it, so the row appears at
  // whatever cadence the session is actually being watched at.
  //
  // Fed the MERGED flag (#1723): a frame the structured layer classified is not
  // an unclassified frame, and writing a "detection failed" row for a turn the
  // agent itself told us had ended would put a false stall into the audit trail
  // `capture --prompts` prints.
  const unclassifiedVerdict = observeUnclassifiedFrame(compositeKey, merged.isUnclassifiedActive);
  if (unclassifiedVerdict.shouldRecord) {
    recordUnclassifiedFrame(db, {
      worktreeId,
      cliToolId,
      instanceId: resolvedInstanceId,
      dwellMs: unclassifiedVerdict.dwellMs,
      sessionStatus: merged.status,
      sessionStatusReason: merged.reason,
    });
  }

  // Issue #1725: the structured layer saw a dialog the scraper did not. That
  // gap is the fact worth keeping — see recordStructuredPrompt.
  if (promptWaiting !== null && !scraperPromptWaiting && !promptWaiting.recorded) {
    markStructuredPromptRecorded(worktreeId, cliToolId, instanceId);
    recordStructuredPrompt(db, {
      worktreeId,
      cliToolId,
      instanceId: resolvedInstanceId,
      state: promptWaiting,
    });
  }

  const realtimeSnippet = lines.slice(-100).join('\n');
  const autoYesState = getAutoYesState(worktreeId, cliToolId, instanceId);

  return {
    isRunning: true,
    cliToolId,
    sessionStatus: merged.status,
    sessionStatusReason: merged.reason,
    content: newContent,
    fullOutput: output,
    realtimeSnippet,
    lineCount: totalLines,
    lastCapturedLine,
    isComplete: isPromptWaiting,
    isGenerating: merged.thinking,
    thinking: merged.thinking,
    thinkingMessage: merged.thinking ? 'Claude is thinking...' : null,
    isPromptWaiting,
    promptData,
    autoYes: {
      enabled: autoYesState?.enabled ?? false,
      expiresAt: autoYesState?.enabled ? autoYesState.expiresAt : null,
      stopReason: autoYesState?.stopReason,
      lastSuppression: getLastPolicySuppression(worktreeId, cliToolId, instanceId),
    },
    isSelectionListActive,
    isPagerActive,
    isUnclassifiedActive: merged.isUnclassifiedActive,
    lastServerResponseTimestamp,
    serverPollerActive: isPollerActive(compositeKey),
    lastStopEventAt: stopEventAt,
    structuredEvents,
  };
}
