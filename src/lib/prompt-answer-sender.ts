/**
 * Shared prompt answer sender for cursor-key and text-based tmux input.
 *
 * Issue #287 Bug2: Extracted from route.ts and auto-yes-manager.ts to
 * eliminate code duplication and ensure consistent behavior (including
 * the promptType/defaultOptionNumber fallback introduced in Bug1).
 */

import { capturePane, sendKeys, sendSpecialKeys } from './tmux/tmux';
import type { CLIToolType } from './cli-tools/types';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import { getToolStatusDetector } from '@/lib/detection/tools/registry';
import type { DialogAnswerMode, DialogVerdict } from '@/lib/detection/tools/types';
import type { PromptData, PromptType, SubmitMode } from '@/types/models';
import { isValidSubmitMode } from '@/types/models';
import { invalidateCache } from './tmux/tmux-capture-cache';
import { TUI_TEXT_INPUT_WAIT_MS } from '@/config/cli-tool-timing-config';

/** Regex pattern to detect checkbox-style multi-select options */
const CHECKBOX_OPTION_PATTERN = /^\[[ x]\] /;

/**
 * The reason code a caller gets back when a digit meets a `keys`-mode dialog
 * (Issue #2033).
 *
 * Spelled as a constant because it crosses two boundaries: the API refusal body
 * `respond` reads (`/prompt-response`), and the assertions that pin it.
 */
export const ANSWER_MODE_KEYS_REASON = 'answer_mode_keys';

/**
 * The only {@link DialogAnswerMode} a typed digit can actually drive.
 *
 * Named rather than compared inline so the test that would have to change is
 * the one that states the rule, not five call sites of `=== 'keys'`.
 */
const TEXT_ANSWERABLE_ANSWER_MODE: DialogAnswerMode = 'numbered';

/**
 * How much scrollback the guard reads when the caller supplied no frame.
 *
 * The dialog rules window the LAST rows of the pane (`STATUS_CHECK_LINE_COUNT`
 * for the strips, the content run for the pickers), so this only has to be
 * comfortably larger than a screen — not the 1000-row default `capturePane`
 * would otherwise take on a path that runs before every keystroke.
 */
const GUARD_CAPTURE_LINES = 200;

/**
 * A prompt answer that was refused BEFORE any key reached the pane.
 *
 * The distinction matters to every caller: a throw from `sendKeys` leaves the
 * terminal in an unknown state, whereas this one is a guarantee that nothing was
 * typed and the dialog is still exactly as the operator left it.
 */
export class PromptAnswerRejectedError extends Error {
  /** Machine-readable code, currently always {@link ANSWER_MODE_KEYS_REASON}. */
  readonly reason: string;
  /** The dialog family the tool vouched for, e.g. `permission` / `picker`. */
  readonly dialogKind: string;
  /** How that dialog actually takes its answer. */
  readonly answerMode: DialogAnswerMode;

  constructor(cliToolId: CLIToolType, answer: string, dialog: DialogVerdict) {
    super(
      `Refused to send "${answer}" to ${cliToolId}: its ${dialog.kind} dialog takes `
      + `'${dialog.answerMode}' input, not a typed number (${ANSWER_MODE_KEYS_REASON}). `
      + 'The digit would be swallowed and the Enter after it would confirm whatever is '
      + 'highlighted. Nothing was sent.'
    );
    this.name = 'PromptAnswerRejectedError';
    this.reason = ANSWER_MODE_KEYS_REASON;
    this.dialogKind = dialog.kind;
    this.answerMode = dialog.answerMode;
  }
}

