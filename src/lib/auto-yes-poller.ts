/**
 * Auto-Yes Poller - Server-side polling for auto-yes prompt responses.
 *
 * Extracted from auto-yes-manager.ts (Issue #479) to separate polling logic
 * from state management.
 *
 * Issue #525: Composite key migration (worktreeId:cliToolId) for per-agent auto-yes.
 *
 * Dependencies: auto-yes-state.ts (composite keys / state), polling/* (prompt
 * detection, resolver, policy, dialog gate, enter fallback, poller state),
 * cli-tools/*, session/cli-session.ts, tmux/*, detection/*, db/*, tasks/*.
 */

import type { CLIToolType } from './cli-tools/types';
import { captureSessionOutputFresh, getSessionPresence } from './session/cli-session';
import { detectPromptOnCleanFrame } from './polling/response-checker';
import {
  beginAntigravityFrameRead,
  endAntigravityFrameRead,
} from './polling/antigravity-receipt-episodes';
import { policyLookupMode, resolveAutoAnswerWithPolicy } from './polling/auto-yes-resolver';
import {
  getSessionAutoYesPolicy,
  invalidateSessionAutoYesPolicy,
} from './polling/auto-yes-policy';
import { isCodexModelPickerFrame } from './detection/tools/codex/detect';
import { normalizeFrame } from './detection/tools/frame';
import { detectAntigravityNumberedDialogPrompt } from './detection/tools/antigravity/dialog';
import { evaluateAutoYesDialogGate, type AutoYesDialogGateVerdict } from './polling/auto-yes-dialog-gate';
import {
  clearEnterFallbacks,
  enterFallbackScreenKey,
  forgetEnterFallback,
  forgetEnterFallbacksByWorktree,
  getEnterFallbackSessionEpoch,
  judgeEnterFallback,
  recordEnterFallbackNoEffect,
  recordEnterFallbackSent,
} from './polling/auto-yes-enter-fallback';
import { applyEventToActiveTask } from './tasks/task-transition-service';
import { getDbInstance } from './db/db-instance';
import { recordAnsweredPrompt, type RecordAnsweredPromptResult } from './db/chat-db';
import { checkWorktreeSessionOwnership } from './cli-tools/worktree-session-ownership';
import { sendPromptAnswer } from './prompt-answer-sender';
import { isMultiSelectPrompt } from './prompt-answer-semantic';
import { sendSpecialKeys } from './tmux/tmux';
import { onTmuxSessionCreated } from './tmux/session-created-signal';
import { CLIToolManager } from './cli-tools/manager';
import { stripAnsi, stripBoxDrawing, detectThinking, getCodexLifecycleDialog } from './detection/cli-patterns';
import { generatePromptKey } from './detection/prompt-key';
import type { PromptDetectionResult } from './detection/types';
import { getErrorMessage } from './errors';
import { invalidateCache } from './tmux/tmux-capture-cache';
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
  warnOncePerFrame,
  type AutoYesPollerState,
  type AutoYesSendAttempt,
} from './polling/auto-yes-poller-state';
import {
  suppressAndWarnOnce,
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
  isPollerCurrent,
  isSameSession,
  isTickCurrent,
  ownedPollerState,
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
import { AUTO_YES_ENTER_FALLBACK_ANSWER, syncEnterFallbackEpoch } from './polling/auto-yes-poller-enter-fallback';
import { capturePollerFrame } from './polling/auto-yes-poller-capture';
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
  resolveAnswerUnderPolicy,
  skippedForUnownedSession,
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
 * Issue #3397: is the fresh capture still the screen the Enter was decided for?
 * Re-reads it the way one tick does — prompt reading, the same `promptFrameKey`,
 * codex's launch dialogs and `/model` picker, the dialog gate refusing with no
 * dialog vouched for, and `judgeEnterFallback` (input box off screen, tool
 * alive, not thinking). The policy and the checkbox rule read `promptData`,
 * which the equal `promptFrameKey` already pins (type, question, options).
 */
function isStillEnterFallbackScreen(prompt: JudgedPrompt, fresh: string): boolean {
  const { worktreeId, cliToolId, instanceId, frameKey } = prompt;
  const clean = stripBoxDrawing(stripAnsi(fresh));
  const frame = normalizeFrame(fresh, cliToolId);
  const detection = detectPromptOnCleanFrame(
    clean,
    cliToolId,
    clean.split('\n'),
    fresh,
    { worktreeId, instanceId },
    frame,
  );
  if (!detection.isPrompt || !detection.promptData) return false;
  if (promptFrameKey(detection.promptData) !== frameKey) return false;
  if (cliToolId === 'codex' && (getCodexLifecycleDialog(frame) || isCodexModelPickerFrame(frame))) {
    return false;
  }
  const gate = evaluateAutoYesDialogGate(cliToolId, detection.promptData.type, frame);
  if (gate.allowed || gate.dialog !== null) return false;
  return judgeEnterFallback(cliToolId, fresh).eligible;
}

/**
 * Issue #3397: a frame the dialog gate refused may still be a choice screen
 * CommandMate cannot read — the one the prompt window offers direct input for.
 * Send ONE Enter there (confirm whatever is selected), under every condition
 * `judgeEnterFallback` and this function check; otherwise record the refusal as
 * step 3.5 always did.
 *
 * Order, each one able to stop the Enter:
 *  1. `judgeEnterFallback` (rollout table, refusal, composer off screen, tool
 *     alive, not thinking) — and the gate must not have vouched for a dialog it
 *     refused to type into (opencode's `keys` strip, #1893);
 *  2. the screen already had its Enter: record `no-effect`, send nothing;
 *  3. the contract policy, exactly as step 4 applies it (mode, allow-listed
 *     types, deny patterns over the question, options and `approvalTarget`);
 *     a prompt the base rules would not answer (multi-select, typed text) gets
 *     nothing either;
 *  4. the screen must have been eligible on the previous tick as well;
 *  5. the session must be this server's (#2865);
 *  6. a capture taken now, past the capture cache, must still be that screen
 *     ({@link isStillEnterFallbackScreen}).
 *
 * Issue #3706: with a `generation` (a tick of `pollAutoYes`), the waits of
 * steps 5 and 6 are each followed by {@link isTickCurrent}; a tick that lost
 * its generation sends nothing and changes nothing.
 *
 * @returns true when the Enter was sent; the caller returns `responded`
 */
async function tryEnterFallback(
  prompt: JudgedPrompt,
  promptDetection: PromptDetectionResult,
  dialogGate: AutoYesDialogGateVerdict,
  rawOutput: string | undefined,
  generation?: AutoYesTickGeneration,
): Promise<boolean> {
  const { worktreeId, cliToolId, instanceId, pollerState, promptData, frameKey } = prompt;

  const judgement = dialogGate.dialog === null ? judgeEnterFallback(cliToolId, rawOutput) : null;
  if (judgement === null || !judgement.eligible) {
    pollerState.enterFallbackCandidateKey = null;
    suppressUnclassifiedFrame(prompt, dialogGate);
    return false;
  }

  const screenKey = enterFallbackScreenKey(promptData);

  // 2. The Enter did not move the screen on. Another one would be a guess.
  if (pollerState.enterFallbackSentKey === frameKey) {
    pollerState.enterFallbackCandidateKey = null;
    recordEnterFallbackNoEffect(worktreeId, cliToolId, instanceId, screenKey);
    suppressUnclassifiedFrame(prompt, dialogGate);
    warnOncePerFrame(pollerState, `${frameKey}\u0000enter-fallback-no-effect`, 'poller:auto-yes-enter-fallback-no-effect', {
      worktreeId,
      cliToolId,
      instanceId,
      promptType: promptData.type,
      refusalReason: judgement.refusalReason,
    });
    return false;
  }

  // 3. The contract policy, as step 4 reads it (Issue #3822: a failed lookup withholds).
  const policy = getSessionAutoYesPolicy(worktreeId, cliToolId, instanceId);
  const resolution = resolveAutoAnswerWithPolicy(promptData, policy);
  if (resolution.suppressedBy) {
    pollerState.enterFallbackCandidateKey = null;
    const mode = policyLookupMode(policy);
    suppressAndWarnOnce(
      prompt,
      {
        reason: resolution.suppressedBy,
        mode,
        promptType: promptData.type,
        pattern: resolution.pattern,
      },
      `${frameKey}\u0000${resolution.suppressedBy}\u0000${mode ?? ''}\u0000${resolution.pattern ?? ''}`,
      'poller:auto-yes-suppressed-by-policy',
      {
        reason: resolution.suppressedBy,
        mode,
        pattern: resolution.pattern,
        promptType: promptData.type,
        enterFallback: true,
      },
    );
    return false;
  }
  // A checkbox list is out of scope whatever the parser's flag says: the
  // labels' boxes (`[ ]` / `[x]` / `[X]` / `[✔]`, the one reading in
  // `prompt-answer-semantic` the sender shares) count too, so an Enter never
  // submits a half-ticked list (Issue #3397; the base rules' #2755 reading
  // covers `multiSelect` only).
  if (
    resolution.answer === null ||
    (promptData.type === 'multiple_choice' && isMultiSelectPrompt(promptData))
  ) {
    pollerState.enterFallbackCandidateKey = null;
    suppressUnclassifiedFrame(prompt, dialogGate);
    return false;
  }

  // 4. Seen once: wait for the next tick to see the same screen again.
  // Nothing is recorded as withheld here: Auto-Yes is about to answer, and a
  // fresh `lastSuppression` would make `cmate wait` report the prompt to a
  // human at once instead of holding for Auto-Yes (#2463).
  if (pollerState.enterFallbackCandidateKey !== frameKey) {
    pollerState.enterFallbackCandidateKey = frameKey;
    logger.debug('poller:auto-yes-enter-fallback-candidate', {
      worktreeId,
      cliToolId,
      instanceId,
      promptType: promptData.type,
    });
    return false;
  }

  // 5. Never another server's session (Issue #2865).
  const sessionName = CLIToolManager.getInstance().getTool(cliToolId).getSessionName(worktreeId, instanceId);
  const ownership = await checkWorktreeSessionOwnership(worktreeId, sessionName);
  if (generation !== undefined && !isTickCurrent(generation)) return false;
  if (ownership === null || ownership.verdict === 'foreign') {
    // Issue #3820: the ledger's own reason, as `skippedForUnownedSession` records it.
    withholdLedgerConfirmation(prompt, 'foreign-session');
    warnOncePerFrame(
      pollerState,
      `${frameKey}\u0000${sessionName}\u0000${ownership ? 'foreign' : 'worktree_not_found'}`,
      'poller:auto-yes-skipped-foreign-session',
      {
        worktreeId,
        cliToolId,
        instanceId,
        sessionName,
        sessionPath: ownership?.sessionPath ?? null,
        reason: ownership ? 'foreign' : 'worktree_not_found',
        enterFallback: true,
      },
    );
    return false;
  }

  // 6. The last look before the key, at a capture taken NOW. The two ticks of
  // step 4 read through the capture cache, whose TTL is longer than the poll
  // interval, so "seen twice" can be one stale frame read twice: a redraw caught
  // with its input box missing (#2457's repaint) while the real pane already
  // has the box back. Everything that decided the Enter is judged again on the
  // fresh frame; any difference sends nothing, and the next tick starts over.
  const fresh = await captureSessionOutputFresh(
    worktreeId,
    cliToolId,
    (rawOutput ?? '').split('\n').length,
    instanceId,
  );
  if (generation !== undefined && !isTickCurrent(generation)) return false;
  if (!isStillEnterFallbackScreen(prompt, fresh)) {
    pollerState.enterFallbackCandidateKey = null;
    logger.debug('poller:auto-yes-enter-fallback-fresh-frame-differs', {
      worktreeId,
      cliToolId,
      instanceId,
      promptType: promptData.type,
    });
    return false;
  }

  const receiptEpisode = receiptEpisodeOfSend(cliToolId, worktreeId, instanceId);
  // Issue #3820: taken before the await, so the result goes to this confirmation.
  const ledgerAttempt = beginLedgerAttempt(prompt, 'enter-fallback');
  try {
    await sendSpecialKeys(sessionName, ['Enter']);
  } catch (error) {
    // Issue #3796: the Enter may or may not have reached the pane.
    noteAnswerSent(cliToolId, worktreeId, instanceId, true, receiptEpisode);
    settleLedgerAttempt(ledgerAttempt, 'failed');
    throw error;
  } finally {
    invalidateCache(sessionName);
  }
  // Issue #3796 review E: the Enter is out — for the episode it began for only.
  noteAnswerSent(cliToolId, worktreeId, instanceId, false, receiptEpisode);
  settleLedgerAttempt(ledgerAttempt, 'ok');

  // Issue #3706: the Enter is out, but the per-screen record is the CURRENT
  // session's: when the poller was stopped (the record was forgotten with it)
  // or a new session began while `send-keys` was awaited, the return of this
  // send must not put the record back. The audit row below is kept either way.
  if (generation === undefined || (isPollerCurrent(generation) && isSameSession(generation))) {
    pollerState.enterFallbackSentKey = frameKey;
    pollerState.enterFallbackCandidateKey = null;
    recordEnterFallbackSent(worktreeId, cliToolId, instanceId, {
      promptType: promptData.type,
      refusalReason: judgement.refusalReason,
      screenKey,
      ...(generation !== undefined ? { epoch: generation.sessionEpoch } : {}),
    });
  }
  logger.info('poller:auto-yes-enter-fallback-sent', {
    worktreeId,
    cliToolId,
    instanceId,
    promptType: promptData.type,
    refusalReason: judgement.refusalReason,
    composerState: judgement.composerState,
  });

  await finishAnsweredPrompt(prompt, promptDetection, AUTO_YES_ENTER_FALLBACK_ANSWER, generation);
  return true;
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
 */
async function finishAnsweredPrompt(
  prompt: JudgedPrompt,
  promptDetection: PromptDetectionResult,
  answer: string,
  generation?: AutoYesTickGeneration,
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
  // option number, `y`, or `[Enter]`) — so an answer that should not have been
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
      promptData,
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
  return { frame, promptDetection };
}

/**
 * What `detectAndRespondToPrompt` does to the poller state on a frame with no
 * prompt to answer, before it returns `no_prompt`.
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
}): void {
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
  } = tick;
  forgetPartialAnswer(compositeKey);
  pollerState.lastAnsweredPromptKey = null;
  pollerState.lastAnsweredAt = null;
  pollerState.enterFallbackCandidateKey = null;
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
    return;
  }
  pollerState.lastSkipWarnKey = null;
  if (cliToolId === 'antigravity' && !promptDetection.isPrompt) {
    const seen = logIfWithheldForWantOfReceipt(worktreeId, instanceId, compositeKey, () =>
      detectPromptOnCleanFrame(cleanOutput, cliToolId, precomputedLines, rawOutput),
    );
    // Issue #3820: past the receipt window the gated reading says "no prompt"
    // while the dialog is still up. The ungated reading says it is, so the
    // ledger keeps the same confirmation (and the same withheld interval)
    // rather than closing it on every tick outside the window.
    if (seen !== null) {
      const scope: LedgerScope = { compositeKey, worktreeId, cliToolId, instanceId };
      observeLedgerScreen(scope, ledgerScreenKey(seen.promptData), seen.promptData.type);
      if (seen.reason !== null) withholdLedgerConfirmation(scope, seen.reason);
    }
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
  if (attempt !== null) settleSendAttempt(attempt, false);
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
 *   wait before a key — the ownership check, the Enter fallback's fresh capture,
 *   each wait inside the send — is followed by {@link isTickCurrent}, and a tick
 *   that lost it types nothing more and returns `no_answer`. Omitted (direct
 *   callers, tests), nothing is checked, as before.
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
  generation?: AutoYesTickGeneration
): Promise<'responded' | 'no_prompt' | 'duplicate' | 'no_answer' | 'error'> {
  const compositeKey = buildCompositeKey(worktreeId, cliToolId, instanceId);
  // Issue #3706 / #3713: the send in flight, settled without an await once it
  // comes back — as a partial answer when it was stopped with keys on the pane.
  let attempt: AutoYesSendAttempt | null = null;
  // Issue #3796: `sendPromptAnswer` began and has not returned — a throw now cut
  // the send short, and the agy receipt gate is told so (`noteAnswerSent`).
  let sendInFlight = false;
  let receiptEpisode: number | null = null;
  // Issue #3820: the ledger's tick. A tick that read the screen and saw no
  // confirmation closes the open one as gone when it ends (`endLedgerTick`).
  const ledgerScope: LedgerScope = { compositeKey, worktreeId, cliToolId, instanceId };
  const ledgerTick = beginLedgerTick(ledgerScope);
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
    );

    if (!promptDetection.isPrompt || !promptDetection.promptData) {
      noteNoPromptOnScreen({
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
      });
      return 'no_prompt';
    }

    // Issue #3820: computed here, before the duplicate check, so the ledger
    // sees the confirmation on every tick it is on screen (step 2.5 below
    // reads the same key).
    // The ledger's own key keeps the body (`ledgerScreenKey`): two commands
    // that differ by a `>` or an indent are two confirmations to count.
    const screenKey = partialAnswerScreenKey(promptDetection.promptData);
    observeLedgerScreen(ledgerScope, ledgerScreenKey(promptDetection.promptData), promptDetection.promptData.type);

    // 2. Check for duplicate prompt (Issue #306)
    const promptKey = generatePromptKey(promptDetection.promptData);
    const frameKey = promptFrameKey(promptDetection.promptData);
    if (isDuplicatePrompt(pollerState, promptKey)) {
      // Issue #3820: not answered on this tick either — an interval of its own
      // reason, so the count can tell the wait for an answer to land apart.
      withholdLedgerConfirmation(ledgerScope, 'answered-recently');
      return 'duplicate';
    }

    const judged: JudgedPrompt = {
      worktreeId,
      cliToolId,
      instanceId,
      compositeKey,
      pollerState,
      promptData: promptDetection.promptData,
      promptKey,
      frameKey,
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
      return 'no_answer';
    }

    // 3., 3.2., 3.5. Frames that are not Auto-Yes's to answer: see
    // `suppressIfNotOursToAnswer`.
    const notOurs = suppressIfNotOursToAnswer(judged, frame);
    if (notOurs.kind !== 'dialog-gate-refused') {
      pollerState.enterFallbackCandidateKey = null;
    }
    if (notOurs.kind === 'left-alone') {
      return 'no_answer';
    }
    // 3.6. Issue #3397: a refused frame may be a choice screen CommandMate
    // cannot read; with Auto-Yes on it gets one Enter. See `tryEnterFallback`.
    if (notOurs.kind === 'dialog-gate-refused') {
      if (!(await tryEnterFallback(judged, promptDetection, notOurs.dialogGate, rawOutput, generation))) {
        return 'no_answer';
      }
      return 'responded';
    }

    // 4. Resolve auto answer under the execution contract's policy (Issue #1547).
    // Auto-Yes reads the frame itself instead of going through status-detector
    // (it shares the reader, not the verdict), so this is the only place the policy can gate an
    // auto-answer: a prompt the policy withholds is left for a human, and the
    // response poller's prompt path (WS broadcast + Web Push, see
    // polling/response-checker.ts) is what tells them it is waiting.
    const answer = resolveAnswerUnderPolicy(judged);
    if (answer === null) {
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
      return 'no_answer';
    }

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

    // 6., 7. The answer reached tmux: see `finishAnsweredPrompt`.
    await finishAnsweredPrompt(judged, promptDetection, answer, generation);

    return 'responded';
  } catch (error) {
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
  };
  // Issue #3796: this is the session wait's tick (it was scheduled as one) —
  // recorded before anything can fail, for the push gate.
  if (pollerState!.sessionWaitTickAt !== undefined) pollerState!.sessionWaitTickRanAt = generation.startedAt;

  try {
    // 2. Capture and clean output
    const captureLines = grant.stopPattern
      ? FULL_CAPTURE_LINES
      : REDUCED_CAPTURE_LINES;
    // Issue #2522: one capture, both spellings. The cleaned string drives every
    // step below exactly as it did; the raw one is carried to the prompt reading
    // so a dialog anchored on box drawing is not invisible to the one path that
    // can answer it without a human.
    const { raw: rawOutput, clean: cleanOutput } = await capturePollerFrame(
      worktreeId,
      cliToolId,
      captureLines,
      instanceId,
    );
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
