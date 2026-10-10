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
import { captureSessionOutput, captureSessionOutputFresh, getSessionPresence } from './session/cli-session';
import { detectPromptOnCleanFrame } from './polling/response-checker';
import {
  ANTIGRAVITY_PERMISSION_RECEIPT_WINDOW_MS,
  hasRecentAntigravityPermissionReceipt,
} from './polling/antigravity-permission-receipts';
import { resolveAutoAnswerWithPolicy } from './polling/auto-yes-resolver';
import { getSessionAutoYesPolicy, invalidateSessionAutoYesPolicy } from './polling/auto-yes-policy';
import { isCodexModelPickerFrame } from './detection/tools/codex/detect';
import { normalizeFrame } from './detection/tools/frame';
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
} from '@/config/auto-yes-config';
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
  DUPLICATE_RETRY_EXPIRY_MS,
  MAX_CONCURRENT_POLLERS,
  THINKING_CHECK_LINE_COUNT,
} from './auto-yes-state';
import { getOrInitGlobal } from './global-state';
import { promptFrameKey, warnOncePerFrame, type AutoYesPollerState } from './polling/auto-yes-poller-state';
import {
  suppressAndWarnOnce,
  suppressIfNotOursToAnswer,
  suppressUnclassifiedFrame,
  type JudgedPrompt,
} from './polling/auto-yes-prompt-suppression';

export type { AutoYesPollerState } from './polling/auto-yes-poller-state';

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

// =============================================================================
// In-memory State (globalThis for hot reload persistence - Issue #153)
// Issue #525: Map key changed from worktreeId to compositeKey
// =============================================================================

declare global {
  // eslint-disable-next-line no-var
  var __autoYesPollerStates: Map<string, AutoYesPollerState> | undefined;
  // eslint-disable-next-line no-var
  var __autoYesWithheldNoReceiptLoggedAt: Map<string, number> | undefined;
}

/** In-memory storage for poller states (globalThis for hot reload persistence) */
const autoYesPollerStates = getOrInitGlobal('__autoYesPollerStates', () => new Map<string, AutoYesPollerState>());

/**
 * When `antigravity-autoyes-withheld-no-hook-receipt` was last logged, per
 * compositeKey (Issue #2857). The poller re-reads a static pane every 2s, so the
 * line is limited to one per {@link WITHHELD_NO_RECEIPT_LOG_INTERVAL_MS} per
 * instance. globalThis for the same reason as the poller states above.
 */
const withheldNoReceiptLoggedAt = getOrInitGlobal('__autoYesWithheldNoReceiptLoggedAt', () => new Map<string, number>());

/** Least gap between two `antigravity-autoyes-withheld-no-hook-receipt` lines for one instance. */
const WITHHELD_NO_RECEIPT_LOG_INTERVAL_MS = 60_000;

// =============================================================================
// Poller State Accessors (compositeKey-based)
// =============================================================================

/**
 * Get poller state by composite key.
 *
 * @param compositeKey - Composite key (worktreeId:cliToolId)
 * @returns Poller state or undefined
 */
function getPollerState(compositeKey: string): AutoYesPollerState | undefined {
  return autoYesPollerStates.get(compositeKey);
}

/**
 * Get the number of active pollers.
 */
export function getActivePollerCount(): number {
  return autoYesPollerStates.size;
}

/**
 * Clear all poller states.
 * Stops all active pollers before clearing state.
 * @internal Exported for testing purposes only.
 */
export function clearAllPollerStates(): void {
  stopAllAutoYesPolling();
  autoYesPollerStates.clear();
  withheldNoReceiptLoggedAt.clear();
}

/**
 * Get the last server response timestamp for a composite key.
 *
 * Issue #525: Changed from (worktreeId) to (compositeKey).
 *
 * @param compositeKey - Composite key (worktreeId:cliToolId)
 * @returns Timestamp (Date.now()) of the last server response, or null if none
 */
export function getLastServerResponseTimestamp(compositeKey: string): number | null {
  const pollerState = getPollerState(compositeKey);
  return pollerState?.lastServerResponseTimestamp ?? null;
}

/**
 * Check if a server-side auto-yes poller is active for a composite key.
 *
 * Issue #525: Changed from (worktreeId) to (compositeKey).
 *
 * @param compositeKey - Composite key (worktreeId:cliToolId)
 * @returns true if a poller is actively running
 */
export function isPollerActive(compositeKey: string): boolean {
  return autoYesPollerStates.has(compositeKey);
}