/**
 * The pane to judge the tool's own dialog rules against.
 *
 * Prefers the capture the caller already took — `/prompt-response` captures a
 * fresh frame two statements before it calls in, and re-reading the pane there
 * would be a second tmux round trip AND a second, later frame, i.e. a different
 * screen from the one whose prompt was verified.
 *
 * Falls back to reading the pane here so that a caller with no frame (the chat
 * button route, `auto-yes-manager`) is still covered: the point of Issue #2033
 * is that this function must not be dangerous on its own.
 *
 * Returns null when the pane cannot be read at all. That is deliberately
 * fail-OPEN, and it is the same call `/prompt-response` already makes for its
 * own pre-send verification ("If capture fails, proceed with caution - don't
 * block manual responses"): a session whose pane is unreadable is far more often
 * a mocked or racing transport than an open dialog, and turning every such case
 * into a refusal would make the operator's only way out stop working.
 */
async function readGuardFrame(params: SendPromptAnswerParams): Promise<string | null> {
  if (params.frame !== undefined) return params.frame;
  try {
    return await capturePane(params.sessionName, GUARD_CAPTURE_LINES);
  } catch {
    return null;
  }
}

/**
 * Refuse a numeric answer the tool's own dialog cannot take (Issue #2033).
 *
 * ## Why this is keyed on `answerMode` and not on the tool id
 *
 * The branch below has always asked "which tool is this?", and the comment above
 * it classified opencode as a tool that "accepts N + Enter as text". That was
 * measured to be false (#1893): opencode's permission strip is a row of
 * unnumbered buttons driven by ←/→, the digit is swallowed, and the Enter after
 * it confirms whatever is HIGHLIGHTED — which defaults to `Allow once`. So
 * `respond <id> 3`, meaning Reject, approved.
 *
 * Fixing that by adding `opencode` to a list would have re-opened on the eighth
 * tool. `answerMode` is the measurement itself, declared per DIALOG by the
 * module that read the tool's own frames (`DialogVerdict.answerMode`), and it is
 * already what {@link evaluateAutoYesDialogGate} gates Auto-Yes on. Reading the
 * same field here puts the operator's `respond` behind the same measurement that
 * Auto-Yes is behind, instead of behind a second opinion about tool names.
 *
 * Per-dialog rather than per-tool is load-bearing, not pedantry: copilot reports
 * `numbered` for its permission block and `keys` for its picker
 * (`detection/tools/copilot/prompt.ts`), so any per-tool verdict would be wrong
 * for one of the two.
 *
 * ## What it deliberately does NOT do
 *
 * - It judges only NUMERIC answers. `y` / `no` / free text on a `keys` dialog is
 *   a different failure and a different fix (`resolvePromptAnswer`, #1681).
 * - It never fires for a tool with no measured dialog rules
 *   (`hasDialogRules === false`: gemini, antigravity, vibe-local). Gating on
 *   rules that do not exist would silence those tools, which is the rollout
 *   mistake `auto-yes-dialog-gate` documents.
 * - It does not MAP the answer onto the dialog's buttons. Turning "3" into the
 *   two ←/→ presses that reach `Reject` is Issue P1-7's structured-decision
 *   work; this Issue only stops the wrong keystroke.
 *
 * @throws {PromptAnswerRejectedError} when the tool vouched for a dialog on this
 *   frame whose `answerMode` is not {@link TEXT_ANSWERABLE_ANSWER_MODE}.
 */
async function assertAnswerModeAcceptsNumber(params: SendPromptAnswerParams): Promise<void> {
  if (!/^\d+$/.test(params.answer)) return;

  const detector = getToolStatusDetector(params.cliToolId);
  if (!detector.hasDialogRules) return;

  const frame = await readGuardFrame(params);
  if (frame === null) return;

  const dialog = detector.detectDialog(normalizeFrame(frame));
  if (dialog === null) return;
  if (dialog.answerMode === TEXT_ANSWERABLE_ANSWER_MODE) return;

  throw new PromptAnswerRejectedError(params.cliToolId, params.answer, dialog);
}

/**
 * Resolve the effective SubmitMode from promptData, fallback, and default.
 * Resolution order: promptData.submitMode -> fallbackSubmitMode -> 'answer_then_enter'.
 * Invalid values are normalized to 'answer_then_enter' via allowlist validation.
 *
 * @returns The resolved SubmitMode, guaranteed to be a valid value.
 */
