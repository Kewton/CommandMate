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
// Issue #2429: the send ledger, read directly from `chat-db` rather than from
// the `@/lib/db` barrel because that barrel does not re-export it. It is the
// SAME row `commandmate wait` asks for over
// `GET /api/worktrees/:id/messages?limit=1&unit=pairs` (see `readNewestPromptAt`
// in `cli/commands/wait.ts`), so the server and the CLI cannot disagree about
// when this instance was last handed a prompt.
import { getLastUserMessageForInstance } from '@/lib/db/chat-db';
import { observeUnclassifiedFrame } from '@/lib/detection/unclassified-frame-tracker';
import {
  getSessionStartingSince,
  observeSessionStartingFrame,
  startingStatusResult,
} from '@/lib/session/session-starting-state';
import { extractComposerText } from '@/lib/detection/composer-text';
import { matchUpstreamFault } from '@/lib/detection/upstream-faults';
import {
  detectOpenCodePaneObstruction,
  OPENCODE_SIDEBAR_RECOVERY_CHORD,
  type OpenCodePaneObstruction,
} from '@/lib/detection/opencode-pane-obstruction';
import {
  CHAT_TURN_PROGRESS_EVENT_TYPE,
  CHAT_TURN_PROGRESS_MIN_INTERVAL_MS,
  truncateChatTurnProgressBody,
  type ChatTurnProgressEvent,
} from '@/lib/realtime/types';
import { UNCLASSIFIED_PROMPT_TYPE, type ChatMessage, type UnclassifiedFrameRecord } from '@/types/models';
import { createLogger } from '@/lib/logger';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import {
  capturedLineCountIsCursor,
  getCliToolDisplayName,
  type CLIToolType,
} from '@/lib/cli-tools/types';
import { getAgentEventSource } from '@/lib/hooks/sources/registry';
import { describeAgentEventSource } from '@/lib/hooks/sources/define-source';
import { getOpencodeProbedActivity } from '@/lib/hooks/sources/opencode/subscription';
import { getLastPermissionDecision } from '@/lib/hooks/permission-decision-state';
import { getLastToolInputNormalization } from '@/lib/hooks/tool-input-normalization-state';
import {
  ensureAgentSessionContextUsage,
  getAgentSessionTelemetry,
} from '@/lib/hooks/agent-session-telemetry';
import { pendingDecisionKind } from '@/lib/hooks/pending-decision-kind';
import { ensureOpencodeSessionDiff } from '@/lib/hooks/sources/opencode/diff';
import { questionDecisionOptions } from '@/lib/hooks/structured-decision-response';
import { captureSessionOutput } from '@/lib/session/cli-session';
import {
  detectSessionStatus,
  STATUS_REASON,
  SELECTION_LIST_REASONS,
  isGeneratingStatus,
  type SessionStatus,
} from '@/lib/detection/status-detector';
import {
  getAutoYesState,
  getLastServerResponseTimestamp,
  isPollerActive,
  buildCompositeKey,
} from '@/lib/polling/auto-yes-manager';
import { getLastPolicySuppression } from '@/lib/polling/auto-yes-suppression-state';
import { getPromptDedupSkips } from '@/lib/polling/prompt-dedup-state';
import { STATUS_CAPTURE_LINES } from '@/config/status-capture-config';
import { CACHE_MAX_CAPTURE_LINES, isCaptureWindowSaturated } from '@/lib/tmux/tmux-capture-cache';
import { selectRealtimeSnippetRows } from '@/lib/realtime-snippet';
import {
  getAgentEventDropCounts,
  getAskUserQuestion,
  getLastAgentEvent,
  getLastStopEventAt,
  getPendingDecisions,
  getPublishedAgentTurn,
  getResolvedAgentModelInfo,
  getStructuredSessionState,
  markStructuredPromptRecorded,
  observeScraperCompletionEvidence,
  type AskUserQuestionEpisode,
  type StructuredPromptWaitingState,
  type StructuredSessionState,
} from '@/lib/session/agent-event-state';
import {
  resolvePromptWaiting,
  structuredWaitingReason,
} from '@/lib/session/prompt-waiting-composition';
import {
  DIALOG_PENDING_MAX_MS,
  isDeliveryExpired,
  type PublishedTurn,
} from '@/lib/session/provisional-turn';
import {
  forgetLastKnownStatus,
  getLastKnownStatus,
  isUnclassifiedFrame,
  observeStatusEvidence,
  type StatusEvidence,
} from '@/lib/session/status-evidence';
import { applyAskUserQuestion } from '@/lib/session/ask-user-question-prompt';
import { derivePromptView } from '@/lib/session/prompt-view';
import { assessPromptAnswerability } from '@/lib/polling/auto-yes-dialog-gate';
import { classifyLayerDisagreement, reportLayerDisagreement } from '@/lib/session/layer-disagreement';
import {
  buildStructuredPromptData,
  buildStructuredPromptHistoryRecord,
  hasApiAnswerableDecision,
  isAddressableDecision,
  structuredDecisionOptionsFor,
  type StructuredAskUserQuestionSummary,
  type StructuredPromptFacts,
  type StructuredPromptWaitingData,
} from '@/lib/session/structured-prompt';
import type { PromptData } from '@/types/models';
import type {
  StructuredEventsPayload,
  CurrentOutputPayload,
  SessionTargetResolution,
} from './current-output-types';

// Issue #3215: the response types live in `current-output-types`. Re-exported
// under the same names so every existing import of this module keeps resolving.
export type {
  StructuredEventsPayload,
  PendingQuestionOptionPayload,
  PendingDecisionPayload,
  StructuredSourcePayload,
  CurrentOutputPayload,
  SessionTargetResolution,
} from './current-output-types';

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
/**
 * The sentence that turns "nothing could read this frame" into "here is what is
 * on it, and here is the key that removes it" (Issue #2095).
 *
 * Empty string when there is no obstruction, so every caller can concatenate it
 * unconditionally and the #1708 wording is byte-identical on a frame that has
 * none.
 *
 * English, like the rest of {@link recordUnclassifiedFrame}'s row and unlike the
 * UI banner this pairs with. The row is read in `capture --prompts` as often as
 * in the history pane, and `commandmate` has no locale to read it in.
 */
function describePaneObstruction(obstruction?: OpenCodePaneObstruction | null): string {
  if (!obstruction) return '';
  return (
    ` Cause: opencode's sidebar is sharing rows with the transcript ` +
    `(paneObstruction=${obstruction.id}, second column reads ` +
    `${JSON.stringify(obstruction.matchedText)}), which covers the marker that ends a ` +
    `turn. Press \`${OPENCODE_SIDEBAR_RECOVERY_CHORD}\` in the pane to close it.`
  );
}

/**
 * Push a history row this module just wrote to the worktree room (Issue #2214).
 *
 * Always `'message'`: both callers INSERT a brand-new row, so nothing has been
 * delivered for it before and the client appends rather than replaces.
 *
 * Detached on purpose, and for two reasons that both matter here:
 *
 *  - the `ws-server` import stays dynamic, which is the same bargain
 *    {@link emitChatTurnProgress} strikes — this module's *other* callers (the
 *    `/current-output` route and the terminal push) must not pull the WebSocket
 *    server into their graph just by building a payload;
 *  - the row is already committed when this runs, so a socket write can never
 *    turn a written row into a failed one. The two record functions below are
 *    best-effort by contract and their callers are waiting on a payload.
 *
 * #2214 recorded a limitation here — a route bundle holding its own empty copy
 * of `ws-server`'s `rooms` under `next dev` — and added that "production runs
 * one custom-server bundle and is unaffected". **That last clause was wrong.**
 * `npm run dev` and `npm start` run the *same* custom server (`tsx server.ts`
 * vs `node dist/server/server.js`); what differs is only whether Next evaluates
 * a route handler from a dev compilation or from `.next/server`. Either way the
 * route handler's copy of this module and of `ws-server` is not the custom
 * server's, so this push was silent in production too. #2220 bridged it: the
 * `broadcastMessage` below now reaches the socket owner through
 * `lib/realtime/publisher-registry` regardless of which graph called it.
 */
