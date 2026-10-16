/**
 * `isCommandCodeQuestionConfirmPage` — the `❯ 1. Submit` / `2. Cancel` page of
 * Command Code's `AskUserQuestion`, read wider than the Review page reading
 * (Issue #3497).
 *
 * The Review page reading (#2755 §7) needs its `← to go back and edit` row. On a
 * frame without it, the generic parser read `Submit` / `Cancel` as an ordinary
 * two-option prompt and Auto-Yes sent `1` (Kewton/Musunest#283). The predicate
 * here is what Auto-Yes declines on; the sweep below is its negative control:
 * no question screen of the four earlier Issues reads as a confirm page.
 *
 * @vitest-environment node
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isCommandCodeQuestionConfirmPage,
  readCommandCodeReviewPage,
} from '@/lib/detection/tools/command-code/selection-shape';
import { readCommandCodeQuestionDialog } from '@/lib/detection/tools/command-code/dialog';
import { detectPromptOnCleanFrame } from '@/lib/polling/response-checker';
import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { COMMAND_CODE_FREE_TEXT_CONFIRM_FRAME } from '@tests/fixtures/command-code-askuserquestion-3497/free-text-confirm';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const DIR_3497 = path.join(FIXTURES, 'command-code-askuserquestion-3497');
const DIR_2754 = path.join(FIXTURES, 'command-code-askuserquestion-2754');

function read(dir: string, file: string): string {
  return readFileSync(path.join(dir, file), 'utf8');
}

const NO_BACK_HINT = read(DIR_3497, 'review-page-no-back-hint.txt');
const FREE_TEXT_CONFIRM = COMMAND_CODE_FREE_TEXT_CONFIRM_FRAME;

describe('[#3497] what reached Auto-Yes', () => {
  it.each([
    // The Review page reading needs its back hint; the question reader declines
    // the page (it draws `1.` twice), so the generic parser reads it.
    ['review-page-no-back-hint.txt', NO_BACK_HINT, 'none'],
    // A question whose only options are the pair is an ordinary question to the reader.
    ['free-text-confirm.ts', FREE_TEXT_CONFIRM, 'prompt'],
  ])('%s: published as a prompt whose default is Submit', (_name, raw, readerKind) => {
    expect(readCommandCodeReviewPage(raw)).toBeNull();
    expect(readCommandCodeQuestionDialog(raw).kind).toBe(readerKind);

    const clean = stripBoxDrawing(stripAnsi(raw));
    const detection = detectPromptOnCleanFrame(clean, 'command-code', clean.split('\n'), raw);
    expect(detection.isPrompt).toBe(true);
    expect(detection.promptData?.type).toBe('multiple_choice');
    if (detection.promptData?.type !== 'multiple_choice') return;
    expect(detection.promptData.options.map((o) => [o.label, o.isDefault])).toEqual([
      ['Submit', true],
      ['Cancel', false],
    ]);
  });
});

describe('[#3497] isCommandCodeQuestionConfirmPage', () => {
  it.each([
    ['3497/review-page-no-back-hint.txt', NO_BACK_HINT],
    ['3497/free-text-confirm.ts', FREE_TEXT_CONFIRM],
    ['2754/review-page-submit-cancel.txt', read(DIR_2754, 'review-page-submit-cancel.txt')],
    ['2754/review-page-unanswered-warning.txt', read(DIR_2754, 'review-page-unanswered-warning.txt')],
  ])('%s is a confirm page', (_name, raw) => {
    expect(isCommandCodeQuestionConfirmPage(raw)).toBe(true);
  });

  it('reads the page with the cursor on Cancel, and with CRLF row ends', () => {
    const onCancel = FREE_TEXT_CONFIRM.replace('❯ 1. Submit', '  1. Submit').replace(
      '  2. Cancel',
      '❯ 2. Cancel',
    );
    expect(onCancel).not.toBe(FREE_TEXT_CONFIRM);
    expect(isCommandCodeQuestionConfirmPage(onCancel)).toBe(true);
    expect(isCommandCodeQuestionConfirmPage(FREE_TEXT_CONFIRM.replace(/\n/g, '\r\n'))).toBe(true);
  });

  it('needs the tab strip directly under the last rule', () => {
    // The same rows with the strip gone: a reply that QUOTES a confirm pair.
    const noStrip = FREE_TEXT_CONFIRM.replace('● Retry design | ◯ Review', 'Retry design');
    expect(isCommandCodeQuestionConfirmPage(noStrip)).toBe(false);
  });

  it('needs both halves of the pair when the current tab is not Review', () => {
    expect(isCommandCodeQuestionConfirmPage(FREE_TEXT_CONFIRM.replace('2. Cancel', '2. Retry'))).toBe(false);
    expect(isCommandCodeQuestionConfirmPage(FREE_TEXT_CONFIRM.replace('1. Submit', '1. Ship it'))).toBe(false);
  });

  it.each([null, undefined, ''])('answers false for %s', (frame) => {
    expect(isCommandCodeQuestionConfirmPage(frame)).toBe(false);
  });
});

describe('[#3497] no question screen of #2521 / #2522 / #2753 / #2754 is a confirm page (陰性対照・全走査)', () => {
  const screens = [
    'command-code-askuserquestion-2521',
    'command-code-askuserquestion-2522',
    'command-code-askuserquestion-2753',
    'command-code-askuserquestion-2754',
  ].flatMap((dir) =>
    readdirSync(path.join(FIXTURES, dir))
      .filter((file) => file.endsWith('.txt') && !file.startsWith('review-page-'))
      .sort()
      .map((file) => [`${dir}/${file}`, read(path.join(FIXTURES, dir), file)] as const),
  );

  it('has screens to sweep', () => {
    expect(screens.length).toBeGreaterThanOrEqual(20);
  });

  it.each(screens)('%s', (_name, raw) => {
    expect(isCommandCodeQuestionConfirmPage(raw)).toBe(false);
  });
});
