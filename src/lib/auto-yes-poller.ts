/**
 * Auto-Yes Poller - Server-side polling for auto-yes prompt responses.
 *
 * Extracted from auto-yes-manager.ts (Issue #479) to separate polling logic
 * from state management.
 *
 * Issue #525: Composite key migration (worktreeId:cliToolId) for per-agent auto-yes.
 *
 * Dependencies: auto-yes-state.ts (composite keys / state), polling/* (prompt
 * detection, resolver, policy, dialog gate, session epoch, poller state,
 * decision record), cli-tools/*, session/cli-session.ts, tmux/*, detection/*,
 * db/*, tasks/*.
 *
 * Issue #3821: this poller (with the hook / API adjudication) is what answers
 * automatically. The browser no longer answers, and the Enter sent to a choice
 * screen CommandMate could not read (#3397) is gone: such a screen is left to a
 * human, recorded as `unclassified-frame`.
 */

import type { CLIToolType } from './cli-tools/types';
import { getSessionPresence } from './session/cli-session';
import { detectPromptOnCleanFrame } from './polling/response-checker';
import {
  beginAntigravityFrameRead,
  endAntigravityFrameRead,
  getAntigravityAcceptedReceiptCallId,
} from './polling/antigravity-receipt-episodes';
import { invalidateSessionAutoYesPolicy } from './polling/auto-yes-policy';
import { normalizeFrame } from './detection/tools/frame';
import { detectAntigravityNumberedDialogPrompt } from './detection/tools/antigravity/dialog';
import {
  clearEnterFallbacks,
  forgetEnterFallback,
  forgetEnterFallbacksByWorktree,
  getEnterFallbackSessionEpoch,
} from './polling/auto-yes-enter-fallback';
import {
  clearAutoYesDecisions,
  forgetAutoYesDecision,
  forgetAutoYesDecisionsByWorktree,
  reaffirmAutoYesAnswering,
  recordAutoYesDecision,
} from './polling/auto-yes-decision-state';
import {
  ANSWERED_BY_HUMAN_DECISION_REASON,
  getManualAnswerSeq,
  isManualAnswerHolding,
} from './polling/auto-yes-manual-answer';
import { getLastPolicySuppression } from './polling/auto-yes-suppression-state';
import { NO_AUTO_ANSWER_DECISION_REASON, type AutoYesDecisionReason } from '@/types/auto-yes-decision';
import { applyEventToActiveTask } from './tasks/task-transition-service';
import { getDbInstance } from './db/db-instance';
import { recordAnsweredPrompt, type RecordAnsweredPromptResult } from './db/chat-db';
import { checkWorktreeSessionOwnership } from './cli-tools/worktree-session-ownership';
import { sendPromptAnswer } from './prompt-answer-sender';
import { onTmuxSessionCreated } from './tmux/session-created-signal';
import { CLIToolManager } from './cli-tools/manager';
import { detectThinking } from './detection/cli-patterns';
import { generatePromptKey } from './detection/prompt-key';
import type { PromptDetectionResult } from './detection/types';
import type { PromptData } from '@/types/models';
import type { CaptureTop } from '@/types/prompt-reading';
import { getErrorMessage } from './errors';
import { invalidateCache } from './tmux/tmux-capture-cache';
import { promptWaitingReading, readWaitingScreen, type ScreenReading } from './detection/waiting-screen-reading';
import { detectSessionStatus } from './detection/status-detector';
import { isApiAnswerableStructuredWait, peekPromptWaiting } from './session/prompt-waiting-composition';
import { getAgentEventSource } from './hooks/sources/registry';
import {
  captureObservedFrame,
  observeWaiting,
  startWaitingObservation,
  type CapturedFrameTime,
  type ObservationStart,
} from './session/waiting-episode-binding';
import { getEpisodeVersion, getWaitingEpisodeRecord } from './session/waiting-episode-state';
import {
  THINKING_POLLING_INTERVAL_MS,
  REDUCED_CAPTURE_LINES,
  FULL_CAPTURE_LINES,
  AUTO_STOP_ERROR_THRESHOLD,
  type AutoYesPollerStopReason,
} from '@/config/auto-yes-config';
import { resolvePollerStopReason, withPollerStopReason } from './polling/auto-yes-poller-stop-reason';
import { createLogger } from '@/lib/logger';

const logger = createLogger('auto-yes-poller');
import { isValidWorktreeId } from './security/path-validator';
import {
  buildCompositeKey,
  extractWorktreeId,
  extractCliToolId,
  extractInstanceId,
  filterCompositeKeysByWorktree,
  getAutoYesState,
  disableAutoYes,
  checkStopCondition,
  calculateBackoffInterval,
  POLLING_INTERVAL_MS,
  COOLDOWN_INTERVAL_MS,
  MAX_BACKOFF_MS,
  MAX_CONCURRENT_POLLERS,
  THINKING_CHECK_LINE_COUNT,
  isAutoYesShutdownStarted,
} from './auto-yes-state';
import { getOrInitGlobal } from './global-state';
import {
  beginSendAttempt,
  clearPartialAnswers,
  forgetPartialAnswer,
  forgetPartialAnswersByWorktree,
  ledgerScreenKey,
  partialAnswerScreenKey,
  promptFrameKey,
  settleSendAttempt,
  type AutoYesPollerState,
  type AutoYesSendAttempt,
} from './polling/auto-yes-poller-state';
import {
  suppressAntigravityTrustScreen,
  suppressIfNotOursToAnswer,
  suppressUnclassifiedFrame,
  truncateForLog,
  type JudgedPrompt,
} from './polling/auto-yes-prompt-suppression';

export type { AutoYesPollerState } from './polling/auto-yes-poller-state';
import {
  autoYesPollerStates,
  getPollerState,
  isDuplicatePrompt,
  isDuplicateRetryOf,
  isPollerCurrent,
  isSameSession,
  isTickCurrent,
  ownedPollerState,
  releaseDuplicateRetry,
  reserveDuplicateRetry,
  resetErrorCount,
  updateLastServerResponseTimestamp,
  type AutoYesTickGeneration,
} from './polling/auto-yes-poller-generation';
import {
  logIfWithheldForWantOfReceipt,
  noteAnswerSent,
  receiptEpisodeOfSend,
  withheldNoReceiptLoggedAt,
} from './polling/auto-yes-poller-receipt-log';
import { syncEnterFallbackEpoch } from './polling/auto-yes-poller-enter-fallback';
import { capturePollerFrame } from './polling/auto-yes-poller-capture';
import {
  captureTopOf as captureTopOfWindow,
  promptDataForStorage,
  withCaptureTopCompleteness,
} from './polling/prompt-screen-reading';
import {
  beginLedgerAttempt,
  beginLedgerTick,
  endLedgerTick,
  noteLedgerPollerStopped,
  noteLedgerWorktreeStopped,
  observeLedgerScreen,
  settleLedgerAttempt,
  withholdLedgerConfirmation,
  type LedgerScope,
} from './polling/auto-yes-confirmation-ledger';
import type { AnswerBasis, AttemptResult } from './polling/auto-yes-confirmation-ledger-types';
import {
  answerModeOfTick,
  resolveAnswerUnderPolicy,
  skippedForUnownedSession,
  withheldAsQuestion,
  withheldAtSend,
  withheldForEarlierSend,
} from './polling/auto-yes-poller-steps';

// Issue #3783: split out; re-exported so existing importers are unchanged.
export {
  getActivePollerCount,
  getLastServerResponseTimestamp,
  isPollerActive,
  type AutoYesTickGeneration,
} from './polling/auto-yes-poller-generation';
export { noHookReceiptHint } from './polling/auto-yes-poller-receipt-log';
export { AUTO_YES_ENTER_FALLBACK_ANSWER } from './polling/auto-yes-poller-enter-fallback';
export {
  captureAndCleanOutput,
  capturePollerFrame,
  type CapturedPollerFrame,
} from './polling/auto-yes-poller-capture';

// =============================================================================
// Poller Types
// =============================================================================

/** Result of starting a poller */
export interface StartPollingResult {
  /** Whether the poller was started */
  started: boolean;
  /** Reason if not started */
  reason?: string;
}

/**
 * Clear all poller states.
 * Stops all active pollers before clearing state.
 * @internal Exported for testing purposes only.
 */
export function clearAllPollerStates(): void {
  // Issue #3730: a test seam, not a shutdown — logged as such.
  withPollerStopReason('reset', () => stopAllAutoYesPolling());
  autoYesPollerStates.clear();
  withheldNoReceiptLoggedAt.clear();
}

/**
 * Increment error count and apply backoff if the threshold is exceeded.
 * [IA-MF-001] compositeKey-based: extracts worktreeId/cliToolId for disableAutoYes.
 *
 * @param compositeKey - Composite key
 * @param owner - The tick's own poller state (Issue #3706); see {@link ownedPollerState}
 */
