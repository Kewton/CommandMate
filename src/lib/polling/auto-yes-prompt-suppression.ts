/**
 * The suppression exits of `detectAndRespondToPrompt` (Issue #3214), moved out
 * of auto-yes-poller.ts unchanged (Issue #3411). Must not import
 * auto-yes-poller.ts (cycle) or `../tmux/tmux` (tmux import allowlist).
 */

import type { CLIToolType } from '../cli-tools/types';
import type { PromptData } from '@/types/models';
import type { NormalizedFrame } from '../detection/tools/types';
import { isCodexModelPickerFrame } from '../detection/tools/codex/detect';
import { getCodexLifecycleDialog } from '../detection/cli-patterns';
import { isAntigravityTrustScreen } from '../detection/tools/antigravity/patterns';
import { isStartupTrustPending, isStartupWindowOpen } from '../cli-tools/antigravity-startup-trust';
import {
  GEMINI_TRUST_LAUNCH_DIALOG,
  decideLaunchDialog,
  isLaunchDialogDrawn,
  isLaunchDialogOpen,
} from '../cli-tools/launch-dialog';
import { isLaunchWindowOpen } from '../cli-tools/launch-window';
import { resolveSessionName } from '../cli-tools/session-name';
import {
  QUESTION_CONFIRM_PAGE_SUPPRESSION_REASON,
  STARTUP_TRUST_UNHANDLED_SUPPRESSION_REASON,
} from './auto-yes-suppression-reason';
import { isAutoYesDeclinedConfirmPage } from './auto-yes-confirm-page';
import { recordPolicySuppression, type AutoYesPolicySuppression } from './auto-yes-suppression-state';
import { evaluateAutoYesDialogGate, type AutoYesDialogGateVerdict } from './auto-yes-dialog-gate';
import { warnOncePerFrame, type AutoYesPollerState } from './auto-yes-poller-state';

/**
 * Issue #3214: the prompt one `detectAndRespondToPrompt` tick is judging, as the
 * steps split out of that function need it. Built once, after the duplicate
 * check, from that function's own locals.
 */
export interface JudgedPrompt {
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId: string | undefined;
  /** `buildCompositeKey()` of the three above. */
  compositeKey: string;
  pollerState: AutoYesPollerState;
  promptData: PromptData;
  /** `generatePromptKey(promptData)`: the duplicate guard's key (Issue #306). */
  promptKey: string;
  /** `promptFrameKey(promptData)`: what `warnOncePerFrame` tells prompts apart by. */
  frameKey: string;
}

/**
 * Issue #3214: the form the four suppression exits of `detectAndRespondToPrompt`
 * share. Records why Auto-Yes left the prompt alone (`recordPolicySuppression`,
 * not throttled), then prints the WARN once per frame (`warnOncePerFrame`).
 *
 * @param suppression - Handed to `recordPolicySuppression` as is
 * @param warnFrameKey - Handed to `warnOncePerFrame` as is: the prompt's
 *   `frameKey` plus the exit's own detail
 * @param event - The WARN's log name
 * @param detail - The WARN's fields after `worktreeId`, `cliToolId` and `instanceId`
 */
export function suppressAndWarnOnce(
  prompt: JudgedPrompt,
  suppression: Omit<AutoYesPolicySuppression, 'at'>,
  warnFrameKey: string,
  event: string,
  detail: Record<string, unknown>,
): void {
  const { worktreeId, cliToolId, instanceId } = prompt;
  recordPolicySuppression(worktreeId, cliToolId, instanceId, suppression);
  warnOncePerFrame(prompt.pollerState, warnFrameKey, event, {
    worktreeId,
    cliToolId,
    instanceId,
    ...detail,
  });
}

/** How much of a prompt's question a log line carries (Issue #3497). */
export const MAX_LOGGED_QUESTION_LENGTH = 500;

/**
 * `question` cut to {@link MAX_LOGGED_QUESTION_LENGTH}, for a log line.
 * Exported for `poller:response-sent` (Issue #3748).
 */
export function truncateForLog(question: string): string {
  return question.length > MAX_LOGGED_QUESTION_LENGTH
    ? `${question.slice(0, MAX_LOGGED_QUESTION_LENGTH)}…`
    : question;
}

/**
 * What `suppressIfNotOursToAnswer` decided: carry on and answer, the prompt was
 * left alone (and recorded), or the dialog gate refused it (Issue #3397: the
 * caller tries the Enter fallback before recording the refusal).
 */
