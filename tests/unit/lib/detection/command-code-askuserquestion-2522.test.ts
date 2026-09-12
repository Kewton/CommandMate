/**
 * Command Code's footer-less question screen, READ (Issue #2522).
 *
 * ## Where this picks up from
 *
 * Issue #2521 taught the chain to RECOGNISE `AskUserQuestion`: a 200-column
 * rule, a tab strip (`● Dispatch | ◯ Review`), a question and a strict `1.`…`N.`
 * run with one `❯` on it, and no hint-bar footer anywhere. What it published was
 * a manual-operation fallback — `waiting` / `command_code_selection_list` /
 * `hasActivePrompt: false` — which stops `wait` exiting 0 on a pane that is
 * asking a human a question, and offers nothing to answer it with.
 *
 * This Issue produces the payload. `tools/command-code/dialog.ts` reads the same
 * region into a `multiple_choice` prompt, and the frames #2521 fixtured are now
 * published as `PROMPT_DETECTED`. **That verdict change is the deliverable, not
 * a regression**: the assertions #2521 wrote for those two frames are updated in
 * its own suite to the final state, and the fallback they pinned is re-pinned
 * there on the frames that still take it.
 *
 * ## What is asserted here
 *
 * The three states 確定仕様 B distinguishes, each on a frame:
 *
 *  - `none` — not this screen. Every existing verdict stands;
 *  - `prompt` — read in full. Question, labels, default, free-text row;
 *  - `unsupported` — this screen, unreadable. #2521's fallback, and explicitly
 *    NOT the generic parser's partial list.
 *
 * and the controls that make those non-vacuous: what the generic parser does to
 * the same bytes with the reader removed, and what each one-condition mutation
 * of a positive frame answers.
 *
 * Fixtures: `tests/fixtures/command-code-askuserquestion-2522/` (synthetic, see
 * its README) over `tests/fixtures/command-code-askuserquestion-2521/` (derived
 * from the live capture).
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  COMMAND_CODE_QUESTION_MAX_REGION_ROWS,
  detectCommandCodeQuestionPrompt,
  readCommandCodeQuestionDialog,
} from '@/lib/detection/tools/command-code/dialog';
import {
  hasCommandCodeQuestionChrome,
  readCommandCodeQuestionRegion,
} from '@/lib/detection/selection-shape';
import { detectPrompt } from '@/lib/detection/prompt-detector';
import { STATUS_REASON, detectSessionStatus } from '@/lib/detection/status-detector';
import { stripBoxDrawing, stripAnsi } from '@/lib/detection/cli-patterns';
import type { PromptData } from '@/types/models';

const DIR_2522 = path.resolve(__dirname, '../../../fixtures/command-code-askuserquestion-2522');
const DIR_2521 = path.resolve(__dirname, '../../../fixtures/command-code-askuserquestion-2521');
const LIVE_DIR = path.resolve(__dirname, '../../../fixtures/command-code-live-2250');
const CARD_DIR = path.resolve(__dirname, '../../../fixtures/chat-dialog-card-2254');

const read = (dir: string, name: string): string => fs.readFileSync(path.join(dir, name), 'utf-8');
const f2522 = (name: string): string => read(DIR_2522, name);

/** The reported screen, derived from the live 1.53.0 capture by Issue #2521. */
const REPORTED = read(DIR_2521, 'askuserquestion-wrapped-1530-200x1000.txt');
/** The Issue's minimal example: the same rows, no ANSI, a 24-row pane. */
const MINIMAL = read(DIR_2521, 'askuserquestion-wrapped-minimal.txt');

/** The `promptData` a frame reads to, or a failure that names what it read to. */
function promptDataOf(frame: string): Extract<PromptData, { type: 'multiple_choice' }> {
  const reading = readCommandCodeQuestionDialog(frame);
  if (reading.kind !== 'prompt') {
    throw new Error(`expected a prompt, read ${reading.kind}`);
  }
  const data = reading.prompt.promptData;
  if (data === undefined || data.type !== 'multiple_choice') {
    throw new Error('expected multiple_choice promptData');
  }
  return data;
}

// ===========================================================================
// A. The reported frame, read
// ===========================================================================