/**
 * Update the last server response timestamp.
 *
 * @param compositeKey - Composite key
 * @param timestamp - Timestamp value (Date.now())
 */
function updateLastServerResponseTimestamp(compositeKey: string, timestamp: number): void {
  const pollerState = getPollerState(compositeKey);
  if (pollerState) {
    pollerState.lastServerResponseTimestamp = timestamp;
  }
}

/**
 * Reset error count for a poller and restore the default polling interval.
 * Called after every poll that ran to the end without an error (Issue #3329)
 * and after an answer is sent.
 *
 * @param compositeKey - Composite key
 */
function resetErrorCount(compositeKey: string): void {
  const pollerState = getPollerState(compositeKey);
  if (pollerState) {
    pollerState.consecutiveErrors = 0;
    pollerState.currentInterval = POLLING_INTERVAL_MS;
  }
}

/**
 * Increment error count and apply backoff if the threshold is exceeded.
 * [IA-MF-001] compositeKey-based: extracts worktreeId/cliToolId for disableAutoYes.
 *
 * @param compositeKey - Composite key
 */
function incrementErrorCount(compositeKey: string): void {
  const pollerState = getPollerState(compositeKey);
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
      stopAutoYesPolling(compositeKey);
    }
  }
}

/**
 * Check if the given prompt has already been answered recently.
 *
 * @param pollerState - Current poller state
 * @param promptKey - Composite key of the current prompt
 * @returns true if the prompt key matches and is within the retry expiry window
 */
function isDuplicatePrompt(
  pollerState: AutoYesPollerState,
  promptKey: string
): boolean {
  if (pollerState.lastAnsweredPromptKey !== promptKey) return false;
  if (pollerState.lastAnsweredAt === null) return false;
  return (Date.now() - pollerState.lastAnsweredAt) < DUPLICATE_RETRY_EXPIRY_MS;
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
    stopAutoYesPolling(compositeKey);
    return 'expired';
  }

  // Issue #896: resolve instanceId so per-instance enabled state is checked.
  const instanceId = extractInstanceId(compositeKey) ?? undefined;
  const autoYesState = getAutoYesState(worktreeId, cliToolId, instanceId);
  if (!autoYesState?.enabled) {
    stopAutoYesPolling(compositeKey);
    return 'expired';
  }

  return 'valid';
}

/**
 * One tick's capture, in the two spellings this poller needs (Issue #2522).
 *
 * The poller has always cleaned its capture once and thrown the original away.
 * That is the right trade for everything it did with it — the stop-condition
 * delta, the thinking check, the dialog gate and the generic prompt parser all
 * want text with no ANSI and no box drawing — and it is exactly what made
 * Command Code's `AskUserQuestion` unreadable HERE while the status API
 * published it: that screen is anchored on a 200-column U+2500 rule row, and
 * `stripBoxDrawing` blanks precisely that row.
 *
 * So the original is kept instead of being re-derived. Not re-captured: a second
 * `capture-pane` is a second instant, and answering a dialog read off one frame
 * with keys aimed at another is the race `/prompt-response`'s `verifiedFrame`
 * already exists to close. And not "un-cleaned": `stripBoxDrawing` is lossy and
 * non-idempotent, so there is nothing to restore.
 */
export interface CapturedPollerFrame {
  /** The capture exactly as tmux returned it: ANSI and box drawing intact. */
  readonly raw: string;
  /** `stripBoxDrawing(stripAnsi(raw))` — the spelling every other step reads. */
  readonly clean: string;
}

/**
 * Capture tmux session output once, keeping both spellings (Issue #2522).
 *
 * @internal Exported for testing purposes only.
 * @param worktreeId - Worktree identifier
 * @param cliToolId - CLI tool type being polled
 * @param captureLines - Optional number of lines to capture
 * @param instanceId - Optional agent instance ID (Issue #896; defaults to primary session)
 * @returns The tick's raw capture and its cleaned form
 */
export async function capturePollerFrame(
  worktreeId: string,
  cliToolId: CLIToolType,
  captureLines?: number,
  instanceId?: string
): Promise<CapturedPollerFrame> {
  const lines = captureLines ?? FULL_CAPTURE_LINES;
  const output = await captureSessionOutput(worktreeId, cliToolId, lines, instanceId);
  return { raw: output, clean: stripBoxDrawing(stripAnsi(output)) };
}

