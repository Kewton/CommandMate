/**
 * Shared prompt answer sender for cursor-key and text-based tmux input.
 *
 * Issue #287 Bug2: Extracted from route.ts and auto-yes-manager.ts to
 * eliminate code duplication and ensure consistent behavior (including
 * the promptType/defaultOptionNumber fallback introduced in Bug1).
 */

import { capturePane, sendKeys, sendSpecialKeys, type KeyDeliveryState } from './tmux/tmux';
import type { CLIToolType } from './cli-tools/types';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import { getToolStatusDetector } from '@/lib/detection/tools/registry';
import type { DialogAnswerMode, DialogVerdict } from '@/lib/detection/tools/types';
import { isTypedTextFieldOption } from '@/lib/detection/prompt-detect-multiple-choice';
import { readCommandCodeQuestionDialog } from '@/lib/detection/tools/command-code/dialog';
import { readCommandCodeReviewPage } from '@/lib/detection/selection-shape';
import type { MultipleChoicePromptData, PromptData, PromptType, SubmitMode } from '@/types/models';
import { isValidSubmitMode } from '@/types/models';
import { invalidateCache } from './tmux/tmux-capture-cache';
import { hasCheckboxOptions } from '@/lib/prompt-answer-semantic';
import {
  TUI_MESSAGE_PROCESSED_WAIT_MS,
  TUI_TEXT_INPUT_WAIT_MS,
} from '@/config/cli-tool-timing-config';
import { assessPromptAnswerability } from '@/lib/polling/auto-yes-dialog-gate';
import {
  answerUnderInstanceInputLock,
  instanceInputReadMark,
  type InstanceInputAnswerSkip,
} from '@/lib/session/instance-input-lock';

// Issue #3397: the checkbox reading (`hasCheckboxOptions`) lives in
// `prompt-answer-semantic`, shared with the semantic resolver and Auto-Yes.

/**
 * A validated SELECTION SET, as opposed to free text (Issue #2755).
 *
 * `"1,3"` does not match `/^\d+$/`, which is the shape every guard in this
 * module asks "is this a number?" with — so without this the answer for a
 * checkbox question would be judged, and refused, as free text aimed at a menu
 * row (#2573 / #2583 / #2584). The set is recognised BEFORE those guards run
 * and takes its own arm; none of them is loosened, and every other answer still
 * meets them exactly as it did.
 *
 * Deliberately strict: digits and single commas, no spaces, no empty members.
 * `/prompt-response` normalises what it accepts into this spelling and refuses
 * anything else with nothing sent, so a string reaching here is one the route
 * has already range-checked against the option list on the FRESH frame.
 */