describe('[#2522] A. the reported frame reads as a four-option question', () => {
  it.each([
    ['200x1000', REPORTED],
    ['minimal', MINIMAL],
  ])('%s: question, options and default are the Issue’s', (_name, frame) => {
    const data = promptDataOf(frame);

    expect(data.type).toBe('multiple_choice');
    expect(data.status).toBe('pending');
    expect(data.question).toBe(
      'Approve proceeding from the plan into worktree creation and dispatch?',
    );
    expect(data.options).toHaveLength(4);
    expect(data.options.filter((option) => option.isDefault).map((option) => option.number)).toEqual([1]);
  });

  it.each([
    ['200x1000', REPORTED],
    ['minimal', MINIMAL],
  ])('%s: no tab strip, no rule and no TODOS row reach the question', (_name, frame) => {
    const data = promptDataOf(frame);

    expect(data.question).not.toContain('Dispatch |');
    expect(data.question).not.toContain('─');
    expect(data.question).not.toContain('TODOS');
    // The row above the rule on the 200x1000 capture, which a five-row lookback
    // would have reached.
    expect(data.question).not.toContain('Presenting dispatch decision');
  });

  it('option 1 keeps the wrapped tail the generic parser stops at', () => {
    // The acceptance criterion, on the live bytes: ` answer).` is the row whose
    // single leading space ends `isContinuationLine`'s scan, and it belongs to
    // option 1's description — not to option 2, and not to the question.
    const data = promptDataOf(REPORTED);

    expect(data.options[0].label).toMatch(/^Prepare worktrees \+ dispatch \(Recommended\) /);
    expect(data.options[0].label).toMatch(/ for you to answer\)\.$/);
    expect(data.options[1].label).toBe(
      'Worktrees only, then pause I create the 3 worktrees, run the baseline gates in each, and ' +
        'stop so you can inspect before any worker turns are spent.',
    );
    expect(data.options[2].label).toBe(
      'Stop at the plan No worktrees, no workers. Deliver the dry-run plan artifacts and the ' +
        'body/profile fixes only.',
    );
  });

  it('marks the free-text row and nothing else', () => {
    const data = promptDataOf(REPORTED);

    expect(data.options.map((option) => option.requiresTextInput)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(data.options[3].label).toBe('Type something...');
  });

  it('answers with the digit alone, and says so in the payload', () => {
    // 確定仕様 D. `answer_only` is what `sendPromptAnswer` reads to suppress the
    // Enter it would otherwise pair with the digit — which on this screen would
    // land on whatever the tool painted next.
    expect(promptDataOf(REPORTED).submitMode).toBe('answer_only');
    expect(promptDataOf(REPORTED).isAskUserQuestion).toBe(true);
  });

  it('bounds the deny surface and the stored body at the rule', () => {
    // Issue #1699's machine-facing surface. A deny pattern must see THIS
    // question's own descriptions; it must not see the shell commands and tool
    // output the transcript above the rule is full of.
    const reading = readCommandCodeQuestionDialog(REPORTED);
    if (reading.kind !== 'prompt') throw new Error('expected a prompt');
    const data = promptDataOf(REPORTED);

    expect(data.approvalTarget).toContain('--worker-method cmate-worker-development');
    expect(data.approvalTarget).not.toContain('Presenting dispatch decision');
    expect(data.approvalTarget).not.toContain('───');
    expect(reading.prompt.rawContent).not.toContain('Presenting dispatch decision');
    // Bounded well inside the #235 caps, which the whole-pane spelling was not.
    expect(reading.prompt.rawContent!.split('\n').length).toBeLessThan(30);
    expect(reading.prompt.cleanContent).toBe(data.question);
  });

  it('reads the same payload through ANSI, through CRLF and through padding', () => {
    expect(promptDataOf(f2522('question-flat-short-ansi-crlf.txt'))).toEqual(
      promptDataOf(f2522('question-flat-short.txt')),
    );
  });
});

// ===========================================================================
// B. The shapes 確定仕様 A enumerates
// ===========================================================================

