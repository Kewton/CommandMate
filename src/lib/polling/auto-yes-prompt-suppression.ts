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
 * Issue #3214: steps 3, 3.2 and 3.5 of `detectAndRespondToPrompt` -- the frames
 * that read as a prompt and are still not Auto-Yes's to answer, judged in the
 * order they always were. "The detection above" in the comments below is that
 * function's step 1.
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
  const launchDialog =
    cliToolId === 'codex' ? getCodexLifecycleDialog(frame) : null;
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
