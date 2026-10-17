/**
 * Issue #3770 (item 1): the shapes `isClaudeAskUserQuestionConfirmPage` misses.
 *
 * The frames are synthetic (`tests/fixtures/claude-confirm-missed-3770`), so the
 * predicate is NOT loosened on them: they pin today's `false`, which is the
 * safe direction (Auto-Yes answers as before), and give a live capture a place
 * to land. When one is captured, move the matching case to `true` here and
 * keep the lookalike negatives of #3748.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { isAutoYesDeclinedConfirmFrame } from '@/lib/polling/auto-yes-confirm-page';
import * as frames from '@tests/fixtures/claude-confirm-missed-3770/frames';

describe('[#3770] Claude confirm page shapes the predicate misses', () => {
  it('positive control: the shape it reads is still recognised', () => {
    expect(isAutoYesDeclinedConfirmFrame('claude', frames.CONFIRM_PAGE_CONTROL)).toBe(true);
  });

  it.each([
    ['the tab bar wrapped onto two rows', frames.CONFIRM_PAGE_TAB_ROW_WRAPPED],
    ['the tab bar more than 200 rows above the question', frames.CONFIRM_PAGE_TAB_ROW_FAR_ABOVE],
    ['an unknown footer under `2. Cancel`', frames.CONFIRM_PAGE_UNKNOWN_FOOTER],
    ['a question row that is not exactly the sentence', frames.CONFIRM_PAGE_QUESTION_REWORDED],
    ['a head scrolled off', frames.CONFIRM_PAGE_HEAD_SCROLLED_OFF],
  ])('is not read as the page today (left to Auto-Yes as before): %s', (_label, frame) => {
    expect(isAutoYesDeclinedConfirmFrame('claude', frame)).toBe(false);
  });
});