describe('[#2522] B. the reading covers the shapes the screen is drawn in', () => {
  it('reads a screen with no wrapping at all, question chrome included', () => {
    // The case a "call the generic parser first, fall back to the reader" wiring
    // would get wrong rather than miss: the generic parser SUCCEEDS here, and
    // its question reaches five rows up into the tab strip and the transcript.
    const frame = f2522('question-flat-short.txt');
    const data = promptDataOf(frame);

    expect(data.question).toBe(
      'Approve proceeding from the plan into worktree creation and dispatch?',
    );
    expect(data.options).toHaveLength(4);

    const generic = detectPrompt(stripBoxDrawing(stripAnsi(frame)));
    expect(generic.isPrompt).toBe(true);
    expect(generic.promptData?.question).toContain('Dispatch |');
    expect(generic.promptData?.question).not.toBe(data.question);
  });

  it('folds a description under the LAST option into it', () => {
    const data = promptDataOf(f2522('question-description-on-last-option.txt'));

    expect(data.options.map((option) => option.label)).toEqual([
      'develop',
      'main',
      'Type something... Give me a branch name and I will check it out before dispatching.',
    ]);
    expect(data.options[2].requiresTextInput).toBe(true);
  });

  it('folds descriptions at indent 0, 1 and 2 into the option above them', () => {
    const data = promptDataOf(f2522('question-description-indent-0-1-2.txt'));

    expect(data.options.map((option) => option.label)).toEqual([
      'Lint and unit only fastest, skips the build',
      'Lint, unit and build the set CI runs on pull requests.',
      'Everything, integration included the slowest set and the only complete one.',
    ]);
  });

  it('reads a Japanese question with a full-width question mark', () => {
    const data = promptDataOf(f2522('question-japanese-fullwidth.txt'));

    expect(data.question).toBe('プランの内容で worktree を作成して dispatch してもよいですか？');
    expect(data.options).toHaveLength(4);
    expect(data.options[0].label).toBe(
      'worktree を作って dispatch する（推奨） worktree を作成し、最初のワーカープロンプトで 停止します。',
    );
    // The free-text row is the tool's own English string even here, and the
    // description under it folds in without taking the flag away.
    expect(data.options[3].requiresTextInput).toBe(true);
  });

  it('reads a wrapped question with no question mark anywhere', () => {
    // `?` is usable evidence and deliberately not required: a question fixed to
    // "the last row ending in ?" would lose this screen entirely, and on the
    // reported one would lose the question's first two rows.
    const data = promptDataOf(f2522('question-wrapped-no-question-mark.txt'));

    expect(data.question).toBe(
      'Choose how much of the dispatch plan I should carry out now, bearing in mind that the ' +
        'worktrees are cheap to create and expensive to clean up, and that the workers will start ' +
        'spending turns the moment they are dispatched',
    );
    expect(data.question).not.toContain('?');
    expect(data.options).toHaveLength(3);
  });

  it('reads a dialog taller than both detection windows', () => {
    // `lastLines` is 15 rows and `SELECTION_SHAPE_TAIL_LINE_COUNT` is 40. This
    // dialog is 39 rows of options under a tab strip, on a 900-row-padded pane.
    const frame = f2522('question-taller-than-detection-windows.txt');
    const data = promptDataOf(frame);

    expect(data.options).toHaveLength(4);
    expect(data.options[0].label).toContain('description row 30 of option 1');
    expect(data.options[0].label).toMatch(/and this row is where the wrap lands\.$/);
    expect(detectSessionStatus(frame, 'command-code').reason).toBe(STATUS_REASON.PROMPT_DETECTED);
  });

  it('puts the default on the free-text row when that is where the cursor is', () => {
    const data = promptDataOf(f2522('question-default-on-free-text.txt'));

    expect(data.options.map((option) => option.isDefault)).toEqual([false, false, true]);
    expect(data.options[2].requiresTextInput).toBe(true);
  });
});

// ===========================================================================
// C. `unsupported`: this screen, unreadable
// ===========================================================================