function incrementErrorCount(compositeKey: string, owner?: AutoYesPollerState): void {
  const pollerState = ownedPollerState(compositeKey, owner);
  if (pollerState) {
    pollerState.consecutiveErrors++;
    pollerState.currentInterval = calculateBackoffInterval(pollerState.consecutiveErrors);
    // Issue #3791 (review N1): a failed tick held nothing back with the duplicate guard.
    releaseDuplicateRetry(pollerState);

    // Issue #499 Item 5: Auto-stop after consecutive error threshold.
    //
    // Issue #3184: this is the `consecutive-errors` row of AUTO_YES_LIFECYCLE
    // (`lib/auto-yes-lifecycle`) — disable with `consecutive_errors`, stop the
    // poller — applied here directly rather than through `releaseAutoYes`:
    // that module reaches this one through the auto-yes-manager barrel, so
    // importing it back would be a cycle. `auto-yes-lifecycle-3184.test.ts`
    // holds this call and the table row equal. A missing session never gets
    // here (Issue #3329): `pollAutoYes` waits for it instead of counting it.
    if (pollerState.consecutiveErrors >= AUTO_STOP_ERROR_THRESHOLD) {
      const worktreeId = extractWorktreeId(compositeKey);
      const cliToolId = extractCliToolId(compositeKey);
      if (cliToolId) {
        // Issue #896: target the specific instance state (3-part keys carry instanceId).
        disableAutoYes(worktreeId, cliToolId, 'consecutive_errors', extractInstanceId(compositeKey) ?? undefined);
      }
      stopAutoYesPolling(compositeKey, 'consecutive-errors');
    }
  }
}

/**
 * End a tick that found its generation gone (Issue #3706). It changes nothing;
 * it re-arms its timer only when its own poller is still the current one — a
 * renewed grant or a relaunched session under the same poller — so the chain
 * goes on and the next tick starts from the new state.
 */
function endStaleTick(generation: AutoYesTickGeneration): void {
  logger.debug('poller:auto-yes-tick-superseded', {
    worktreeId: generation.worktreeId,
    cliToolId: generation.cliToolId,
    instanceId: generation.instanceId,
    pollerCurrent: isPollerCurrent(generation),
  });
  if (isPollerCurrent(generation)) scheduleNextPoll(generation);
}

// =============================================================================
// Extracted Functions for pollAutoYes (Issue #323: SRP decomposition)
// =============================================================================

/**
 * Validate that polling context is still valid.
 * Checks pollerState existence and auto-yes enabled state.
 *
 * Issue #525: Changed from (worktreeId, pollerState) to (compositeKey, pollerState).
 *
 * @internal Exported for testing purposes only.
 * @param compositeKey - Composite key (worktreeId:cliToolId)
 * @param pollerState - Current poller state (or undefined if not found)
 * @returns 'valid' | 'stopped' | 'expired'
 */
export function validatePollingContext(
  compositeKey: string,
  pollerState: AutoYesPollerState | undefined
): 'valid' | 'stopped' | 'expired' {
  if (!pollerState) return 'stopped';

  const worktreeId = extractWorktreeId(compositeKey);
  const cliToolId = extractCliToolId(compositeKey);
  if (!cliToolId) {
    stopAutoYesPolling(compositeKey, 'invalid-key');
    return 'expired';
  }

  // Issue #896: resolve instanceId so per-instance enabled state is checked.
  const instanceId = extractInstanceId(compositeKey) ?? undefined;
  const autoYesState = getAutoYesState(worktreeId, cliToolId, instanceId);
  if (!autoYesState?.enabled) {
    // Issue #3730: the return value says 'expired' for every one of these (its
    // callers only need "stop"), but the log says which it was — the getter
    // has just turned a past deadline into `stopReason: 'expired'`, and
    // anything else is a grant some other path disabled or removed.
    stopAutoYesPolling(compositeKey, autoYesState?.stopReason === 'expired' ? 'expired' : 'not-enabled');
    return 'expired';
  }

  return 'valid';
}

/**
 * Process stop condition check using delta-based approach.
 *
 * Issue #525: Changed from (worktreeId, ...) to (compositeKey, ...).
 *
 * @internal Exported for testing purposes only.
 * @param compositeKey - Composite key (worktreeId:cliToolId)
 * @param pollerState - Current poller state (mutated: stopCheckBaselineLength updated)
 * @param cleanOutput - ANSI-stripped terminal output
 * @returns true if stop condition matched and auto-yes was disabled
 */
export function processStopConditionDelta(
  compositeKey: string,
  pollerState: AutoYesPollerState,
  cleanOutput: string
): boolean {
  if (pollerState.stopCheckBaselineLength < 0) {
    pollerState.stopCheckBaselineLength = cleanOutput.length;
    return false;
  }

  const baseline = pollerState.stopCheckBaselineLength;
  if (cleanOutput.length > baseline) {
    const newContent = cleanOutput.substring(baseline);
    pollerState.stopCheckBaselineLength = cleanOutput.length;
    return checkStopCondition(compositeKey, newContent, (key) => stopAutoYesPolling(key, 'stop-pattern'));
  } else if (cleanOutput.length < baseline) {
    pollerState.stopCheckBaselineLength = cleanOutput.length;
  }

  return false;
}

/**
 * Issue #3214: steps 6 and 7 of `detectAndRespondToPrompt` and everything after
 * them -- what is done once the answer has reached tmux, in the order it always
 * ran. Awaited inside that function's `try`, so a throw here still ends the
 * tick as `error`.
 *
 * @param promptDetection - The detection `prompt.promptData` was read from; its
 *   content becomes the audit row's
 * @param answer - The answer that was sent
 * @param generation - The tick's generation (Issue #3706). The keys are out, so
 *   the task event and the audit row are always written: they record what the
 *   agent actually received. What belongs to the poller is written to the
 *   tick's own poller state only, never to a successor under the same key, and
 *   the response poller restart and the terminal push are skipped when the
 *   session was relaunched meanwhile.
 * @param capture - Issue #3881 (review P2-2): the tick's frame and its capture
 *   window, so an audit row this answer creates carries the same reading the
 *   response poller's save gives a row (`promptDataForStorage`)
 */
async function finishAnsweredPrompt(
  prompt: JudgedPrompt,
  promptDetection: PromptDetectionResult,
  answer: string,
  generation?: AutoYesTickGeneration,
  capture?: { frame: ReturnType<typeof normalizeFrame>; captureTop: CaptureTop | undefined },
): Promise<void> {
  const { worktreeId, cliToolId, instanceId, compositeKey, pollerState, promptData, promptKey } =
    prompt;

  // Issue #3706: the keys went to the session the tick started on. When a new
  // one was begun while they were being sent, the new process never received
  // this answer, so nothing that stands for "this instance's prompt was just
  // answered" is written: not the dedup key (it would keep Auto-Yes off the new
  // process's identical question), not the poller's response time, not the
  // task event (the task looked up now may be the new session's). Only the
  // audit row is, and it may not adopt a pending row saved after the tick began.
  const sameSession = generation === undefined || isSameSession(generation);

  if (sameSession) {
    // 6. Update timestamp and reset error count
    updateLastServerResponseTimestamp(compositeKey, Date.now(), generation?.pollerState);
    resetErrorCount(compositeKey, generation?.pollerState);

    // 7. Record answered prompt key and timestamp
    pollerState.lastAnsweredPromptKey = promptKey;
    pollerState.lastAnsweredAt = Date.now();
    pollerState.lastSkipWarnKey = null;
  }

  // Issue #3748: what was answered and with what — the question (cut to
  // MAX_LOGGED_QUESTION_LENGTH, never the full text) and the answer sent (the
  // option number or `y`) — so an answer that should not have been
  // given can be told from the log alone.
  logger.info('poller:response-sent', {
    worktreeId,
    cliToolId,
    instanceId,
    sameSession,
    promptType: promptData.type,
    question: truncateForLog(promptData.question),
    answer,
  });

  // Issue #1548: the prompt was answered without a human. Raised only after
  // the keys actually reached tmux, so a send that threw is not logged as an
  // answer. No-ops when this instance is not running a contract.
  if (sameSession) {
    applyEventToActiveTask(
      getDbInstance(),
      worktreeId,
      cliToolId,
      // Undefined means the primary instance, which the task lookup identifies
      // by the tool id itself (see getActiveTaskForInstance).
      instanceId ?? cliToolId,
      'prompt_answered_auto',
      { promptType: promptData.type }
    );
  }

  // Issue #1685: persist question/options/answer to chat history so the audit
  // trail survives even when the answer landed inside the response poller's
  // interval and the prompt was never saved as a pending message. Must never
  // fail the answer that already reached tmux.
  let auditRecord: RecordAnsweredPromptResult | null = null;
  try {
    auditRecord = recordAnsweredPrompt(getDbInstance(), {
      worktreeId,
      cliToolId,
      instanceId: instanceId ?? cliToolId,
      // Issue #3881 (review P2-2): with the reading of the frame it answered,
      // so a row this creates is classified as the response poller's row for
      // the same screen would be — not by whichever of the two wrote first.
      promptData: auditPromptData(cliToolId, promptDetection, promptData, capture),
      answer,
      answeredBy: 'auto',
      content: promptDetection.rawContent || promptDetection.cleanContent,
      ...(sameSession ? {} : { pendingSavedAtOrBefore: generation!.startedAt }),
    });
  } catch (recordError) {
    logger.warn('poller:prompt-audit-record-failed', {
      worktreeId,
      cliToolId,
      instanceId,
      error: getErrorMessage(recordError),
    });
  }

  if (auditRecord) {
    const record = auditRecord;
    // Fire-and-forget on purpose: the WS push is advisory, and awaiting a
    // cold ws-server module load inside the poll path would make its
    // completion timing nondeterministic for a side effect it doesn't
    // depend on (the audit row is already committed above).
    void import('@/lib/ws-server')
      .then(({ broadcastMessage }) => {
        broadcastMessage(record.created ? 'message' : 'message_updated', {
          worktreeId,
          message: record.message,
        });
      })
      .catch(() => {});
  }

  // Dynamic imports avoid a module cycle through terminal-broadcast ->
  // current-output-builder -> auto-yes-manager -> this poller.
  const [{ startPolling: startResponsePolling }, { broadcastTerminalSnapshotAfterInteraction }] =
    await Promise.all([
      import('@/lib/polling/response-poller'),
      import('@/lib/realtime/terminal-broadcast'),
    ]);
  // Re-read after the await, not the `sameSession` taken before the audit: a
  // relaunch while the modules loaded makes the restart about the new process.
  if (!sameSession || (generation !== undefined && !isSameSession(generation))) return;
  startResponsePolling(worktreeId, cliToolId, instanceId);
  void broadcastTerminalSnapshotAfterInteraction(worktreeId, cliToolId, instanceId);
}

