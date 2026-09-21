/**
 * Command Code's footer-less `AskUserQuestion`, read as an answerable prompt
 * (Issue #2522).
 *
 * ## What Issue #2521 left here
 *
 * #2521 taught the status chain to RECOGNISE this screen. It draws a 200-column
 * rule, a tab strip (`● Dispatch | ◯ Review`), a question and a strict `1.`…`N.`
 * run with one `❯` on it — and no hint-bar footer at all — and when an option's
 * description wraps, the continuation row begins with a SINGLE space:
 *
 *     ────────────────────────────… (200 columns of U+2500)
 *     ● Dispatch | ◯ Review
 *
 *     Approve proceeding from the plan into worktree creation and dispatch?
 *
 *     ❯ 1. Prepare worktrees + dispatch (Recommended)
 *          I create the worktrees and pause for you to
 *      answer).
 *       2. Worktrees only, then pause
 *     …
 *
 * `isContinuationLine` in the shared multiple-choice parser refuses ` answer).`
 * (one leading space, five characters or more, no path shape), so the generic
 * reverse scan stops there one row short of option 1, collects `[2,3,4]`, and
 * rejects the block for not starting at `1`. #2521's answer was a manual-operation
 * fallback: `waiting` / `COMMAND_CODE_SELECTION_LIST` / `hasActivePrompt: false`,
 * which stops `wait` exiting 0 and raises a card a human drives with the arrows.
 *
 * This module is the other half. It reads the SAME region #2521 recognises
 * ({@link readCommandCodeQuestionRegion}) and produces the `multiple_choice`
 * payload that `respond`, the chat surface's answer buttons, the prompt-history
 * rows, the push notification and Auto-Yes all consume — so a frame this reads
 * is published as `PROMPT_DETECTED` and the fallback no longer applies to it.
 *
 * ## Three states, one reading
 *
 * {@link readCommandCodeQuestionDialog} answers a discriminated union rather
 * than `PromptDetectionResult | null`, because "this is not that screen" and
 * "this IS that screen and I cannot read it" need opposite handling and a `null`
 * cannot tell them apart (Issue #2522 確定仕様 B):
 *
 * | `kind`        | what it means                              | what the caller does |
 * |---------------|--------------------------------------------|----------------------|
 * | `none`        | not Command Code's question screen          | every existing tool-specific / generic path, unchanged |
 * | `prompt`      | read in full                                | use this prompt; do not let the generic parser overwrite it |
 * | `unsupported` | the question UI is plainly up, and a gap / a duplicate / an over-tall region / an unreadable option run stopped the reading | #2521's manual-operation fallback. No `promptData`, no auto-answer, and NOT the generic parser's partial list |
 *
 * ## Why it is not "call the generic parser, fall back to this"
 *
 * Because the generic parser SUCCEEDS on the short spelling of this screen —
 * one-line descriptions, nothing wrapped — and succeeds badly: `extractQuestionText`
 * walks up to {@link QUESTION_CONTEXT_LINES} rows above the options and would
 * take the tab strip, the rule and the transcript's TODOS row into the question.
 * So this reader runs FIRST wherever it runs at all, and the question it produces
 * is bounded by the tab row rather than by a row count.
 *
 * ## Input contract
 *
 * A frame with its BOX DRAWING INTACT — `capture-pane -p -e` output, or that
 * with ANSI removed. The region is anchored on a pure-U+2500 rule row, and
 * `stripBoxDrawing` blanks exactly that row, so a `captureAndCleanOutput`
 * spelling reaches `none` here however plainly the dialog is on screen. That is
 * the trap #2522 確定仕様 C is written against: the three consumers that clean
 * their frames (`detectPromptWithOptions`, the Auto-Yes poller, `/prompt-response`)
 * each keep the RAW capture from the same tick and hand it here, and hand the
 * cleaned string to everything else. ANSI is stripped internally, per row, off
 * the same split the region indices address, so either spelling reads alike.
 *
 * Pure and side-effect free: no status, no poller, no database, no UI.
 */

import { stripAnsi } from '../../ansi';
import {
  buildMultipleChoiceResult,
  joinApprovalTarget,
} from '../../prompt-detect-multiple-choice';
import {
  hasCommandCodeQuestionChrome,
  readCommandCodeQuestionRegion,
  readCommandCodeReviewPage,
  type CommandCodeQuestionRegion,
} from '../../selection-shape';
import { findNumberedOptionBlock } from '../dialog-block';
import type { PromptDetectionResult } from '../../types';