describe('[#2522] C. a question screen it cannot read falls back, it does not guess', () => {
  it.each([
    ['a gap in the numbering', 'unsupported-missing-number.txt', 'numbering-unreadable'],
    ['a repeated option row', 'unsupported-duplicate-number.txt', 'numbering-unreadable'],
    ['a region past the reader cap', 'unsupported-region-too-tall.txt', 'region-too-tall'],
    [
      'a trailing description longer than the tail allowance',
      'unsupported-last-option-tail-too-long.txt',
      'option-block-unreadable',
    ],
    ['a multi-select checkbox list', 'unsupported-multi-select-checkboxes.txt', 'multi-select'],
  ])('%s is unsupported (%s)', (_label, name, reason) => {
    const reading = readCommandCodeQuestionDialog(f2522(name));

    expect(reading.kind).toBe('unsupported');
    expect(reading.kind === 'unsupported' ? reading.reason : null).toBe(reason);
  });

  it.each([
    ['unsupported-missing-number.txt'],
    ['unsupported-duplicate-number.txt'],
    ['unsupported-region-too-tall.txt'],
    ['unsupported-last-option-tail-too-long.txt'],
    ['unsupported-multi-select-checkboxes.txt'],
  ])('%s: publishes #2521’s fallback and no payload at all', (name) => {
    const result = detectSessionStatus(f2522(name), 'command-code');

    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.COMMAND_CODE_SELECTION_LIST);
    expect(result.evidence).toBe('positive');
    expect(result.hasActivePrompt).toBe(false);
    expect(result.promptDetection.promptData).toBeUndefined();
    expect(detectCommandCodeQuestionPrompt(f2522(name))).toBeNull();
  });

  it('never hands an unsupported frame to the generic parser’s partial list', () => {
    // The half of 確定仕様 B that a `null`-returning reader could not express.
    // On the multi-select frame the generic parser DOES find four options, and
    // answering `2` against them would tick a checkbox and stop — leaving the
    // question up and the operator told it was answered.
    const frame = f2522('unsupported-multi-select-checkboxes.txt');
    expect(detectPrompt(stripBoxDrawing(stripAnsi(frame))).isPrompt).toBe(true);

    const result = detectSessionStatus(frame, 'command-code');
    expect(result.hasActivePrompt).toBe(false);
    expect(result.promptDetection.isPrompt).toBe(false);
  });

  it('states the cap rather than truncating to it', () => {
    // The reader refuses a region taller than its cap instead of reporting the
    // options it managed to see — 確定仕様 A forbids the partial success.
    const tall = f2522('unsupported-region-too-tall.txt');
    const region = readCommandCodeQuestionRegion(tall)!;

    expect(region).not.toBeNull();
    expect(region.optionCount).toBe(3);
    expect(region.lastLineIndex - region.firstLineIndex + 1).toBeGreaterThan(
      COMMAND_CODE_QUESTION_MAX_REGION_ROWS,
    );
  });
});

// ===========================================================================
// D. `none`: everything that is not this screen
// ===========================================================================