/**
 * The `promptData` an Auto-Yes audit row is recorded with (Issue #3881 review
 * P2-2): the answered prompt with `promptDataForStorage`'s reading of the
 * tick's frame. A pending row the response poller saved keeps its own reading
 * (`recordAnsweredPrompt` spreads it); this is what a row created here, or one
 * saved without a reading, gets.
 */
function auditPromptData(
  cliToolId: CLIToolType,
  promptDetection: PromptDetectionResult,
  promptData: PromptData,
  capture: { frame: ReturnType<typeof normalizeFrame>; captureTop: CaptureTop | undefined } | undefined,
): PromptData {
  return (
    promptDataForStorage(cliToolId, capture?.frame ?? null, { ...promptDetection, promptData }, capture?.captureTop)
    ?? promptData
  );
}

/**
 * Step 1 of `detectAndRespondToPrompt`: normalise the tick's frame once and
 * read the prompt on it.
 */
function readPromptFrame(
  worktreeId: string,
  cliToolId: CLIToolType,
  cleanOutput: string,
  precomputedLines: string[] | undefined,
  instanceId: string | undefined,
  rawOutput: string | undefined,
  captureWindowLines: number | undefined,
): { frame: ReturnType<typeof normalizeFrame>; promptDetection: PromptDetectionResult } {
  const receiptScope = { worktreeId, instanceId };
  // Issue #3183: the ONE frame every judgement below reads — normalised once,
  // from the capture as captured (the input-box markers are rule rows the
  // cleaned spelling has blanked), and handed as the same object to the
  // prompt reading, the codex launch guards and the dialog gate. That is what
  // makes "the status chain and Auto-Yes read the same live region" a fact
  // rather than a hope: there is no second normalisation to disagree with.
  const frame = normalizeFrame(rawOutput ?? cleanOutput, cliToolId);
  // Issue #3767: bracket the read so the receipt gate can tell when an agy
  // dialog first appeared, not only what time this tick is.
  if (cliToolId === 'antigravity') beginAntigravityFrameRead(worktreeId, instanceId);
  const promptDetection = detectPromptOnCleanFrame(
    cleanOutput,
    cliToolId,
    precomputedLines,
    rawOutput,
    receiptScope,
    frame,
  );
  if (cliToolId === 'antigravity') endAntigravityFrameRead(worktreeId, instanceId);
  return { frame, promptDetection: withCaptureTop(promptDetection, rawOutput ?? cleanOutput, captureWindowLines) };
}

/**
 * Issue #3881 (review P2-1): an approval target whose upward scan reached the
 * top of a capture that filled its window is marked `top-unknown`, so the
 * resolver does not answer on a deny miss. Without the window (a direct
 * caller, a test) the capture's extent is not known and nothing is added, as
 * before.
 */
function withCaptureTop(
  detection: PromptDetectionResult,
  capture: string,
  captureWindowLines: number | undefined,
): PromptDetectionResult {
  const captureTop = captureTopOf(capture, captureWindowLines);
  return captureTop === undefined ? detection : withCaptureTopCompleteness(detection, captureTop);
}

/**
 * Where a poller capture's first row sits (Issue #3881 review P2-1): the
 * capture is the last `captureWindowLines` rows of the pane, so one that came
 * back with fewer rows holds the pane's whole history, and one that filled the
 * window may be cut at its top (#1670's `isCaptureWindowSaturated`).
 * Undefined when the window is not known.
 */
function captureTopOf(capture: string, captureWindowLines: number | undefined): CaptureTop | undefined {
  return captureWindowLines === undefined ? undefined : captureTopOfWindow(capture, captureWindowLines);
}

/**
 * What `detectAndRespondToPrompt` does to the poller state on a frame with no
 * prompt to answer, before it returns `no_prompt`.
 *
 * @returns agy's dialog the ungated reading still sees past the receipt gate
 *   (Issue #3821: the decision published for it), else null
 */
function noteNoPromptOnScreen(tick: {
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId: string | undefined;
  compositeKey: string;
  pollerState: AutoYesPollerState;
  frame: ReturnType<typeof normalizeFrame>;
  promptDetection: PromptDetectionResult;
  cleanOutput: string;
  precomputedLines: string[] | undefined;
  rawOutput: string | undefined;
  captureWindowLines: number | undefined;
}): ReturnType<typeof logIfWithheldForWantOfReceipt> {
  const {
    worktreeId,
    cliToolId,
    instanceId,
    compositeKey,
    pollerState,
    frame,
    promptDetection,
    cleanOutput,
    precomputedLines,
    rawOutput,
    captureWindowLines,
  } = tick;
  forgetPartialAnswer(compositeKey);
  pollerState.lastAnsweredPromptKey = null;
  pollerState.lastAnsweredAt = null;
  // Issue #3757: agy's trust screen reads as no prompt (unnumbered: neither
  // reader takes it), but it is one nobody here answers — record why, still
  // as `no_prompt`. Before the warn key is cleared, so the WARN stays once
  // per screen.
  // Issue #3820: the trust screen records itself in the ledger when it records
  // its reason (`suppressAntigravityTrustScreen`).
  if (
    cliToolId === 'antigravity' &&
    suppressAntigravityTrustScreen(
      worktreeId,
      instanceId,
      pollerState,
      frame,
      CLIToolManager.getInstance().getTool(cliToolId).getSessionName(worktreeId, instanceId),
    )
  ) {
    return null;
  }
  pollerState.lastSkipWarnKey = null;
  if (cliToolId === 'antigravity' && !promptDetection.isPrompt) {
    const seen = logIfWithheldForWantOfReceipt(worktreeId, instanceId, compositeKey, () =>
      // Issue #3881: judged with the same capture-top reading as the tick's prompt.
      withCaptureTop(
        detectPromptOnCleanFrame(cleanOutput, cliToolId, precomputedLines, rawOutput),
        rawOutput ?? cleanOutput,
        captureWindowLines,
      ),
    );
    // Issue #3820: past the receipt window the gated reading says "no prompt"
    // while the dialog is still up. The ungated reading says it is, so the
    // ledger keeps the same confirmation (and the same withheld interval)
    // rather than closing it on every tick outside the window.
    if (seen !== null) {
      const scope: LedgerScope = { compositeKey, worktreeId, cliToolId, instanceId };
      observeLedgerScreen(
        scope,
        ledgerScreenKey(seen.promptData),
        seen.promptData.type,
        ledgerCallOf(cliToolId, worktreeId, instanceId),
      );
      if (seen.reason !== null) withholdLedgerConfirmation(scope, seen.reason);
    }
    return seen;
  }
  return null;
}

/**
 * Issue #3821: records what one tick decided about the prompt it read, for
 * `current-output` to publish (`autoYesDecision`, see
 * `polling/auto-yes-decision-state`). Tied to the grant and the session epoch
 * the tick read under, and to the confirmation (the prompt, and for agy the
 * hook call its receipt was accepted for); a tick that lost its generation
 * (#3706) records nothing, because the grant or the session it decided for is
 * gone.
 */
function tickDecisionRecorder(tick: {
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId: string | undefined;
  compositeKey: string;
  promptData: PromptData;
  epoch: number;
  generation: AutoYesTickGeneration | undefined;
  startedAt: number;
}): {
  answering: () => void;
  reaffirmAnswering: () => void;
  withheld: (fallback: AutoYesDecisionReason) => void;
} {
  const { worktreeId, cliToolId, instanceId, compositeKey, promptData, epoch, generation, startedAt } = tick;
  const grantOf = () => generation?.grant ?? getAutoYesState(worktreeId, cliToolId, instanceId);
  const callId = ledgerCallOf(cliToolId, worktreeId, instanceId).callId ?? null;
  const record = (state: 'answering' | 'withheld', reason: AutoYesDecisionReason | null): void => {
    if (generation !== undefined && !isTickCurrent(generation)) return;
    recordAutoYesDecision(compositeKey, { state, reason, promptData, callId, grant: grantOf(), epoch });
  };
  return {
    answering: () => record('answering', null),
    // The duplicate guard's "answered recently" compares the question only, so
    // it is not evidence this confirmation is the one answered: `answering`
    // stands only when the record the send made is about this confirmation,
    // under the same grant and session (review 2). Otherwise nothing stands.
    reaffirmAnswering: () => {
      if (generation !== undefined && !isTickCurrent(generation)) {
        forgetAutoYesDecision(compositeKey);
        return;
      }
      reaffirmAutoYesAnswering(compositeKey, { promptData, callId, grant: grantOf(), epoch });
    },
    // The reason the step that withheld it recorded on this tick (the #1684
    // record), else the step's own: a stop the policy record never carries.
    withheld: (fallback) => {
      const recorded = getLastPolicySuppression(worktreeId, cliToolId, instanceId);
      record('withheld', recorded !== null && recorded.at >= startedAt ? recorded.reason : fallback);
    },
  };
}