/**
 * How many rows of dialog this reader will parse.
 *
 * 確定仕様 A forbids truncating to the 15-row detection window or the 40-row
 * selection-shape tail — a wrapped description is exactly what pushes the
 * question out of those — and equally forbids reporting a PARTIAL list as a
 * success when a cap is hit. So the cap is stated here, generously, and hitting
 * it is `unsupported` rather than "the options I managed to see".
 *
 * Sixty rows is the tallest this screen can plausibly be (a tab strip, a blank,
 * a question wrapped over half a dozen rows, and nine options with four rows of
 * description each) and equals {@link findNumberedOptionBlock}'s own
 * `MAX_BLOCK_ROWS`, so the two cannot disagree about which one declined: the
 * region is measured first and the block walk can no longer reach its limit.
 */
export const COMMAND_CODE_QUESTION_MAX_REGION_ROWS = 60;

/**
 * How many non-blank rows under the LAST option may be its own description.
 *
 * The region ends at the last row carrying content, so the rows
 * {@link findNumberedOptionBlock} files as `footer` are not chrome — this screen
 * draws none — they are the wrapped tail of the bottom option, and 確定仕様 A
 * says a description under the last option folds into it exactly as one under
 * any other option does. Same trade agy's reader makes for the same reason.
 */
const LAST_OPTION_TAIL_ROWS = 12;

/** The cursor glyph, restated from the region reader's own private constant. */
const COMMAND_CODE_CURSOR_GLYPH = '❯';

/**
 * The cursor row's own option number, for the cross-check below.
 *
 * The region reading already proved there is exactly one `❯` in the region and
 * that it sits on an option row; this recovers WHICH option it is, so the
 * default can be pinned against {@link findNumberedOptionBlock}'s own answer
 * instead of trusting a glyph union (`[❯›●>]`) that is wider than this screen's.
 */
const CURSOR_OPTION_NUMBER_PATTERN = /❯[^\S\n]*(\d{1,2})[.)]/;

/**
 * The one option on this screen that is NOT answerable by its number
 * (Issue #2522 確定仕様 A / D).
 *
 * Command Code draws `4. Type something...` as the last row of the list, and it
 * is not a fourth choice: the measured `QuestionPrompt` gives the ordinary
 * choices to a `SelectInput` and renders this one as a separate `TextInput`. It
 * is kept as a displayed option — a human has to see that the screen offers free
 * text — and marked `requiresTextInput`, which is what stops `resolveBaseAnswer`
 * auto-selecting it and what makes the answer UIs open a text field instead of
 * sending a bare `4`.
 *
 * Added to the shared builder's result rather than to `TEXT_INPUT_PATTERNS`,
 * because that list is the GENERIC one every CLI is read through and 対象外
 * forbids widening it: `/enter\s+/`-class patterns there already over-match, and
 * one more entry would change what every other tool's options mean.
 *
 * Anchored at the start of the label so the fold-in of a description below the
 * row (`Type something... Write your own answer.`) still matches.
 */
const COMMAND_CODE_FREE_TEXT_OPTION_PATTERN = /^[^\S\n]*type\s+something\b/i;

/**
 * A checkbox option — the row shape of a MULTI-select question.
 *
 * Issue #2522 used this to DECLINE the screen: on a checkbox list the digit
 * toggles a box and the confirm is a separate `Submit` / `Next` row, so a
 * payload claiming "option 2 is the answer" had `respond 2` tick a box and stop,
 * leaving the question up and the operator told it was answered.
 *
 * Issue #2755 turns it into a READING instead. The prefix is stripped off the
 * label, the ticked rows are reported as {@link MultipleChoiceOption.checked},
 * and the payload says `multiSelect: true` so that every consumer that turns a
 * number into keys branches on it. The decline survives for the one screen that
 * still cannot be answered — a checkbox list with no confirm row, where nothing
 * measured says how the question is committed.
 *
 * Three tick glyphs, all measured: `[x]` on the 1.54.1 capture #2753 was raised
 * from, `[✔]` (U+2714) across #2754's twenty-six, and `[X]` because the two
 * differ only in case and a build that switches is not worth a second Issue.
 */
const CHECKBOX_OPTION_PATTERN = /^\[[ xX\u2714]\]\s/;

/** The tick half of {@link CHECKBOX_OPTION_PATTERN}: a box that is ON. */
const CHECKBOX_TICKED_PATTERN = /^\[[xX\u2714]\]\s/;