/**
 * Capture tmux session output and strip ANSI escape codes.
 *
 * Kept as the cleaned half of {@link capturePollerFrame} so the many callers and
 * tests that only ever wanted that string are untouched; `pollAutoYes` takes the
 * pair. `stripBoxDrawing` still runs exactly once per capture either way.
 *
 * @internal Exported for testing purposes only.
 * @param worktreeId - Worktree identifier
 * @param cliToolId - CLI tool type being polled
 * @param captureLines - Optional number of lines to capture
 * @param instanceId - Optional agent instance ID (Issue #896; defaults to primary session)
 * @returns Cleaned output string (ANSI stripped)
 */
export async function captureAndCleanOutput(
  worktreeId: string,
  cliToolId: CLIToolType,
  captureLines?: number,
  instanceId?: string
): Promise<string> {
  return (await capturePollerFrame(worktreeId, cliToolId, captureLines, instanceId)).clean;
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
    return checkStopCondition(compositeKey, newContent, stopAutoYesPolling);
  } else if (cleanOutput.length < baseline) {
    pollerState.stopCheckBaselineLength = cleanOutput.length;
  }

  return false;
}

/**
 * Say, once a minute, that Auto-Yes left an agy dialog alone for want of a hook
 * receipt (Issue #2857).
 *
 * `detectPromptOnCleanFrame` hands a frame the receipt gate (#2849) withholds
 * back as an ordinary `isPrompt: false`, so the poller cannot tell "no dialog on
 * the pane" from "a dialog agy never asked us about" by looking at the result.
 * The gate is the ONLY thing `receiptScope` changes, so the same frame read
 * without it answering a prompt is exactly the withheld case. That second
 * reading is taken only after the cheap tests: no receipt for this instance in
 * the window (with one, the gate let the frame through and a no-prompt result is
 * a real one) and no line for it in the last minute.
 *
 * Why it is worth a line: a machine whose `~/.gemini/config/hooks.json` points at
 * another server (#2622) never sends us the question, and every real dialog then
 * waits for a human with no sign of why. The line names the file to look at.
 * The response-checker's own `antigravity-dialog-no-recent-receipt` stays at
 * debug — it prints on every tick the same pane is read again.
 *
 * @param compositeKey - The instance's key, for the once-a-minute limit
 * @param readWithoutGate - The same frame read without `receiptScope`
 */
function logIfWithheldForWantOfReceipt(
  worktreeId: string,
  instanceId: string | undefined,
  compositeKey: string,
  readWithoutGate: () => PromptDetectionResult,
): void {
  if (hasRecentAntigravityPermissionReceipt(worktreeId, 'antigravity', instanceId)) return;

  const now = Date.now();
  const lastLoggedAt = withheldNoReceiptLoggedAt.get(compositeKey);
  if (lastLoggedAt !== undefined && now - lastLoggedAt < WITHHELD_NO_RECEIPT_LOG_INTERVAL_MS) return;

  const ungated = readWithoutGate();
  if (!ungated.isPrompt || !ungated.promptData) return;

  for (const [key, loggedAt] of withheldNoReceiptLoggedAt) {
    if (now - loggedAt >= WITHHELD_NO_RECEIPT_LOG_INTERVAL_MS) withheldNoReceiptLoggedAt.delete(key);
  }
  withheldNoReceiptLoggedAt.set(compositeKey, now);
  logger.info('antigravity-autoyes-withheld-no-hook-receipt', {
    worktreeId,
    instanceId: instanceId ?? 'antigravity',
    windowMs: ANTIGRAVITY_PERMISSION_RECEIPT_WINDOW_MS,
    hint: 'hook の受信記録が直近に無いため Auto-Yes は答えなかった。~/.gemini/config/hooks.json の向き先（#2622）を確認',
  });
}

/**
 * The audit row's `answer` for the Enter (Issue #3397): not a digit, so the
 * History reads as "Auto-Yes pressed Enter" rather than as a chosen option.
 */
export const AUTO_YES_ENTER_FALLBACK_ANSWER = '[Enter]';

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
 * @returns true when the Enter was sent; the caller returns `responded`
 */