/**
 * Issue #3820 (design §2.4, PR 3): the agy call the receipt episode on screen
 * was accepted for, for the ledger to tie the confirmation to. Asked after the
 * frame was judged; read only to record, and never throws.
 */
function ledgerCallOf(
  cliToolId: CLIToolType,
  worktreeId: string,
  instanceId: string | undefined,
): { callId?: string } {
  if (cliToolId !== 'antigravity') return {};
  try {
    const callId = getAntigravityAcceptedReceiptCallId(worktreeId, instanceId);
    return callId === null ? {} : { callId };
  } catch {
    // Recording only: a failure here ties nothing and changes nothing else.
    return {};
  }
}

/**
 * Issue #3820: the result of a send that threw, as the ledger counts it.
 * `keysSent` is what the sender said (#3706); a throw that says nothing is a
 * failure whose keys may or may not be on the pane.
 */
function attemptResultOfThrow(keysSent: boolean | null): AttemptResult {
  if (keysSent === true) return 'partial';
  if (keysSent === false) return 'no-keys-sent';
  return 'failed';
}

/**
 * Issue #3820: the evidence an answer on the screen path is given on (design
 * §7 PR 1). A tool's own dialog detector vouched for the frame: `L3`. The
 * gate did not judge it (a `legacy` tool, a non-multiple-choice prompt): the
 * generic reading alone, `L4`.
 *
 * agy's gate is `legacy` (`gated: false`), yet its prompts are read by its own
 * reader first (`detectPromptOnCleanFrame` returns that reader's result
 * whenever it reads the frame). Which reader it was is not on the detection
 * result, so it is asked of the same reader on the same text here — for the
 * label only; the answer was decided before this is called. Read by agy's own
 * reader, and through the receipt gate (the tick's reading carried the
 * receipt scope): `L3`, with `receiptAccepted` on the attempt.
 */
function answerBasisOf(prompt: JudgedPrompt, cleanOutput: string): AnswerBasis {
  if (prompt.cliToolId === 'antigravity') {
    return detectAntigravityNumberedDialogPrompt(cleanOutput) !== null ? 'L3' : 'L4';
  }
  const gate = prompt.dialogGate;
  return gate !== undefined && gate.gated && gate.allowed && gate.dialog !== null ? 'L3' : 'L4';
}

/**
 * The `catch` of `detectAndRespondToPrompt`: settles the send in flight and
 * tells an abandoned tick from a failed one.
 */
function settleFailedTick(
  error: unknown,
  tick: {
    worktreeId: string;
    cliToolId: CLIToolType;
    instanceId: string | undefined;
    compositeKey: string;
    generation: AutoYesTickGeneration | undefined;
    attempt: AutoYesSendAttempt | null;
    sendInFlight: boolean;
    receiptEpisode: number | null;
  },
): 'no_answer' | 'error' {
  const { worktreeId, cliToolId, instanceId, compositeKey, generation, attempt, sendInFlight, receiptEpisode } =
    tick;
  const keysSent = error instanceof Error && 'keysSent' in error ? Boolean(error.keysSent) : null;
  // Issue #3820: the send that was cut short, in the ledger — before the send
  // record below is settled, whose state says whether it had expired.
  if (attempt !== null && sendInFlight) {
    settleLedgerAttempt(attempt.ledger, attemptResultOfThrow(keysSent), { expired: attempt.state === 'expired' });
  }
  // Issue #3706: a tick that lost its generation — the send stopped part-way
  // (`PromptAnswerAbortedError`), or failed after the grant went — is not a
  // failure of the poller that now holds the key, and not an answer either.
  if (generation !== undefined && !isTickCurrent(generation)) {
    // A stop with keys already on the pane: the next tick must not type the
    // answer again over them (step 2.5). Recorded under the attempt's key as
    // it is now — the new one when a worktree ID move carried it (#3713).
    if (attempt !== null) settleSendAttempt(attempt, keysSent === true);
    if (sendInFlight) noteAnswerSent(cliToolId, worktreeId, instanceId, true, receiptEpisode);
    logger.info('poller:auto-yes-answer-abandoned', { worktreeId, cliToolId, instanceId, keysSent });
    return 'no_answer';
  }
  // Issue #3839: a failure with keys already on the pane is held the same way —
  // the next tick must not type the answer again over them (step 2.5); the
  // screen leaving or changing forgets it (`forgetPartialAnswer`).
  if (attempt !== null) settleSendAttempt(attempt, keysSent === true);
  if (sendInFlight) noteAnswerSent(cliToolId, worktreeId, instanceId, true, receiptEpisode);
  incrementErrorCount(compositeKey, generation?.pollerState);
  logger.warn('poller:detect-respond-error', { worktreeId, cliToolId, instanceId });
  return 'error';
}

/**
 * Detect prompt in terminal output, resolve auto-answer, and send response.
 *
 * @internal Exported for testing purposes only.
 * @param worktreeId - Worktree identifier
 * @param pollerState - Current poller state (mutated: lastAnsweredPromptKey updated)
 * @param cliToolId - CLI tool type
 * @param cleanOutput - ANSI-stripped terminal output
 * @param precomputedLines - Optional pre-split lines to reuse
 * @param instanceId - Optional agent instance ID (Issue #896; defaults to primary session)
 * @param rawOutput - The SAME tick's capture with its box drawing intact
 *   (Issue #2522). Omitting it costs Command Code's `AskUserQuestion` and
 *   nothing else; see {@link capturePollerFrame}.
 * @param generation - The calling tick's generation (Issue #3706). Given, every
 *   wait before a key — the ownership check and each wait inside the send — is
 *   followed by {@link isTickCurrent}, and a tick
 *   that lost it types nothing more and returns `no_answer`. Omitted (direct
 *   callers, tests), nothing is checked, as before.
 * @param observation - Issue #3798: the tick's waiting-episode start, fixed
 *   before its capture, and when that capture's frame was fetched. The answer
 *   is observed against them ({@link observeAnsweredPrompt}). Omitted (direct
 *   callers, tests), the start is fixed here and the frame dated 0.
 * @param captureWindowLines - Issue #3881 (review P2-1): the window the
 *   capture was taken with. Given, a capture that filled it is read as
 *   possibly cut at its top: an approval target that reached that top is
 *   `top-unknown`, and a deny miss on it is not a pass. Omitted (direct
 *   callers, tests), nothing is known about the capture's extent, as before.
 *   The same window says where the audit row's frame begins (`captureTop`).
 * @returns 'responded' | 'no_prompt' | 'duplicate' | 'no_answer' | 'error'
 */
