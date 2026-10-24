/**
 * Auto-Yes poller: what one tick reads off its frame and records about it —
 * the prompt reading, the no-prompt bookkeeping, the decision recorder and the
 * ledger's labels (Issue #3893: split out of `auto-yes-poller.ts`).
 *
 * Does not import `auto-yes-poller.ts` (no cycle). Nor `polling/response-checker`:
 * that module reaches the poller back through `auto-yes-manager`, so the frame
 * reader is handed in by the poller (`detectPromptOnCleanFrame` below).
 *
 * @module lib/auto-yes-poller-tick
 */

import type { CLIToolType } from './cli-tools/types';
import type { detectPromptOnCleanFrame } from './polling/response-checker';
import {
  beginAntigravityFrameRead,
  endAntigravityFrameRead,
  getAntigravityAcceptedReceiptCallId,
} from './polling/antigravity-receipt-episodes';
import { normalizeFrame } from './detection/tools/frame';
import { detectAntigravityNumberedDialogPrompt } from './detection/tools/antigravity/dialog';
import {
  forgetAutoYesDecision,
  reaffirmAutoYesAnswering,
  recordAutoYesDecision,
} from './polling/auto-yes-decision-state';
import { getLastPolicySuppression } from './polling/auto-yes-suppression-state';
import type { AutoYesDecisionReason } from '@/types/auto-yes-decision';
import { CLIToolManager } from './cli-tools/manager';
import type { PromptDetectionResult } from './detection/types';
import type { PromptData } from '@/types/models';
import type { CaptureTop } from '@/types/prompt-reading';
import { getAutoYesState } from './auto-yes-state';
import {
  forgetPartialAnswer,
  getPartialAnswer,
  keepPartialAnswerByPerson,
  ledgerScreenKey,
  partialAnswerCovers,
  partialAnswerScreenKey,
  personSendsInFlight,
  type AutoYesPollerState,
} from './polling/auto-yes-poller-state';
import { suppressAntigravityTrustScreen, type JudgedPrompt } from './polling/auto-yes-prompt-suppression';
import { isTickCurrent, type AutoYesTickGeneration } from './polling/auto-yes-poller-generation';
import { logIfWithheldForWantOfReceipt } from './polling/auto-yes-poller-receipt-log';
import { captureTopOf as captureTopOfWindow, withCaptureTopCompleteness } from './polling/prompt-screen-reading';
import {
  observeLedgerScreen,
  withholdLedgerConfirmation,
  type LedgerScope,
} from './polling/auto-yes-confirmation-ledger';
import type { AnswerBasis, AttemptResult } from './polling/auto-yes-confirmation-ledger-types';

/** The poller's frame reader, handed in (see the module comment). */
type DetectPromptOnCleanFrame = typeof detectPromptOnCleanFrame;

/**
 * Step 1 of `detectAndRespondToPrompt`: normalise the tick's frame once and
 * read the prompt on it.
 */
export function readPromptFrame(
  worktreeId: string,
  cliToolId: CLIToolType,
  cleanOutput: string,
  precomputedLines: string[] | undefined,
  instanceId: string | undefined,
  rawOutput: string | undefined,
  captureExtent: CaptureExtent | undefined,
  detectPromptOnCleanFrame: DetectPromptOnCleanFrame,
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
  return {
    frame,
    promptDetection: withCaptureTop(promptDetection, cliToolId, rawOutput ?? cleanOutput, captureExtent),
  };
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
  cliToolId: CLIToolType,
  capture: string,
  captureExtent: CaptureExtent | undefined,
): PromptDetectionResult {
  const captureTop = captureTopOf(capture, captureExtent, cliToolId);
  return captureTop === undefined ? detection : withCaptureTopCompleteness(detection, captureTop);
}

/**
 * The window a tick's capture was taken with, and whether that window dropped
 * rows from the top of what tmux returned when the capture layer said
 * (Issue #3881: review P2-1, third review N4).
 */
export interface CaptureExtent {
  windowLines: number;
  headCut?: boolean;
}

/**
 * Where a poller capture's first row sits (Issue #3881 review P2-1): on a
 * scrollback pane the capture is the last `windowLines` rows, so one
 * that came back with fewer rows holds the pane's whole history, and one that
 * filled the window may be cut at its top (#1670's `isCaptureWindowSaturated`)
 * unless the capture layer said it was not (the fourth review's N5: `headCut`);
 * an alternate-screen pane has no history and is read off its screen (the
 * second review's N1, `captureTopOf` in `prompt-screen-reading`), unless the
 * window cut it (the third review's N4: `headCut`).
 * Undefined when the window is not known.
 */