function broadcastRecordedRow(worktreeId: string, message: ChatMessage): void {
  void import('@/lib/ws-server')
    .then(({ broadcastMessage }) => {
      broadcastMessage('message', { worktreeId, message });
    })
    .catch((error: unknown) => {
      logger.warn('history-row-broadcast-failed', {
        worktreeId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

function recordUnclassifiedFrame(
  db: Database.Database,
  params: {
    worktreeId: string;
    cliToolId: CLIToolType;
    instanceId: string;
    dwellMs: number;
    sessionStatus: string;
    sessionStatusReason: string;
    /** Issue #2095: the second column that explains the frame, when there is one. */
    obstruction?: OpenCodePaneObstruction | null;
  },
): void {
  const dwellSeconds = Math.round(params.dwellMs / 1000);
  const statusReason = `${params.sessionStatus}/${params.sessionStatusReason}`;
  const question =
    `Unclassified interactive frame (${statusReason}) held for ${dwellSeconds}s. ` +
    `The detection layer could not parse it, so no prompt was published and ` +
    `nothing could answer it. Inspect the raw pane with ` +
    `\`commandmate capture ${params.worktreeId} --pane\`.` +
    // Issue #2095: appended rather than substituted. Everything above is still
    // true — the frame really was unreadable — and a caller matching on the
    // #1708 wording keeps matching. What follows turns "we could not read it"
    // into "here is why, and here is the key that fixes it".
    describePaneObstruction(params.obstruction);

  const record: UnclassifiedFrameRecord = {
    type: UNCLASSIFIED_PROMPT_TYPE,
    status: 'unclassified',
    question,
    options: [],
    dwellSeconds,
    sessionStatusReason: statusReason,
  };

  try {
    const message = createMessage(db, {
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
    // `cliToolId` / `instanceId` are already the explicit values passed above —
    // `createMessage` hands back the caller's own object — so the published row
    // addresses the same instance the column does.
    broadcastRecordedRow(params.worktreeId, message);
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
    facts: StructuredPromptFacts;
  },
): void {
  const record = buildStructuredPromptHistoryRecord(params.worktreeId, params.facts);

  try {
    const message = createMessage(db, {
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
    broadcastRecordedRow(params.worktreeId, message);
  } catch (error: unknown) {
    logger.warn('structured-prompt-record-failed', {
      worktreeId: params.worktreeId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Re-exported from `@/lib/session/status-evidence`, where Issue #1926 moved it
 * so `worktree-status-helper` — the second producer, and the one that drives the
 * header chip, `BranchStatusIndicator` and `commandmate ls` — could call the
 * same derivation instead of restating it.
 *
 * Kept exported here because #1924 published it from this module and the type is
 * imported by name elsewhere; the definition is one file away, not two.
 */
export type { StatusEvidence };

/** What `detectSessionStatus()` said about this frame, as this module uses it. */
export interface ScraperVerdict {
  status: SessionStatus;
  reason: string;
  /** The agent is producing output right now. */
  thinking: boolean;
  /**
   * Whether `status` was positively confirmed (Issue #1924).
   *
   * Produced by the detector since #1927 (§8 Phase 3): an `input_prompt` frame
   * that no tool-specific idle-composer rule vouches for is `'none'` here, with
   * the same status and reason on the wire as one that was vouched for.
   *
   * NOT the negation of {@link ScraperVerdict.isUnclassifiedActive}, though it
   * was when both were introduced. Issue #2011 separated them after the rollout
   * made the two sets diverge — see `status-evidence.ts` for the two questions
   * and which consumer asks which.
   */
  evidence: StatusEvidence;
  /**
   * The frame is interactive but could not be classified (#1497 / #1708).
   *
   * `isUnclassifiedFrame(status, reason)` — the reason vocabulary, not the
   * evidence. A published CLI contract (`capture --json`, and `wait`'s
   * `ready && !isUnclassifiedActive` completion rule), so it is derived from the
   * one expression in `status-evidence.ts` at the single site that produces a
   * verdict and carried through everywhere else — two expressions for one fact
   * is how §4 D1 decision 2 says this drifts, and #2011 is what it cost.
   */
  isUnclassifiedActive: boolean;
}

export interface MergedStatusVerdict extends ScraperVerdict {
  /** True when the structured layer, not the scraper, decided `status`. */
  structuredApplied: boolean;
}

/**
 * The `AskUserQuestion` call as the degraded prompt can describe it
 * (Issue #1726).
 *
 * Only the first question, and no option numbers — see
 * {@link StructuredAskUserQuestionSummary} for why a layer that cannot see the
 * screen must not publish numbers for it.
 */
function summarizeAskUserQuestion(
  episode: AskUserQuestionEpisode | null,
): StructuredAskUserQuestionSummary | null {
  const first = episode?.spec.questions[0];
  if (!first) return null;
  return {
    question: first.question,
    labels: first.choices.map((choice) => choice.label),
    questionCount: episode!.spec.questions.length,
    // Issue #2951: a question that takes a typed answer, so the panel and the
    // phone sheet can offer an input for it.
    ...(first.custom ? { custom: true as const } : {}),
  };
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
 * ## `isUnclassifiedActive` is not this function's to move (Issue #2011)
 *
 * The flag is carried through from the scraper on every path. It answers "could
 * the detection layer read this frame?", and no amount of knowledge about the
 * TURN changes the answer for the FRAME:
 *
 *  - a static overlay left on screen after a turn (`/help`, #1497) reads as
 *    `running`/`no_recent_output` while the structured layer says `ready` — the
 *    structured layer adds nothing about the screen, and clearing the flag would
 *    take away the navigation hatch the user needs to escape;
 *  - a frame nobody can classify while the structured layer says `running` is
 *    still a frame nobody can classify. `wait`'s unclassified dwell (exit 10)
 *    is the last hatch for a screen that produces no events at all, and #1708
 *    exists because it was missing. A structured `running` does not prove a
 *    human is not needed — see the AskUserQuestion case above.
 *
 * `#1723`'s reported case — `Stop` arrives while the spinner is still painted —
 * needs no help from here: that frame reads `running`/`thinking_indicator`, which
 * is classified, so the flag was already down and `wait` completes on the
 * structured `ready` alone.
 *
 * What this function DOES move is `evidence`, and only upwards: see
 * {@link hookClosedTurn}.
 *
 * @param turn - The published turn record for this instance, or null. Read only
 *   for {@link hookClosedTurn}; `structured` remains the status authority.
 */
export function mergeStructuredStatus(
  scraper: ScraperVerdict,
  structured: StructuredSessionState | null,
  promptWaiting: StructuredPromptWaitingState | null = null,
  turn: PublishedTurn | null = null,
  lastPromptAt: number | null = null,
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
      reason: structuredWaitingReason(promptWaiting),
      thinking: false,
      // Untouched: what the scraper could read about this frame does not change
      // because the agent told us a dialog is open (Issue #1924).
      evidence: scraper.evidence,
      isUnclassifiedActive: scraper.isUnclassifiedActive,
      structuredApplied: true,
    };
  }

  if (structured === null || structured.status === 'waiting') {
    return { ...scraper, structuredApplied: false };
  }

  // Issue #2429: the structured `ready` is about a turn older than the prompt
  // this instance is currently answering, and the screen says so. See
  // {@link structuredReadyPredatesPrompt} for why that combination is the only
  // one in which the scraper wins a `running`.
  if (structuredReadyPredatesPrompt(scraper, structured, turn, lastPromptAt)) {
    return { ...scraper, structuredApplied: false };
  }

  const thinking = structured.status === 'running';
  // Issue #2011 (対応 2): the agent's own turn close IS positive evidence.
  //
  // #1927 (DR2-003) guarded this override with `scraper.evidence === 'positive'`
  // to stop a structured `ready` clearing `isUnclassifiedActive` on a frame
  // nobody could read. It over-corrected twice over. First, the conjunct made
  // the whole expression a no-op: `evidence = cond ? 'positive' : scraper.evidence`
  // where `cond` requires `scraper.evidence === 'positive'` returns
  // `scraper.evidence` on both arms, so the branch could not change a value in
  // any direction. Second, the fix it was reaching for belonged one field over —
  // the hatch is held open by {@link ScraperVerdict.isUnclassifiedActive}, which
  // is carried through below rather than re-derived, so the evidence no longer
  // has to be understated to protect it.
  //
  // What that leaves is a payload that stopped contradicting itself. A pane
  // whose `reason` reads `hook_stop` while `statusEvidence` reads `'none'` is
  // denying, in one field, the strongest positive signal this server can get: a
  // `Stop` from the agent, for a turn this server watched open. `closedAt >
  // openedAt` is what narrows it to that case — a `Stop` that arrived with no
  // turn open publishes `openedAt: null` (see `recordAgentEvent`), and a close
  // the SCREEN inferred carries one of the other {@link TurnCloseReason} values.
  // Freshness needs no bound of its own: `getStructuredSessionState` answered
  // null above once the display event passed STRUCTURED_STATE_MAX_AGE_MS.
  //
  // `scraper.status === 'running'` is deliberately NOT required. The session this
  // Issue was reported from sat at `ready`/`input_prompt` with `closedBy: 'stop'`
  // — the agent had said it was done and the frame agreed — and the old conjunct
  // is what kept publishing `'none'` for it.
  const evidence: StatusEvidence =
    structured.status === 'ready' && hookClosedTurn(turn) ? 'positive' : scraper.evidence;
  return {
    status: structured.status,
    reason: structured.reason,
    thinking,
    evidence,
    // Issue #2011: what the structured layer knows about the TURN says nothing
    // about whether this FRAME could be read. #1708's dwell and the nav hatch
    // are the last way out of a pane nothing can drive, and a `Stop` does not
    // make an unreadable pane readable — see the `/help` overlay fixture in
    // `tests/unit/lib/detection/fixtures/claude-live-2011/`.
    isUnclassifiedActive: scraper.isUnclassifiedActive,
    structuredApplied: true,
  };
}

/**
 * Whether the agent's own `Stop` closed a turn this server watched open
 * (Issue #2011, 対応 2).
 *
 * Both halves are required. `closedBy: 'stop'` rules out the five close reasons
 * that are the server's inference rather than the agent's word (`stale`,
 * `generation`, `session_end`, `scraper_evidence`, `resync_idle`), and
 * `closedAt > openedAt` rules out a `Stop` whose turn was never observed
 * opening — `recordAgentEvent` publishes `openedAt: null` for that, and a close
 * with nothing behind it is not a completion anybody watched.
 */
function hookClosedTurn(turn: PublishedTurn | null): boolean {
  if (turn === null) return false;
  const { closedBy, closedAt, openedAt } = turn;
  return closedBy === 'stop' && closedAt !== null && openedAt !== null && closedAt > openedAt;
}

/**
 * Whether a structured `ready` could be about a turn that ended before the
 * prompt now on screen (Issue #2429).
 *
 * The cheap half of {@link structuredReadyPredatesPrompt}, split out because
 * `buildPayload` asks it FIRST: it is the gate on the one database read this
 * rule needs, and a session that is not in this state must not pay for the send
 * ledger on every poll. One expression, two callers — the alternative is the
 * "two expressions for one fact" the merge's own docblock says is how this
 * layer drifts.
 *
 * Three conjuncts, and all three are about the same instant:
 *
 *  - **the screen is positively generating.** `ScraperVerdict.thinking` is
 *    `isGeneratingStatus`, i.e. `running` with `thinking_indicator` /
 *    `opencode_processing_indicator` behind it — a spinner, `✻ Thinking…` or
 *    `esc to interrupt` that a tool's own pattern matched. It is deliberately
 *    NOT `scraper.status === 'running'`: the `no_recent_output` and
 *    `unknown_frame` floors are also `running`, and neither is evidence of
 *    anything. A frame that merely stopped changing must never retire a `Stop`
 *    the agent actually sent.
 *  - **the structured layer says `ready`.** `running` and `waiting` already win
 *    on their own paths and are not in question here.
 *  - **that `ready` came from the agent's own `Stop`.**
 *    `getStructuredSessionState` publishes `ready / hook_stop` exactly when the
 *    turn record carries `closedBy: 'stop'` with a `closedAt`, so the record is
 *    read rather than the folded reason.
 *
 * `openedAt` is deliberately not required, which is what separates this from
 * {@link hookClosedTurn}. A `Stop` that arrived with no turn open publishes
 * `openedAt: null`, and for the tool this Issue was reported from that is the
 * ORDINARY shape: Command Code cannot emit `UserPromptSubmit` (its loader
 * validates the event name against a closed list) and emits no
 * `PreToolUse` / `PostToolUse` on a turn that calls no tool, so nothing ever
 * opens the turn. Requiring an `openedAt` here would exclude precisely the case
 * this rule exists for.
 */
function staleReadyCandidate(
  scraper: ScraperVerdict,
  structured: StructuredSessionState | null,
  turn: PublishedTurn | null,
): boolean {
  if (!scraper.thinking) return false;
  if (structured === null || structured.status !== 'ready') return false;
  if (turn === null) return false;
  return turn.closedBy === 'stop' && turn.closedAt !== null;
}

/**
 * Whether the structured layer's `ready` has been outlived by the newest prompt
 * this instance was handed (Issue #2429).
 *
 * ## The defect this closes
 *
 * The merge above prefers the agent's own account to the screen, and until this
 * Issue the only exception was a scraper `waiting` (#1708). That is correct for
 * every tool that can say when a turn BEGINS — claude, codex, copilot, gemini
 * and antigravity all post a turn-opening event, so a live turn replaces the
 * previous turn's `stop` before the first generating frame is ever read.
 *
 * Command Code can post neither: no `UserPromptSubmit`, and no `PreToolUse` /
 * `PostToolUse` on a turn that calls no tool. The previous turn's `ready /
 * hook_stop` therefore stays the newest structured fact for the whole of the
 * next turn, and the merge published it over a pane that was visibly generating.
 * Measured 2026-09-08 on a 19 s turn: `sessionStatus` read `ready / hook_stop`
 * from 4 s to 18 s while the status row said `esc to interrupt`. `commandmate
 * wait` reads that field — not the frame — for "is at its composer", so #1975's
 * 60 s unanswered-prompt hold was the only thing standing between a long turn
 * and a `basis=scraper_ready` completion reported before the reply existed.
 *
 * ## Why a comparison rather than a timer
 *
 * The same comparison `wait` already makes (`outstandingPrompt`), against the
 * same two server-stamped facts: the turn's `closedAt`, and the timestamp of
 * the newest user row in the chat ledger. A `Stop` that POSTDATES the newest
 * prompt is this turn's own — the agent finished, the spinner on the frame is a
 * repaint that has not settled, and the structured `ready` keeps winning. A
 * `Stop` that predates it has reported neither the start nor the end of the
 * work now on screen, and about that work it says nothing at all.
 *
 * Shortening #1975's hold would have been the other repair, and the Issue rules
 * it out for a reason worth restating here: the hold is what stops a false
 * completion during a turn nobody has reported yet, so a shorter one moves the
 * false completion earlier rather than removing it.
 *
 * @param lastPromptAt - Epoch ms of the newest prompt handed to this instance,
 *   or null when the ledger was not read or holds none. Null decides nothing:
 *   an unreadable ledger is not evidence that nothing was sent, so the
 *   structured verdict stands exactly as it did before this Issue.
 */
function structuredReadyPredatesPrompt(
  scraper: ScraperVerdict,
  structured: StructuredSessionState | null,
  turn: PublishedTurn | null,
  lastPromptAt: number | null,
): boolean {
  if (lastPromptAt === null) return false;
  if (!staleReadyCandidate(scraper, structured, turn)) return false;
  const closedAt = turn?.closedAt ?? null;
  return closedAt !== null && closedAt < lastPromptAt;
}

/**
 * When this instance was last handed a prompt, or null (Issue #2429).
 *
 * The server's half of the comparison `commandmate wait` makes over HTTP. Both
 * sides read the same row — the newest `role: 'user'` message scoped to this
 * (worktree, tool, instance) — so the field this function feeds and the notice
 * `wait` prints cannot describe different sends.
 *
 * Best effort, like {@link recordUnclassifiedFrame} and
 * {@link recordStructuredPrompt}: the caller is building a payload, and a
 * ledger that cannot be read must cost this one comparison and nothing else.
 * Null is reported rather than a guess, and null leaves the pre-#2429
 * precedence in place — an unreadable ledger is not evidence that nothing was
 * sent, which is the position `wait` takes on the same read.
 */
function readNewestPromptAt(
  db: Database.Database,
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string,
): number | null {
  try {
    const row = getLastUserMessageForInstance(db, worktreeId, cliToolId, instanceId);
    if (!row) return null;
    const at = row.timestamp instanceof Date ? row.timestamp.getTime() : NaN;
    return Number.isFinite(at) ? at : null;
  } catch (error: unknown) {
    logger.debug('newest-prompt-read-failed', {
      worktreeId,
      cliToolId,
      instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Build the current-output payload for a worktree session.
 *
 * @param db - Database instance
 * @param worktreeId - Worktree ID (assumed already validated by the caller)
 * @param cliToolId - CLI tool ID, ALREADY resolved by the caller
 * @param instanceId - Optional agent instance ID (defaults to the primary instance)
 * @param resolution - How the caller resolved that pair, when it resolved one
 *   (Issue #1884). Appended to the payload; nothing here reads it.
 */
export async function buildCurrentOutput(
  db: Database.Database,
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  resolution?: SessionTargetResolution,
): Promise<CurrentOutputPayload> {
  const payload = await buildPayload(db, worktreeId, cliToolId, instanceId);
  // Issue #2199. Fire-and-forget, and placed HERE rather than in the poller for
  // one reason: this is the function both live paths run through. The WebSocket
  // push calls it from `broadcastTerminalSnapshot` on every generating poller
  // tick, and the HTTP `/current-output` poll calls it at the same cadence when
  // the push is down — so the progress frames appear at whatever rate the
  // surface is actually being watched at, which is exactly the property the
  // terminal snapshot already has. Gated on the merged verdict (`'running'`, not
  // the tmux-session-exists `isRunning`) so an idle pane reads no transcript.
  // Issue #3179: not during a launch — there is no turn to publish yet.
  if (payload.isRunning && payload.sessionStatus === 'running' && payload.startingSince == null) {
    // Issue #2248 made this an `await`, and it buys less than it looks like: the
    // expensive half — the transcript read and the broadcast — is detached
    // inside, so what is waited for is a worktree row and a Map lookup. What it
    // buys is that the frame's outcome is logged against the tick that produced
    // it rather than whenever the event loop got round to the detached tail.
    await publishChatTurnProgress(db, worktreeId, cliToolId, instanceId);
  }
  if (!resolution) return payload;
  return {
    ...payload,
    resolvedBy: resolution.resolvedBy,
    // Explicit null rather than an absent key: `capture --json | jq '.conflict'`
    // must answer "no contradiction" rather than nothing at all, exactly as
    // `model` does.
    conflict: resolution.conflict ?? null,
  };
}

/**
 * The payload itself, with no knowledge of how its (tool, instance) pair was
 * chosen. Split from {@link buildCurrentOutput} so the resolution fields are
 * appended in one place instead of at both of the two return sites below.
 */
async function buildPayload(
  db: Database.Database,
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
): Promise<CurrentOutputPayload> {
  const resolvedInstanceId = instanceId ?? cliToolId;
  const manager = CLIToolManager.getInstance();
  const cliTool = manager.getTool(cliToolId);
  // Issue #2886: read once, independent of `isRunning`, so both return paths
  // below publish the same value the pane is (or would be) reached at.
  const sessionName = cliTool.getSessionName(worktreeId, instanceId);

  const stopEventAt = getLastStopEventAt(worktreeId, cliToolId, instanceId);
  const lastEvent = getLastAgentEvent(worktreeId, cliToolId, instanceId);
  // Issue #1924: the registry answers for every tool — a real implementation
  // when there is one, the compatibility source otherwise — so this needs no
  // null branch and never names a tool.
  const eventSource = getAgentEventSource(cliToolId);
  const now = Date.now();
  const pendingDecisions = getPendingDecisions(worktreeId, cliToolId, instanceId, now);
  // Issue #1726's episode, read once at the same `now` the decisions were read
  // at. Issue #2040 needs it up here — a question's choices are published on the
  // decision entry — and the degraded prompt below re-uses this read rather than
  // taking a second one, so the two cannot describe different instants.
  const askUserQuestion = getAskUserQuestion(worktreeId, cliToolId, instanceId, now);
  // Issue #2040, read once: #2042's context measurement is keyed on this
  // record's `at`, so reading it twice would risk keying the derived block to a
  // different instant than the one it is published beside.
  const agentSession = getAgentSessionTelemetry(worktreeId, cliToolId, instanceId);
  const structuredEvents: StructuredEventsPayload = {
    lastEventType: lastEvent?.event ?? null,
    lastEventAt: lastEvent?.at ?? null,
    lastEventDetail: lastEvent?.detail ?? null,
    // Issue #1926 published these; Issue #1930 made them a real record. Read
    // before the `isRunning` branch so both return paths carry the turn fields.
    ...getPublishedAgentTurn(worktreeId, cliToolId, instanceId, now),
    // Issue #1930. `deliveryExpired` is computed HERE and only here, because
    // this is the layer that holds both halves: the record's age, and the
    // source's declared `decisionTimeoutSeconds`. `agent-event-state` cannot
    // reach the registry — its module graph pulls in `better-sqlite3` — which
    // is why every capability arrives there as a value a caller hands over.
    pendingDecisions: pendingDecisions.map((decision) => {
      // Issue #2040. Recovered rather than stored — see `pending-decision-kind`.
      const kind = pendingDecisionKind(decision.toolName);
      return {
        id: decision.decisionId,
        at: decision.at,
        source: decision.source,
        toolName: decision.toolName,
        confirmedAt: decision.confirmedAt,
        scraperCorroborated: decision.scraperCorroborated,
        deliveryExpired: isDeliveryExpired(
          decision,
          eventSource.capabilities.decisionTimeoutSeconds,
          now
        ),
        kind,
        // Issue #2040: the agent's own list, numbered the way `respond` numbers
        // it — the same `questionDecisionOptions` the reply path resolves an
        // answer against (#2039), so what is printed here and what a number
        // means cannot come apart. Null for an approval and for a question whose
        // payload is no longer held; never a screen's numbering.
        questionOptions:
          kind === 'question' && askUserQuestion
            ? questionDecisionOptions(askUserQuestion.spec).map((option) => ({
                number: option.number,
                label: option.label,
              }))
            : null,
      };
    }),
    dedupDropped: getAgentEventDropCounts(worktreeId, cliToolId, instanceId),
    dialogPendingMaxMs: { ...DIALOG_PENDING_MAX_MS },
    promptWaitingSince: null,
    promptWaitingSource: null,
    // Issue #1902. Read here, before the `isRunning` branch, so both return
    // paths carry it.
    toolInputNormalization: getLastToolInputNormalization(worktreeId, cliToolId, instanceId),
    // Issue #1898, the same shape and for the same reason: an automatic verdict
    // this server delivered on the agent's behalf is invisible to the operator
    // otherwise. Exposure only — the dialog state is `promptWaitingSince` /
    // `isPromptWaiting`, and nothing reads this back to decide anything.
    permissionDecision: getLastPermissionDecision(worktreeId, cliToolId, instanceId),
    source: {
      cliToolId: eventSource.cliToolId,
      capabilities: eventSource.capabilities,
      // Issue #2054. Read through the source interface — `liveness(target)` —
      // rather than through opencode's subscription map, so this layer keeps
      // naming no tool: every push source answers `{ state: 'unknown' }` from
      // `definePushHookSource` at no cost, and the fold that turns that into a
      // published `kind` is the same one `worktree-status-helper` calls.
      ...describeAgentEventSource(
        eventSource,
        eventSource.liveness({ worktreeId, cliToolId, instanceId: resolvedInstanceId }),
        now
      ),
      // Issue #2054: opencode-only by construction, and read from the module
      // that owns the attach. `./opencode/diff` is imported here for the same
      // reason (#2043) — the alternative is a field that exists on the wire and
      // is filled in by nothing.
      probedActivity: getOpencodeProbedActivity({
        worktreeId,
        cliToolId,
        instanceId: resolvedInstanceId,
      }),
    },
    // Issue #2040. Read here, before the `isRunning` branch, so both return
    // paths carry the key — but the record itself is dropped when the
    // subscription closes, so a pane that is not running answers null without
    // this layer needing a rule of its own.
    session: agentSession,
    // Issue #2042. `ensure…` never awaits: it answers from the cache and starts
    // a refresh only when the session record has moved since the last one, so
    // the two HTTP round trips it needs happen once per *turn* rather than once
    // per poll and never in front of this payload. See
    // `ensureAgentSessionContextUsage` for why that trade is the right way
    // round here.
    sessionContext: ensureAgentSessionContextUsage(
      { worktreeId, cliToolId, instanceId },
      agentSession
    ),
    // Issue #2043, on exactly #2042's terms: `ensure...` answers from the store
    // and starts at most one `GET /session/:id/diff` per *turn*, never in front
    // of this payload. It answers null for every tool but opencode, so no other
    // tool's status poll grows a field or a request.
    sessionDiff: ensureOpencodeSessionDiff({ worktreeId, cliToolId, instanceId }),
  };

  const running = await cliTool.isRunning(worktreeId, instanceId);
  if (!running) {
    // Issue #1926: the latch describes a process, and this one is gone. Dropped
    // rather than aged out so the next session on this key starts with no
    // history instead of inheriting the last one's verdict.
    forgetLastKnownStatus(buildCompositeKey(worktreeId, cliToolId, instanceId));
    return {
      isRunning: false,
      // Issue #3179: `beginAgentSession` runs before the pane is created, so a
      // launch can be in progress with no tmux session yet. Read-only here —
      // there is no frame to judge a dialog on.
      startingSince: getSessionStartingSince(worktreeId, cliToolId, instanceId),
      sessionName,
      content: '',
      lineCount: 0,
      cliToolId,
      sessionStatus: 'idle',
      sessionStatusReason: 'session_not_running',
      // Issue #1926: `'positive'` is not a formality here. tmux was asked and
      // answered — the absence of the session is a fact this layer observed,
      // not a pattern that failed to match, which is the whole distinction §4 D1
      // is drawing.
      statusEvidence: 'positive',
      lastKnownStatus: null,
      lastKnownStatusAt: null,
      lastStopEventAt: stopEventAt,
      structuredEvents,
      // Issue #1785: null on a dead session, not the last model it ran. The
      // latch outlives the process that filled it (by design — see
      // getLastKnownAgentModel), so reporting it here would tell `commandmate
      // instances` that a `RUNNING no` row is on gpt-5.6. The same holds for
      // the effort, whose scraped half never expires either: dropping both is
      // the server's job, done here and in exactly one place.
      model: null,
      reasoningEffort: null,
      // Issue #1695: the real tally, not zeros — and deliberately unlike the two
      // fields above. A model latch describes a process, so on a dead session it
      // would assert something false; a skip count describes what already
      // happened, and `lastSkippedAt` dates it. Zeroing it here would erase the
      // evidence at exactly the moment an operator goes looking for it — the
      // session ended and the prompt they were waiting on was never saved.
      promptDedup: getPromptDedupSkips(worktreeId, cliToolId, instanceId),
      // Issue #1839: there is no frame to read, so there is nothing to report.
      // Unlike `promptDedup` this is not a tally of what already happened — it
      // is a claim about what is on screen right now, and a dead session has no
      // screen.
      upstreamFault: null,
      // Issue #2095: same reasoning — a session that is not running has no pane
      // to lay out in two columns.
      paneObstruction: null,
      // Issue #1879: same reasoning as `upstreamFault` — there is no input box
      // on a session that is not running, so there is nothing to report and
      // nothing the UI could act on.
      composerText: null,
      composerState: 'no_composer',
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

  // Issue #1910: saturation of the capture WINDOW is only one of the two ways
  // the cursor dies, and it is the one that never fires for the alternate-screen
  // tools — their pane is 1000 rows (claude / copilot) or 200 (opencode), so a
  // 10000-line window is never reached and the branch above stayed false
  // forever. Meanwhile the poller stores `lastCapturedLine` for them too
  // (`updateSessionState` is called unconditionally; only the DEDUP comparison
  // is gated on the tool, response-checker.ts), so after one turn the stored
  // value is the pane height, `slice()` starts past the last row, and `content`
  // — the field `commandmate capture <id>` prints — was an empty string.
  // `capturedLineCountIsCursor` states both conditions in one place.
  const lineCountIsCursor = capturedLineCountIsCursor(cliToolId, captureWindowSaturated);
  const newLines = lineCountIsCursor ? lines.slice(Math.max(0, lastCapturedLine)) : lines;
  const newContent = newLines.join('\n');

  const compositeKey = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const lastServerResponseTimestamp = getLastServerResponseTimestamp(compositeKey);
  const lastOutputTimestamp = lastServerResponseTimestamp ? new Date(lastServerResponseTimestamp) : undefined;

  const rawStatusResult = detectSessionStatus(output, cliToolId, lastOutputTimestamp);
  // Issue #3179: a launch in progress. The frame is a shell prompt and the
  // launch line, or a dialog the launch is about to answer, and none of the
  // flags below may be read off it: the floor verdict raised the Navigate pad,
  // the trust dialog raised the selection list / prompt sheet. A dialog that
  // outstays the launch's own answer releases the record (a login, an unknown
  // dialog), and from then on this is the ordinary verdict again.
  const startingSince = observeSessionStartingFrame(
    worktreeId,
    cliToolId,
    instanceId,
    rawStatusResult.status === 'waiting' || rawStatusResult.hasActivePrompt,
  );
  const statusResult = startingSince === null
    ? rawStatusResult
    : startingStatusResult(rawStatusResult);
  // Issue #1912: every `running` reason that means "the agent is producing
  // output", not just `thinking_indicator`. opencode answers
  // `opencode_processing_indicator` for its `esc interrupt` footer, which is
  // the only signal it gives between the submitted prompt and the first
  // transcript row — on a scraper-only session that stretch showed no
  // thinking indicator at all.
  const thinking = isGeneratingStatus(statusResult);
  const scraperPromptWaiting = statusResult.hasActivePrompt;
  const isSelectionListActive =
    statusResult.status === 'waiting' && SELECTION_LIST_REASONS.has(statusResult.reason);
  const isPagerActive = statusResult.reason === STATUS_REASON.CODEX_PAGER;
  // Issue #2369: an overlay whose ONLY exit is the dismiss — Command Code's
  // `/usage` panel, whose last row is `Press Esc to close`.
  //
  // A THIRD flag rather than a member of `SELECTION_LIST_REASONS`, and the
  // separation is the fix rather than a nicety: `isSelectionListActive` is what
  // the arrow pad is drawn from, and this screen has no highlight to move. Nor
  // is it `isUnclassifiedActive` any more — the detector answers `waiting` for
  // it, and `isUnclassifiedFrame` only ever says yes to `running` — which is
  // exactly what stops the chat surface offering the eighteen-button
  // hatch + answer-key card to a panel that accepts one key.
  //
  // `status === 'waiting'` is checked as well as the reason, the same shape
  // `isSelectionListActive` above uses, so a future producer that publishes the
  // token with some other status cannot silently turn the card into an Esc
  // button.
  const isDismissablePanelActive =
    statusResult.status === 'waiting'
    && statusResult.reason === STATUS_REASON.COMMAND_CODE_DISMISSABLE_PANEL;
  // Issue #1497: the detection-independent nav hatch (#1017/#1494) is gated on
  // isUnclassifiedActive. A static, unrecognized TUI overlay (e.g. Claude `/help`)
  // whose frame stops changing degrades from `running`/`default` to
  // `no_recent_output` once the Auto-Yes poller has stamped lastOutputTimestamp
  // (its sole writer, auto-yes-poller.ts). That is still an interactive-but-
  // unclassified frame — a real idle prompt (`❯`) is classified earlier as
  // `input_prompt`, never as `no_recent_output` — so treat the timed-out fallback
  // as unclassified too and keep the hatch open instead of stranding the user.
  // Issue #1924, §4 D1 decision 2: stated as evidence. Issue #1927 moved that
  // PRODUCER into the detector, because only the detector knows which rule
  // answered — `input_prompt` is positive for a tool whose idle rule vouched for
  // the frame and `'none'` for one whose rule declined, with the same status and
  // the same reason on the wire.
  const evidence: StatusEvidence = statusResult.evidence;
  // Issue #2011: the flag is NOT that fact, and deriving it from `evidence` is
  // the regression this Issue fixes. `'none'` is "I could not prove this pane is
  // idle" — an ordinary Claude composer with no completion marker above it
  // qualifies, and 7 of 8 live idle panes did on 2026-08-24. The flag's three
  // consumers all ask the older, narrower question instead: `TerminalEscapeHatch`
  // opens on a frame a human has to drive by hand, `wait` suppresses its
  // completion check and eventually exits 10 on one, and `unclassified_frames`
  // records it as a detection failure worth capturing as a fixture. That is
  // `isUnclassifiedFrame` — the reason vocabulary, not the strength of the
  // evidence behind a readable verdict.
  const isUnclassifiedActive = isUnclassifiedFrame(statusResult.status, statusResult.reason);

  // Issue #1723: the two-layer merge. Everything above this line is the string
  // analysis, unchanged and still the only source on a machine where no hook
  // ever fires — `getStructuredSessionState` answers null there, and
  // `mergeStructuredStatus` then returns the scraper's verdict untouched.
  // Issue #1930: the screen's own half of "is this turn over". Fed BEFORE the
  // structured state is read so a poll that closes the turn is the poll that
  // reports it, and fed with the SCRAPER's verdict rather than the merged one —
  // reading the merge back would be circular, since the merge is where this
  // layer's `running` overrides the frame.
  //
  // What this buys is a bound on a lost `Stop` far shorter than the 30-minute
  // staleness rule: three consecutive frames that positively read as a finished
  // composer retire the structured `running`, and the pane goes back to being
  // the scraper's to describe. What it deliberately does NOT do is complete a
  // `commandmate wait` — see SCRAPER_COMPLETION_POLLS, and #1839's measurement
  // of a 529 storm returning Claude to exactly this frame having run nothing.
  observeScraperCompletionEvidence(
    worktreeId,
    cliToolId,
    instanceId,
    statusResult.status === 'ready' && evidence === 'positive'
  );

  const structured = getStructuredSessionState(worktreeId, cliToolId, instanceId);

  // Issue #1725: the open-dialog half of the same merge, resolved before the
  // status merge because it decides one of its inputs. The rule itself — the
  // asymmetric release and the OR below — lives in `prompt-waiting-composition`
  // since Issue #1737, because the `send` guard has to reach the same verdict
  // and a second copy here is exactly how the two answers diverged.
  const promptResolution = resolvePromptWaiting({
    worktreeId,
    cliToolId,
    instanceId,
    scraper: {
      status: statusResult.status,
      reason: statusResult.reason,
      hasActivePrompt: scraperPromptWaiting,
    },
  });
  const promptWaiting = promptResolution.structured;
  if (promptWaiting !== null) {
    structuredEvents.promptWaitingSince = promptWaiting.at;
    structuredEvents.promptWaitingSource = promptWaiting.source;
  }

  const scraperVerdict: ScraperVerdict = {
    status: statusResult.status,
    reason: statusResult.reason,
    thinking,
    evidence,
    isUnclassifiedActive,
  };

  // Issue #2429: the send ledger, read ONLY when it could change the verdict.
  // `staleReadyCandidate` is the merge's own first three conjuncts, so the two
  // cannot disagree about when this read is needed — and every other poll (an
  // idle pane, a turn the agent has opened, a tool that reports its own start)
  // costs exactly what it did before this Issue, which is nothing.
  const lastPromptAt = staleReadyCandidate(scraperVerdict, structured, structuredEvents)
    ? readNewestPromptAt(db, worktreeId, cliToolId, resolvedInstanceId)
    : null;

  const merged = mergeStructuredStatus(
    scraperVerdict,
    structured,
    promptWaiting,
    // Issue #2011: the same record `structuredEvents` publishes, read once. The
    // merge needs `closedBy` / `closedAt` / `openedAt`, which
    // `StructuredSessionState` folds away into `hook_stop` — and the folded form
    // cannot tell a `Stop` that closed a watched turn from one that arrived with
    // no turn open.
    structuredEvents,
    lastPromptAt,
  );

  // The OR rule, computed once for the whole server (Issue #1737): this is the
  // same `resolvePromptWaiting` call the `send` guard makes, so the payload and
  // the guard cannot disagree about whether a prompt is open. What they are
  // still allowed to differ on is what to DO about it — see `blocksSend`, which
  // bounds the structured layer's veto over sends and leaves this flag alone.
  // Issue #3179: not while a launch is in progress. The scraper half is already
  // neutralised above; this also drops a structured wait the launch inherited.
  const isPromptWaiting = startingSince === null && promptResolution.waiting;

  // Issue #1726: the agent's own account of what it asked. It contributes only
  // where some other layer has already established that a dialog is on screen —
  // this record decides no status of its own, because Claude emits nothing at
  // all while an AskUserQuestion picker is up (§5.6) and a record that asserted
  // `waiting` from the invocation would go on asserting it long after a human
  // answered in the terminal.
  // Issue #2040 moved the read to the top of this function (the decision entries
  // publish the same episode's choices) and this line now re-uses it, so the two
  // surfaces cannot describe different instants.
  const scraperPromptData = statusResult.promptDetection.promptData;
  const correctedPromptData =
    scraperPromptData && askUserQuestion
      ? applyAskUserQuestion(scraperPromptData, askUserQuestion.spec)
      : null;

  // The degraded form, for a dialog only the structured layer can see. Enriched
  // with the question text when one is in flight — that turns "a dialog is open
  // and nobody could read it" into "a dialog is open and here is what it asks".
  //
  // Issue #1898 adds the replies the dialog accepts, for the sources that can be
  // answered without touching the pane. The gate is `eventIdentity`: a source
  // that publishes a per-decision id is a source whose approval can be answered
  // by that id, which is what makes an option NUMBER here mean something other
  // than a line on a screen nobody parsed. `source === 'notification'` narrows
  // it to a dialog the agent actually reported — a `permission-request` record
  // is a prediction, and a question is answered with a choice rather than with
  // one of these three verdicts.
  //
  // Issue #2031 adds the fourth conjunct and folds the whole gate into ONE
  // value. The three verdicts and the id they are delivered to are now derived
  // from the same expression, so they cannot be published apart — and "apart"
  // is not hypothetical, it is the state #1932 shipped: options were published
  // on the capability alone while `decisionId` was published nowhere at all, so
  // the panel drew no buttons and the only way out of an opencode approval in a
  // browser was the arrow-key safety net. Options WITHOUT an id is the worse
  // half of that pair — the numbers would reach the keystroke path, where a
  // bare "1" selects whatever the picker happens to be highlighting (#1681).
  const addressableDecisionId =
    promptWaiting !== null &&
    promptWaiting.source === 'notification' &&
    eventSource.capabilities.eventIdentity === 'permission-id' &&
    isAddressableDecision(promptWaiting.decisionId)
      ? promptWaiting.decisionId
      : null;
  // Issue #2100 splits the two halves of #2031's single expression, because an
  // addressable decision is now of two KINDS. The id is published for both — it
  // is what `POST /respond` names, and a question needs it exactly as much as an
  // approval does — but the three verdicts belong to an approval alone.
  //
  // Publishing both for a question is not a cosmetic error: it is precisely what
  // #2039's third gate refuses. `readPromptQuestionChoices` returns null the
  // moment `decisionOptions` is non-empty, so a question carrying them would
  // draw `Allow once / Allow always / Reject` over the agent's own choices, and
  // a verdict sent to a question is refused at the source
  // (`question-needs-answer-verdict`). The kind is recovered from the record the
  // same way `structuredEvents.pendingDecisions[].kind` is, through the one
  // reader in `pending-decision-kind`.
  const addressesQuestion =
    promptWaiting !== null && pendingDecisionKind(promptWaiting.toolName) === 'question';
  const decisionOptions =
    addressableDecisionId !== null && !addressesQuestion
      ? // Issue #2951: in the tool's own words (OpenCode V2: `Always allow`).
        structuredDecisionOptionsFor(cliToolId)
      : null;

  const structuredFacts: StructuredPromptFacts | null =
    promptWaiting === null
      ? null
      : {
          ...promptWaiting,
          askUserQuestion: summarizeAskUserQuestion(askUserQuestion),
          decisionOptions,
          // Explicit, though the spread above already carries a `decisionId`
          // off the record: the spread's copy is the raw one, and what may be
          // published is the GATED one. Letting the record's value through
          // would put an id on a payload whose verdicts were withheld, which is
          // the biconditional this Issue exists to hold.
          decisionId: addressableDecisionId,
          // Gated on the same value, for a reason of its own: `patterns` is
          // what the `Allow always` BUTTON grants, so publishing it where no
          // button is drawn adds a rule list to a panel that is telling the
          // user to go and answer in the terminal. Every source but opencode
          // therefore keeps the exact payload it had before this Issue, plus
          // the one `decisionId: null`.
          //
          // Issue #2100 moves the gate onto `decisionOptions` rather than the
          // id, which is the same value for every approval and the honest one
          // for a question: a question draws no `Allow always`, so it may not
          // carry the rules one would have saved. (`reportQuestionPending`
          // records `patterns: null` anyway; the two agree by construction now
          // instead of by coincidence.)
          patterns: decisionOptions !== null ? promptWaiting.patterns : null,
        };

  const promptData: PromptData | StructuredPromptWaitingData | null = startingSince !== null
    ? null
    : scraperPromptWaiting
    ? correctedPromptData ??
      scraperPromptData ??
      (structuredFacts ? buildStructuredPromptData(worktreeId, structuredFacts) : null)
    : structuredFacts
      ? buildStructuredPromptData(worktreeId, structuredFacts)
      : null;

  // Issue #2870: whether `/prompt-response` would answer the prompt published
  // above, read by the SAME function it re-verifies with. In #2868 `promptData`
  // came off the generic parser alone, the route refused it, and the UI's Send
  // did nothing. Only for a parser-read prompt: the structured form (hook
  // `decisionId`, degraded) is answered by id or not by number at all, so the
  // key is left out there, as it is when no prompt is up. `isPromptWaiting` /
  // `promptData` / `sessionStatus` are untouched — `wait`'s exit 10, Auto-Yes
  // and push notifications keep reading exactly what they read before.
  const promptAnswerable: boolean | undefined =
    scraperPromptWaiting && (correctedPromptData ?? scraperPromptData)
      ? assessPromptAnswerability(cliToolId, output).refusal === null
      : undefined;

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

  // Issue #1839 defined this window and Issue #2095 reuses it, so it is computed
  // once, here, above the first reader. The 100 rows are also what the payload
  // publishes, which is the property both fields rest on: what they claim can be
  // checked against the rows printed next to them in `capture --json`.
  // Issue #2768: still "the 100 rows this payload publishes" — but anchored to
  // the last content row when the plain tail is entirely blank (top-anchored panes).
  const realtimeSnippet = selectRealtimeSnippetRows(lines).join('\n');

  // Issue #2095: gated on the tool because the anchors are opencode's own box
  // drawing. Every other CLI's detection is untouched by construction — nothing
  // here even looks at its frame. Computed before the unclassified-frame writer
  // below because that row is where a user first meets this: the sidebar is
  // exactly the reason the frame could not be classified, and a "detection
  // failed" row that does not say so sends the reader to the raw pane to work it
  // out again.
  const paneObstruction: OpenCodePaneObstruction | null =
    cliToolId === 'opencode' ? detectOpenCodePaneObstruction(realtimeSnippet) : null;

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
  //
  // Issue #2965: not while the agent holds a decision this server can answer by
  // id (OpenCode V2 / opencode approvals and questions). The frame may still be
  // one the scraper cannot read, but "nothing could answer it" is false then,
  // and the row landed in the chat as a meaningless assistant line. Fed to the
  // tracker as "not unclassified" rather than merely not written, so the run —
  // and the 60 seconds — start afresh if the frame is still unreadable once the
  // decision is gone (answered, expired, or the source dropped).
  const answerableOverAgentApi = hasApiAnswerableDecision(
    eventSource.capabilities.eventIdentity,
    structuredEvents.pendingDecisions ?? [],
  );
  // Issue #3179: a launch in progress is not a detection failure — its frame is
  // the shell and the launch line — so no row, and the run starts afresh after.
  const unclassifiedVerdict = observeUnclassifiedFrame(
    compositeKey,
    merged.isUnclassifiedActive && !answerableOverAgentApi && startingSince === null,
  );
  if (unclassifiedVerdict.shouldRecord) {
    recordUnclassifiedFrame(db, {
      worktreeId,
      cliToolId,
      instanceId: resolvedInstanceId,
      dwellMs: unclassifiedVerdict.dwellMs,
      sessionStatus: merged.status,
      sessionStatusReason: merged.reason,
      // Issue #2095: the cause, when the frame carries one. Null leaves the row
      // exactly as #1708 wrote it.
      obstruction: paneObstruction,
    });
  }

  // Issue #2843: the opposite gap — the scraper reads a dialog on a turn the
  // agent's own `Stop` closed. Logged only (see `layer-disagreement.ts`); fed the
  // SCRAPER's verdict, because the merge lets a scraper `waiting` win and would
  // hide the very disagreement this records.
  const disagreement = classifyLayerDisagreement({
    supportedEvents: eventSource.capabilities.supportedEvents,
    scraperStatus: statusResult.status,
    scraperReason: statusResult.reason,
    hasActivePrompt: scraperPromptWaiting,
    lastEventType: structuredEvents.lastEventType,
    lastEventDetail: structuredEvents.lastEventDetail,
  });
  if (disagreement !== null) {
    reportLayerDisagreement({
      compositeKey,
      worktreeId,
      cliToolId,
      instanceId: resolvedInstanceId,
      turnId: structuredEvents.turnId,
      kind: disagreement,
      scraperReason: statusResult.reason,
      frame: output,
    });
  }

  // Issue #1725: the structured layer saw a dialog the scraper did not. That
  // gap is the fact worth keeping — see recordStructuredPrompt.
  //
  // Issue #2965: except while that dialog can be answered over the agent's API
  // — the live payload already carries its id and replies, so the row says
  // nothing true. Not marked recorded either: should the decision expire with
  // the dialog still open, the row is written then (the safe side).
  if (
    promptWaiting !== null &&
    structuredFacts !== null &&
    !scraperPromptWaiting &&
    !promptWaiting.recorded &&
    !answerableOverAgentApi
  ) {
    markStructuredPromptRecorded(worktreeId, cliToolId, instanceId);
    recordStructuredPrompt(db, {
      worktreeId,
      cliToolId,
      instanceId: resolvedInstanceId,
      state: promptWaiting,
      facts: structuredFacts,
    });
  }

  // Issue #1879: structural, and computed here next to the other frame readers
  // rather than inside a status branch — the bar it feeds must appear on the
  // strength of what is in the box, never on the strength of a status verdict.
  const composer = extractComposerText(output, cliToolId);

  // Issue #1839: judged on exactly what is published as `realtimeSnippet`, not
  // on `output`. The wider capture keeps a banner from an hour ago in scope, and
  // a fault the operator cannot see in the payload next to it is unverifiable.
  const upstreamFaultMatch = matchUpstreamFault(realtimeSnippet);
  const autoYesState = getAutoYesState(worktreeId, cliToolId, instanceId);

  // Issue #1785 + #1784: ONE resolution for both halves, not two readers.
  //
  // `getResolvedAgentModelInfo` is the reader #1784 documents as "the single
  // answer both surfaces should read", and it is already what the list API
  // publishes (`worktree-status-helper`). Reading the model off the hook latch
  // here while taking the effort from the resolver would let this payload
  // publish an effort with no model — the exact shape `buildModelByInstance`
  // calls "unreachable through the API" — on a claude session whose banner the
  // poller scraped before its first `SessionStart` hook arrived. It also folds
  // in antigravity's rule that the effort comes from the model id, which a bare
  // read of the scraped half would drop.
  const { model, effort } = getResolvedAgentModelInfo(worktreeId, cliToolId, instanceId);

  // Issue #1926, §7: fed the MERGED verdict, for the reason the unclassified
  // tracker above is — this is the verdict that gets published, so latching the
  // scraper's raw reading would make `lastKnownStatus` disagree with the
  // `sessionStatus` it sat next to one poll earlier. Observed before it is read
  // so a positive poll reports itself, which is what keeps the field from
  // looking stale on a healthy session.
  // Issue #3179: the structured layer cannot override a launch in progress
  // either — a `waiting` it inherited would put the answer sheet back.
  const published = startingSince === null
    ? merged
    : { ...merged, status: 'running' as const, reason: STATUS_REASON.STARTING, thinking: false };

  observeStatusEvidence(compositeKey, {
    status: published.status,
    reason: published.reason,
    evidence: published.evidence,
  });
  const lastKnown = getLastKnownStatus(compositeKey);

  return {
    isRunning: true,
    sessionName,
    cliToolId,
    sessionStatus: published.status,
    sessionStatusReason: published.reason,
    content: newContent,
    fullOutput: output,
    realtimeSnippet,
    lineCount: totalLines,
    lastCapturedLine,
    isComplete: isPromptWaiting,
    isGenerating: published.thinking,
    thinking: published.thinking,
    // Issue #2607: named after the tool actually running. A fixed "Claude" was
    // published for every agent, and `capture --json` readers took it at its word.
    thinkingMessage: published.thinking ? `${getCliToolDisplayName(cliToolId)} is thinking...` : null,
    isPromptWaiting,
    promptData,
    ...(promptAnswerable !== undefined ? { promptAnswerable } : {}),
    // Issue #3184: appended next to the value it is derived from, not at the end
    // — it is a reading of `promptData`, and only of it.
    promptView: derivePromptView(promptData),
    autoYes: {
      enabled: autoYesState?.enabled ?? false,
      expiresAt: autoYesState?.enabled ? autoYesState.expiresAt : null,
      stopReason: autoYesState?.stopReason,
      lastSuppression: getLastPolicySuppression(worktreeId, cliToolId, instanceId),
      // Issue #1694: undefined (so the key is absent from the JSON) unless a
      // stop pattern actually fired — the state clears it on every other path.
      stopMatchedText: autoYesState?.stopMatchedText,
    },
    isSelectionListActive,
    isPagerActive,
    isDismissablePanelActive,
    isUnclassifiedActive: startingSince === null && merged.isUnclassifiedActive,
    startingSince,
    // Issue #1926: the same fact `isUnclassifiedActive` carries, named the way
    // §4 D1 names it. Published from the merged verdict so the two cannot
    // disagree on the wire.
    statusEvidence: published.evidence,
    lastKnownStatus: lastKnown?.status ?? null,
    lastKnownStatusAt: lastKnown?.at ?? null,
    lastServerResponseTimestamp,
    serverPollerActive: isPollerActive(compositeKey),
    lastStopEventAt: stopEventAt,
    structuredEvents,
    // Issue #1785: straight from the retention layer, unparsed. See the field
    // docs on CurrentOutputPayload for why nothing is normalised on the way out.
    model,
    reasoningEffort: effort,
    // Issue #1695: appended last on purpose — every field above is a published
    // CLI contract and reordering them churns the diff for no reader's benefit.
    promptDedup: getPromptDedupSkips(worktreeId, cliToolId, instanceId),
    // Issue #1839: read from `realtimeSnippet`, the same rows an operator sees
    // in `capture --json`, so what the field claims can be checked against what
    // is printed next to it.
    upstreamFault: upstreamFaultMatch
      ? {
          id: upstreamFaultMatch.fault.id,
          matchedText: upstreamFaultMatch.matchedText,
          at: Date.now(),
        }
      : null,
    // Issue #2095: the same three keys as `upstreamFault`, read from the same
    // rows, so an operator comparing the two is comparing like with like. The
    // detector's `boxRight` / `rows` stay off the wire — they are how the rule
    // decided, not what a caller acts on, and the payload is already a published
    // contract wide enough to be hard to change.
    paneObstruction: paneObstruction
      ? {
          id: paneObstruction.id,
          matchedText: paneObstruction.matchedText,
          at: Date.now(),
        }
      : null,
    // Issue #1879: read from `output` — the RAW capture, still carrying the SGR
    // attributes `capture-pane -e` fetched. Everything else in this function
    // works on stripped text; this one deliberately does not, because dim is the
    // only thing that separates Claude's ghost suggestion from text a human
    // typed. Do not "tidy" this to read a stripped variable.
    composerText: composer.state === 'content' ? composer.text : null,
    composerState: composer.state,
  };
}

// ============================================================================
// Chat turn progress (Issue #2199)
// ============================================================================

/**
 * The instance one progress frame is about.
 *
 * `instanceId` is optional here and resolved on the way out, exactly as every
 * other function in this file treats it, so a caller cannot key the throttle on
 * `undefined` and the wire on `'claude'`.
 */
export interface ChatTurnProgressTarget {
  readonly worktreeId: string;
  readonly cliToolId: CLIToolType;
  readonly instanceId?: string;
}

/** What a tool's reader hands over. See {@link ChatTurnProgressSource}. */
export interface ChatTurnProgressDraft {
  /** The `requestId` the settled row will carry. */
  readonly turnKey: string;
  /** Markdown, as the agent wrote it. */
  readonly body: string;
  /** True when the reader could not reach the beginning of the turn. */
  readonly partial?: boolean;
}

/**
 * How the shared builder gets a body, and why it is a callback.
 *
 * The claude reader costs a 4 MiB file read and a JSONL parse, and the opencode
 * reader walks up to `MAX_OPENCODE_TURN_PARTS` parts through a Markdown
 * renderer. Neither is something to do on every poll tick and every SSE frame,
 * and passing a *value* would mean exactly that: the caller would have paid for
 * it before the throttle got a chance to say no. A callback moves the whole cost
 * behind {@link CHAT_TURN_PROGRESS_MIN_INTERVAL_MS}.
 *
 * Answering null means "nothing to show yet" — an open turn with no assistant
 * text, a session with no transcript. It is not an error and is not logged here.
 */
export type ChatTurnProgressSource = () =>
  | ChatTurnProgressDraft
  | null
  | Promise<ChatTurnProgressDraft | null>;

/** One instance's progress bookkeeping. */
interface ChatTurnProgressState {
  /** Monotonic, and never reset by a new turn — see {@link buildChatTurnProgress}. */
  version: number;
  /** When the source was last *asked*, which is what the throttle bounds. */
  askedAt: number;
  /** The last published turn key, or null before the first frame. */
  turnKey: string | null;
  /** The last published body, for the "nothing changed" check. */
  body: string | null;
  /** Issue #2248: the outcome already reported at info for this instance. */
  loggedOutcome: ChatTurnProgressOutcome | null;
  /** Issue #2248: the turn that outcome was reported for; null when unknown. */
  loggedTurnKey: string | null;
}

/** Issue #2248: what one tick of the progress publisher did. */
type ChatTurnProgressOutcome = 'published' | 'no-subscribers' | 'failed';

function newChatTurnProgressState(): ChatTurnProgressState {
  return {
    version: 0,
    askedAt: Number.NEGATIVE_INFINITY,
    turnKey: null,
    body: null,
    loggedOutcome: null,
    loggedTurnKey: null,
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __chatTurnProgressState: Map<string, ChatTurnProgressState> | undefined;
}

/**
 * On `globalThis` for the reason every shared map in this subsystem is (#1736):
 * under `next dev` the poller's bundle and the opencode subscription's bundle
 * would each get a private copy, and two producers throttling against two
 * different maps is no throttle at all.
 */
const chatTurnProgressState = (globalThis.__chatTurnProgressState ??= new Map<
  string,
  ChatTurnProgressState
>());

function chatTurnProgressKey(target: ChatTurnProgressTarget): string {
  return `${target.worktreeId}:${target.cliToolId}:${target.instanceId ?? target.cliToolId}`;
}

/** Forget every instance's progress bookkeeping. Test seam. */
export function resetChatTurnProgressState(): void {
  chatTurnProgressState.clear();
}

/**
 * Say once, at info, what happened to this instance's progress frames (Issue #2248).
 *
 * ## Why info, and why this file had none
 *
 * Every outcome here was `logger.debug`, including the two that mean the reader
 * is watching a blank space: a push that threw, and a room with no subscribers.
 * Issue #2248 was opened after a live session where the body reached the browser
 * — or did not — and the server logs could not answer which, because debug is
 * off in the builds people run. An unobservable push is a feature that can only
 * be debugged by reproducing it.
 *
 * ## Why once
 *
 * The publisher runs on EVERY poll tick of a generating session. Logging each
 * tick at info would put a line per second per agent into the operator's log and
 * make the level useless, so this collapses a run of identical ticks into its
 * first: the outcome and the turn it happened on are the identity, and a repeat
 * of the pair says nothing the first line did not.
 *
 * The consequences of that identity, both deliberate:
 *
 *  - **a new turn always logs**, because `turnKey` is part of the pair. That is
 *    the acceptance criterion — one info line per turn — and the reason
 *    `loggedTurnKey` exists at all rather than a bare boolean;
 *  - **a CHANGE of outcome always logs**, so "the subscriber left" and "it
 *    started failing" are both visible the tick they happen, without the
 *    steady state that follows repeating them.
 *
 * `no-subscribers` and `failed` carry no turn key — neither knows one; the first
 * returns before the source is asked and the second is why there is no frame —
 * so for them the pair is `(outcome, null)` and the run collapses to one line
 * until something else happens.
 */
function logChatTurnProgressOutcome(
  target: ChatTurnProgressTarget,
  outcome: ChatTurnProgressOutcome,
  turnKey: string | null,
  extra: Record<string, unknown> = {},
): void {
  const key = chatTurnProgressKey(target);
  const state = chatTurnProgressState.get(key) ?? newChatTurnProgressState();
  chatTurnProgressState.set(key, state);
  if (state.loggedOutcome === outcome && state.loggedTurnKey === turnKey) return;
  state.loggedOutcome = outcome;
  state.loggedTurnKey = turnKey;

  // Written out rather than interpolated: these strings are what an operator
  // greps the log for, and an interpolated name cannot be found in the source.
  const message =
    outcome === 'published'
      ? 'chat-turn-progress-published'
      : outcome === 'no-subscribers'
        ? 'chat-turn-progress-no-subscribers'
        : 'chat-turn-progress-failed';

  logger.info(message, {
    worktreeId: target.worktreeId,
    cliToolId: target.cliToolId,
    instanceId: target.instanceId ?? target.cliToolId,
    turnKey,
    ...extra,
  });
}

/**
 * Decide whether this instance has a new progress frame, and build it.
 *
 * The single generator both tools go through, on the same argument
 * {@link buildCurrentOutput} makes for the terminal payload: two producers of one
 * wire shape drift, and the drift is invisible because each of them is
 * individually correct. Three rules, in this order, and each of them is a way
 * this feature goes wrong if it is missing:
 *
 *  1. **Throttle.** At most one *ask* per {@link CHAT_TURN_PROGRESS_MIN_INTERVAL_MS}
 *     per instance. It gates the ask rather than the send because the source is
 *     the expensive half (see {@link ChatTurnProgressSource}); a gate on the send
 *     alone would re-read a 4 MiB transcript to discover it had not changed.
 *  2. **No-change suppression.** Same turn, same body → no frame. A reply that
 *     has stopped growing must not keep waking every subscribed browser.
 *  3. **Monotonic version**, per instance and NOT per turn. A client drops
 *     anything at or below what it has already rendered, and restarting the
 *     counter on a new turn would make the first frame of turn N+1 look stale
 *     against the last frame of turn N.
 *
 * The body is bounded by {@link truncateChatTurnProgressBody}, whose cut is
 * folded into `partial` together with the reader's own — see
 * {@link ChatTurnProgressEvent.partial} for why one flag answers both.
 *
 * Never throws: a source that throws is a turn with nothing to show, not a
 * broken poll tick.
 *
 * @param target - The instance
 * @param source - Asked only when the throttle allows it
 * @param now - Epoch ms; injected by the tests
 * @returns The frame to broadcast, or null when there is nothing new to say
 */
export async function buildChatTurnProgress(
  target: ChatTurnProgressTarget,
  source: ChatTurnProgressSource,
  now: number = Date.now(),
): Promise<ChatTurnProgressEvent | null> {
  const key = chatTurnProgressKey(target);
  const state = chatTurnProgressState.get(key) ?? newChatTurnProgressState();

  if (now - state.askedAt < CHAT_TURN_PROGRESS_MIN_INTERVAL_MS) return null;
  state.askedAt = now;
  chatTurnProgressState.set(key, state);

  let draft: ChatTurnProgressDraft | null;
  try {
    draft = await source();
  } catch {
    // The readers already promise never to throw; this is the belt for the
    // dynamic import that reaches them.
    return null;
  }
  if (!draft || draft.body.length === 0) return null;

  const bounded = truncateChatTurnProgressBody(draft.body);
  if (draft.turnKey === state.turnKey && bounded.body === state.body) return null;

  state.turnKey = draft.turnKey;
  state.body = bounded.body;
  state.version += 1;

  return {
    type: CHAT_TURN_PROGRESS_EVENT_TYPE,
    worktreeId: target.worktreeId,
    cliToolId: target.cliToolId,
    instanceId: target.instanceId ?? target.cliToolId,
    turnKey: draft.turnKey,
    body: bounded.body,
    partial: bounded.truncated || draft.partial === true,
    version: state.version,
    done: false,
  };
}

/**
 * Build a progress frame and push it to the worktree room.
 *
 * Subscribers are checked FIRST, before the throttle state is touched and long
 * before the source is asked, so a session nobody is watching costs one map
 * lookup per tick — the same bargain `broadcastTerminalSnapshot` strikes, and
 * the reason a 4 MiB transcript read does not happen for every claude session on
 * the machine.
 *
 * The `ws-server` import is dynamic so this module's *other* callers — the
 * `/current-output` route and `commandmate capture` — do not pull the WebSocket
 * server into their graph just by building a payload.
 *
 * Never throws; a failed push is a moment of staleness on a surface that has the
 * settled row coming anyway.
 *
 * @returns Whether a frame was broadcast
 */
export async function emitChatTurnProgress(
  target: ChatTurnProgressTarget,
  source: ChatTurnProgressSource,
  now: number = Date.now(),
): Promise<boolean> {
  try {
    const { broadcast, hasRoomSubscribers } = await import('@/lib/ws-server');
    if (!hasRoomSubscribers(target.worktreeId)) {
      // Issue #2248. Reported, not silent: "the body never reached the browser"
      // and "nobody was listening" look identical from a screenshot, and this is
      // the only place that can tell them apart.
      logChatTurnProgressOutcome(target, 'no-subscribers', null);
      return false;
    }

    const event = await buildChatTurnProgress(target, source, now);
    // Not logged: null is the throttle, an unchanged body, or a turn with no
    // text yet — the quiet, correct majority of ticks.
    if (!event) return false;

    broadcast(target.worktreeId, event);
    logChatTurnProgressOutcome(target, 'published', event.turnKey, {
      version: event.version,
      bodyLength: event.body.length,
      partial: event.partial,
    });
    return true;
  } catch (error) {
    logChatTurnProgressOutcome(target, 'failed', null, {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Ask the tool that has a transcript for the body of its open turn (Issue #2199).
 *
 * claude only, and that is a statement about which tools have a *pull* reader
 * rather than a list to extend by hand. opencode's body arrives on its own SSE
 * stream and is published from `sources/opencode/history` at the moment a part
 * lands — polling for it here would be a second producer of the same frames.
 * codex and antigravity have neither, and stay on the indicator (#2197 / #2198).
 *
 * The reader is imported dynamically so `sources/claude/history` — and through
 * it `fs/promises`, the session-pointer latch and `user-turn-recorder` — stays
 * out of the module graph of the `/current-output` route and of `commandmate
 * capture`, both of which reach this file for a payload and nothing else.
 *
 * ## Which half the caller waits for (Issue #2248)
 *
 * The caller awaits the CHEAP half — the worktree row and "is anybody watching"
 * — and not the expensive one. That split is what `void` was protecting in the
 * first place: the 4 MiB transcript read, the JSONL parse, the render and the
 * broadcast still run detached, so no poll tick and no WebSocket snapshot waits
 * on them.
 *
 * What awaiting the prelude buys is the reason this Issue exists: the line that
 * says whether anybody received the frame is written while the tick it belongs
 * to is still the tick in progress. Left inside the detached half it landed
 * wherever the event loop happened to get to it, next to some unrelated
 * request's output, which is not a log an operator can read backwards.
 *
 * Never throws: `emitChatTurnProgress` swallows, and so does this.
 */
async function publishChatTurnProgress(
  db: Database.Database,
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
): Promise<void> {
  if (cliToolId !== 'claude') return;
  const target: ChatTurnProgressTarget = { worktreeId, cliToolId, instanceId };
  try {
    // The slug the transcript directory is named after is a function of the
    // worktree's path, so the row is what makes the file findable at all. Read
    // before the throttle only because it is a single indexed lookup against a
    // connection this function was handed; everything expensive is behind the
    // gate.
    const { getWorktreeById } = await import('@/lib/db/worktree-db');
    const worktreePath = getWorktreeById(db, worktreeId)?.path;
    if (!worktreePath) return;

    // Issue #2248. Hoisted out of `emitChatTurnProgress` — which still makes the
    // same check for its other caller — so the answer, and the line that reports
    // it, are settled before this function returns. Costs one Map lookup on the
    // sessions nobody is watching, which is the bargain that was already being
    // struck one frame later.
    const { hasRoomSubscribers } = await import('@/lib/ws-server');
    if (!hasRoomSubscribers(worktreeId)) {
      logChatTurnProgressOutcome(target, 'no-subscribers', null);
      return;
    }

    // Detached on purpose: everything past this point is the transcript read.
    void emitChatTurnProgress(target, async () => {
      const { readClaudeTurnProgress } = await import('@/lib/hooks/sources/claude/history');
      return readClaudeTurnProgress(
        { worktreeId, cliToolId, instanceId: instanceId ?? cliToolId },
        { worktreePath },
      );
    });
  } catch (error) {
    // Issue #2248: the reader's half of the same failure — the worktree row or
    // one of the dynamic imports — on the same once-per-run gate as the push's.
    logChatTurnProgressOutcome(target, 'failed', null, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