export async function detectAndRespondToPrompt(
  worktreeId: string,
  pollerState: AutoYesPollerState,
  cliToolId: CLIToolType,
  cleanOutput: string,
  precomputedLines?: string[],
  instanceId?: string,
  rawOutput?: string,
  generation?: AutoYesTickGeneration,
  observation?: TickObservation,
  captureWindowLines?: number,
): Promise<'responded' | 'no_prompt' | 'duplicate' | 'no_answer' | 'error'> {
  const compositeKey = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const tickObservation: TickObservation = observation ?? {
    start: startWaitingObservation(worktreeId, cliToolId, instanceId),
    frameTime: { frameCapturedAt: 0, frameFetchedAfterStart: false },
  };
  // Issue #3706 / #3713: the send in flight, settled without an await once it
  // comes back — as a partial answer when it was stopped with keys on the pane.
  let attempt: AutoYesSendAttempt | null = null;
  // Issue #3796: `sendPromptAnswer` began and has not returned — a throw now cut
  // the send short, and the agy receipt gate is told so (`noteAnswerSent`).
  let sendInFlight = false;
  let receiptEpisode: number | null = null;
  // Issue #3820: the ledger's tick. A tick that read the screen and saw no
  // confirmation closes the open one as gone when it ends (`endLedgerTick`).
  // Issue #3863: the answer mode this tick acts under, recorded on its ledger lines.
  const answerMode = answerModeOfTick(worktreeId, cliToolId, instanceId, generation?.grant);
  const ledgerScope: LedgerScope = { compositeKey, worktreeId, cliToolId, instanceId, answerMode };
  const ledgerTick = beginLedgerTick(ledgerScope);
  // Issue #3821: when this tick began, for the decision's reason (see `tickDecisionRecorder`).
  const tickStartedAt = Date.now();
  // Issue #3791 (review N1 / N3): the duplicate guard's reservation outlives
  // this tick only when the guard holds the prompt back again. It stays up
  // while the tick goes on to send the retry of the reserved prompt (an answer
  // still on its way), and is released before any await for another screen,
  // and in `finally` for everything else — withheld, failed, stopped, or
  // answered (the new answer restarts the hold).
  let keepDuplicateRetry = false;
  try {
    // 1. Detect prompt.
    //
    // Issue #2368: through `detectPromptOnCleanFrame`, the entry the status
    // path and the response poller already read frames on — NOT the generic
    // `detectPrompt` this used to call. #2364 gave agy its own dialog reader and
    // wired it into three of the four consumers of one frame; this poller was
    // the fourth, and it stayed on the generic multiple-choice parser. That
    // parser folds a wrapped option label only when the continuation row is
    // indented, short or path-shaped (#372, for codex prose), and agy prints the
    // approved command INSIDE the label and wraps it at column 0 — so every
    // Bash approval read as `isPrompt: false` here and Auto-Yes answered
    // nothing, while `/current-output` published the same screen as a waiting
    // four-option prompt. Everything after this point is unchanged: the
    // duplicate key (#306), codex's launch dialogs (#1829), the dialog gate
    // (#1928) and the contract policy (#1547) all still run. What changed is
    // only whether the frame can be READ.
    //
    // `cleanOutput` is handed over already stripped, and the clean-frame entry
    // is the one that does not strip again (`stripBoxDrawing` is not
    // idempotent), so this poller and the response poller judge identical text.
    //
    // Issue #2522 adds the fourth argument, and it is a WIRING change rather
    // than a reader one: Command Code's `AskUserQuestion` is anchored on the
    // rule row `captureAndCleanOutput` blanks, so teaching
    // `detectPromptOnCleanFrame` to read it changed nothing on this path until
    // the same tick's raw capture reached it. `precomputedLines` stays the split
    // of `cleanOutput` — the stop-condition delta and every other tool's reading
    // are measured on that string and must not move.
    //
    // Issue #2857 adds the fifth, and this is the only caller that passes it: the
    // one that ANSWERS the frame. For agy the frame then reads as a prompt only
    // when agy asked CommandMate about a tool call for this instance in the last
    // few seconds (#2849) — a dialog it never asked about is a reply quoting one
    // (#2845, #2851) or a menu the user opened, and neither is ours to answer.
    // The status API, the response poller's `prompt` row and the notification
    // still call without it, so a real dialog stays visible to a human on a
    // machine whose hook does not reach us. The price is that Auto-Yes leaves
    // such a machine's dialogs alone, which is why `logIfWithheldForWantOfReceipt`
    // says so.
    const epoch = syncEnterFallbackEpoch(compositeKey, pollerState);

    const { frame, promptDetection } = readPromptFrame(
      worktreeId,
      cliToolId,
      cleanOutput,
      precomputedLines,
      instanceId,
      rawOutput,
      captureWindowLines,
    );

    if (!promptDetection.isPrompt || !promptDetection.promptData) {
      // Issue #3821: no prompt, no decision — except agy's dialog the receipt
      // gate keeps from this reading while the status API still shows it.
      forgetAutoYesDecision(compositeKey);
      const withheldPastGate = noteNoPromptOnScreen({
        worktreeId,
        cliToolId,
        instanceId,
        compositeKey,
        pollerState,
        frame,
        promptDetection,
        cleanOutput,
        precomputedLines,
        rawOutput,
        captureWindowLines,
      });
      if (withheldPastGate !== null && withheldPastGate.reason !== null) {
        tickDecisionRecorder({
          worktreeId,
          cliToolId,
          instanceId,
          compositeKey,
          promptData: withheldPastGate.promptData,
          epoch,
          generation,
          startedAt: tickStartedAt,
        }).withheld(withheldPastGate.reason);
      }
      return 'no_prompt';
    }

    // Issue #3820: computed here, before the duplicate check, so the ledger
    // sees the confirmation on every tick it is on screen (step 2.5 below
    // reads the same key).
    // The ledger's own key keeps the body (`ledgerScreenKey`): two commands
    // that differ by a `>` or an indent are two confirmations to count.
    const screenKey = partialAnswerScreenKey(promptDetection.promptData);
    // agy (PR 3): tied to the call the receipt that let it through asked about.
    observeLedgerScreen(
      ledgerScope,
      ledgerScreenKey(promptDetection.promptData),
      promptDetection.promptData.type,
      ledgerCallOf(cliToolId, worktreeId, instanceId),
    );

    // Issue #3821: what this tick decides about the prompt, for `current-output`.
    const decision = tickDecisionRecorder({
      worktreeId,
      cliToolId,
      instanceId,
      compositeKey,
      promptData: promptDetection.promptData,
      epoch,
      generation,
      startedAt: tickStartedAt,
    });

    // 1.5. Issue #3821 (review 2): a person began answering on this instance
    // moments ago. What is on screen may be the very confirmation they are
    // answering, so it is theirs until the hold passes; Auto-Yes stays on.
    if (isManualAnswerHolding(compositeKey)) {
      decision.withheld(ANSWERED_BY_HUMAN_DECISION_REASON);
      return 'no_answer';
    }

    // 2. Check for duplicate prompt (Issue #306)
    const promptKey = generatePromptKey(promptDetection.promptData);
    const frameKey = promptFrameKey(promptDetection.promptData);
    if (isDuplicatePrompt(pollerState, promptKey)) {
      // Issue #3791 (review N1): the push gate holds this wait until the retry.
      reserveDuplicateRetry(pollerState, promptKey, tickStartedAt);
      keepDuplicateRetry = true;
      // Issue #3820: not answered on this tick either — an interval of its own
      // reason, so the count can tell the wait for an answer to land apart.
      withholdLedgerConfirmation(ledgerScope, 'answered-recently');
      // Issue #3821: still `answering` only if this is the confirmation the send was for.
      decision.reaffirmAnswering();
      return 'duplicate';
    }
    // Issue #3791 (review N3): another screen than the reserved one — released
    // now, before the awaits below, so the gate never reads it for this screen.
    if (!isDuplicateRetryOf(pollerState, promptKey)) releaseDuplicateRetry(pollerState);

    const judged: JudgedPrompt = {
      worktreeId,
      cliToolId,
      instanceId,
      compositeKey,
      pollerState,
      promptData: promptDetection.promptData,
      promptKey,
      frameKey,
      // Issue #3863: for the `recommended` answer mode's choice among a question's options.
      ...(promptDetection.optionRecommendations !== undefined
        ? { optionRecommendations: promptDetection.optionRecommendations }
        : {}),
      answerMode,
    };

    // 2.5. Issue #3706: an earlier answer to this prompt was stopped after some
    // of its keys reached the pane (a `y` whose Enter was withheld). Typing the
    // answer again would append to what is already in the input (`yy`), and
    // what the pane holds now cannot be told from the frame, so the prompt is
    // left for a human until it leaves the screen, another prompt replaces it
    // (`partialAnswerScreenKey`: options and approvalTarget count, the cursor
    // does not), or the session is relaunched. Recorded as a suppression, so
    // the prompt Push and `cmate wait` see "withheld", not "answering".
    if (withheldForEarlierSend(judged, screenKey, epoch)) {
      decision.withheld('moved-send-in-flight');
      return 'no_answer';
    }

    // 3., 3.2., 3.5. Frames that are not Auto-Yes's to answer: see
    // `suppressIfNotOursToAnswer`.
    const notOurs = suppressIfNotOursToAnswer(judged, frame);
    if (notOurs.kind === 'left-alone') {
      decision.withheld('unclassified-frame');
      return 'no_answer';
    }
    // 3.6. A frame the dialog gate refused is left to a human, whatever it is.
    // Issue #3821: including a choice screen CommandMate cannot read, which got
    // one bare Enter (#3397) until this Issue retired it — an Enter confirms
    // whatever happens to be selected, and nothing here can say what that is.
    if (notOurs.kind === 'dialog-gate-refused') {
      suppressUnclassifiedFrame(judged, notOurs.dialogGate);
      decision.withheld('unclassified-frame');
      return 'no_answer';
    }

    // 3.7. Issue #3822: a question to the operator is the human's to answer —
    // under the `careful` answer mode (Issue #3863); under `recommended` a
    // question reader's picker goes on to step 4. See `withheldAsQuestion`.
    if (withheldAsQuestion(judged)) {
      decision.withheld('question-left-to-human');
      return 'no_answer';
    }

    // 4. Resolve auto answer under the execution contract's policy (Issue #1547).
    // Issue #3863: a question the `recommended` mode answers takes its
    // recommended option, else its default; one whose recommendation cannot
    // be told is withheld (`recommended-option-unidentified`).
    // Auto-Yes reads the frame itself instead of going through status-detector
    // (it shares the reader, not the verdict), so this is the only place the policy can gate an
    // auto-answer: a prompt the policy withholds is left for a human, and the
    // response poller's prompt path (WS broadcast + Web Push, see
    // polling/response-checker.ts) is what tells them it is waiting.
    const answer = resolveAnswerUnderPolicy(judged);
    if (answer === null) {
      decision.withheld(NO_AUTO_ANSWER_DECISION_REASON);
      return 'no_answer';
    }

    // 5. Send answer to tmux (Issue #896: resolve the instance-specific session)
    const manager = CLIToolManager.getInstance();
    const cliTool = manager.getTool(cliToolId);
    const sessionName = cliTool.getSessionName(worktreeId, instanceId);

    // Issue #2865: never auto-answer a same-named session another CommandMate
    // server created. The poller keeps running; it just does not type.
    const ownership = await checkWorktreeSessionOwnership(worktreeId, sessionName);
    if (generation !== undefined && !isTickCurrent(generation)) return 'no_answer';
    if (skippedForUnownedSession(judged, sessionName, ownership)) {
      decision.withheld('foreign-session');
      return 'no_answer';
    }

    // 5.5. Issue #3822: the last look before the first key — Auto-Yes still on
    // and inside its window, and the contract, read past its cache, still
    // allowing this answer. No wait between here and the send.
    if (withheldAtSend(judged, generation !== undefined)) {
      decision.withheld(NO_AUTO_ANSWER_DECISION_REASON);
      return 'no_answer';
    }

    // Issue #3821: from here until the screen is redrawn, Auto-Yes is answering.
    decision.answering();
    attempt = beginSendAttempt(
      compositeKey,
      screenKey,
      generation?.sessionEpoch ?? epoch,
      // Issue #3820: an agy prompt read past the gate is one a hook receipt let through.
      beginLedgerAttempt(ledgerScope, answerBasisOf(judged, cleanOutput), {
        receiptAccepted: cliToolId === 'antigravity',
      }),
    );
    receiptEpisode = receiptEpisodeOfSend(cliToolId, worktreeId, instanceId);
    // Issue #3798: the wait this answer goes to, fixed as the send begins.
    const answerTarget = fixAnswerTarget(worktreeId, cliToolId, instanceId);
    sendInFlight = true;
    try {
      await sendPromptAnswer({
        sessionName,
        answer,
        cliToolId,
        promptData: promptDetection.promptData,
        // Issue #3706: asked after each wait inside the send.
        ...(generation !== undefined ? { stillCurrent: () => isTickCurrent(generation) } : {}),
      });
    } finally {
      invalidateCache(sessionName);
    }
    sendInFlight = false;
    settleLedgerAttempt(attempt.ledger, 'ok', { expired: attempt.state === 'expired' });
    settleSendAttempt(attempt, false);
    // Issue #3796 review E: the episode the send began for, as on the failure side.
    noteAnswerSent(cliToolId, worktreeId, instanceId, false, receiptEpisode);
    // Issue #3798: the wait this answer went to — opened if none is open — so
    // the frame that shows the confirmation gone closes it. Once the keys are
    // out, only by a tick that still acts for this instance (#3706: one that
    // lost its grant or session writes nothing that says "answered"), and only
    // for the wait fixed as the send began.
    if (generation === undefined || isTickCurrent(generation)) {
      observeAnsweredPrompt(judged, screenKey, tickObservation, answerTarget);
    }

    // 6., 7. The answer reached tmux: see `finishAnsweredPrompt`.
    await finishAnsweredPrompt(judged, promptDetection, answer, generation, {
      // The tick's one normalised frame (#3183), not the capture again.
      frame,
      captureTop: captureTopOf(rawOutput ?? cleanOutput, captureWindowLines),
    });

    return 'responded';
  } catch (error) {
    // Issue #3821: a tick that failed has decided nothing the next one will not
    // decide again; until then the prompt is not "being answered".
    if (generation === undefined || isTickCurrent(generation)) forgetAutoYesDecision(compositeKey);
    return settleFailedTick(error, {
      worktreeId,
      cliToolId,
      instanceId,
      compositeKey,
      generation,
      attempt,
      sendInFlight,
      receiptEpisode,
    });
  } finally {
    endLedgerTick(ledgerScope, ledgerTick);
    if (!keepDuplicateRetry) releaseDuplicateRetry(pollerState);
  }
}

