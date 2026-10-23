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
import {
  COPILOT_FOLDER_TRUST_ANCHORS,
  COPILOT_FOLDER_TRUST_OPTION_LABEL_PATTERN,
  isCopilotFolderTrustDialog,
} from '../detection/tools/copilot/patterns';
import { isStartupTrustPending, isStartupWindowOpen } from '../cli-tools/antigravity-startup-trust';
import {
  GEMINI_TRUST_LAUNCH_DIALOG,
  decideLaunchDialog,
  isLaunchDialogDrawn,
  isLaunchDialogOpen,
} from '../cli-tools/launch-dialog';
import { isLaunchDialogPressSettling, isLaunchWindowOpen } from '../cli-tools/launch-window';
import { resolveSessionName } from '../cli-tools/session-name';
import {
  QUESTION_CONFIRM_PAGE_SUPPRESSION_REASON,
  STARTUP_TRUST_UNHANDLED_SUPPRESSION_REASON,
} from './auto-yes-suppression-reason';
import { isAutoYesDeclinedConfirmPage } from './auto-yes-confirm-page';
import { recordPolicySuppression, type AutoYesPolicySuppression } from './auto-yes-suppression-state';
import { evaluateAutoYesDialogGate, type AutoYesDialogGateVerdict } from './auto-yes-dialog-gate';
import { warnOncePerFrame, type AutoYesPollerState } from './auto-yes-poller-state';
import { observeLedgerScreen, withholdLedgerConfirmation } from './auto-yes-confirmation-ledger';

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
  /**
   * Issue #3820: the dialog gate's verdict, set by `suppressIfNotOursToAnswer`
   * when it hands the prompt back as ours — what the ledger's evidence level
   * (`L3` / `L4`) is read from. Absent until then.
   */
  dialogGate?: AutoYesDialogGateVerdict;
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
  // Issue #3820: the same stop, as an interval of the confirmation on screen.
  withholdLedgerConfirmation(prompt, suppression.reason);
  warnOncePerFrame(prompt.pollerState, warnFrameKey, event, {
    worktreeId,
    cliToolId,
    instanceId,
    ...detail,
  });
}