export type NotOursToAnswerVerdict =
  | { kind: 'ours' }
  | { kind: 'left-alone' }
  | { kind: 'dialog-gate-refused'; dialogGate: AutoYesDialogGateVerdict };

/**
 * Issue #3776: whether the prompt the poller is about to answer is gemini's
 * folder-trust dialog itself — its parsed options are the declared option
 * rows — rather than another prompt sharing the screen with it (the
 * authentication picker under a dismissed dialog, a permission prompt under a
 * reply that quotes the question).
 */
function isGeminiTrustPrompt(promptData: PromptData): boolean {
  if (promptData.type !== 'multiple_choice') return false;
  const { optionRow, minOptionRows } = GEMINI_TRUST_LAUNCH_DIALOG;
  return promptData.options.filter((o) => optionRow.test(`${o.number}. ${o.label}`)).length >= minOptionRows;
}

/**
 * Issue #3776: whether gemini's folder-trust dialog on this frame is left to
 * the launch (step 3). Only the dialog itself counts — its question over its
 * option block, and the prompt being answered is that block: a reply quoting
 * the question or a diff of the declaration is not it.
 *
 * - While the launch window is open (`cli-tools/launch-window`), the dialog is
 *   the launch's, dismissed or not: an answered dialog stays drawn above
 *   gemini's restart line, and a `1` typed there lands on whatever the restart
 *   draws next (the authentication picker).
 * - After it — the launch's Enter did not land, or gemini drew the dialog late
 *   (an auto-update, a slow start) — nobody else will answer it. The poller's
 *   default (the cursor row) goes through when the cursor is on the safe row
 *   (`press`); on any other row, a dialog that does not read as declared, or
 *   one already dismissed, it is still left alone.
 */
function isGeminiTrustDialogLeftToLaunch(prompt: JudgedPrompt, frame: NormalizedFrame): boolean {
  if (!isGeminiTrustPrompt(prompt.promptData)) return false;
  if (!isLaunchDialogDrawn(GEMINI_TRUST_LAUNCH_DIALOG, frame.clean)) return false;
  let windowOpen = false;
  try {
    windowOpen = isLaunchWindowOpen(resolveSessionName('gemini', prompt.worktreeId, prompt.instanceId));
  } catch {
    // An id that would not make a session name was never launched here.
  }
  if (windowOpen || !isLaunchDialogOpen(GEMINI_TRUST_LAUNCH_DIALOG, frame.clean)) return true;
  return decideLaunchDialog(GEMINI_TRUST_LAUNCH_DIALOG, frame.clean).action !== 'press';
}

/**
 * Issue #3214: steps 3, 3.2, 3.3 (Issue #3497) and 3.5 of
 * `detectAndRespondToPrompt` -- the frames that read as a prompt and are still
 * not Auto-Yes's to answer, judged in the order they always were. "The
 * detection above" in the comments below is that function's step 1.
 *
 * Issue #3397: step 3.5 no longer records its refusal here. It hands the gate's
 * verdict back so `tryEnterFallback` can look at the frame first, and records
 * through {@link suppressUnclassifiedFrame} when that sends nothing. Steps 3 and
 * 3.2 still win: an Enter never reaches codex's launch dialogs or its `/model`
 * picker.
 *
 * @param frame - The tick's one normalised frame (Issue #3183)
 */