/**
 * Internal polling function that recursively schedules itself via setTimeout.
 *
 * @param worktreeId - Worktree identifier
 * @param cliToolId - CLI tool type being polled
 * @param instanceId - Agent instance ID being polled (Issue #896; equals cliToolId for primary)
 * @param owner - The poller state whose timer fired (Issue #3706); a timer of a
 *   poller that has since been replaced does nothing
 */
async function pollAutoYes(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  owner?: AutoYesPollerState,
): Promise<void> {
  const compositeKey = buildCompositeKey(worktreeId, cliToolId, instanceId);

  // 1. Validate context
  const pollerState = getPollerState(compositeKey);
  if (owner !== undefined && pollerState !== owner) return;
  const contextResult = validatePollingContext(compositeKey, pollerState);
  if (contextResult !== 'valid') {
    return;
  }
  const grant = getAutoYesState(worktreeId, cliToolId, instanceId);
  if (!grant?.enabled) return;

  // Issue #3706: what this tick acts for, compared after every wait below.
  const generation: AutoYesTickGeneration = {
    compositeKey,
    worktreeId,
    cliToolId,
    instanceId,
    pollerState: pollerState!,
    grant,
    sessionEpoch: getEnterFallbackSessionEpoch(compositeKey),
    startedAt: Date.now(),
    // Issue #3821: a person's answer begun after this is read stops the tick.
    manualAnswerSeq: getManualAnswerSeq(compositeKey),
  };
  // Issue #3796: this is the session wait's tick (it was scheduled as one) —
  // recorded before anything can fail, for the push gate.
  if (pollerState!.sessionWaitTickAt !== undefined) pollerState!.sessionWaitTickRanAt = generation.startedAt;
  // Issue #3798: the waiting episode as this tick found it, before its first wait.
  const observationStart = startWaitingObservation(worktreeId, cliToolId, instanceId);

  try {
    // 2. Capture and clean output
    const captureLines = grant.stopPattern
      ? FULL_CAPTURE_LINES
      : REDUCED_CAPTURE_LINES;
    // Issue #2522: one capture, both spellings. The cleaned string drives every
    // step below exactly as it did; the raw one is carried to the prompt reading
    // so a dialog anchored on box drawing is not invisible to the one path that
    // can answer it without a human.
    //
    // Issue #3798: dated by where that frame came from — the capture goes
    // through the 5 s cache, so it may predate this tick.
    const {
      frame: { raw: rawOutput, clean: cleanOutput },
      frameTime,
    } = await captureObservedFrame(() => capturePollerFrame(worktreeId, cliToolId, captureLines, instanceId));
    if (!isTickCurrent(generation)) {
      endStaleTick(generation);
      return;
    }

    if (pollerState!.waitingForSession) {
      pollerState!.waitingForSession = false;
      // Issue #3796: the session wait's tick ran here — read by the push gate.
      pollerState!.sessionAppearedAt = generation.startedAt;
      logger.info('poller:session-appeared', { worktreeId, cliToolId, instanceId });
    }

    const lines = cleanOutput.split('\n');

    // 3. Stop condition delta check (Issue #314)
    if (processStopConditionDelta(compositeKey, pollerState!, cleanOutput)) {
      return;
    }

    // 4. Detect and respond to prompt
    const result = await detectAndRespondToPrompt(
      worktreeId, pollerState!, cliToolId, cleanOutput, lines, instanceId, rawOutput, generation,
      { start: observationStart, frameTime },
      // Issue #3881 (review P2-1): the window this capture was taken with.
      captureLines,
    );
    if (!isTickCurrent(generation)) {
      endStaleTick(generation);
      return;
    }
    // Issue #3329: a poll that ran to the end ends the run of errors, so only
    // failures in a row reach AUTO_STOP_ERROR_THRESHOLD — not ones scattered
    // over hours. Not on 'error': a capture that works followed by an answer
    // that fails every time must still back off and stop.
    if (result !== 'error') {
      resetErrorCount(compositeKey, generation.pollerState);
    }
    if (result === 'responded') {
      scheduleNextPoll(generation, COOLDOWN_INTERVAL_MS);
      return;
    }

    // 5. Thinking check
    if (result === 'no_prompt') {
      observeWaitingFromTick({
        worktreeId,
        cliToolId,
        instanceId,
        start: observationStart,
        frameTime,
        pollerState: generation.pollerState,
        rawOutput,
      });
      const recentLines = lines.slice(-THINKING_CHECK_LINE_COUNT).join('\n');
      if (detectThinking(cliToolId, recentLines)) {
        scheduleNextPoll(generation, THINKING_POLLING_INTERVAL_MS);
        return;
      }
    }
  } catch (error) {
    // Issue #3329: no session is not an error. Auto-Yes lives independently of
    // the session it answers for (`auto-yes-lifecycle`), and `send --auto-yes`
    // enables it before the session starts — so wait until `expiresAt`, at the
    // backoff cap, instead of counting toward `consecutive_errors`.
    const sessionMissing = await isSessionMissing(worktreeId, cliToolId, instanceId);
    if (!isTickCurrent(generation)) {
      endStaleTick(generation);
      return;
    }
    if (sessionMissing) {
      // Issue #3791 (review N1): no screen for the duplicate guard to hold back.
      releaseDuplicateRetry(generation.pollerState);
      // Issue #3798: a session that is gone is waiting for nobody.
      observeWaitingFromTick({
        worktreeId,
        cliToolId,
        instanceId,
        start: observationStart,
        frameTime: { frameCapturedAt: 0, frameFetchedAfterStart: false },
        pollerState: generation.pollerState,
        rawOutput: null,
      });
      if (!pollerState!.waitingForSession) {
        pollerState!.waitingForSession = true;
        logger.info('poller:waiting-for-session', { worktreeId, cliToolId, instanceId });
      }
      scheduleNextPoll(generation, MAX_BACKOFF_MS, { sessionWait: true });
      return;
    }
    incrementErrorCount(compositeKey, generation.pollerState);
    logger.warn('poller:poll-error', { worktreeId, cliToolId, instanceId, error: getErrorMessage(error) });
  }

  scheduleNextPoll(generation);
}

/**
 * The wait an answer goes to, fixed in the synchronous step the send begins in
 * (Issue #3798): the episode open then, or none and the version it was at.
 */
interface AnswerTarget {
  episodeId: string | null;
  version: number;
}

function fixAnswerTarget(worktreeId: string, cliToolId: CLIToolType, instanceId: string | undefined): AnswerTarget {
  return {
    episodeId: getWaitingEpisodeRecord(worktreeId, cliToolId, instanceId)?.episodeId ?? null,
    version: getEpisodeVersion(worktreeId, cliToolId, instanceId),
  };
}

/**
 * Whether the wait is still the one the answer was sent to: the same episode
 * open, as it was when the send began (the version has not moved) or rebound
 * since to a binding the answer may still be for — the hook of the turn the
 * answer resumed may have landed during the send — but not to a `screen`: a
 * survey or a picker another observer saw during the send is newer than the
 * prompt these keys answered, and re-observing that prompt would turn the
 * person's screen back into a wait Auto-Yes answered. When none was open,
 * none opened or closed since.
 */