/** The `dialog` that copilot's folder-trust suppression records (Issue #3790). */
export const COPILOT_FOLDER_TRUST_LAUNCH_DIALOG_ID = 'copilot-folder-trust';

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
 * left alone (and recorded), or the dialog gate refused it (the caller records
 * the refusal; Issue #3821 retired the Enter it tried first, #3397).
 */
export type NotOursToAnswerVerdict =
  | { kind: 'ours' }
  | { kind: 'left-alone' }
  | { kind: 'dialog-gate-refused'; dialogGate: AutoYesDialogGateVerdict };

/**
 * Whether the launch still owns its startup confirmation for this instance:
 * its window is open (Issue #3776), or it pressed the confirming key less than
 * `LAUNCH_DIALOG_PRESS_SETTLE_MS` ago and the agent may not have redrawn yet —
 * the window can close in between (Issue #3790).
 */
function isLaunchStillAnswering(cliToolId: 'gemini' | 'copilot', prompt: JudgedPrompt): boolean {
  let sessionName: string;
  try {
    sessionName = resolveSessionName(cliToolId, prompt.worktreeId, prompt.instanceId);
  } catch {
    // An id that would not make a session name was never launched here.
    return false;
  }
  return isLaunchWindowOpen(sessionName) || isLaunchDialogPressSettling(sessionName);
}

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
 * the launch (step 3). Judged only for a prompt whose options are the dialog's
 * declared rows ({@link isGeminiTrustPrompt}): a reply quoting the question
 * over another prompt, or the authentication picker under a dismissed dialog,
 * is answered as any prompt is.
 *
 * Left alone by default — the poller answers only when nothing else will and
 * the answer is the safe one:
 * - While the launch window is open (`cli-tools/launch-window`), never: the
 *   launch answers it, and an answered dialog stays drawn above gemini's
 *   restart line, where a `1` lands on whatever the restart draws next. Nor
 *   for a while after the launch's Enter, window or not (Issue #3790,
 *   {@link isLaunchStillAnswering}).
 * - After it — the launch's Enter did not land, or gemini drew the dialog late
 *   (an auto-update, a slow start) — only when the prompt's default (the
 *   cursor row, which is what the poller sends) is `1. Trust folder`, and,
 *   when the screen reads as the declared dialog, the launch's own reading is
 *   `press` (not a dismissed dialog).
 *
 * A screen that does not read as the dialog (the wording changed, the options
 * sit further below the question than declared) is not a reason to answer
 * (review of #3776): with the cursor on `3. Don't trust` the poller's default
 * would write that answer for good.
 */
function isGeminiTrustDialogLeftToLaunch(prompt: JudgedPrompt, frame: NormalizedFrame): boolean {
  const { promptData } = prompt;
  if (promptData.type !== 'multiple_choice' || !isGeminiTrustPrompt(promptData)) return false;
  if (isLaunchStillAnswering('gemini', prompt)) return true;
  const defaultOption = promptData.options.find((o) => o.isDefault);
  const defaultIsSafe =
    defaultOption !== undefined &&
    GEMINI_TRUST_LAUNCH_DIALOG.safeRow.test(`${defaultOption.number}. ${defaultOption.label}`);
  if (!defaultIsSafe) return true;
  if (!isLaunchDialogDrawn(GEMINI_TRUST_LAUNCH_DIALOG, frame.clean)) return false;
  if (!isLaunchDialogOpen(GEMINI_TRUST_LAUNCH_DIALOG, frame.clean)) return true;
  return decideLaunchDialog(GEMINI_TRUST_LAUNCH_DIALOG, frame.clean).action !== 'press';
}

/**
 * Issue #3790: whether copilot's folder-trust dialog on this frame is left to
 * the launch (step 3), as gemini's is. The launch confirms it with a bare `1`
 * (`CopilotTool.answerFolderTrustDialog`); the poller answered `1` + Enter
 * beside it, and when the launch's `1` landed first, the poller's was typed
 * into the composer the dismissal revealed and submitted as a user message
 * (measured on 1.0.91, private tmux socket and HOME).
 *
 * Judged only when the frame carries both of the dialog's anchors and the
 * prompt's options are its rows: a reply quoting the question over another
 * prompt is answered as any prompt is. Left alone while the launch is still
 * answering ({@link isLaunchStillAnswering}); after it — the launch's `1` did
 * not land, or copilot drew the dialog late — the poller's default goes through
 * only when it is the session-only `1. Yes` in the declared order
 * (`isCopilotFolderTrustDialog`). `2.` writes `trustedFolders` into the
 * machine-wide `~/.copilot/config.json`.
 */
function isCopilotTrustDialogLeftToLaunch(prompt: JudgedPrompt, frame: NormalizedFrame): boolean {
  const { promptData } = prompt;
  if (promptData.type !== 'multiple_choice') return false;
  if (!COPILOT_FOLDER_TRUST_ANCHORS.every((anchor) => frame.clean.includes(anchor))) return false;
  const trustRows = promptData.options.filter((o) => COPILOT_FOLDER_TRUST_OPTION_LABEL_PATTERN.test(o.label));
  if (trustRows.length < 2) return false;
  if (isLaunchStillAnswering('copilot', prompt)) return true;
  const defaultOption = promptData.options.find((o) => o.isDefault);
  const defaultIsSessionOnly = defaultOption?.number === 1 && defaultOption.label === 'Yes';
  return !(defaultIsSessionOnly && isCopilotFolderTrustDialog(frame.clean));
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
  //
  // Issue #3790: copilot's folder-trust question too, whose launch answers a
  // bare `1` (see {@link isCopilotTrustDialogLeftToLaunch}).
  const launchDialog =
    cliToolId === 'codex'
      ? getCodexLifecycleDialog(frame)
      : cliToolId === 'gemini' && isGeminiTrustDialogLeftToLaunch(prompt, frame)
        ? GEMINI_TRUST_LAUNCH_DIALOG.id
        : cliToolId === 'copilot' && isCopilotTrustDialogLeftToLaunch(prompt, frame)
          ? COPILOT_FOLDER_TRUST_LAUNCH_DIALOG_ID
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
  // same way. Judged by `isAutoYesDeclinedConfirmPage` (the browser's fallback,
  // `useAutoYes`, read the same page by its options until #3821 retired it), and recorded with a reason of its own,
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

  prompt.dialogGate = dialogGate;
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

/** Issue #3820: the ledger's screen key for agy's startup trust screen (not a `partialAnswerScreenKey`). */
const ANTIGRAVITY_TRUST_SCREEN_LEDGER_KEY = 'antigravity-startup-trust';

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
  // Issue #3820: unnumbered, so no prompt data and no screen key of its own —
  // the screen is one confirmation for as long as it stays up.
  const ledgerScope = { worktreeId, cliToolId: 'antigravity' as const, instanceId };
  observeLedgerScreen(ledgerScope, ANTIGRAVITY_TRUST_SCREEN_LEDGER_KEY, 'multiple_choice');
  withholdLedgerConfirmation(ledgerScope, STARTUP_TRUST_UNHANDLED_SUPPRESSION_REASON);
  warnOncePerFrame(pollerState, 'antigravity-startup-trust', 'poller:auto-yes-skipped-startup-trust', {
    worktreeId,
    cliToolId: 'antigravity',
    instanceId,
    reason: STARTUP_TRUST_UNHANDLED_SUPPRESSION_REASON,
  });
  return true;
}
