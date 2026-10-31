/**
 * The refusals and failures `prompt-answer-sender` throws, with the reason
 * codes they carry (Issue #3965: moved out of `prompt-answer-sender`, which
 * re-exports every error and reason code here, so callers keep importing from it).
 *
 * Issue #3982: also how each of them is answered over HTTP
 * ({@link promptAnswerErrorResponse}), in one table both answering routes read.
 * That mapping is imported from this module directly.
 *
 * Type-only imports: this module must not import the sender back.
 */

import type { CLIToolType } from './cli-tools/types';
import type { DialogAnswerMode, DialogVerdict } from '@/lib/detection/tools/types';
import type { InstanceInputAnswerSkip } from '@/lib/session/instance-input-lock';

/**
 * The reason code a caller gets back when a digit meets a `keys`-mode dialog
 * (Issue #2033).
 *
 * Spelled as a constant because it crosses two boundaries: the API refusal body
 * `respond` reads (`/prompt-response`), and the assertions that pin it.
 */
export const ANSWER_MODE_KEYS_REASON = 'answer_mode_keys';

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

/**
 * The reason code of {@link PromptAnswerInputLostError} (Issue #3975). Carried
 * in its message too: `/prompt-response` answers it as a 500 whose body is the
 * message, and `respond` tells it from {@link ANSWER_NOT_DELIVERED_REASON} by
 * this code (some keys may be on the pane — look before answering again).
 */
export const ANSWER_INPUT_LOST_REASON = 'answer_input_lost';

/**
 * An answer whose input was taken from it part-way (Issue #3952 review P2):
 * the session was replaced after some of its keys had gone out, and the rest
 * were not sent. Unlike {@link PromptAnswerNotDeliveredError} the pane was
 * touched (`keysSent: true`), so it is a failure, not a refusal.
 */
export class PromptAnswerInputLostError extends Error {
  readonly reason = ANSWER_INPUT_LOST_REASON;
  readonly keysSent = true;

  constructor(sessionName: string) {
    super(
      `The answer to ${sessionName} was stopped part-way: the session was replaced while the answer ` +
        `held its input. Some keys were sent; the rest were not (${ANSWER_INPUT_LOST_REASON}, Issue #3952).`
    );
    this.name = 'PromptAnswerInputLostError';
  }
}

/**
 * The reason code of {@link PromptAnswerAbortedError} on the wire (Issue #3982).
 * Neither answering route passes a `stillCurrent`, so neither is expected to
 * see one; it has a code so that the mapping below has no hole.
 */
export const ANSWER_ABORTED_REASON = 'answer_aborted';

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

/** The two routes that type a person's answer at the pane (Issue #3982). */
export type PromptAnswerRoute = 'prompt-response' | 'respond';

/** What a thrown answer error says about itself on the wire (Issue #3982). */
export interface PromptAnswerErrorFacts {
  reason: string;
  /** Whether any key of the answer reached the pane before the error. */
  keysSent: boolean;
}

/** One row of {@link PROMPT_ANSWER_ERROR_RESPONSES}. */
export interface PromptAnswerErrorMapping {
  facts: (error: Error) => PromptAnswerErrorFacts;
  /**
   * The HTTP status per route. `/prompt-response` answers a refusal as 200
   * `success: false` (#2033); `/respond` answered the same errors as 500 or 409
   * before the table existed, and those stay as they were.
   */
  status: Readonly<Record<PromptAnswerRoute, number>>;
}

type ErrorClass<E extends Error> = new (...args: never[]) => E;

function row<E extends Error>(
  errorClass: ErrorClass<E>,
  facts: (error: E) => PromptAnswerErrorFacts,
  status: Record<PromptAnswerRoute, number>,
): readonly [ErrorClass<Error>, PromptAnswerErrorMapping] {
  return [errorClass, { facts: facts as (error: Error) => PromptAnswerErrorFacts, status }];
}

/**
 * Every error class this module exports, and how each route answers it
 * (Issue #3982).
 *
 * Before this table each route had its own `instanceof` chain, and an error
 * added to one was missing from the other: `/prompt-response` answered
 * {@link PromptAnswerInputLostError} as a bare 500 with neither `reason` nor
 * `keysSent`, so a caller could only find the reason by reading the message —
 * which is also where a quoted answer lands. A unit test enumerates this
 * module's exported classes and fails when one has no row here.
 *
 * `keysSent` is stated here for the refusals that never touch the pane rather
 * than put on those errors: Auto-Yes reads `keysSent` off a thrown error to
 * count its attempt, and that count is not this table's to change.
 */
export const PROMPT_ANSWER_ERROR_RESPONSES: ReadonlyMap<ErrorClass<Error>, PromptAnswerErrorMapping> = new Map([
  row(PromptAnswerRejectedError, (e) => ({ reason: e.reason, keysSent: false }), { 'prompt-response': 200, respond: 500 }),
  row(FreeTextAnswerRejectedError, (e) => ({ reason: e.reason, keysSent: false }), { 'prompt-response': 200, respond: 500 }),
  row(FreeTextAtChoiceOnlyPromptError, (e) => ({ reason: e.reason, keysSent: false }), { 'prompt-response': 200, respond: 500 }),
  row(MultiSelectAnswerRejectedError, (e) => ({ reason: e.reason, keysSent: e.keysSent }), { 'prompt-response': 200, respond: 500 }),
  row(PromptAnswerNotDeliveredError, (e) => ({ reason: e.reason, keysSent: e.keysSent }), { 'prompt-response': 200, respond: 409 }),
  // Keys reached the pane: a failure, not a refusal, on both routes (#3952 review P2).
  row(PromptAnswerInputLostError, (e) => ({ reason: e.reason, keysSent: e.keysSent }), { 'prompt-response': 500, respond: 500 }),
  row(PromptAnswerAbortedError, (e) => ({ reason: ANSWER_ABORTED_REASON, keysSent: e.keysSent }), { 'prompt-response': 500, respond: 500 }),
]);

/** The mapping row for an error, or null when it is not one of this module's. */
function mappingOf(error: unknown): PromptAnswerErrorMapping | null {
  if (!(error instanceof Error)) return null;
  for (const [errorClass, mapping] of PROMPT_ANSWER_ERROR_RESPONSES) {
    if (error instanceof errorClass) return mapping;
  }
  return null;
}

/**
 * How `route` answers an error `sendPromptAnswer` threw (Issue #3982), or null
 * for an error this module does not define (the route keeps its own 500).
 *
 * The body always carries `reason` and `keysSent`. Its other keys are the ones
 * each status already had: `success: false` + `message` for a 200 refusal (the
 * route adds `answer`), `error` for a 409, and `error` prefixed
 * `Failed to send answer to tmux:` for a 500. That 500's `error` still quotes
 * the message, so a CLI older than this table reads it as before.
 */
export function promptAnswerErrorResponse(
  error: unknown,
  route: PromptAnswerRoute,
): { status: number; body: Record<string, unknown> } | null {
  const mapping = mappingOf(error);
  if (mapping === null) return null;
  const err = error as Error;
  const { reason, keysSent } = mapping.facts(err);
  const status = mapping.status[route];
  if (status === 200) {
    return { status, body: { success: false, reason, message: err.message, keysSent } };
  }
  if (status >= 500) {
    return { status, body: { error: `Failed to send answer to tmux: ${err.message}`, reason, keysSent } };
  }
  return { status, body: { error: err.message, reason, keysSent } };
}