function answerTargetHolds(
  target: AnswerTarget,
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined
): boolean {
  if (target.episodeId === null) return getEpisodeVersion(worktreeId, cliToolId, instanceId) === target.version;
  const episode = getWaitingEpisodeRecord(worktreeId, cliToolId, instanceId);
  if (episode?.episodeId !== target.episodeId) return false;
  return getEpisodeVersion(worktreeId, cliToolId, instanceId) === target.version || episode.binding.kind !== 'screen';
}

/** What a tick fixed for its waiting-episode observations (Issue #3798). */
interface TickObservation {
  start: ObservationStart;
  frameTime: CapturedFrameTime;
}

/**
 * The answer the poller just sent, as an observation of the waiting episodes
 * (Issue #3798, design §2.5 "Auto-Yes poller", PR 3). Called in the
 * synchronous step the send returns to, before anything else is awaited: the
 * confirmation answered is a fresh prompt (planned against the episode as it
 * is now, I5 (d)), so a wait opens if none is open, and a second confirmation
 * of the same turn after an answer (another screen key) replaces the answered
 * wait (R1-7) — a new hold, not the old wait's spent one. The episode the plan
 * leaves open is recorded as `lastAnswer`; a plan refused (another generation,
 * or a frame fetched before the close of this very confirmation — a stop that
 * landed during the send) records none, so nothing is closed on the strength
 * of it. Nor does a send whose wait moved under it (`target`, fixed as the
 * send began): another wait opened during the send — a hook, another
 * observer — is not the one these keys answered, and nothing is planned or
 * recorded for it; `lastAnswer` stays as it was — and so for the same wait
 * rebound during the send to a person's `screen`. Advisory, like
 * {@link observeWaitingFromTick}.
 */
function observeAnsweredPrompt(
  prompt: JudgedPrompt,
  screenKey: string,
  observation: TickObservation,
  target: AnswerTarget
): void {
  const { worktreeId, cliToolId, instanceId, pollerState, promptData } = prompt;
  try {
    if (!answerTargetHolds(target, worktreeId, cliToolId, instanceId)) {
      logger.debug('poller:answer-target-moved', { worktreeId, cliToolId, instanceId, target: target.episodeId });
      return;
    }
    const plan = observeWaiting({
      worktreeId,
      cliToolId,
      instanceId,
      observer: 'auto-yes-poller',
      start: observation.start,
      reading: promptWaitingReading(promptData),
      ...observation.frameTime,
      freshPrompt: true,
      lastAnswer: pollerState.lastAnswer ?? null,
    });
    const episode = plan.action === 'ignored' ? null : getWaitingEpisodeRecord(worktreeId, cliToolId, instanceId);
    pollerState.lastAnswer = episode === null ? null : { episodeId: episode.episodeId, screenKey, at: plan.at };
  } catch (error) {
    pollerState.lastAnswer = null;
    logger.debug('poller:waiting-observation-failed', {
      worktreeId,
      cliToolId,
      instanceId,
      error: getErrorMessage(error),
    });
  }
}

/**
 * Tell the waiting episodes what this tick saw (Issue #3798, design §2.5,
 * PR 1b): a frame with nothing for Auto-Yes to answer, read the way the status
 * probe reads it — without the agy receipt window — or a session that is gone.
 *
 * What it can do is table O-1 for a waiting frame (a survey or a picker after
 * an answer opens, or turns the wait into, a person's `screen`), and on the
 * closing side a `screen` this tick saw cleared on a frame fetched after it
 * became one, the wait the poller answered (`lastAnswer`, PR 3), or any wait
 * of a session that is gone. A wait the poller did not answer — or answered
 * before it was replaced — is not its to close. Advisory: a failure is logged
 * and the tick goes on.
 */
function observeWaitingFromTick(tick: {
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId: string | undefined;
  start: ObservationStart;
  frameTime: CapturedFrameTime;
  pollerState: AutoYesPollerState;
  rawOutput: string | null;
}): void {
  const { worktreeId, cliToolId, instanceId } = tick;
  try {
    let reading: ScreenReading = { kind: 'gone' };
    if (tick.rawOutput !== null) {
      const lastResponseAt = tick.pollerState.lastServerResponseTimestamp;
      const lastOutputTimestamp = lastResponseAt ? new Date(lastResponseAt) : undefined;
      // Without the receipt scope (design I9), and with the structured wait
      // read the way the status probe reads it — the API-answerable one
      // (#3184) a `prompt` here too, or the two observers would flip the
      // episode's kind between `prompt` and `menu` on every tick.
      const verdict = detectSessionStatus(tick.rawOutput, cliToolId, lastOutputTimestamp);
      const { structured } = peekPromptWaiting({ worktreeId, cliToolId, instanceId, scraper: verdict });
      reading = readWaitingScreen({
        cliToolId,
        output: tick.rawOutput,
        lastOutputTimestamp,
        structuredWaiting: structured !== null,
        structuredSince: structured?.at ?? null,
        apiAnswerable: isApiAnswerableStructuredWait(
          structured,
          getAgentEventSource(cliToolId).capabilities.eventIdentity,
        ),
        verdict,
      });
    }
    observeWaiting({
      worktreeId,
      cliToolId,
      instanceId,
      observer: 'auto-yes-poller',
      start: tick.start,
      reading,
      ...tick.frameTime,
      lastAnswer: tick.pollerState.lastAnswer ?? null,
    });
  } catch (error) {
    logger.debug('poller:waiting-observation-failed', {
      worktreeId,
      cliToolId,
      instanceId,
      error: getErrorMessage(error),
    });
  }
}

/**
 * Whether a failed capture failed because the session does not exist
 * (Issue #3329). Asked of tmux (`has-session`'s exit code), not read off the
 * error text. `unknown` — tmux timed out or could not be run — is not "absent":
 * the failure is counted as before, so a broken tmux still stops Auto-Yes.
 */
async function isSessionMissing(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
): Promise<boolean> {
  try {
    return (await getSessionPresence(worktreeId, cliToolId, instanceId)) === 'absent';
  } catch {
    return false;
  }
}

/**
 * Schedule the next polling iteration
 *
 * Issue #3706: on the tick's OWN poller state, and only while it is still the
 * one under its key. Re-reading by key let a tick that outlived a disable →
 * enable write its timer over the new poller's `timerId`, leaving two chains.
 *
 * @param generation - The tick's generation
 * @param overrideInterval - Optional override for the next poll delay
 * @param options.sessionWait - The tick waits for a session to appear (Issue #3791)
 */
function scheduleNextPoll(
  generation: AutoYesTickGeneration,
  overrideInterval?: number,
  options: { sessionWait?: boolean } = {},
): void {
  if (!isPollerCurrent(generation)) return;
  const { worktreeId, cliToolId, instanceId, pollerState } = generation;

  const interval = Math.max(overrideInterval ?? pollerState.currentInterval, POLLING_INTERVAL_MS);
  // Issue #3791: only the session wait's tick is one the push gate waits for.
  pollerState.sessionWaitTickAt = options.sessionWait === true ? Date.now() + interval : undefined;
  // Issue #3796: any new timer supersedes the previous one's wake.
  dropSessionWaitWake(generation.compositeKey);
  const timerId = setTimeout(() => {
    dropSessionWaitWake(generation.compositeKey, timerId);
    void pollAutoYes(worktreeId, cliToolId, instanceId, pollerState);
  }, interval);
  pollerState.timerId = timerId;
  if (options.sessionWait === true) armSessionWaitWake(generation, timerId);
}

/** A session-wait tick's wake (Issue #3796): the timer it would replace, and how to stop listening. */
interface SessionWaitWake {
  timerId: ReturnType<typeof setTimeout>;
  unsubscribe: () => void;
}

declare global {
  // eslint-disable-next-line no-var
  var __autoYesSessionWaitWakes: Map<string, SessionWaitWake> | undefined;
}

/** compositeKey -> the pending session-wait tick's wake. At most one per poller key. */
const sessionWaitWakes = getOrInitGlobal('__autoYesSessionWaitWakes', () => new Map<string, SessionWaitWake>());

/**
 * Stop listening for the session of `compositeKey` (Issue #3796).
 *
 * @param timerId - Only when the wake is this timer's: the timer firing drops
 *   its own wake, never a successor's
 */
function dropSessionWaitWake(compositeKey: string, timerId?: ReturnType<typeof setTimeout>): void {
  const wake = sessionWaitWakes.get(compositeKey);
  if (wake === undefined || (timerId !== undefined && wake.timerId !== timerId)) return;
  sessionWaitWakes.delete(compositeKey);
  wake.unsubscribe();
}

/**
 * Issue #3796: while the poller waits `MAX_BACKOFF_MS` for its session, the
 * session's creation brings the tick forward to a poll interval — so the first
 * prompt of a session started right after the poller looked (`send --auto-yes`
 * enables Auto-Yes before the session exists) is answered, or its human
 * notified, without waiting out the backoff. The push gate's hold follows the
 * earlier tick (`autoYesHoldEndsAt`).
 *
 * The wake replaces the pending timer and nothing else: it does nothing once
 * that timer fired (the tick drops the wake before it runs, so a tick in flight
 * is never doubled), once another timer replaced it, or once the poller was
 * stopped or replaced (`stopAutoYesPolling` drops it, and `scheduleNextPoll`
 * checks the poller is still the generation's).
 */