/**
 * The confirm row of a multi-select question (Issue #2755).
 *
 * `Submit` on the last question of a call, `Next` on every other one, measured
 * on 1.54.1. It carries NO number — the strict `1.`…`N.` run ends one row above
 * it — and it is the row `findNumberedOptionBlock` files as `footer` and this
 * module used to fold into the bottom option's label:
 *
 *     options[4].label = "[ ] Type something... Submit Enter to select | …"
 *
 * The cursor glyph is optional and is the reason this is not
 * `/^\s*Submit\s*$/`: 1.54.1 draws `❯ Submit` the moment the cursor parks
 * there (#2754 実測 1), and a pattern that missed that spelling would fold the
 * row back into the label on exactly the frames #2755 exists for.
 */
const COMMAND_CODE_CONFIRM_ROW_PATTERN =
  /^[^\S\n]*(?:\u276F[^\S\n]*)?(?:Submit|Next)[^\S\n]*$/;

/**
 * 1.54.1's hint bar, which is not part of any option either (Issue #2755).
 *
 *     Enter to select | Arrow keys to navigate | 1-9 quick select | n notes | c chat | Esc to cancel
 *
 * Drawn only when the call carries more than one question (#2754 実測 3), which
 * is why it is NOT used as evidence that this screen is up — the most dangerous
 * spelling, one question with the cursor on `Submit`, draws no footer at all.
 * It is read here for the one thing it is good for: keeping it out of the last
 * option's label, where the tail walk would otherwise put it along with its
 * `requiresTextInput` flag.
 *
 * Distinct from {@link COMMAND_CODE_SELECTION_LIST_FOOTER}, which is the `·`
 * separated picker footer and is left exactly as #2753 left it.
 */
const COMMAND_CODE_QUESTION_HINT_BAR_PATTERN =
  /^[^\S\n]*Enter\s+to\s+select\b.*\|.*\bEsc\s+to\s+cancel[^\S\n]*$/i;

/**
 * The same tail limits `prompt-detector.ts` applies to `rawContent`
 * (`RAW_CONTENT_MAX_LINES` / `RAW_CONTENT_MAX_CHARS`), restated because that
 * helper is private to it. A prompt row stores this text as its message body.
 *
 * In practice neither bound binds here — the region is at most
 * {@link COMMAND_CODE_QUESTION_MAX_REGION_ROWS} rows — which is the point: what
 * used to reach these consumers for this screen was the whole 1000-row pane.
 */
const RAW_CONTENT_MAX_LINES = 200;
const RAW_CONTENT_MAX_CHARS = 5000;

function truncateRawContent(content: string): string {
  const lines = content.split('\n');
  const tail = lines.length > RAW_CONTENT_MAX_LINES ? lines.slice(-RAW_CONTENT_MAX_LINES) : lines;
  const joined = tail.join('\n');
  return joined.length > RAW_CONTENT_MAX_CHARS ? joined.slice(-RAW_CONTENT_MAX_CHARS) : joined;
}

/** What {@link readCommandCodeQuestionDialog} concluded about a frame. */
export type CommandCodeQuestionReading =
  /** Not Command Code's question screen. Every existing path applies unchanged. */
  | { readonly kind: 'none' }
  /**
   * The question screen is up and this reader could not read it.
   *
   * `reason` is diagnostic only — no caller branches on it — and exists so a
   * test and a log line can say WHICH condition declined instead of asserting
   * an opaque `unsupported`.
   */
  | { readonly kind: 'unsupported'; readonly reason: CommandCodeQuestionUnsupportedReason }
  /** The question, its options and its default, read in full. */
  | { readonly kind: 'prompt'; readonly prompt: PromptDetectionResult; readonly region: CommandCodeQuestionRegion };