function resolveSubmitMode(params: SendPromptAnswerParams): SubmitMode {
  const fromPromptData = params.promptData?.type === 'multiple_choice'
    ? params.promptData.submitMode
    : undefined;
  const raw = fromPromptData ?? params.fallbackSubmitMode ?? 'answer_then_enter';
  return isValidSubmitMode(raw) ? raw : 'answer_then_enter';
}

/**
 * Determine whether the Enter key should be suppressed after sending the answer text.
 * answer_only mode applies only when the prompt is multiple_choice and the answer is numeric.
 */
function shouldSuppressEnter(params: SendPromptAnswerParams, submitMode: SubmitMode): boolean {
  if (submitMode !== 'answer_only') return false;
  const isMultipleChoice = params.promptData?.type === 'multiple_choice'
    || params.fallbackPromptType === 'multiple_choice';
  return isMultipleChoice && /^\d+$/.test(params.answer);
}

/**
 * Build navigation key array for cursor movement.
 * @param offset - positive = Down, negative = Up
 */
function buildNavigationKeys(offset: number): string[] {
  if (offset === 0) return [];
  const direction = offset > 0 ? 'Down' : 'Up';
  return Array.from({ length: Math.abs(offset) }, () => direction);
}

export interface SendPromptAnswerParams {
  sessionName: string;
  answer: string;
  cliToolId: CLIToolType;
  promptData?: PromptData;
  /** Fallback prompt type from client (only available in route.ts path) */
  fallbackPromptType?: PromptType;
  /** Fallback default option number from client (only available in route.ts path) */
  fallbackDefaultOptionNumber?: number;
  /** Fallback submit mode from client (Issue #616) */
  fallbackSubmitMode?: SubmitMode;
  /**
   * The pane capture to judge the tool's dialog rules against (Issue #2033).
   *
   * Pass the RAW capture, ANSI and box drawing intact: opencode's permission
   * strip is anchored on the input box's own gutter, so a `stripBoxDrawing`ed
   * spelling reaches `null` instead of `permission` (documented in
   * `detection/tools/opencode/prompt.ts`). Both answers suppress here, but only
   * the raw one names the dialog in the refusal.
   *
   * Omit it and the guard reads the pane itself; see {@link readGuardFrame}.
   */
  frame?: string;
}

/**
 * Send an answer to a tmux session, using cursor-key navigation for
 * Claude Code / Antigravity multiple-choice prompts and text input for
 * everything else.
 *
 * This function unifies the logic previously duplicated in:
 * - src/app/api/worktrees/[id]/prompt-response/route.ts (L114-187)
 * - src/lib/auto-yes-manager.ts (L340-399)
 */