describe('[#2522] D. the reading declines everything it was not measured on', () => {
  it.each([
    ['an ordinary numbered answer under the same rule', 'not-applicable-numbered-answer.txt'],
    ['the Review tab, which draws a diff', 'not-applicable-review-tab.txt'],
    ['a question already answered, with a composer under it', 'not-applicable-answered-then-composer.txt'],
  ])('%s reads as none', (_label, name) => {
    const frame = f2522(name);

    expect(readCommandCodeQuestionDialog(frame).kind).toBe('none');
    expect(hasCommandCodeQuestionChrome(frame)).toBe(false);
  });

  it('leaves every committed Command Code frame that is not this screen alone', () => {
    const others = [
      [LIVE_DIR, 'dialog-create-file.txt'],
      [LIVE_DIR, 'dialog-kill-task-1490.txt'],
      [LIVE_DIR, 'dialog-shell-1490.txt'],
      [LIVE_DIR, 'dialog-shell-command.txt'],
      [LIVE_DIR, 'boot-idle-1490.txt'],
      [LIVE_DIR, 'turn-done-1490.txt'],
      [LIVE_DIR, 'turn-thinking-1490.txt'],
      [LIVE_DIR, 'idle-after-interrupt-1490.txt'],
      [CARD_DIR, 'command-code-model-1-40-1.txt'],
      [CARD_DIR, 'command-code-model-1-47-1-open.txt'],
      [CARD_DIR, 'command-code-model-1-47-1-closed.txt'],
    ] as const;

    for (const [dir, name] of others) {
      const frame = read(dir, name);
      expect(readCommandCodeQuestionDialog(frame).kind, name).toBe('none');
      expect(hasCommandCodeQuestionChrome(frame), name).toBe(false);
    }
  });

  it('answers none for another CLI’s detector handed the same bytes', () => {
    // The branch belongs to the command-code module. A claude session that
    // somehow painted this frame keeps whatever claude's rules said about it.
    expect(detectSessionStatus(REPORTED, 'claude').reason).not.toBe(STATUS_REASON.PROMPT_DETECTED);
    expect(detectSessionStatus(REPORTED, 'claude').hasActivePrompt).toBe(false);
  });

  it('answers none for the spelling with the box drawing removed', () => {
    // The contract 確定仕様 C is written against, asserted rather than assumed:
    // this is why every consumer keeps the tick's RAW capture. `stripBoxDrawing`
    // blanks the rule row the region is anchored on.
    expect(readCommandCodeQuestionDialog(stripBoxDrawing(stripAnsi(REPORTED))).kind).toBe('none');
    expect(readCommandCodeQuestionDialog(REPORTED).kind).toBe('prompt');
  });

  it('answers none for empty and absent input', () => {
    expect(readCommandCodeQuestionDialog('').kind).toBe('none');
    expect(readCommandCodeQuestionDialog(null).kind).toBe('none');
    expect(readCommandCodeQuestionDialog(undefined).kind).toBe('none');
  });
});

// ===========================================================================
// E. The positive control
// ===========================================================================

describe('[#2522] E. without this reader the same bytes are a false completion', () => {
  it.each([
    ['200x1000', REPORTED],
    ['minimal', MINIMAL],
  ])('%s: the generic parser still cannot read it', (_name, frame) => {
    // The mechanism, pinned on the bytes. The generic parser is UNCHANGED by
    // this Issue (対象外 forbids relaxing `isContinuationLine`), so it still
    // stops at the one-space continuation row and finds no prompt at all.
    expect(detectPrompt(stripBoxDrawing(stripAnsi(frame))).isPrompt).toBe(false);
  });

  it('the status verdict is the reader’s, not the composer check’s', () => {
    const result = detectSessionStatus(REPORTED, 'command-code');

    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.PROMPT_DETECTED);
    expect(result.hasActivePrompt).toBe(true);
    expect(result.evidence).toBe('positive');
    expect(result.promptDetection.promptData?.type).toBe('multiple_choice');
  });

  it('leaves every other Command Code verdict where #2250 / #2304 / #2369 left it', () => {
    const verdict = (dir: string, name: string): string => {
      const r = detectSessionStatus(read(dir, name), 'command-code');
      return `${r.status}/${r.reason}/${r.evidence}`;
    };

    expect(verdict(LIVE_DIR, 'boot-idle-1490.txt')).toBe(`ready/${STATUS_REASON.INPUT_PROMPT}/positive`);
    expect(verdict(LIVE_DIR, 'turn-done-1490.txt')).toBe(`ready/${STATUS_REASON.INPUT_PROMPT}/positive`);
    expect(verdict(LIVE_DIR, 'turn-thinking-1490.txt')).toBe(
      `running/${STATUS_REASON.THINKING_INDICATOR}/positive`,
    );
    for (const name of [
      'dialog-create-file.txt',
      'dialog-kill-task-1490.txt',
      'dialog-shell-1490.txt',
      'dialog-shell-command.txt',
    ]) {
      expect(verdict(LIVE_DIR, name), name).toBe(`waiting/${STATUS_REASON.PROMPT_DETECTED}/positive`);
    }
    for (const name of [
      'command-code-model-1-40-1.txt',
      'command-code-model-1-47-1-open.txt',
    ]) {
      expect(verdict(CARD_DIR, name), name).toBe(
        `waiting/${STATUS_REASON.COMMAND_CODE_SELECTION_LIST}/positive`,
      );
    }
  });
});