export function suppressIfNotOursToAnswer(prompt: JudgedPrompt, frame: NormalizedFrame): NotOursToAnswerVerdict {
  const { cliToolId, promptData, frameKey } = prompt;

  // 3. Issue #1829: codex's own launch dialogs are CodexTool.waitForReady()'s
  // to answer, not the poller's. Every one of them defaults to option 1, and
  // the base rules answer the default:
  //
  //   "Hooks need review"  -> 1. Review hooks   (undoes Issue #1760; the pane
  //                           then sits two screens deep in a review UI that
  //                           only `t`/`esc` leave, reported as `running`)
  //   "Update available"   -> 1. Update now     (undoes Issue #890; runs
  //                           `npm install -g @openai/codex`, killing codex)
  //   "Do you trust …"     -> 1. Yes, continue
  //
  // waitForReady answers the same screens deliberately and differently ('3',
  // '2', '1' — each without a trailing Enter), but only during startSession,
  // while this poller runs on its own 2s phase for the life of the session.
  // Whichever sees the dialog first decides, so the fix is to leave them all
  // to the tool. Auto-answer layer only: the detection above still reports the
  // prompt, so the human keeps seeing the screen and the response poller
  // still notifies them about it.
  //
  // Issue #3776: gemini's folder-trust question too. The generic parser reads
  // it as a multiple choice whose default is the cursor row, so the poller
  // answered `1` beside the launch's own Enter (the second keypress then fell
  // on the restarted gemini's authentication picker), and answered `3` —
  // `Don't trust`, written for good — when the cursor sat there. The launch
  // confirms only `1. Trust folder` (`cli-tools/launch-dialog`). See
  // {@link isGeminiTrustDialogLeftToLaunch} for when the poller may answer.
  const launchDialog =
    cliToolId === 'codex'
      ? getCodexLifecycleDialog(frame)
      : cliToolId === 'gemini' && isGeminiTrustDialogLeftToLaunch(prompt, frame)
        ? GEMINI_TRUST_LAUNCH_DIALOG.id
        : null;
  if (launchDialog) {
    // Recorded through the #1684 channel so `capture --json` and `cmate wait`
    // can name the reason instead of showing a worker that went quiet.
    suppressAndWarnOnce(
      prompt,
      { reason: 'agent-launch-dialog', mode: null, promptType: promptData.type },
      `${frameKey}\u0000${launchDialog}`,
      'poller:auto-yes-skipped-launch-dialog',
      { dialog: launchDialog, promptType: promptData.type },
    );
    return { kind: 'left-alone' };
  }

  // 3.2. Issue #3062: codex's `/model` picker (both stages) is not ours to
  // answer. A digit there is an immediate decision, so the base rules'
  // default would choose the model and effort for the operator. Judged by the
  // picker's own footer, not by `kind: picker`, which the hooks screens share.
  // The tool's `detectPrompt` still reports the prompt, so `/prompt-response`
  // (the human's answer) is unaffected. Reuses `unclassified-frame`: the tool
  // recognised the frame and deliberately declined it.
  if (cliToolId === 'codex' && isCodexModelPickerFrame(frame)) {
    suppressAndWarnOnce(
      prompt,
      { reason: 'unclassified-frame', mode: null, promptType: promptData.type },
      `${frameKey}\u0000codex-model-picker`,
      'poller:auto-yes-skipped-model-picker',
      { promptType: promptData.type },
    );
    return { kind: 'left-alone' };
  }

  // 3.3. Issue #3497: Command Code's `AskUserQuestion` confirm page
  // (`❯ 1. Submit` / `2. Cancel` under the question's tab strip) is not ours
  // to answer. `Submit` picks nothing — it commits whatever stands as the
  // answers, and on Kewton/Musunest#283 that was the worker's own proposal,
  // which the worker then implemented as though a human had approved it. The
  // full Review page is already declined by the reader (#2755 §7); a frame
  // without its `← to go back and edit` row reaches the generic parser, and a
  // question whose only choices are the pair is read by the question reader —
  // both as `multiple_choice` with `Submit` as the default, answered `1`. Default, no setting: free-text questions go back to a human.
  // The status path still publishes the prompt, so the human sees it.
  //
  // Issue #3748: Claude's confirmation page (`Ready to submit your answers?` /
  // `❯ 1. Submit answers` / `2. Cancel`) is the same page and is declined the
  // same way. Judged by `isAutoYesDeclinedConfirmPage`, which the browser's
  // fallback (`useAutoYes`) asks too, and recorded with a reason of its own,
  // `question-confirm-page`, which `cmate wait` names as such (it reused
  // `unclassified-frame`, whose wording says no detector recognised the frame).
  if (isAutoYesDeclinedConfirmPage(cliToolId, frame)) {
    suppressAndWarnOnce(
      prompt,
      { reason: QUESTION_CONFIRM_PAGE_SUPPRESSION_REASON, mode: null, promptType: promptData.type },
      `${frameKey}\u0000question-confirm-page`,
      'poller:auto-yes-skipped-question-confirm',
      {
        reason: QUESTION_CONFIRM_PAGE_SUPPRESSION_REASON,
        promptType: promptData.type,
        question: truncateForLog(promptData.question),
        options:
          promptData.type === 'multiple_choice'
            ? promptData.options.map((option) => `${option.number}. ${option.label}`)
            : [...promptData.options],
      },
    );
    return { kind: 'left-alone' };
  }

  // 3.5. Issue #1928 (§4 D1 decision 4): the generic numbered-list inference is
  // not enough to send an answer. The detection above judges the ROWS, and the
  // rows of an agent's own reply can be indistinguishable from a dialog's --
  // opencode 1.18 answering "list three options and ask which one" is the
  // reported case (#1896), and the `1` this poller sent in reply was not
  // answering anything, it was SENT AS A USER UTTERANCE. What separates the two
  // is position and chrome, which only the tool's own module knows, so the
  // decision is delegated to `detectDialog` (the seam #1927 declared).
  //
  // Per tool, and only for tools whose dialogs were measured from their own
  // live captures -- see AUTO_YES_DIALOG_GATE_DEFAULT_MODE. An ungated tool
  // reaches `allowed: true` without being judged, which is the pre-#1928
  // behaviour and the right one where nobody has measured anything.
  //
  // Recorded through the #1684 channel with the reason code #1924 landed for
  // exactly this position, so `capture --json` and `cmate wait` can name the
  // gap instead of showing a worker that silently went quiet.
  const dialogGate = evaluateAutoYesDialogGate(
    cliToolId,
    promptData.type,
    frame,
  );
  if (!dialogGate.allowed) {
    return { kind: 'dialog-gate-refused', dialogGate };
  }

  return { kind: 'ours' };
}