/** Why a recognised question screen could not be read. */
export type CommandCodeQuestionUnsupportedReason =
  /**
   * The chrome is a question screen's and the option run is not a strict
   * `1.`…`N.` with one cursor: a gap, a repeat, a list starting at `2`, or a
   * second cursor from a half-finished repaint.
   */
  | 'numbering-unreadable'
  /** The region is taller than {@link COMMAND_CODE_QUESTION_MAX_REGION_ROWS}. */
  | 'region-too-tall'
  /** The option run could not be walked down to `1.` inside the region. */
  | 'option-block-unreadable'
  /** The block and the region disagree about how many options are drawn. */
  | 'option-count-mismatch'
  /** The `❯` could not be tied to one option of the block. */
  | 'default-unresolved'
  /**
   * The options are checkboxes and the screen draws no confirm row.
   *
   * Issue #2755 turned the rest of the multi-select family into a reading; this
   * is what is left of the decline. Without a `Submit` / `Next` row nothing
   * measured says how the question is committed, so ticking boxes would leave
   * the human exactly where #2522 found them — told the prompt was answered
   * while it is still on screen.
   */
  | 'multi-select'
  /**
   * The question screen is up and the `❯` has left the option list
   * (Issue #2755 §2 / §8).
   *
   * `Submit`, `Next` and the `notes:` row `n` opens, generalised: the condition
   * is the cursor's POSITION, not the label it happens to be resting on. Six
   * live captures of an unanswered question were published as `ready` /
   * `input_prompt` before this reason existed, because the region reading
   * declined them and the composer check then answered off the dialog's own `❯`
   * row — #2521's 偽完了, and `commandmate wait` exited 0 on every one.
   *
   * Declined rather than answered because a digit sent while the cursor is off
   * the list is measured to do NOTHING at all (#2754 §4.1): the quick-select
   * hotkeys are dead, so a payload built from this frame would promise an answer
   * no keystroke could deliver.
   */
  | 'cursor-outside-options'
  /**
   * The `AskUserQuestion` Review page (Issue #2755 §7).
   *
   * `❯ 1. Submit` / `2. Cancel` over `← to go back and edit`. It is a real
   * numbered list under a real tab strip, so the generic parser answered it —
   * with the default on `Submit`, which does not pick anything but COMMITS
   * whatever the human has ticked. Declined here so no payload reaches Auto-Yes
   * or the answer panels; the same verdict covers the page reached with answers
   * still missing (`⚠ You have not answered all questions`), which must never
   * read as answered either.
   */
  | 'review-page'
  /** Nothing but blanks between the tab strip and option 1. */
  | 'question-missing';

function unsupported(reason: CommandCodeQuestionUnsupportedReason): CommandCodeQuestionReading {
  return { kind: 'unsupported', reason };
}

/**
 * Read Command Code's `AskUserQuestion` off one capture (Issue #2522).
 *
 * @param frame - a capture with its box drawing intact (ANSI optional, CRLF
 *   tolerated). A `stripBoxDrawing`-ed string answers `none`; see the module
 *   docblock for why that is a contract and not a limitation to work around.
 */