export async function sendPromptAnswer(params: SendPromptAnswerParams): Promise<void> {
  const { sessionName, answer, cliToolId, promptData, fallbackPromptType, fallbackDefaultOptionNumber } = params;

  // Issue #2033: before ANY key is chosen, let the tool's own dialog rules
  // refuse a digit its dialog cannot take. Placed above the branch rather than
  // inside the text arm because the number->offset arithmetic the cursor arm
  // does is just as meaningless on an unnumbered button strip as typing the
  // digit is.
  await assertAnswerModeAcceptsNumber(params);

  // Determine if this is an arrow-key-navigated multiple-choice prompt.
  // Claude Code and Antigravity (agy) both render selection menus that only
  // respond to cursor navigation + Enter, not to typed option numbers
  // ([Issue #999] agy's "Do you want to proceed?" permission menu).
  //
  // [Issue #2033] The comment that used to sit here said "everything else
  // (codex/gemini/copilot/opencode) accepts 'N' + Enter as text". That was
  // measured to be wrong for opencode (#1893) and for copilot's picker (#1895),
  // and the correction is NOT another tool id in this condition: it is
  // `assertAnswerModeAcceptsNumber` above, which asks the tool's own
  // `detectDialog` what the dialog ON SCREEN takes. This condition is now only
  // about which INPUT METHOD to use for a dialog that was already cleared as
  // answerable by number.
  const isCursorNavMultiChoice = (cliToolId === 'claude' || cliToolId === 'antigravity')
    && (promptData?.type === 'multiple_choice' || fallbackPromptType === 'multiple_choice')
    && /^\d+$/.test(answer);

  if (isCursorNavMultiChoice) {
    const targetNum = parseInt(answer, 10);

    let defaultNum: number;
    let mcOptions: Array<{ number: number; label: string; isDefault?: boolean }> | null = null;

    if (promptData?.type === 'multiple_choice') {
      // Primary path: use fresh promptData
      mcOptions = promptData.options;
      const defaultOption = mcOptions.find(o => o.isDefault);
      defaultNum = defaultOption?.number ?? 1;
    } else {
      // Fallback path (Issue #287): promptData is undefined or type mismatch, use fallback fields
      defaultNum = fallbackDefaultOptionNumber ?? 1;
    }

    const offset = targetNum - defaultNum;

    // Detect multi-select (checkbox) prompts by checking for [ ] in option labels.
    // Multi-select prompts require: Space to toggle checkbox -> navigate to "Next" -> Enter.
    // Single-select prompts require: navigate to option -> Enter.
    // Note: multi-select detection is only possible when promptData succeeded (mcOptions available).
    const isMultiSelect = mcOptions !== null && mcOptions.some(o => CHECKBOX_OPTION_PATTERN.test(o.label));

    if (isMultiSelect && mcOptions !== null) {
      // Multi-select: toggle checkbox, then navigate to "Next" and submit
      const checkboxCount = mcOptions.filter(o => CHECKBOX_OPTION_PATTERN.test(o.label)).length;
      const keys: string[] = [
        ...buildNavigationKeys(offset),  // 1. Navigate to target option
        'Space',                          // 2. Toggle checkbox
      ];
      // 3. Navigate to "Next" button (positioned right after all checkbox options)
      const downToNext = checkboxCount - targetNum + 1;
      keys.push(...buildNavigationKeys(downToNext));
      // 4. Enter to submit
      keys.push('Enter');
      await sendSpecialKeys(sessionName, keys);
    } else {
      // Single-select: navigate and Enter to select
      const navigationKeys = buildNavigationKeys(offset);

      // [Issue #807] Claude Code v2.x AskUserQuestion picker: when selecting the
      // already-highlighted default option (offset === 0), a bare Enter can fail
      // to advance the picker because its internal cursor index is not committed
      // until a navigation key is pressed. Send a net-zero Down+Up nudge first to
      // engage the cursor onto the default option, then Enter. For offset !== 0
      // the Up/Down navigation already engages the cursor, so no extra nudge is
      // needed. Old-format numbered prompts (isAskUserQuestion unset) keep their
      // exact prior key sequence, so their response behavior is unchanged.
      const isAskUserQuestionPicker = promptData?.type === 'multiple_choice'
        && promptData.isAskUserQuestion === true;
      const keys: string[] = (isAskUserQuestionPicker && offset === 0)
        ? ['Down', 'Up', 'Enter']
        : [...navigationKeys, 'Enter'];
      await sendSpecialKeys(sessionName, keys);
    }
  } else {
    // Standard CLI prompt: send text + Enter (y/n, Approve?, etc.)
    await sendKeys(sessionName, answer, false);

    // Issue #616: Resolve submitMode and determine whether to suppress Enter
    const resolvedSubmitMode = resolveSubmitMode(params);

    if (!shouldSuppressEnter(params, resolvedSubmitMode)) {
      // Wait a moment for the input to be processed
      await new Promise(resolve => setTimeout(resolve, TUI_TEXT_INPUT_WAIT_MS));

      // Send Enter
      await sendKeys(sessionName, '', true);
    }
  }

  // Issue #405: Invalidate cache after sending prompt answer
  invalidateCache(sessionName);
}