const SELECTION_SET_PATTERN = /^\d+(?:,\d+)*$/;

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
 * The reason code a caller gets back when free text meets a prompt whose
 * text-bearing options are all menu rows (Issue #2573).
 *
 * The code `/prompt-response` already answers "this answer cannot be mapped onto
 * a choice, and nothing was sent" with (#1681, #2522), so `respond` reports it
 * without a new branch.
 */
export const FREE_TEXT_AT_MENU_ROW_REASON = 'unresolvable_answer';

/**
 * Which measurement refused the free text.
 *
 * Both refusals are the same promise to the caller — the text was not typed and
 * the Enter after it was not pressed — and both are reported under
 * {@link FREE_TEXT_AT_MENU_ROW_REASON}, because `respond` and `/prompt-response`
 * branch on the reason code and the next step is the same either way: the dialog
 * is still up, untouched. What differs is the evidence, and therefore the
 * sentence the operator is shown.
 *
 * - `menu_row` (#2573): every text-bearing row on this screen is a MENU row, so
 *   there is nowhere for the characters to land at all.
 * - `cursor_elsewhere` (#2584): there IS a real text field, but the cursor is
 *   resting on a different option, so the characters land nowhere and the Enter
 *   confirms that option instead.
 */
export type FreeTextRefusalKind = 'menu_row' | 'cursor_elsewhere';

/**
 * The extra measurement a `cursor_elsewhere` refusal cites (Issue #2584).
 *
 * Optional on the error so the #2573 construction is unchanged; when it is
 * absent the refusal is a `menu_row` one.
 */
export interface FreeTextRefusalDetail {
  readonly kind: FreeTextRefusalKind;
  /**
   * The option the cursor rests on — i.e. the one the Enter after the text would
   * have confirmed. For Command Code's `AskUserQuestion` this is a verified
   * reading, not a guess: `tools/command-code/dialog.ts` cross-checks the `❯`
   * row against the region's own cursor line and declines the whole screen
   * (`default-unresolved`) when the two disagree.
   */
  readonly cursorOptionNumber: number;
}

/**
 * The sentence for each refusal, built from a tool id and option numbers only.
 *
 * Fixed text, a tool id and option numbers, never the answer (SEC-003, as in
 * `prompt-answer-semantic`): the answer is whatever the operator typed, and
 * `/prompt-response` returns this message to the client verbatim.
 *
 * The two sentences sit side by side on purpose. They differ in the one thing
 * the operator has to act on — what to do next — and that is only comparable
 * when both are readable at once.
 */
function freeTextRefusalMessage(
  cliToolId: CLIToolType,
  optionNumbers: readonly number[],
  detail: FreeTextRefusalDetail | undefined,
): string {
  const numbers = optionNumbers.join(', ');
  if (detail === undefined) {
    return `Refused to type free text at ${cliToolId}'s prompt: option ${numbers} `
      + 'reads as taking your own words, but on this screen it is a menu row, not a text field. '
      + 'The text would be ignored and the Enter after it would confirm whatever is highlighted. '
      + 'Nothing was sent. Answer with the option number, then send the instructions as a message.';
  }
  return `Refused to type free text at ${cliToolId}'s prompt: option ${numbers} is the text field `
    + `on this screen, but the cursor is on option ${detail.cursorOptionNumber}. The text would be `
    + `ignored and the Enter after it would confirm option ${detail.cursorOptionNumber}. Nothing `
    + 'was sent. Move the cursor onto the text field in the terminal and send the text again — '
    + 'sending its option number does not move the cursor, it selects nothing.';
}

/**
 * Free text refused BEFORE any key reached the pane (Issue #2573, #2584).
 *
 * A sibling of {@link PromptAnswerRejectedError}, not a use of it, because the
 * two cite different evidence. That one cites the dialog the tool's own rules
 * vouched for (`dialogKind` / `answerMode`), and no such verdict can decide this
 * case: Command Code has had rules since Issue #2574, and the permission dialog
 * this guard is first about is vouched `numbered` — the verdict that lets a
 * DIGIT through — while the `AskUserQuestion` screen whose free text must keep
 * working is deliberately not recognised by those rules at all
 * (`tools/command-code/permission.ts`). `answerMode` says how a CHOICE is
 * pressed; it says nothing about which row is a text field, nor about which row
 * the cursor is on. So what this one cites is the rows.
 *
 * One class rather than two because `/prompt-response` is out of reach of both
 * Issues' scope and matches this type by `instanceof` to report the refusal at
 * all; {@link FreeTextRefusalKind} is what tells the two cases apart.
 */
export class FreeTextAnswerRejectedError extends Error {
  /** Machine-readable code, always {@link FREE_TEXT_AT_MENU_ROW_REASON}. */
  readonly reason: string;
  /**
   * The text-bearing options this refusal is about: the menu rows for
   * `menu_row`, the measured text field(s) for `cursor_elsewhere`.
   */
  readonly optionNumbers: readonly number[];
  /** Which measurement refused (Issue #2584). */
  readonly kind: FreeTextRefusalKind;
  /** The option the Enter would have confirmed, or null for `menu_row`. */
  readonly cursorOptionNumber: number | null;

  constructor(
    cliToolId: CLIToolType,
    optionNumbers: readonly number[],
    detail?: FreeTextRefusalDetail,
  ) {
    super(freeTextRefusalMessage(cliToolId, optionNumbers, detail));
    this.name = 'FreeTextAnswerRejectedError';
    this.reason = FREE_TEXT_AT_MENU_ROW_REASON;
    this.optionNumbers = optionNumbers;
    this.kind = detail?.kind ?? 'menu_row';
    this.cursorOptionNumber = detail?.cursorOptionNumber ?? null;
  }
}

/**
 * Free text refused because NO row on the screen takes typed text (Issue #2583).
 *
 * ## The hole #2573 left
 *
 * {@link FreeTextAnswerRejectedError} looks for rows that READ as taking the
 * operator's own words (`requiresTextInput`, i.e. `TEXT_INPUT_PATTERNS`) and
 * only judges the answer when it finds at least one. A permission dialog with
 * no such row was therefore never judged at all, and the text arm typed the
 * answer and pressed Enter. Measured on 2026-09-16 against develop `9f4b4e29`:
 *
 * | tool | dialog | rows | result |
 * |------|--------|------|--------|
 * | Claude Code 2.1.273 | Bash command | `1. Yes` / `2. Yes, and always allow access to …` / `3. Yes, and switch to auto mode` / `4. No` | `success: true`, the `mkdir` RAN |
 * | Antigravity 1.2.3 | Run this command? | `1. Yes, run command` / `2. Yes, and always allow …` / `3. Yes, … (Persist to settings.json)` / `4. No, cancel` | `success: true`, the `mkdir` RAN |
 *
 * Same screens, but with a path containing the word `custom`, `/custom/i`
 * flagged the quoting row and #2573's guard refused. So what was left decided
 * whether a refusal meaning "do not do this" approved instead: the SPELLING of
 * the command being approved.
 *
 * ## What the caller is told, and why the count rather than the rows
 *
 * There is no row to name here — that is the whole condition — so the message
 * cites how many options the screen has and points at the option number. It
 * never quotes the answer (SEC-003, as in `prompt-answer-semantic`): the answer
 * is whatever the operator typed and `/prompt-response` hands this message back
 * to the client verbatim.
 *
 * Shares {@link FREE_TEXT_AT_MENU_ROW_REASON} with its sibling deliberately:
 * the reason code is what `respond` and `/prompt-response` branch on, and both
 * cases are the same promise to the caller — the answer could not be mapped onto
 * a choice and NOTHING was sent.
 */
export class FreeTextAtChoiceOnlyPromptError extends Error {
  /** Machine-readable code, always {@link FREE_TEXT_AT_MENU_ROW_REASON}. */
  readonly reason: string;
  /** How many options the screen offers, none of which is a text field. */
  readonly optionCount: number;

  constructor(cliToolId: CLIToolType, optionCount: number) {
    super(
      `Refused to type free text at ${cliToolId}'s prompt: none of its ${optionCount} options is a `
      + 'text field on this screen, so the text would be ignored and the Enter after it would '
      + 'confirm whatever is highlighted. Nothing was sent. Answer with the option number instead, '
      + 'then send your instructions as a separate message.'
    );
    this.name = 'FreeTextAtChoiceOnlyPromptError';
    this.reason = FREE_TEXT_AT_MENU_ROW_REASON;
    this.optionCount = optionCount;
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
 *   mistake `auto-yes-dialog-gate` documents. command-code has had rules since
 *   Issue #2574 (before it, it belonged in this list and was missing from it);
 *   they only ever answer `numbered`, so on that tool this guard never refuses
 *   and its reading is used for the Enter instead (see {@link resolveSubmitMode}).
 * - It does not MAP the answer onto the dialog's buttons. Turning "3" into the
 *   two ←/→ presses that reach `Reject` is Issue P1-7's structured-decision
 *   work; this Issue only stops the wrong keystroke.
 *
 * @returns The `numbered` dialog the tool vouched for on this frame, or null when
 *   the guard did not read one (non-numeric answer, no rules, unreadable pane,
 *   or no dialog on screen). Returned so the Enter decision is made off the
 *   same reading rather than a second capture (Issue #2574).
 * @throws {PromptAnswerRejectedError} when the tool vouched for a dialog on this
 *   frame whose `answerMode` is not {@link TEXT_ANSWERABLE_ANSWER_MODE}.
 */
async function assertAnswerModeAcceptsNumber(params: SendPromptAnswerParams): Promise<DialogVerdict | null> {
  if (!/^\d+$/.test(params.answer)) return null;

  const detector = getToolStatusDetector(params.cliToolId);
  if (!detector.hasDialogRules) return null;

  const frame = await readGuardFrame(params);
  if (frame === null) return null;

  const dialog = detector.detectDialog(normalizeFrame(frame, params.cliToolId));
  if (dialog === null) return null;
  if (dialog.answerMode === TEXT_ANSWERABLE_ANSWER_MODE) return dialog;

  throw new PromptAnswerRejectedError(params.cliToolId, params.answer, dialog);
}

/**
 * Resolve the effective SubmitMode from the dialog on screen, promptData, fallback, and default.
 * Resolution order: dialog.submitMode -> promptData.submitMode -> fallbackSubmitMode -> 'answer_then_enter'.
 * Invalid values are normalized to 'answer_then_enter' via allowlist validation.
 *
 * Issue #2574: the dialog comes first because it is the tool's own measurement,
 * read off the frame the answer is about to land on. `promptData` may have been
 * built by the generic parser, which cannot see that a digit is a hotkey —
 * Command Code's permission dialog was published with no `submitMode`, and the
 * Enter sent after its `1` submitted whatever draft was waiting in the composer.
 *
 * @returns The resolved SubmitMode, guaranteed to be a valid value.
 */
function resolveSubmitMode(params: SendPromptAnswerParams, dialog: DialogVerdict | null): SubmitMode {
  const fromPromptData = params.promptData?.type === 'multiple_choice'
    ? params.promptData.submitMode
    : undefined;
  const raw = dialog?.submitMode ?? fromPromptData ?? params.fallbackSubmitMode ?? 'answer_then_enter';
  return isValidSubmitMode(raw) ? raw : 'answer_then_enter';
}

/**
 * Determine whether the Enter key should be suppressed after sending the answer text.
 * answer_only mode applies only when the prompt is multiple_choice and the answer is numeric.
 * A numbered dialog the tool vouched for is a multiple-choice prompt in its own right,
 * which covers a caller that could not supply promptData (Issue #2574).
 */
function shouldSuppressEnter(
  params: SendPromptAnswerParams,
  submitMode: SubmitMode,
  dialog: DialogVerdict | null,
): boolean {
  if (submitMode !== 'answer_only') return false;
  const isMultipleChoice = dialog !== null
    || params.promptData?.type === 'multiple_choice'
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

/**
 * Refuse free text aimed at a menu row (Issue #2573).
 *
 * ## The hole
 *
 * `PromptPanel` / `MobilePromptSheet` sent the operator's TEXT instead of the
 * option number whenever the selected option had `requiresTextInput`, and
 * `respond <id> "<text>"` sends text by construction. Nothing below maps text
 * onto a choice — the cursor arm takes digits only — so the text arm typed it at
 * the dialog and pressed Enter. On Command Code 1.53.1's permission dialog
 * (`3. No, tell Command Code what to do differently`) the characters are ignored
 * and the Enter confirms the highlighted `1. Yes`: measured, a reason meaning
 * "do not do this" ran the `mkdir` it was sent to stop, and `/prompt-response`
 * answered `success: true`.
 *
 * ## Why it is keyed on the rows and not on "is the answer a number"
 *
 * Free text is the RIGHT answer on the screen next door. Command Code's
 * `AskUserQuestion` ends in `Type something...`, a real `TextInput` (#2522), and
 * both rows carry `requiresTextInput`. So the question is whether the prompt's
 * text-bearing options include one measured to be a field
 * ({@link isTypedTextFieldOption}); only when every one of them is a menu row is
 * the text refused.
 *
 * ## Issue #2583: a screen with no text-bearing row is judged too
 *
 * The bullet that used to sit here said this guard does not judge a prompt with
 * NO `requiresTextInput` option, citing #1726's pin — "sessions the rows cannot
 * speak for keep behaving as they did". It named the hole it was leaving open in
 * as many words (`the same Enter still sits under free text sent at, e.g.,
 * claude's 1. Yes / 2. … / 3. No`), and #2583 then measured it: on claude 2.1.273
 * and agy 1.2.3 a refusal typed at a Bash-approval dialog answered
 * `success: true` and RAN the command. Whether it was refused came down to
 * whether the quoted path happened to contain the word `custom`, which is
 * `/custom/i` in `TEXT_INPUT_PATTERNS` — the spelling of someone else's argument.
 *
 * So the rule is now the one the guard's name always claimed: free text needs a
 * text field, and a `multiple_choice` prompt whose rows are all choices has none.
 *
 * **What this costs, and why it is still the right trade.** #1726's pin is about
 * AUTHORITY: that Issue reads the agent's own `AskUserQuestion` payload and must
 * not let its absence narrow what a hook-less session accepts, because there the
 * screen is the only authority. The rows judged here ARE the screen — the fresh
 * capture `/prompt-response` re-verified, parsed by the same reader that draws
 * the answer panels — so nothing is being second-guessed from a payload that is
 * missing. What #1726 keeps is its actual subject: an out-of-RANGE number is
 * still sent when no payload vouches for the list (this guard reads only
 * non-numeric answers), and a call with no `promptData` at all still goes
 * through untouched. The one case that regresses is an operator who has walked
 * the cursor onto a row that opens a field the rows do not advertise — claude's
 * `4. Type something.`, which no pattern flags — and sends text for it; they now
 * get a refusal with the dialog still up instead of a silent approval. That
 * direction is the safe one, and cursor position is #2584's subject, not this
 * one's.
 *
 * ## What it deliberately does NOT do
 *
 * - It does not judge a call with no `promptData`, nor a `multiple_choice` with
 *   an empty option list. Both mean the rows are unknown, which is exactly where
 *   #1726's pin still holds — and where `/prompt-response` has already refused
 *   for its own reasons if the pane could be read at all.
 * - It does not deliver the reason. Sending the number and then the text as a
 *   message is the follow-up (#2573 対応内容 2). Issue #2574 has since removed the
 *   Enter that would have landed the reason in the wrong place on command-code,
 *   so what is still missing is a measurement, per tool, of where the input goes
 *   once the digit has confirmed.
 *
 * @throws {FreeTextAtChoiceOnlyPromptError} when the answer is not a number and
 *   no option of the multiple-choice prompt even reads as taking text (#2583).
 * @throws {FreeTextAnswerRejectedError} when the answer is not a number and every
 *   text-bearing option of the multiple-choice prompt is a menu row (#2573).
 */
function assertFreeTextHasATextField(params: SendPromptAnswerParams): void {
  if (/^\d+$/.test(params.answer)) return;
  const { promptData } = params;
  if (promptData?.type !== 'multiple_choice') return;
  // No rows to read is not the same as rows that take no text: a prompt this
  // degraded says nothing about where characters land, so it keeps the
  // pre-#2583 path (see the pin discussion above).
  if (promptData.options.length === 0) return;

  const textBearing = promptData.options.filter((option) => option.requiresTextInput === true);
  // Issue #2583. Deliberately BEFORE the `isTypedTextFieldOption` reading below
  // and never inside it: that reading decides between a field and a menu row on
  // a screen that has at least one candidate, and this branch is the screen that
  // has none.
  if (textBearing.length === 0) {
    throw new FreeTextAtChoiceOnlyPromptError(params.cliToolId, promptData.options.length);
  }
  if (textBearing.some(isTypedTextFieldOption)) return;

  throw new FreeTextAnswerRejectedError(
    params.cliToolId,
    textBearing.map((option) => option.number),
  );
}

/**
 * Refuse free text while the cursor is on another row (Issue #2584).
 *
 * ## The hole #2573 left open
 *
 * {@link assertFreeTextHasATextField} asks what KIND the text-bearing rows are,
 * and lets the text through the moment one of them is a measured field. On
 * Command Code's `AskUserQuestion` that is one question short, because the field
 * is a row of a list and typed characters only reach it while the cursor is
 * resting there. Measured on 1.53.1 (#2584), with `Type something...` on row 3
 * and the `❯` on row 1:
 *
 * ```
 * ❯ 1. apple
 *   2. banana
 *   3. Type something...
 * ```
 *
 * `answer: "UAT-FREETEXT-KIWI"` was ignored, the Enter after it confirmed
 * `apple`, and `/prompt-response` answered `success: true` — the same failure
 * shape as #2573, reached through the screen #2573 deliberately exempts. The
 * SAME request on the SAME screen with the `❯` on row 3 records the text, so
 * nothing but the cursor decides which of the two it means.
 *
 * ## Why it refuses instead of moving the cursor there first
 *
 * The obvious alternative is to reuse the cursor arm: compute `field - cursor`
 * and send that many Down presses before typing. The arithmetic is available —
 * both numbers are read off the frame — but the KEYS are not measured for this
 * screen. The cursor arm is claude's and agy's by construction
 * (`isCursorNavMultiChoice`, and `tools/command-code/dialog.ts` says so where it
 * publishes this prompt), and what IS measured for Command Code is the opposite
 * input method: the digit is a hotkey that selects on its own, which is why the
 * screen is published `answer_only` (#2574). #2522 measured the remaining half —
 * the digit aimed at the field row selects nothing — so this repository has no
 * measured keystroke that moves this cursor at all.
 *
 * Sending Down at it anyway would, if the list does not take arrow keys,
 * reproduce exactly today's bug with extra keystrokes in front of it and still
 * answer `success: true`. That is the mistake `assertAnswerModeAcceptsNumber`
 * was written against: gate on the measurement, and stop the wrong keystroke
 * rather than invent a mapping. Mapping the answer onto the field — teaching the
 * sender to arm this cursor once the movement key has been measured live — is
 * the follow-up, and it can be added under this guard without changing what any
 * caller sees today.
 *
 * ## What it deliberately does NOT do
 *
 * - It does not fire on a prompt with no measured field: that is #2573's case
 *   above (every text-bearing row is a menu row) or the pre-#2573 pass-through
 *   (#1726), and neither changes here.
 * - It does not fire when NO option carries the cursor. agy's picker publishes
 *   its highlight without `isDefault` at all (`#999`), and a screen whose cursor
 *   cannot be read is one this guard has nothing to say about — the same
 *   fail-open {@link readGuardFrame} takes for an unreadable pane.
 *
 * @throws {FreeTextAnswerRejectedError} with `kind: 'cursor_elsewhere'` when the
 *   answer is not a number, the prompt has a measured text field, and the cursor
 *   is resting on some other option.
 */
function assertFreeTextCursorIsOnTheField(params: SendPromptAnswerParams): void {
  if (/^\d+$/.test(params.answer)) return;
  const { promptData } = params;
  if (promptData?.type !== 'multiple_choice') return;

  const fields = promptData.options.filter(isTypedTextFieldOption);
  if (fields.length === 0) return;

  const cursor = promptData.options.find((option) => option.isDefault === true);
  if (cursor === undefined) return;
  if (isTypedTextFieldOption(cursor)) return;

  throw new FreeTextAnswerRejectedError(
    params.cliToolId,
    fields.map((option) => option.number),
    { kind: 'cursor_elsewhere', cursorOptionNumber: cursor.number },
  );
}

/**
 * The reason code every Command Code multi-select refusal carries
 * (Issue #2755).
 *
 * Shares the shape of {@link ANSWER_MODE_KEYS_REASON} and
 * {@link FREE_TEXT_AT_MENU_ROW_REASON} — a machine-readable code the API and
 * `respond` branch on — and means one thing: **the question was not
 * committed.** What varies is how far the arm got, which
 * {@link MultiSelectAnswerRejectedError.stage} says.
 */
export const MULTI_SELECT_NOT_COMMITTED_REASON = 'multi_select_not_committed';

/** How far {@link sendCommandCodeMultiSelectAnswer} got before it gave up. */
export type MultiSelectRefusalStage =
  /** The payload named no cursor row, so the walk to the confirm row has no origin. NOTHING was sent. */
  | 'cursor-unknown'
  /** The pane could not be re-read after the toggles. */
  | 'recapture-failed'
  /** The screen is no longer the same checkbox question. */
  | 'screen-changed'
  /** The re-read ticks do not equal the requested set. The confirm was NOT pressed. */
  | 'toggle-mismatch'
  /** The confirm row was pressed and neither a Review page nor the next question came up. */
  | 'not-committed'
  /** The Review page says answers are missing, so it must not be confirmed. */
  | 'review-unanswered';

/**
 * A Command Code checkbox answer that did not reach the agent (Issue #2755).
 *
 * The sibling of {@link PromptAnswerRejectedError} for the two-stage confirm.
 * Unlike that one it does NOT always promise an untouched pane — ticking boxes
 * is the first half of this answer and it may already have happened — so
 * {@link keysSent} says which of the two the caller is looking at. What it does
 * promise in every case is that the question was **not submitted**: the arm
 * stops before the confirm row whenever the screen it re-read is not the one it
 * was asked to answer.
 *
 * Fixed text, a tool id and option numbers only (SEC-003, as in
 * `prompt-answer-semantic`): `/prompt-response` returns this message verbatim.
 */
export class MultiSelectAnswerRejectedError extends Error {
  /** Machine-readable code, always {@link MULTI_SELECT_NOT_COMMITTED_REASON}. */
  readonly reason: string;
  readonly stage: MultiSelectRefusalStage;
  /** Whether any key reached the pane before the refusal. */
  readonly keysSent: boolean;
  /** The set the caller asked for, ascending. */
  readonly wanted: readonly number[];

  constructor(stage: MultiSelectRefusalStage, keysSent: boolean, wanted: readonly number[]) {
    super(
      `The question was not submitted (${stage}). `
      + (keysSent
        ? 'Some boxes may have been ticked, but the confirm row was not pressed, so the '
          + 'question is still on screen exactly as the pane shows it. '
        : 'No key was sent. ')
      + `Requested selection: ${wanted.join(', ')}. Check the terminal and answer it there, or `
      + 'retry once the screen has settled.'
    );
    this.name = 'MultiSelectAnswerRejectedError';
    this.reason = MULTI_SELECT_NOT_COMMITTED_REASON;
    this.stage = stage;
    this.keysSent = keysSent;
    this.wanted = wanted;
  }
}

/**
 * Is this request a Command Code checkbox answer? (Issue #2755)
 *
 * Three conditions, all of them about the FRESH reading rather than about the
 * caller's claim: the tool, the payload's own `multiSelect` and the shape of
 * the answer. `promptData` here is what `/prompt-response` re-verified against
 * the pane a moment ago, which is why this arm may act on `option.checked`
 * without taking a capture of its own first.
 *
 * A bare `"2"` counts. On a `multiSelect: true` payload the digit is a TOGGLE,
 * so "the answer is 2" is not an available reading of it — which is the half of
 * 確定仕様 5 this function owns; the other half, telling a one-item checkbox
 * answer apart from a single-select one, is a request-shape question and lives
 * in the route.
 */
function readMultiSelectRequest(
  params: SendPromptAnswerParams,
): { promptData: MultipleChoicePromptData; wanted: number[] } | null {
  if (params.cliToolId !== 'command-code') return null;
  const { promptData } = params;
  if (promptData?.type !== 'multiple_choice') return null;
  if (promptData.multiSelect !== true) return null;
  if (!SELECTION_SET_PATTERN.test(params.answer)) return null;
  const wanted = [...new Set(params.answer.split(',').map(Number))].sort((a, b) => a - b);
  return { promptData, wanted };
}

/** `Down` this many times, as {@link sendSpecialKeys} names the key. */
function downKeys(count: number): string[] {
  return Array.from({ length: Math.max(0, count) }, () => 'Down');
}

/** The ticked option numbers of a reading, ascending. */
function tickedNumbers(promptData: MultipleChoicePromptData): number[] {
  return promptData.options.filter((o) => o.checked === true).map((o) => o.number);
}

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Re-read the pane after a keystroke, or null when it cannot be read.
 *
 * `capturePane` here rather than the caller's `frame`: the whole point of the
 * read is that the screen has moved since. {@link TUI_MESSAGE_PROCESSED_WAIT_MS}
 * is the settle the rest of this file already uses for a TUI that has just been
 * typed at.
 */
async function recaptureAfterKeys(sessionName: string): Promise<string | null> {
  await new Promise((resolve) => setTimeout(resolve, TUI_MESSAGE_PROCESSED_WAIT_MS));
  try {
    return await capturePane(sessionName, GUARD_CAPTURE_LINES);
  } catch {
    return null;
  }
}

/**
 * Answer Command Code's checkbox `AskUserQuestion` (Issue #2755 §6 / §7).
 *
 * ## What the keys mean, measured
 *
 * Every line below is from #2754's twenty-six live captures
 * (`docs/design/command-code-1541-askuserquestion.md` §4), taken one keystroke
 * at a time with a capture on each side:
 *
 * | key | on this screen |
 * |---|---|
 * | `1`–`9` | **toggles** that box. The cursor does not move. Dead while the `❯` is off the list |
 * | `Enter` on an option row | toggles that row. It is NOT a confirm |
 * | `Enter` on `Submit` / `Next` | opens the **Review page**, or advances to the next question. Still not a send |
 * | `Enter` on the Review page's `❯ 1. Submit` | **this** is where the answer is sent |
 * | `Space` | works, but from `Submit` it ticked a row the cursor was nowhere near. Not sent |
 * | `Esc` / `c` / `d` / `n` | cancel, send-as-chat, finish, mode switch. One keystroke each, no confirmation. Not sent |
 *
 * So the sequence is: **toggle the symmetric difference → walk down to the
 * confirm row → Enter → confirm on the Review page.** The confirm is two stages
 * and an implementation that stopped at the first one would report an answer
 * the agent never received.
 *
 * ## Why a symmetric difference and not "press the numbers"
 *
 * The answer is the SET the operator wants ticked, not a list of toggles. A row
 * the human already ticked in the terminal is `[✔]` on the frame, and pressing
 * its number would turn it OFF; a row they want off but that is already on has
 * to be pressed even though it is not in the answer. `current` comes from
 * `option.checked` on the payload `/prompt-response` verified against the pane
 * moments earlier, so both halves are read rather than assumed.
 *
 * ## Why it re-reads before the confirm
 *
 * Because a toggle is only measured to work while the cursor is in the list,
 * and nothing on the frame proves the tool accepted the keystroke. Confirming a
 * set nobody verified is the failure this whole Issue is about, one screen
 * later. If the re-read does not equal the request, the confirm is not pressed
 * and the operator gets the pane back exactly as it is.
 *
 * @throws {MultiSelectAnswerRejectedError} whenever the question was not
 *   committed; `keysSent` says whether the pane was touched.
 */
async function sendCommandCodeMultiSelectAnswer(
  sessionName: string,
  promptData: MultipleChoicePromptData,
  wanted: readonly number[],
  stillCurrent?: () => boolean,
  touch?: PaneTouch,
  assertOwned: (keysSent: boolean) => void = () => {},
): Promise<void> {
  const cursor = promptData.options.find((option) => option.isDefault === true);
  if (cursor === undefined) {
    throw new MultiSelectAnswerRejectedError('cursor-unknown', false, wanted);
  }

  // 1. The symmetric difference, ascending, one digit per press. An empty one
  //    sends nothing at all — the set on screen is already the set asked for,
  //    and the only thing left to do is commit it.
  const current = tickedNumbers(promptData);
  const toggles = [
    ...wanted.filter((n) => !current.includes(n)),
    ...current.filter((n) => !wanted.includes(n)),
  ].sort((a, b) => a - b);
  if (toggles.length > 0) {
    assertOwned(false);
    await sendSpecialKeysWhileCurrent(sessionName, toggles.map(String), stillCurrent, touch);
  }
  const keysSent = toggles.length > 0;

  // 2. Read the screen back and refuse unless it is the same question with
  //    exactly the requested boxes ticked.
  const afterToggle = await recaptureAfterKeys(sessionName);
  assertStillCurrent(stillCurrent, keysSent);
  if (afterToggle === null) {
    throw new MultiSelectAnswerRejectedError('recapture-failed', keysSent, wanted);
  }
  const reading = readCommandCodeQuestionDialog(afterToggle);
  if (
    reading.kind !== 'prompt' ||
    reading.prompt.promptData?.type !== 'multiple_choice' ||
    reading.prompt.promptData.multiSelect !== true ||
    reading.prompt.promptData.question !== promptData.question ||
    reading.prompt.promptData.options.length !== promptData.options.length
  ) {
    throw new MultiSelectAnswerRejectedError('screen-changed', keysSent, wanted);
  }
  const verified = reading.prompt.promptData;
  if (!sameNumbers(tickedNumbers(verified), [...wanted])) {
    throw new MultiSelectAnswerRejectedError('toggle-mismatch', keysSent, wanted);
  }

  // 3. Walk to the confirm row and open it. `Down` is the only movement key
  //    measured to be deterministic here: it steps one row at a time through
  //    the options, then the free-text row, then stops on `Submit` / `Next`.
  //    (`Up` from option 1 goes to two different rows depending on whether the
  //    list has ever reported a highlight — invisible on the frame.) The cursor
  //    is re-read rather than reused, because the request is allowed to have
  //    been built from a slightly older frame.
  const cursorNow = verified.options.find((option) => option.isDefault === true);
  if (cursorNow === undefined) {
    throw new MultiSelectAnswerRejectedError('cursor-unknown', keysSent, wanted);
  }
  // Issue #3952 review P2: the input held since the toggles, across the re-read.
  assertOwned(keysSent);
  await sendSpecialKeysWhileCurrent(
    sessionName,
    [...downKeys(verified.options.length - cursorNow.number + 1), 'Enter'],
    stillCurrent,
    touch,
  );

  // 4. The second stage. `Submit` opens the Review page and the answer is sent
  //    from there; `Next` advances to the following question, which IS the
  //    commit for this one (its tab turns `✔`).
  const afterConfirm = await recaptureAfterKeys(sessionName);
  assertStillCurrent(stillCurrent, true);
  if (afterConfirm === null) {
    throw new MultiSelectAnswerRejectedError('recapture-failed', true, wanted);
  }
  const review = readCommandCodeReviewPage(afterConfirm);
  if (review !== null) {
    // Reached with answers still missing — the `d` shape. Confirming it would
    // send `No answer` for questions nobody has been shown (Issue #2755 §7).
    if (review.hasUnansweredWarning) {
      throw new MultiSelectAnswerRejectedError('review-unanswered', true, wanted);
    }
    assertOwned(true);
    await sendSpecialKeysWhileCurrent(sessionName, ['Enter'], stillCurrent, touch);
    return;
  }

  const next = readCommandCodeQuestionDialog(afterConfirm);
  const advanced =
    next.kind === 'prompt' &&
    next.prompt.promptData?.type === 'multiple_choice' &&
    next.prompt.promptData.question !== promptData.question;
  if (!advanced) {
    throw new MultiSelectAnswerRejectedError('not-committed', true, wanted);
  }
}

/**
 * The reason code of {@link PromptAnswerNotDeliveredError} (Issue #3952).
 * Crosses the API boundary (`/prompt-response`'s refusal body, `/respond`'s 409).
 */
export const ANSWER_NOT_DELIVERED_REASON = 'answer_not_delivered';

/**
 * Why an answer was not typed: the lock's own reasons, or (review P1-2) the
 * caller's last look before the first key said the answer is no longer its to send.
 */
export type PromptAnswerNotDeliveredSkip = InstanceInputAnswerSkip | 'answer-withheld';

const NOT_DELIVERED_WHY: Record<PromptAnswerNotDeliveredSkip, string> = {
  'target-changed': 'the prompt it was for was no longer on screen once the input in progress had finished',
  'answer-withheld': 'the answer was no longer allowed once the input in progress had finished',
  'recheck-failed': 'the screen could not be read again once the input in progress had finished',
  'input-lock-timeout': 'another input held the session past the wait',
  'session-replaced': 'the session was replaced while the answer waited',
  'input-lock-lost': "the session's input was handed to another writer",
};

/**
 * An answer that waited for a send (or another answer) holding the session's
 * input, and was then not typed (Issue #3952): the prompt it was for is gone or
 * changed, the screen could not be read again, the wait ran out, or the session
 * was replaced. Nothing of it reached the pane (`keysSent: false`), so the
 * prompt is exactly as the operator left it — or no longer there.
 */
export class PromptAnswerNotDeliveredError extends Error {
  readonly reason = ANSWER_NOT_DELIVERED_REASON;
  readonly keysSent = false;

  constructor(readonly skip: PromptAnswerNotDeliveredSkip, sessionName: string) {
    super(`The answer was not sent to ${sessionName}: ${NOT_DELIVERED_WHY[skip]} (${skip}). Nothing was typed.`);
    this.name = 'PromptAnswerNotDeliveredError';
  }
}

/** The prompt a frame shows, read as `/prompt-response` verifies one; null when none is answerable. */
function readAnswerablePrompt(cliToolId: CLIToolType, frame: string): PromptData | null {
  const { promptCheck, refusal } = assessPromptAnswerability(cliToolId, frame);
  if (refusal || !promptCheck?.isPrompt) return null;
  return promptCheck.promptData ?? null;
}

/** A text as compared: runs of whitespace as one, and no cursor glyphs (`❯ 1. Yes` is `1. Yes`). */
function comparable(text: string | undefined): string {
  return (text ?? '').replace(/[❯›▶]/g, ' ').replace(/\s+/g, ' ').trim();
}

function sameText(a: string | undefined, b: string | undefined): boolean {
  return comparable(a) === comparable(b);
}

/**
 * Whether two readings are the same prompt to answer: its kind, its wording,
 * its options' labels and — when both readings have one — what it asks approval
 * for. The cursor (`isDefault`, the `❯` in the approval block) is not compared:
 * moving it does not make it another prompt.
 */
function samePromptTarget(target: PromptData, now: PromptData): boolean {
  if (target.type !== now.type || !sameText(target.question, now.question)) return false;
  if (target.approvalTarget !== undefined && now.approvalTarget !== undefined) {
    if (!sameText(target.approvalTarget, now.approvalTarget)) return false;
  }
  if (target.type === 'multiple_choice' && now.type === 'multiple_choice') {
    if (target.options.length !== now.options.length) return false;
    return target.options.every((option, i) => sameText(option.label, now.options[i].label));
  }
  return true;
}

/**
 * The re-check an answer makes once it owns the session's input after another
 * writer (Issue #3952): the caller still acts (Auto-Yes's `stillCurrent`), and
 * a fresh capture still shows the prompt the answer was decided for — the one
 * read off the caller's frame, else the caller's `promptData`, else any
 * answerable prompt. Returns that fresh reading, or null when it does not.
 */
async function answerTargetStillOnScreen(params: SendPromptAnswerParams): Promise<PromptData | null> {
  if (params.stillCurrent && !params.stillCurrent()) return null;
  const now = readAnswerablePrompt(params.cliToolId, await capturePane(params.sessionName, GUARD_CAPTURE_LINES));
  if (now === null) return null;
  const target = (params.frame !== undefined ? readAnswerablePrompt(params.cliToolId, params.frame) : null)
    ?? params.promptData
    ?? null;
  return target === null || samePromptTarget(target, now) ? now : null;
}

/**
 * An answer whose input was taken from it part-way (Issue #3952 review P2):
 * the session was replaced after some of its keys had gone out, and the rest
 * were not sent. Unlike {@link PromptAnswerNotDeliveredError} the pane was
 * touched (`keysSent: true`), so it is a failure, not a refusal.
 */
export class PromptAnswerInputLostError extends Error {
  readonly keysSent = true;

  constructor(sessionName: string) {
    super(
      `The answer to ${sessionName} was stopped part-way: the session was replaced while the answer ` +
        'held its input. Some keys were sent; the rest were not (Issue #3952).'
    );
    this.name = 'PromptAnswerInputLostError';
  }
}

/**
 * How an answer's keys stay inside its hold of the session's input (Issue
 * #3952 review P2), handed to {@link InputWriterSend}.
 */
interface InputWriterKeys {
  /**
   * The ticket's check, joined with the caller's `stillCurrent` when it gave
   * one: asked between the keys of one `sendSpecialKeys` call. Always given
   * (review P2, fourth contract): a manual answer passes no `stillCurrent`, and
   * its arrow keys and toggles — each its own tmux call after a 100 ms wait —
   * must stop as well when the session is replaced part-way.
   */
  stillCurrent: () => boolean;
  /**
   * Throw before a key when the ticket is no longer current: with nothing on
   * the pane yet, {@link PromptAnswerNotDeliveredError} (`input-lock-lost`);
   * after a key, {@link PromptAnswerInputLostError}.
   */
  assertOwned: (keysSent: boolean) => void;
}

/**
 * The keys of an answer, typed as the session's input writer. Given the prompt
 * as read again under the lock (null when nothing was read again), it types
 * and returns nothing, or returns why it typed nothing — before any key.
 */
type InputWriterSend = (reread: PromptData | null, keys: InputWriterKeys) => Promise<'target-changed' | void>;

/**
 * The caller's last look before the first key (review P1-2, P1-b): asked right
 * before it, whether or not anything was read again — a guard's capture or the
 * lock's admission is an await the contract can change across.
 */
function stillAllowedNow(params: SendPromptAnswerParams): boolean {
  return params.stillAllowedAtSend === undefined || params.stillAllowedAtSend();
}

/**
 * Run an answer's keys as the session's input writer (Issue #3952): a send in
 * progress is waited out, and the prompt is read again after it. The keys are
 * built from that fresh reading (review P1-1: the cursor may have moved), and
 * the caller's `stillAllowedAtSend` is asked again right before the first key
 * (review P1-2: the contract may have changed during the wait). Refused, the
 * answer throws {@link PromptAnswerNotDeliveredError} with nothing typed.
 */
async function sendAsInputWriter(
  params: SendPromptAnswerParams,
  readMark: number,
  send: InputWriterSend,
): Promise<void> {
  let reread: PromptData | null = null;
  const outcome = await answerUnderInstanceInputLock(
    params.sessionName,
    readMark,
    async () => {
      reread = await answerTargetStillOnScreen(params);
      return reread !== null;
    },
    async (ticket): Promise<PromptAnswerNotDeliveredSkip | void> => {
      // Review P1-b: always, wait or no wait — see `stillAllowedNow`.
      if (!stillAllowedNow(params)) return 'answer-withheld';
      // Review P2: every key of the answer goes out only while its ticket is
      // current; a session replaced part-way gets none of the rest.
      let lost = false;
      const owned = (): boolean => {
        if (ticket.isCurrent()) return true;
        lost = true;
        return false;
      };
      const callerStillCurrent = params.stillCurrent;
      const keys: InputWriterKeys = {
        stillCurrent: () => owned() && (callerStillCurrent === undefined || callerStillCurrent()),
        assertOwned: (keysSent) => {
          if (owned()) return;
          if (keysSent) throw new PromptAnswerInputLostError(params.sessionName);
          throw new PromptAnswerNotDeliveredError('input-lock-lost', params.sessionName);
        },
      };
      try {
        return await send(reread, keys);
      } catch (error: unknown) {
        // The joined `stillCurrent` said no because of the ticket, not the
        // caller: say which, as `assertOwned` does.
        if (lost && error instanceof PromptAnswerAbortedError) {
          if (error.keysSent) throw new PromptAnswerInputLostError(params.sessionName);
          throw new PromptAnswerNotDeliveredError('input-lock-lost', params.sessionName);
        }
        throw error;
      }
    },
  );
  if (!outcome.answered) throw new PromptAnswerNotDeliveredError(outcome.reason, params.sessionName);
  if (outcome.value !== undefined) throw new PromptAnswerNotDeliveredError(outcome.value, params.sessionName);
}

/**
 * The caller's `stillCurrent` said no after one of the send's waits
 * (Issue #3706): the keys not yet sent were not sent. Keys already typed cannot
 * be taken back, so {@link keysSent} says whether the pane was touched; either
 * way the answer was NOT completed and must not be recorded as one.
 */
export class PromptAnswerAbortedError extends Error {
  constructor(
    /** Whether any key reached the pane before the stop. */
    readonly keysSent: boolean,
  ) {
    super(`Prompt answer stopped by its caller (${keysSent ? 'some keys were sent' : 'no key was sent'})`);
    this.name = 'PromptAnswerAbortedError';
  }
}

/**
 * Whether a key of this answer is already on the pane (Issue #3839). Set by
 * every send that came back, and by one that failed after a key it is known to
 * have delivered; read when the answer throws.
 */
interface PaneTouch {
  touched: boolean;
}

/**
 * What a failed answer did to the pane, as far as the transport could see
 * (Issue #3880): the tmux module's `KeyDeliveryState` for the whole answer.
 * `delivered` here is a failure after some of its keys were seen to reach tmux.
 */
export type AnswerDelivery = KeyDeliveryState;

/**
 * What the tmux call that failed did (Issue #3880), when the error came from
 * the transport (`TmuxSendError`, by name: test doubles of `./tmux/tmux` need
 * not export the class); null for any other error.
 */
function transportDeliveryOf(error: unknown): Exclude<KeyDeliveryState, 'delivered'> | null {
  if (!(error instanceof Error) || error.name !== 'TmuxSendError') return null;
  const delivery = (error as { delivery?: unknown }).delivery;
  return delivery === 'not-started' || delivery === 'indeterminate' ? delivery : null;
}

/**
 * A failure after a key reached the pane says so (Issue #3839): `keysSent: true`
 * is put on it, as on {@link PromptAnswerAbortedError}, so Auto-Yes does not
 * type the answer again over what is already there. An error that already
 * names `keysSent` (the refusals and the stop above) keeps its own word, and a
 * failure before any key is left as it was.
 *
 * Issue #3880: a transport failure also gets `answerDelivery` ({@link AnswerDelivery};
 * the tmux error's own `delivery` is that one call's).
 * `indeterminate` — the tmux call ended without an exit status, and its key may
 * be on the pane — is NOT `keysSent: true` (no key is known to be there; the
 * ledger counts it `failed`, #3820) but Auto-Yes holds it all the same. A
 * transport refusal before any key is `keysSent: false`: known not sent, free
 * to be sent again.
 */
function withKeysSent(error: unknown, touch: PaneTouch): unknown {
  if (!(error instanceof Error)) return error;
  const transport = transportDeliveryOf(error);
  if (transport !== null) {
    const answerDelivery: AnswerDelivery =
      transport === 'indeterminate' ? 'indeterminate' : touch.touched ? 'delivered' : 'not-started';
    Object.assign(error, { answerDelivery });
  }
  if ('keysSent' in error) return error;
  if (touch.touched) {
    Object.assign(error, { keysSent: true });
  } else if (transport === 'not-started') {
    Object.assign(error, { keysSent: false });
  }
  return error;
}

/** Stop here when the caller's `stillCurrent` says no (Issue #3706). */
function assertStillCurrent(stillCurrent: (() => boolean) | undefined, keysSent: boolean): void {
  if (stillCurrent && !stillCurrent()) throw new PromptAnswerAbortedError(keysSent);
}

/**
 * `sendSpecialKeys`, asking `stillCurrent` between the keys when the caller
 * gave one (Issue #3706). Without it the call is exactly the old two-argument
 * one. Issue #3952 (review P2, fourth contract): every answer typed as the
 * session's input writer gives one — its ticket's check, joined with Auto-Yes's
 * generation when there is one — so a manual answer's keys stop too when the
 * session is replaced between them.
 */
async function sendSpecialKeysWhileCurrent(
  sessionName: string,
  keys: string[],
  stillCurrent: (() => boolean) | undefined,
  touch?: PaneTouch,
): Promise<void> {
  if (!stillCurrent) {
    try {
      await sendSpecialKeys(sessionName, keys);
    } catch (error: unknown) {
      // Issue #3880: without `shouldContinue` the count comes from the error.
      if (touch && keysDeliveredOf(error) > 0) touch.touched = true;
      throw error;
    }
    if (touch && keys.length > 0) touch.touched = true;
    return;
  }
  // Issue #3839: `shouldContinue` is asked after each key but the last, so the
  // times it was asked are the keys known to have reached the pane when a
  // later one fails.
  let delivered = 0;
  try {
    await sendSpecialKeys(sessionName, keys, {
      shouldContinue: () => {
        delivered++;
        return stillCurrent();
      },
    });
  } catch (error: unknown) {
    // By name rather than `instanceof`: test doubles of `./tmux/tmux` need not
    // export the class.
    if (error instanceof Error && error.name === 'SpecialKeysAbortedError') {
      throw new PromptAnswerAbortedError(true);
    }
    if (touch && Math.max(delivered, keysDeliveredOf(error)) > 0) touch.touched = true;
    throw error;
  }
  if (touch && keys.length > 0) touch.touched = true;
}

/**
 * The keys a failed `sendSpecialKeys` says tmux took before the one that
 * failed (Issue #3880, `TmuxSendError.keysDelivered`); 0 when it says none.
 */
function keysDeliveredOf(error: unknown): number {
  if (!(error instanceof Error) || error.name !== 'TmuxSendError') return 0;
  const count = (error as { keysDelivered?: unknown }).keysDelivered;
  return typeof count === 'number' && Number.isFinite(count) && count > 0 ? count : 0;
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
  /**
   * Asked after every wait inside the send — the guard's pane read, the delay
   * between two keys, the settle before the Enter, a re-read — and `false`
   * stops before the next key with {@link PromptAnswerAbortedError}
   * (Issue #3706). Auto-Yes passes its tick's generation check, so a grant
   * withdrawn mid-send does not finish the answer. Omit it (manual answers) and
   * nothing about the send changes.
   */
  stillCurrent?: () => boolean;
  /**
   * {@link instanceInputReadMark} taken before the screen the answer was decided
   * on was read (Issue #3952). An answer that sends an Enter types as the
   * session's input writer; when a send was admitted or let go after this mark,
   * the prompt is read again before the first key. Omitted, it is taken when
   * this function is called.
   */
  readMark?: number;
  /**
   * The caller's last look before a key (Issue #3952 review P1-2), asked again
   * under the session's input lock once the answer had to wait for another
   * writer and read the screen again, right before its first key. `false`
   * types nothing ({@link PromptAnswerNotDeliveredError}, skip
   * `answer-withheld`). Auto-Yes passes its contract and grant check
   * (`withheldAtSend`), which it otherwise made before the wait. Omitted,
   * nothing more is asked.
   */
  stillAllowedAtSend?: () => boolean;
}

/**
 * Send an answer to a tmux session, using cursor-key navigation for
 * Claude Code / Antigravity multiple-choice prompts and text input for
 * everything else.
 *
 * This function unifies the logic previously duplicated in:
 * - src/app/api/worktrees/[id]/prompt-response/route.ts (L114-187)
 * - src/lib/auto-yes-manager.ts (L340-399)
 *
 * A failure after a key of the answer reached the pane carries `keysSent: true`
 * (Issue #3839), and a transport failure its `answerDelivery` (Issue #3880);
 * see {@link withKeysSent}.
 *
 * Issue #3952: every answer that sends an Enter — the cursor arms, the text arm
 * with its Enter, the checkbox arm — types as the session's input writer
 * (`instance-input-lock`), from its first key to its last, so a message send
 * cannot type between the answer's text and its Enter, and an answer waits for
 * a send in progress and is read again after it. An `answer_only` digit sends
 * no Enter and is typed as before.
 *
 * @throws {PromptAnswerNotDeliveredError} when the answer waited for another
 *   writer and was then not typed
 */
export async function sendPromptAnswer(params: SendPromptAnswerParams): Promise<void> {
  const touch: PaneTouch = { touched: false };
  try {
    await sendPromptAnswerKeys(params, touch);
  } catch (error: unknown) {
    throw withKeysSent(error, touch);
  }
}

/** {@link sendPromptAnswer}, noting in `touch` each key that reached the pane. */
async function sendPromptAnswerKeys(params: SendPromptAnswerParams, touch: PaneTouch): Promise<void> {
  const { sessionName, answer, cliToolId, promptData, fallbackPromptType, fallbackDefaultOptionNumber, stillCurrent } =
    params;
  const readMark = params.readMark ?? instanceInputReadMark();

  // Issue #2755: Command Code's checkbox question, before every guard below.
  // Its answer is a SET (`"1,3"`), which none of them can read — `/^\d+$/` is
  // how all three ask "is this a number?", so a set would be judged as free
  // text and refused as text aimed at a menu row. The arm is entered only on a
  // reading that says `multiSelect: true`, so nothing else's path moves, and it
  // returns rather than falling through: what this screen needs is toggles and
  // a two-stage confirm, not a digit and an Enter.
  const multiSelect = readMultiSelectRequest(params);
  if (multiSelect !== null) {
    await sendAsInputWriter(params, readMark, async (reread, keys) => {
      // Review P1-1: the toggles come from the ticks on the screen they go
      // to — read again after a wait — not from the reading the request saw.
      const shown = reread === null ? multiSelect.promptData : reread;
      if (shown.type !== 'multiple_choice' || shown.multiSelect !== true) return 'target-changed';
      await sendCommandCodeMultiSelectAnswer(
        sessionName,
        shown,
        multiSelect.wanted,
        keys.stillCurrent,
        touch,
        keys.assertOwned,
      );
    });
    invalidateCache(sessionName);
    return;
  }

  // Issue #2033: before ANY key is chosen, let the tool's own dialog rules
  // refuse a digit its dialog cannot take. Placed above the branch rather than
  // inside the text arm because the number->offset arithmetic the cursor arm
  // does is just as meaningless on an unnumbered button strip as typing the
  // digit is.
  const dialog = await assertAnswerModeAcceptsNumber(params);

  // Issue #2573 / #2583: the same promise for text. The text arm below types
  // whatever it is given and presses Enter, so text aimed at a screen that has
  // no text field on it — a menu row that reads as one, or a permission dialog
  // whose rows are all choices — has to stop here, before the branch, or the
  // Enter confirms the highlighted default.
  assertFreeTextHasATextField(params);

  // Issue #2584: and the half #2573 left open. A prompt that HAS a real text
  // field still swallows the characters while the cursor is on another row, and
  // the Enter after them confirms that row — so the cursor has to be checked
  // here too, before the branch.
  assertFreeTextCursorIsOnTheField(params);

  // Issue #3706: the guard above may have read the pane; nothing is typed yet.
  assertStillCurrent(stillCurrent, false);

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

    /**
     * The keys for the answer on a screen read as `shown`. Issue #3952 review
     * P1-1: called again with the prompt as read under the input lock after a
     * wait, so the offset is from where the cursor IS — a cursor that moved
     * while the answer waited would otherwise turn "2" into a bare Enter on 1.
     */
    const cursorKeys = (shown: PromptData | undefined): string[] => {
      let defaultNum: number;
      let mcOptions: Array<{ number: number; label: string; isDefault?: boolean }> | null = null;

      if (shown?.type === 'multiple_choice') {
        // Primary path: use fresh promptData
        mcOptions = shown.options;
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
      const isMultiSelect = mcOptions !== null && hasCheckboxOptions(mcOptions);

      if (isMultiSelect && mcOptions !== null) {
        // Multi-select: toggle checkbox, then navigate to "Next" and submit
        const checkboxCount = mcOptions.filter(o => hasCheckboxOptions([o])).length;
        const keys: string[] = [
          ...buildNavigationKeys(offset),  // 1. Navigate to target option
          'Space',                          // 2. Toggle checkbox
        ];
        // 3. Navigate to "Next" button (positioned right after all checkbox options)
        const downToNext = checkboxCount - targetNum + 1;
        keys.push(...buildNavigationKeys(downToNext));
        // 4. Enter to submit
        keys.push('Enter');
        return keys;
      }

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
      const isAskUserQuestionPicker = shown?.type === 'multiple_choice'
        && shown.isAskUserQuestion === true;
      return (isAskUserQuestionPicker && offset === 0)
        ? ['Down', 'Up', 'Enter']
        : [...navigationKeys, 'Enter'];
    };

    await sendAsInputWriter(params, readMark, async (reread, writer) => {
      // A re-read that is not a choice list says nothing about the cursor:
      // the keys cannot be placed, so none are typed.
      if (reread !== null && reread.type !== 'multiple_choice') return 'target-changed';
      const keys = cursorKeys(reread ?? promptData);
      writer.assertOwned(false);
      await sendSpecialKeysWhileCurrent(sessionName, keys, writer.stillCurrent, touch);
    });
  } else {
    // Issue #616: Resolve submitMode and determine whether to suppress Enter
    const resolvedSubmitMode = resolveSubmitMode(params, dialog);
    const typeText = async (): Promise<void> => {
      // Standard CLI prompt: send text + Enter (y/n, Approve?, etc.)
      await sendKeys(sessionName, answer, false);
      // Issue #3839: the text is on the pane; a failed Enter after it says so.
      if (answer !== '') touch.touched = true;
    };

    if (shouldSuppressEnter(params, resolvedSubmitMode, dialog)) {
      // Issue #3952: one digit and no Enter — nothing a send could split, so
      // not a writer of the session's input. Review P1-b: the caller's last
      // look is still taken right before it (the guard above may have awaited
      // a capture since the caller's own look).
      if (!stillAllowedNow(params)) throw new PromptAnswerNotDeliveredError('answer-withheld', sessionName);
      await typeText();
    } else {
      // Issue #3952: text, wait and Enter as one writer, so no send's body can
      // be typed in the wait and submitted by this Enter.
      await sendAsInputWriter(params, readMark, async (reread, writer) => {
        // Review P1-a: free text read again after a wait is judged on that
        // reading — a field still there, and the cursor still on it (#2573 /
        // #2584) — or the Enter after it confirms whatever row the cursor
        // moved to. A refusal here types nothing, as the one before the wait.
        if (reread !== null) {
          const onScreen: SendPromptAnswerParams = { ...params, promptData: reread };
          assertFreeTextHasATextField(onScreen);
          assertFreeTextCursorIsOnTheField(onScreen);
        }
        writer.assertOwned(false);
        await typeText();
        // Wait a moment for the input to be processed
        await new Promise(resolve => setTimeout(resolve, TUI_TEXT_INPUT_WAIT_MS));
        // Issue #3706: the text is typed; the Enter that submits it is not.
        assertStillCurrent(stillCurrent, true);
        // Review P2: nor by a session that replaced this one in the wait.
        writer.assertOwned(answer !== '');

        // Send Enter
        await sendKeys(sessionName, '', true);
      });
    }
  }

  // Issue #405: Invalidate cache after sending prompt answer
  invalidateCache(sessionName);
}
