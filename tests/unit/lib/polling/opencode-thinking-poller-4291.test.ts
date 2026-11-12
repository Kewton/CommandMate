/**
 * Issue #4291: the Auto-Yes poller's thinking check (`detectThinkingInRows`, which
 * picks THINKING_POLLING_INTERVAL_MS) reads opencode's `Thinking:` by position, as
 * the Enter fallback and the response checker do since #4231 — the footer's cwd
 * (`/tmp/Thinking:demo`) holds the word and must not slow the poll.
 *
 * Also: the measured open turn through the two position readers (the progress row
 * is drawn in the transcript, ABOVE the border, not under it).
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { detectThinking, detectThinkingInRows, stripAnsi } from '@/lib/detection/cli-patterns';
import { THINKING_CHECK_LINE_COUNT } from '@/lib/auto-yes-state';
import {
  isOpenCodeProgressBelowComposer,
  isOpenCodeThinkingBelowComposer,
  isOpenCodeThinkingInOpenTurn,
} from '@/lib/detection/tools/opencode/patterns';
import { THINKING_TAIL_LINE_COUNT } from '@/config/thinking-constants';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const read = (rel: string): string[] => stripAnsi(readFileSync(path.resolve(__dirname, rel), 'utf8')).split('\n');

/** Measured open turn: a `⠦ Thinking: Preparing an essay` row in the transcript (opencode 1.18, #1894). */
const OPEN_TURN = read('../detection/fixtures/opencode-live-1894/esc-again-after-marker.txt');
/** Measured busy window with no `Thinking:` row at all. */
const BUSY_NO_THINKING = read('../detection/fixtures/opencode-live-1894/esc-again-window.txt');
/** Finished turn whose footer cwd was rewritten to hold `Thinking:` (#4231). */
const DONE_CWD_THINKING = read(path.join(FIXTURES, 'opencode-live-4231/turn-done-cwd-thinking.txt'));
/** The same finished turn, original cwd. */
const DONE_ORIGINAL = read(path.join(FIXTURES, 'opencode-live-4134/turn-done-subsecond.txt'));

/** What the poller hands the check: the last THINKING_CHECK_LINE_COUNT rows. */
const tick = (rows: string[]): string[] => rows.slice(-THINKING_CHECK_LINE_COUNT);

describe('poller thinking check reads opencode Thinking: by position (#4291)', () => {
  it('positive: the measured open turn (progress row in the transcript) is thinking', () => {
    expect(detectThinkingInRows('opencode', tick(OPEN_TURN))).toBe(true);
  });

  it('negative: a footer cwd holding "Thinking:" is not thinking (the word rule reads true)', () => {
    expect(detectThinking('opencode', tick(DONE_CWD_THINKING).join('\n'))).toBe(true);
    expect(detectThinkingInRows('opencode', tick(DONE_CWD_THINKING))).toBe(false);
  });

  it('control: the original finished frame and a busy frame without the word are not thinking', () => {
    expect(detectThinkingInRows('opencode', tick(DONE_ORIGINAL))).toBe(false);
    expect(detectThinkingInRows('opencode', tick(BUSY_NO_THINKING))).toBe(false);
  });

  it('other tools keep the word rule over the joined rows', () => {
    const rows = ['  some output', '✻ Thinking… (3s · esc to interrupt)'];
    expect(detectThinkingInRows('claude', rows)).toBe(detectThinking('claude', rows.join('\n')));
    expect(detectThinkingInRows('claude', ['plain row'])).toBe(false);
  });
});

describe('measured open turn through the position readers (#4291)', () => {
  it('the progress row is above the border: not read under it, read in the open turn', () => {
    expect(isOpenCodeThinkingBelowComposer(tick(OPEN_TURN))).toBe(false);
    expect(isOpenCodeProgressBelowComposer(OPEN_TURN)).toBe(true); // the busy hint under the border, not the word
    expect(isOpenCodeThinkingInOpenTurn(tick(OPEN_TURN), THINKING_TAIL_LINE_COUNT)).toBe(true);
  });

  it('negative: a finished turn is read by neither, even with the word in the cwd', () => {
    for (const rows of [DONE_ORIGINAL, DONE_CWD_THINKING]) {
      expect(isOpenCodeThinkingBelowComposer(tick(rows))).toBe(false);
      expect(isOpenCodeThinkingInOpenTurn(tick(rows), THINKING_TAIL_LINE_COUNT)).toBe(false);
    }
  });
});