/**
 * Step 3.5's record: the tool's dialog detector did not vouch for the frame and
 * nothing was sent (Issue #1928). Split out of `suppressIfNotOursToAnswer` by
 * Issue #3397, unchanged, so it runs after `tryEnterFallback` declined.
 */
export function suppressUnclassifiedFrame(prompt: JudgedPrompt, dialogGate: AutoYesDialogGateVerdict): void {
  const { promptData, frameKey } = prompt;
  suppressAndWarnOnce(
    prompt,
    { reason: 'unclassified-frame', mode: null, promptType: promptData.type },
    `${frameKey}\u0000${dialogGate.dialog?.kind ?? ''}\u0000${dialogGate.mode}`,
    'poller:auto-yes-skipped-unclassified-frame',
    {
      promptType: promptData.type,
      dialogKind: dialogGate.dialog?.kind ?? null,
      answerMode: dialogGate.dialog?.answerMode ?? null,
      gateMode: dialogGate.mode,
    },
  );
}

/**
 * Issue #3757: agy's startup folder-trust screen, which the tick read as no
 * prompt at all — it is unnumbered, so neither agy's dialog reader nor the
 * generic parser reads it, and the tick never got as far as the dialog gate or
 * the Enter fallback. The status path still calls the pane `waiting`, so the
 * prompt Push opened a wait that, with nothing recorded, it held as "Auto-Yes
 * is answering" until the ten-minute reminder.
 *
 * Not answered here: the screen belongs to the launch, which confirms it with
 * one Enter — in its own window, or through the next send when agy drew it
 * later (`cli-tools/antigravity-startup-trust`). A second sender of that Enter
 * here could press it twice. What this does is record the reason, so the gate
 * notifies and `cmate wait` names the screen.
 *
 * Inside the launch window (`isStartupWindowOpen`) nothing is recorded: the
 * window confirms the screen within a second or two, and a record would make
 * the prompt Push ring for a screen that was never a human's. Outside it — the
 * window ended (with the Enter owed, or not) or this process never launched the
 * session — it is recorded.
 *
 * @param frame - The tick's one normalised frame (Issue #3183)
 * @param sessionName - The instance's tmux session, for the launch window
 * @returns true when the frame is the trust screen (recorded or not)
 */
export function suppressAntigravityTrustScreen(
  worktreeId: string,
  instanceId: string | undefined,
  pollerState: AutoYesPollerState,
  frame: NormalizedFrame,
  sessionName: string,
): boolean {
  if (!isAntigravityTrustScreen(frame.lastLines)) return false;
  if (isStartupWindowOpen(sessionName) && !isStartupTrustPending(sessionName)) return true;
  recordPolicySuppression(worktreeId, 'antigravity', instanceId, {
    reason: STARTUP_TRUST_UNHANDLED_SUPPRESSION_REASON,
    mode: null,
    promptType: 'multiple_choice',
  });
  warnOncePerFrame(pollerState, 'antigravity-startup-trust', 'poller:auto-yes-skipped-startup-trust', {
    worktreeId,
    cliToolId: 'antigravity',
    instanceId,
    reason: STARTUP_TRUST_UNHANDLED_SUPPRESSION_REASON,
  });
  return true;
}