export function captureTopOf(
  capture: string,
  captureExtent: CaptureExtent | undefined,
  cliToolId: CLIToolType,
): CaptureTop | undefined {
  return captureExtent === undefined
    ? undefined
    : captureTopOfWindow(capture, captureExtent.windowLines, cliToolId, captureExtent.headCut);
}

/**
 * What `detectAndRespondToPrompt` does to the poller state on a frame with no
 * prompt to answer, before it returns `no_prompt`.
 *
 * @returns agy's dialog the ungated reading still sees past the receipt gate
 *   (Issue #3821: the decision published for it), else null
 */
export function noteNoPromptOnScreen(tick: {
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId: string | undefined;
  compositeKey: string;
  epoch: number;
  pollerState: AutoYesPollerState;
  frame: ReturnType<typeof normalizeFrame>;
  promptDetection: PromptDetectionResult;
  cleanOutput: string;
  precomputedLines: string[] | undefined;
  rawOutput: string | undefined;
  captureExtent: CaptureExtent | undefined;
  detectPromptOnCleanFrame: DetectPromptOnCleanFrame;
}): ReturnType<typeof logIfWithheldForWantOfReceipt> {
  const {
    worktreeId,
    cliToolId,
    instanceId,
    compositeKey,
    epoch,
    pollerState,
    frame,
    promptDetection,
    cleanOutput,
    precomputedLines,
    rawOutput,
    captureExtent,
    detectPromptOnCleanFrame,
  } = tick;
  // Issue #3880: a person's hold, which agy's dialog past the receipt window
  // keeps (below) — the gated reading's "no prompt" is not the dialog gone.
  const personHold = cliToolId === 'antigravity' ? getPartialAnswer(compositeKey, epoch) : null;
  // The same for a person's send still in flight: one at the dialog the
  // ungated reading still shows is not expired, so its outcome, coming back
  // unknown, still holds the dialog. The ungated reading is taken once.
  // Issue #3881: with the same capture-top reading as the tick's prompt, so the
  // receipt log judges the contract on the frame's known top. The screen key
  // (`partialAnswerScreenKey`) does not read `approvalTargetCompleteness`, so
  // the in-flight sends are matched as before.
  let ungated: PromptDetectionResult | undefined;
  const readWithoutGate = (): PromptDetectionResult =>
    (ungated ??= withCaptureTop(
      detectPromptOnCleanFrame(cleanOutput, cliToolId, precomputedLines, rawOutput),
      cliToolId,
      rawOutput ?? cleanOutput,
      captureExtent,
    ));
  const personSends = cliToolId === 'antigravity' ? personSendsInFlight(compositeKey, epoch) : [];
  const dialogUp = personSends.length > 0 ? readWithoutGate() : null;
  const dialogUpKey = dialogUp?.isPrompt && dialogUp.promptData ? partialAnswerScreenKey(dialogUp.promptData) : null;
  forgetPartialAnswer(
    compositeKey,
    undefined,
    new Set(
      dialogUpKey === null
        ? []
        : personSends.filter((attempt) => partialAnswerCovers(attempt.screenKey, dialogUpKey)),
    ),
  );
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
    const seen = logIfWithheldForWantOfReceipt(
      worktreeId,
      instanceId,
      compositeKey,
      readWithoutGate,
      personHold?.byPerson ? personHold.screenKey : null,
    );
    if (personHold?.byPerson && seen?.keptPersonHold) {
      keepPartialAnswerByPerson(compositeKey, personHold, partialAnswerScreenKey(seen.promptData));
    }
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
export function tickDecisionRecorder(tick: {
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
export function ledgerCallOf(
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
export function attemptResultOfThrow(keysSent: boolean | null): AttemptResult {
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
export function answerBasisOf(prompt: JudgedPrompt, cleanOutput: string): AnswerBasis {
  if (prompt.cliToolId === 'antigravity') {
    return detectAntigravityNumberedDialogPrompt(cleanOutput) !== null ? 'L3' : 'L4';
  }
  const gate = prompt.dialogGate;
  return gate !== undefined && gate.gated && gate.allowed && gate.dialog !== null ? 'L3' : 'L4';
}