function armSessionWaitWake(generation: AutoYesTickGeneration, timerId: ReturnType<typeof setTimeout>): void {
  const { compositeKey, worktreeId, cliToolId, instanceId, pollerState } = generation;
  const sessionName = CLIToolManager.getInstance().getTool(cliToolId).getSessionName(worktreeId, instanceId);
  const unsubscribe = onTmuxSessionCreated(sessionName, () => {
    const wake = sessionWaitWakes.get(compositeKey);
    if (wake === undefined || wake.timerId !== timerId) return;
    sessionWaitWakes.delete(compositeKey);
    if (!isPollerCurrent(generation) || pollerState.timerId !== timerId) return;
    clearTimeout(timerId);
    logger.info('poller:session-created-wake', { worktreeId, cliToolId, instanceId });
    // Still the session wait's tick — the one the push gate's hold is about.
    scheduleNextPoll(generation, POLLING_INTERVAL_MS, { sessionWait: true });
  });
  sessionWaitWakes.set(compositeKey, { timerId, unsubscribe });
}

// =============================================================================
// Public Poller API
// =============================================================================

/**
 * Start server-side auto-yes polling for a worktree/agent instance.
 *
 * Issue #896: per-instance polling. Each agent instance gets its own poller keyed
 * by the (worktreeId, cliToolId, instanceId) composite key, so multiple instances
 * of the same CLI tool on one worktree are polled independently.
 *
 * @param worktreeId - Worktree identifier (must match WORKTREE_ID_PATTERN)
 * @param cliToolId - CLI tool type to poll for
 * @param instanceId - Optional agent instance ID (defaults to the primary instance)
 * @returns Result indicating whether the poller was started
 */
export function startAutoYesPolling(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): StartPollingResult {
  // Validate worktree ID (security)
  if (!isValidWorktreeId(worktreeId)) {
    return { started: false, reason: 'invalid worktree ID' };
  }

  // Resolve the effective instance ID (primary === cliToolId).
  const effectiveInstanceId = instanceId ?? cliToolId;

  // Issue #3730: nothing starts once a shutdown has recorded what it releases —
  // a poller started after the record would be a grant the record never saw.
  if (isAutoYesShutdownStarted()) {
    return { started: false, reason: 'server shutting down' };
  }

  // Check if auto-yes is enabled
  const autoYesState = getAutoYesState(worktreeId, cliToolId, effectiveInstanceId);
  if (!autoYesState?.enabled) {
    return { started: false, reason: 'auto-yes not enabled' };
  }

  const compositeKey = buildCompositeKey(worktreeId, cliToolId, effectiveInstanceId);

  // Check concurrent poller limit (DoS protection)
  const existingPollerState = getPollerState(compositeKey);
  if (!existingPollerState && autoYesPollerStates.size >= MAX_CONCURRENT_POLLERS) {
    return { started: false, reason: 'max concurrent pollers reached' };
  }

  // Issue #501: Idempotency check (key already encodes the instance, so a matching
  // poller is the same instance).
  if (existingPollerState && existingPollerState.cliToolId === cliToolId) {
    return { started: true, reason: 'already_running' };
  }

  // Stop existing poller if cliToolId changed
  if (existingPollerState) {
    stopAutoYesPolling(compositeKey, 'replaced');
  }

  // Create new poller state
  const pollerState: AutoYesPollerState = {
    timerId: null,
    cliToolId,
    instanceId: effectiveInstanceId,
    consecutiveErrors: 0,
    currentInterval: POLLING_INTERVAL_MS,
    lastServerResponseTimestamp: null,
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,
    lastSkipWarnKey: null,
  };
  autoYesPollerStates.set(compositeKey, pollerState);

  // A task may have been recorded moments ago; start from a fresh policy read.
  invalidateSessionAutoYesPolicy(compositeKey);

  // Start polling immediately
  pollerState.timerId = setTimeout(() => {
    void pollAutoYes(worktreeId, cliToolId, effectiveInstanceId, pollerState);
  }, POLLING_INTERVAL_MS);

  logger.info('poller:started', { worktreeId, cliToolId, instanceId: effectiveInstanceId });
  return { started: true };
}

/**
 * Stop server-side auto-yes polling by composite key.
 *
 * Issue #525: Changed from (worktreeId) to (compositeKey).
 *
 * Issue #3730: `reason` is why the POLLER stops, logged on `poller:stopped`. It
 * does not touch the grant: an ID move and a replacement stop the poller and
 * keep the grant, so disabling stays each caller's own decision. Omitted, the
 * reason of an enclosing {@link withPollerStopReason} applies (the lifecycle
 * table's path), else `unspecified`.
 *
 * @param compositeKey - Composite key (worktreeId:cliToolId)
 * @param reason - Why the poller stops
 */
export function stopAutoYesPolling(compositeKey: string, reason?: AutoYesPollerStopReason): void {
  // Issue #3397: before the early return — the disable route and the session
  // cleanup call this for an instance whose poller may already be gone, and the
  // Enter record must not outlive the grant or the session either way.
  forgetEnterFallback(compositeKey);
  // Issue #3821: and the decision, for the same reason.
  forgetAutoYesDecision(compositeKey);
  // Issue #3820: before the early return too — a session ended after its
  // poller had already stopped still abandons the confirmation left on it.
  noteLedgerPollerStopped(compositeKey, resolvePollerStopReason(reason, 'unspecified'));
  const pollerState = getPollerState(compositeKey);
  if (!pollerState) return;

  if (pollerState.timerId) {
    clearTimeout(pollerState.timerId);
  }
  dropSessionWaitWake(compositeKey);

  autoYesPollerStates.delete(compositeKey);
  invalidateSessionAutoYesPolicy(compositeKey);
  logger.info('poller:stopped', { compositeKey, reason: resolvePollerStopReason(reason, 'unspecified') });
}

/**
 * Stop all server-side auto-yes polling (graceful shutdown).
 *
 * Issue #3730: logs `shutdown` unless an enclosing
 * {@link withPollerStopReason} says otherwise (the test reset). Writes nothing
 * to disk: the record of the grants a shutdown released is the server's to
 * make (`lib/auto-yes-shutdown-record`), never a side effect of this.
 */
export function stopAllAutoYesPolling(): void {
  const reason = resolvePollerStopReason(undefined, 'shutdown');
  for (const [key, pollerState] of autoYesPollerStates.entries()) {
    if (pollerState.timerId) {
      clearTimeout(pollerState.timerId);
    }
    dropSessionWaitWake(key);
    invalidateSessionAutoYesPolicy(key);
    noteLedgerPollerStopped(key, reason);
    logger.info('poller:stopped', { compositeKey: key, reason });
  }
  autoYesPollerStates.clear();
  clearEnterFallbacks();
  clearAutoYesDecisions();
  clearPartialAnswers();
}

/**
 * Get all composite keys that have active auto-yes poller entries.
 *
 * Issue #525: Returns composite keys (worktreeId:cliToolId).
 *
 * @returns Array of composite keys present in the autoYesPollerStates Map
 */
export function getAutoYesPollerCompositeKeys(): string[] {
  return Array.from(autoYesPollerStates.keys());
}

// =============================================================================
// byWorktree Helpers (Issue #525)
// =============================================================================

/**
 * Stop all auto-yes polling for a given worktreeId (all agents).
 * [SF-001] Uses shared filterCompositeKeysByWorktree (DRY).
 *
 * @param worktreeId - Worktree identifier
 * @param options.reason - Issue #3730: why the pollers stop, for `poller:stopped`
 * @param options.keepPartialAnswers - Issue #3713 (re-instruction 1, P2-1): the
 *   disable route's "every agent" passes it — a disable, like one agent's
 *   `stopAutoYesPolling`, keeps the memory of an answer stopped part-way and
 *   the sends still in flight, so a disable → enable does not type over a
 *   partial input. Omitted (the worktree being deleted, `session-cleanup` via
 *   `auto-yes-lifecycle`), both are dropped and a late send records nothing.
 */
export function stopAutoYesPollingByWorktree(
  worktreeId: string,
  options?: { keepPartialAnswers?: boolean; reason?: AutoYesPollerStopReason },
): void {
  const pollerKeys = filterCompositeKeysByWorktree(
    Array.from(autoYesPollerStates.keys()),
    worktreeId
  );
  // Issue #3730: `options.reason`, else the enclosing scope's (the lifecycle table).
  pollerKeys.forEach(key => stopAutoYesPolling(key, options?.reason));
  // Issue #3397: and the records of instances whose poller had already stopped.
  forgetEnterFallbacksByWorktree(worktreeId);
  forgetAutoYesDecisionsByWorktree(worktreeId);
  // Issue #3820: and the ledger's confirmations on them — an API approval is
  // opened with Auto-Yes off too, so the running pollers do not name them all.
  noteLedgerWorktreeStopped(worktreeId, resolvePollerStopReason(options?.reason, 'unspecified'));
  if (!options?.keepPartialAnswers) forgetPartialAnswersByWorktree(worktreeId);
}

/**
 * Check if any auto-yes poller is active for a given worktreeId.
 * Uses shared filterCompositeKeysByWorktree (DRY).
 *
 * @param worktreeId - Worktree identifier
 * @returns true if any poller is active for this worktree
 */
export function isAnyPollerActiveForWorktree(worktreeId: string): boolean {
  return filterCompositeKeysByWorktree(
    Array.from(autoYesPollerStates.keys()),
    worktreeId
  ).length > 0;
}
