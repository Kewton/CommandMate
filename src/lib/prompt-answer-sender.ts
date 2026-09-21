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
import { isTypedTextFieldOption } from '@/lib/detection/prompt-detect-multiple-choice';
import { readCommandCodeQuestionDialog } from '@/lib/detection/tools/command-code/dialog';
import { readCommandCodeReviewPage } from '@/lib/detection/selection-shape';
import type { MultipleChoicePromptData, PromptData, PromptType, SubmitMode } from '@/types/models';
import { isValidSubmitMode } from '@/types/models';
import { invalidateCache } from './tmux/tmux-capture-cache';
import {
  TUI_MESSAGE_PROCESSED_WAIT_MS,
  TUI_TEXT_INPUT_WAIT_MS,
} from '@/config/cli-tool-timing-config';

/** Regex pattern to detect checkbox-style multi-select options */
const CHECKBOX_OPTION_PATTERN = /^\[[ x]\] /;

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

  const dialog = detector.detectDialog(normalizeFrame(frame));
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
    await sendSpecialKeys(sessionName, toggles.map(String));
  }
  const keysSent = toggles.length > 0;

  // 2. Read the screen back and refuse unless it is the same question with
  //    exactly the requested boxes ticked.
  const afterToggle = await recaptureAfterKeys(sessionName);
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
  await sendSpecialKeys(sessionName, [
    ...downKeys(verified.options.length - cursorNow.number + 1),
    'Enter',
  ]);

  // 4. The second stage. `Submit` opens the Review page and the answer is sent
  //    from there; `Next` advances to the following question, which IS the
  //    commit for this one (its tab turns `✔`).
  const afterConfirm = await recaptureAfterKeys(sessionName);
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
    await sendSpecialKeys(sessionName, ['Enter']);
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

  // Issue #2755: Command Code's checkbox question, before every guard below.
  // Its answer is a SET (`"1,3"`), which none of them can read — `/^\d+$/` is
  // how all three ask "is this a number?", so a set would be judged as free
  // text and refused as text aimed at a menu row. The arm is entered only on a
  // reading that says `multiSelect: true`, so nothing else's path moves, and it
  // returns rather than falling through: what this screen needs is toggles and
  // a two-stage confirm, not a digit and an Enter.
  const multiSelect = readMultiSelectRequest(params);
  if (multiSelect !== null) {
    await sendCommandCodeMultiSelectAnswer(sessionName, multiSelect.promptData, multiSelect.wanted);
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
    const resolvedSubmitMode = resolveSubmitMode(params, dialog);

    if (!shouldSuppressEnter(params, resolvedSubmitMode, dialog)) {
      // Wait a moment for the input to be processed
      await new Promise(resolve => setTimeout(resolve, TUI_TEXT_INPUT_WAIT_MS));

      // Send Enter
      await sendKeys(sessionName, '', true);
    }
  }

  // Issue #405: Invalidate cache after sending prompt answer
  invalidateCache(sessionName);
}