async function tryEnterFallback(
  prompt: JudgedPrompt,
  promptDetection: PromptDetectionResult,
  dialogGate: AutoYesDialogGateVerdict,
  rawOutput: string | undefined,
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

  // 3. The contract policy, as step 4 reads it.
  const policy = getSessionAutoYesPolicy(worktreeId, cliToolId, instanceId);
  const resolution = resolveAutoAnswerWithPolicy(promptData, policy);
  if (resolution.suppressedBy) {
    pollerState.enterFallbackCandidateKey = null;
    suppressAndWarnOnce(
      prompt,
      {
        reason: resolution.suppressedBy,
        mode: policy?.mode ?? null,
        promptType: promptData.type,
        pattern: resolution.pattern,
      },
      `${frameKey}\u0000${resolution.suppressedBy}\u0000${policy?.mode ?? ''}\u0000${resolution.pattern ?? ''}`,
      'poller:auto-yes-suppressed-by-policy',
      {
        reason: resolution.suppressedBy,
        mode: policy?.mode ?? null,
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
  if (ownership === null || ownership.verdict === 'foreign') {
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

  try {
    await sendSpecialKeys(sessionName, ['Enter']);
  } finally {
    invalidateCache(sessionName);
  }

  pollerState.enterFallbackSentKey = frameKey;
  pollerState.enterFallbackCandidateKey = null;
  recordEnterFallbackSent(worktreeId, cliToolId, instanceId, {
    promptType: promptData.type,
    refusalReason: judgement.refusalReason,
    screenKey,
  });
  logger.info('poller:auto-yes-enter-fallback-sent', {
    worktreeId,
    cliToolId,
    instanceId,
    promptType: promptData.type,
    refusalReason: judgement.refusalReason,
    composerState: judgement.composerState,
  });

  await finishAnsweredPrompt(prompt, promptDetection, AUTO_YES_ENTER_FALLBACK_ANSWER);
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
 */
async function finishAnsweredPrompt(
  prompt: JudgedPrompt,
  promptDetection: PromptDetectionResult,
  answer: string,
): Promise<void> {
  const { worktreeId, cliToolId, instanceId, compositeKey, pollerState, promptData, promptKey } =
    prompt;

  // 6. Update timestamp and reset error count
  updateLastServerResponseTimestamp(compositeKey, Date.now());
  resetErrorCount(compositeKey);

  // 7. Record answered prompt key and timestamp
  pollerState.lastAnsweredPromptKey = promptKey;
  pollerState.lastAnsweredAt = Date.now();
  pollerState.lastSkipWarnKey = null;

  logger.info('poller:response-sent', { worktreeId, cliToolId, instanceId });

  // Issue #1548: the prompt was answered without a human. Raised only after
  // the keys actually reached tmux, so a send that threw is not logged as an
  // answer. No-ops when this instance is not running a contract.
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
  startResponsePolling(worktreeId, cliToolId, instanceId);
  void broadcastTerminalSnapshotAfterInteraction(worktreeId, cliToolId, instanceId);
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
 * @returns 'responded' | 'no_prompt' | 'duplicate' | 'no_answer' | 'error'
 */
export async function detectAndRespondToPrompt(
  worktreeId: string,
  pollerState: AutoYesPollerState,
  cliToolId: CLIToolType,
  cleanOutput: string,
  precomputedLines?: string[],
  instanceId?: string,
  rawOutput?: string
): Promise<'responded' | 'no_prompt' | 'duplicate' | 'no_answer' | 'error'> {
  const compositeKey = buildCompositeKey(worktreeId, cliToolId, instanceId);
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
    // Issue #3397: a session begun since the last tick (a relaunch the poller
    // outlived) starts with no screen that had its Enter.
    const epoch = getEnterFallbackSessionEpoch(compositeKey);
    if ((pollerState.enterFallbackEpoch ?? 0) !== epoch) {
      pollerState.enterFallbackSentKey = null;
      pollerState.enterFallbackCandidateKey = null;
      pollerState.enterFallbackEpoch = epoch;
    }

    const receiptScope = { worktreeId, instanceId };
    // Issue #3183: the ONE frame every judgement below reads — normalised once,
    // from the capture as captured (the input-box markers are rule rows the
    // cleaned spelling has blanked), and handed as the same object to the
    // prompt reading, the codex launch guards and the dialog gate. That is what
    // makes "the status chain and Auto-Yes read the same live region" a fact
    // rather than a hope: there is no second normalisation to disagree with.
    const frame = normalizeFrame(rawOutput ?? cleanOutput, cliToolId);
    const promptDetection = detectPromptOnCleanFrame(
      cleanOutput,
      cliToolId,
      precomputedLines,
      rawOutput,
      receiptScope,
      frame,
    );

    if (!promptDetection.isPrompt || !promptDetection.promptData) {
      pollerState.lastAnsweredPromptKey = null;
      pollerState.lastAnsweredAt = null;
      pollerState.lastSkipWarnKey = null;
      pollerState.enterFallbackCandidateKey = null;
      if (cliToolId === 'antigravity' && !promptDetection.isPrompt) {
        logIfWithheldForWantOfReceipt(worktreeId, instanceId, compositeKey, () =>
          detectPromptOnCleanFrame(cleanOutput, cliToolId, precomputedLines, rawOutput),
        );
      }
      return 'no_prompt';
    }

    // 2. Check for duplicate prompt (Issue #306)
    const promptKey = generatePromptKey(promptDetection.promptData);
    const frameKey = promptFrameKey(promptDetection.promptData);
    if (isDuplicatePrompt(pollerState, promptKey)) {
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
      return (await tryEnterFallback(judged, promptDetection, notOurs.dialogGate, rawOutput))
        ? 'responded'
        : 'no_answer';
    }

    // 4. Resolve auto answer under the execution contract's policy (Issue #1547).
    // Auto-Yes reads the frame itself instead of going through status-detector
    // (it shares the reader, not the verdict), so this is the only place the policy can gate an
    // auto-answer: a prompt the policy withholds is left for a human, and the
    // response poller's prompt path (WS broadcast + Web Push, see
    // polling/response-checker.ts) is what tells them it is waiting.
    const policy = getSessionAutoYesPolicy(worktreeId, cliToolId, instanceId);
    const resolution = resolveAutoAnswerWithPolicy(promptDetection.promptData, policy);
    if (resolution.suppressedBy) {
      // Issue #1684: the log line alone leaves a CLI-driven pipeline blind to
      // why its worker stalled. Record the suppression so buildCurrentOutput
      // can publish it (`autoYes.lastSuppression` in capture --json).
      suppressAndWarnOnce(
        judged,
        {
          reason: resolution.suppressedBy,
          mode: policy?.mode ?? null,
          promptType: promptDetection.promptData.type,
          pattern: resolution.pattern,
        },
        `${frameKey}\u0000${resolution.suppressedBy}\u0000${policy?.mode ?? ''}\u0000${resolution.pattern ?? ''}`,
        'poller:auto-yes-suppressed-by-policy',
        {
          reason: resolution.suppressedBy,
          mode: policy?.mode ?? null,
          pattern: resolution.pattern,
          promptType: promptDetection.promptData.type,
        },
      );
    }
    const answer = resolution.answer;
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
    if (ownership === null || ownership.verdict === 'foreign') {
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
        },
      );
      return 'no_answer';
    }

    try {
      await sendPromptAnswer({
        sessionName,
        answer,
        cliToolId,
        promptData: promptDetection.promptData,
      });
    } finally {
      invalidateCache(sessionName);
    }

    // 6., 7. The answer reached tmux: see `finishAnsweredPrompt`.
    await finishAnsweredPrompt(judged, promptDetection, answer);

    return 'responded';
  } catch {
    incrementErrorCount(compositeKey);
    logger.warn('poller:detect-respond-error', { worktreeId, cliToolId, instanceId });
    return 'error';
  }
}

/**
 * Internal polling function that recursively schedules itself via setTimeout.
 *
 * @param worktreeId - Worktree identifier
 * @param cliToolId - CLI tool type being polled
 * @param instanceId - Agent instance ID being polled (Issue #896; equals cliToolId for primary)
 */
async function pollAutoYes(worktreeId: string, cliToolId: CLIToolType, instanceId?: string): Promise<void> {
  const compositeKey = buildCompositeKey(worktreeId, cliToolId, instanceId);

  // 1. Validate context
  const pollerState = getPollerState(compositeKey);
  const contextResult = validatePollingContext(compositeKey, pollerState);
  if (contextResult !== 'valid') {
    return;
  }

  try {
    // 2. Capture and clean output
    const autoYesState = getAutoYesState(worktreeId, cliToolId, instanceId);
    const captureLines = autoYesState?.stopPattern
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

    if (pollerState!.waitingForSession) {
      pollerState!.waitingForSession = false;
      logger.info('poller:session-appeared', { worktreeId, cliToolId, instanceId });
    }

    const lines = cleanOutput.split('\n');

    // 3. Stop condition delta check (Issue #314)
    if (processStopConditionDelta(compositeKey, pollerState!, cleanOutput)) {
      return;
    }

    // 4. Detect and respond to prompt
    const result = await detectAndRespondToPrompt(
      worktreeId, pollerState!, cliToolId, cleanOutput, lines, instanceId, rawOutput,
    );
    // Issue #3329: a poll that ran to the end ends the run of errors, so only
    // failures in a row reach AUTO_STOP_ERROR_THRESHOLD — not ones scattered
    // over hours. Not on 'error': a capture that works followed by an answer
    // that fails every time must still back off and stop.
    if (result !== 'error') {
      resetErrorCount(compositeKey);
    }
    if (result === 'responded') {
      scheduleNextPoll(worktreeId, cliToolId, instanceId, COOLDOWN_INTERVAL_MS);
      return;
    }

    // 5. Thinking check
    if (result === 'no_prompt') {
      const recentLines = lines.slice(-THINKING_CHECK_LINE_COUNT).join('\n');
      if (detectThinking(cliToolId, recentLines)) {
        scheduleNextPoll(worktreeId, cliToolId, instanceId, THINKING_POLLING_INTERVAL_MS);
        return;
      }
    }
  } catch (error) {
    // Issue #3329: no session is not an error. Auto-Yes lives independently of
    // the session it answers for (`auto-yes-lifecycle`), and `send --auto-yes`
    // enables it before the session starts — so wait until `expiresAt`, at the
    // backoff cap, instead of counting toward `consecutive_errors`.
    if (await isSessionMissing(worktreeId, cliToolId, instanceId)) {
      if (!pollerState!.waitingForSession) {
        pollerState!.waitingForSession = true;
        logger.info('poller:waiting-for-session', { worktreeId, cliToolId, instanceId });
      }
      scheduleNextPoll(worktreeId, cliToolId, instanceId, MAX_BACKOFF_MS);
      return;
    }
    incrementErrorCount(compositeKey);
    logger.warn('poller:poll-error', { worktreeId, cliToolId, instanceId, error: getErrorMessage(error) });
  }

  scheduleNextPoll(worktreeId, cliToolId, instanceId);
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
 * @param worktreeId - Worktree identifier
 * @param cliToolId - CLI tool type being polled
 * @param instanceId - Agent instance ID being polled (Issue #896)
 * @param overrideInterval - Optional override for the next poll delay
 */
function scheduleNextPoll(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  overrideInterval?: number
): void {
  const compositeKey = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const pollerState = getPollerState(compositeKey);
  if (!pollerState) return;

  const interval = Math.max(overrideInterval ?? pollerState.currentInterval, POLLING_INTERVAL_MS);
  pollerState.timerId = setTimeout(() => {
    pollAutoYes(worktreeId, cliToolId, instanceId);
  }, interval);
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
    stopAutoYesPolling(compositeKey);
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
    pollAutoYes(worktreeId, cliToolId, effectiveInstanceId);
  }, POLLING_INTERVAL_MS);

  logger.info('poller:started', { worktreeId, cliToolId, instanceId: effectiveInstanceId });
  return { started: true };
}

/**
 * Stop server-side auto-yes polling by composite key.
 *
 * Issue #525: Changed from (worktreeId) to (compositeKey).
 *
 * @param compositeKey - Composite key (worktreeId:cliToolId)
 */
export function stopAutoYesPolling(compositeKey: string): void {
  // Issue #3397: before the early return — the disable route and the session
  // cleanup call this for an instance whose poller may already be gone, and the
  // Enter record must not outlive the grant or the session either way.
  forgetEnterFallback(compositeKey);
  const pollerState = getPollerState(compositeKey);
  if (!pollerState) return;

  if (pollerState.timerId) {
    clearTimeout(pollerState.timerId);
  }

  autoYesPollerStates.delete(compositeKey);
  invalidateSessionAutoYesPolicy(compositeKey);
  logger.info('poller:stopped', { compositeKey });
}

/**
 * Stop all server-side auto-yes polling (graceful shutdown).
 */
export function stopAllAutoYesPolling(): void {
  for (const [key, pollerState] of autoYesPollerStates.entries()) {
    if (pollerState.timerId) {
      clearTimeout(pollerState.timerId);
    }
    invalidateSessionAutoYesPolicy(key);
    logger.info('poller:stopped', { compositeKey: key, reason: 'shutdown' });
  }
  autoYesPollerStates.clear();
  clearEnterFallbacks();
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
 */
export function stopAutoYesPollingByWorktree(worktreeId: string): void {
  const pollerKeys = filterCompositeKeysByWorktree(
    Array.from(autoYesPollerStates.keys()),
    worktreeId
  );
  pollerKeys.forEach(key => stopAutoYesPolling(key));
  // Issue #3397: and the records of instances whose poller had already stopped.
  forgetEnterFallbacksByWorktree(worktreeId);
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