export function readCommandCodeQuestionDialog(
  frame: string | null | undefined,
): CommandCodeQuestionReading {
  if (!frame) return { kind: 'none' };

  // Issue #2755 §7: the Review page, before the question reading, because the
  // two are told apart by what the rows SAY and not by their shape. Declined
  // outright — see `'review-page'` — so neither this reader nor, through
  // `beforePrompt`'s fallback verdict, the generic parser can turn `1. Submit`
  // into an answerable default.
  if (readCommandCodeReviewPage(frame) !== null) return unsupported('review-page');

  // The positive recognition is #2521's, unchanged and not re-derived: the last
  // qualifying rule row, a tab strip under it, a question, a strict `1.`…`N.`
  // run and exactly one `❯` on one of its rows, with the pickers and panels the
  // other branches own excluded. Everything below is READING what it recognised.
  const region = readCommandCodeQuestionRegion(frame);
  if (region === null) {
    // The strict reading declined. Two very different frames arrive here, and
    // 確定仕様 B needs them told apart: one is any other screen in the world,
    // the other is THIS screen with a gap in its numbering, a repeated row or a
    // second cursor. `hasCommandCodeQuestionChrome` is the same structural scan
    // with the two list-shaped conditions dropped, so it says which — and a
    // question screen nobody can parse still stops `wait` instead of being
    // handed back to the composer check that publishes `ready` off its own `❯`.
    return hasCommandCodeQuestionChrome(frame)
      ? unsupported('numbering-unreadable')
      : { kind: 'none' };
  }

  // Issue #2755 §2 / §8. The region is this screen and the `❯` is not on a
  // numbered row: `Submit`, `Next` or the `notes:` input. Nothing here can be
  // answered — the digits are dead while the cursor is off the list — but the
  // pane is a live question, so it takes #2521's manual-operation fallback and
  // NOT the `ready` the composer check would otherwise publish off `❯ Submit`.
  if (!region.cursorOnOptionRow) return unsupported('cursor-outside-options');

  const lines = frame.replace(/\r\n/g, '\n').split('\n').map(stripAnsi);
  const regionRows = lines.slice(region.firstLineIndex, region.lastLineIndex + 1);
  if (regionRows.length > COMMAND_CODE_QUESTION_MAX_REGION_ROWS) {
    return unsupported('region-too-tall');
  }

  const tabOffset = region.tabLineIndex - region.firstLineIndex;

  // The shared block reader, on the region alone. Walking UP from the bottom is
  // what folds a wrapped description into the option ABOVE it — which is the
  // rule 確定仕様 A states for indent 0, 1 and 2 alike, and the one the generic
  // parser's `isContinuationLine` could not follow.
  const block = findNumberedOptionBlock(regionRows, regionRows.length, LAST_OPTION_TAIL_ROWS);
  if (block === null) return unsupported('option-block-unreadable');

  const labels = [...block.options];
  // Rows below the bottom option. On 1.53.0 there were none but a wrapped
  // description, which 確定仕様 A folds into that option. 1.54.1 draws two rows
  // that are NOT anybody's description — the `Submit` / `Next` confirm and the
  // hint bar — and folding them produced the label #2754 recorded:
  //
  //     "[ ] Type something... Submit Enter to select | Arrow keys to navigate | …"
  //
  // Issue #2755 takes them out here rather than in `findNumberedOptionBlock`:
  // that reader is shared by every tool's `prompt.ts`, and what a row below the
  // last option MEANS is exactly the per-tool knowledge a tool module owns.
  const tailRows = block.footer === '' ? [] : block.footer.split('\n');
  const hasConfirmRow = tailRows.some((row) => COMMAND_CODE_CONFIRM_ROW_PATTERN.test(row));
  const description = tailRows.filter(
    (row) =>
      !COMMAND_CODE_CONFIRM_ROW_PATTERN.test(row) &&
      !COMMAND_CODE_QUESTION_HINT_BAR_PATTERN.test(row),
  );
  if (description.length > 0) {
    const last = labels.length - 1;
    labels[last] = [labels[last], ...description].join(' ').trim();
  }

  if (labels.length !== region.optionCount) return unsupported('option-count-mismatch');

  // Issue #2755: a checkbox list is READ rather than declined — but only when
  // the screen also draws the row that commits it. Without one, the digit
  // toggles a box and nothing on this frame says what finishes the question, so
  // #2522's decline stands.
  const multiSelect = labels.some((label) => CHECKBOX_OPTION_PATTERN.test(label));
  if (multiSelect && !hasConfirmRow) return unsupported('multi-select');

  // The default. Not `selectedGlyph` alone: `findNumberedOptionBlock`'s glyph
  // union is `[❯›●>]` because it serves every CLI, and `●` is this screen's TAB
  // marker — so the answer is cross-checked against the row the region reading
  // actually found the one `❯` on, and a disagreement declines rather than
  // guessing which option a human is about to confirm.
  const cursorRow = regionRows[region.cursorLineIndex - region.firstLineIndex] ?? '';
  const cursorMatch = CURSOR_OPTION_NUMBER_PATTERN.exec(cursorRow);
  if (
    block.selectedIndex < 0 ||
    block.selectedGlyph !== COMMAND_CODE_CURSOR_GLYPH ||
    cursorMatch === null ||
    Number(cursorMatch[1]) !== block.selectedIndex + 1
  ) {
    return unsupported('default-unresolved');
  }

  // The question: everything between the tab strip and option 1, blanks dropped,
  // wrapped rows joined with ONE space and in draw order. Bounded by the tab row
  // rather than by a row count, so neither the rule, the TODOS row above it nor
  // the tab strip itself can reach it — and not narrowed to "the last row ending
  // in `?`", so a question wrapped over three rows keeps its first two. `?` is
  // usable evidence elsewhere and is deliberately not required here.
  const questionRows = regionRows
    .slice(tabOffset + 1, block.firstRow)
    .map((row) => row.trim())
    .filter((row) => row !== '');
  if (questionRows.length === 0) return unsupported('question-missing');
  const question = questionRows.join(' ');

  // The dialog's own rows, and nothing above the rule. Both surfaces are built
  // from the same slice on purpose: `instructionText` is what the answer panels
  // show a human, `approvalTarget` is what the contract's deny patterns are
  // matched against (#1699), and for THIS screen they are the same text — the
  // region already excludes the previous turn, so there is no wider human-facing
  // window to offer and no narrower machine-facing one to carve out. What
  // matters is that the descriptions are inside both: a deny pattern has to see
  // the sentence the option is actually promising.
  const dialogText = joinApprovalTarget(regionRows, tabOffset + 1, regionRows.length);

  // Issue #2755: the checkbox comes OFF the label and becomes state. A label
  // that still read `[ ] calc.js` is what a user reported as "cannot pick more
  // than one" (#2753's capture), and it is also what every label-matching
  // consumer downstream — the deny patterns, `respond`'s semantic resolution,
  // the answer panels — would have had to learn to strip for itself.
  //
  // `checked` is written on BOTH states of a multi-select row, because the
  // sender computes a symmetric difference against it and "absent" would be
  // indistinguishable from "unticked" at the one place the distinction decides
  // whether a box is turned OFF. On a single-select row it is written on
  // neither: 受入基準 (a) pins those payloads with `toStrictEqual`, and an
  // added `checked: false` is exactly the drift that pin exists to catch.
  const readOptions: ReadonlyArray<{
    number: number;
    label: string;
    isDefault: boolean;
    checked?: boolean;
  }> = labels.map((label, index) => ({
    number: index + 1,
    label: multiSelect ? label.replace(CHECKBOX_OPTION_PATTERN, '') : label,
    isDefault: index === block.selectedIndex,
    ...(multiSelect ? { checked: CHECKBOX_TICKED_PATTERN.test(label) } : {}),
  }));

  const built = buildMultipleChoiceResult(
    question,
    readOptions,
    { instructionText: dialogText, approvalTarget: dialogText },
    regionRows.join('\n'),
    truncateRawContent,
    // 確定仕様 D. The measured `QuestionPrompt` hands the ordinary choices to a
    // `SelectInput`, which calls `onSelect` on the DIGIT — so a trailing Enter
    // would land on whatever the tool painted next (the following question, or
    // Review), confirming a second operation nobody chose. `answer_only` is also
    // the safe direction if that measurement is ever wrong for a build: a digit
    // that selects nothing leaves the dialog exactly where it was, while the
    // Enter it would otherwise be paired with cannot be taken back.
    'answer_only',
    // This IS an AskUserQuestion — a tab strip, a question and its own choices,
    // not a permission prompt. It changes no keystroke for this tool (the cursor
    // navigation arm of `sendPromptAnswer` is claude's and agy's), and it is what
    // lets `/prompt-response` tell "the picker is up but unreadable" from "the
    // prompt is gone".
    true,
  );

  const promptData = built.promptData;
  /* c8 ignore next -- buildMultipleChoiceResult always returns multiple_choice */
  if (promptData === undefined || promptData.type !== 'multiple_choice') {
    return unsupported('option-block-unreadable');
  }

  return {
    kind: 'prompt',
    region,
    prompt: {
      ...built,
      promptData: {
        ...promptData,
        // Only ever added, never set to `false`: see the `checked` note above.
        ...(multiSelect ? { multiSelect: true } : {}),
        // `buildMultipleChoiceResult` rebuilds every option from the three
        // fields it takes, so `checked` is re-applied here rather than trusted
        // to survive the shared builder (Issue #2755).
        options: promptData.options.map((option, index) => {
          const checked = readOptions[index]?.checked;
          const withState = checked === undefined ? option : { ...option, checked };
          return option.requiresTextInput === true ||
            COMMAND_CODE_FREE_TEXT_OPTION_PATTERN.test(option.label)
            ? { ...withState, requiresTextInput: true }
            : withState;
        }),
      },
    },
  };
}

/**
 * The same reading as a `PromptDetectionResult | null`, for the call sites whose
 * only question is "is there an answerable prompt here?".
 *
 * `null` for BOTH `none` and `unsupported`, which is safe exactly where the
 * caller has already decided what to do about the second — the detector's
 * `beforePrompt` publishes #2521's fallback for it, and `/prompt-response`
 * refuses it with `unsupported_dialog_layout`. A caller that cannot tell the two
 * apart must use {@link readCommandCodeQuestionDialog} instead.
 */
export function detectCommandCodeQuestionPrompt(
  frame: string | null | undefined,
): PromptDetectionResult | null {
  const reading = readCommandCodeQuestionDialog(frame);
  return reading.kind === 'prompt' ? reading.prompt : null;
}
