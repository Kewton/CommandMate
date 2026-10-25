/**
 * Issue #3791 (item 2): the Claude confirmation page shapes a live session drew.
 *
 * Every frame in `tests/fixtures/claude-confirm-live-3791/` is a verbatim
 * capture of claude-cli 2.1.310 (see its README). The five page shapes were
 * all `false` before #3791 — Auto-Yes would have read past the page — and are
 * the only shapes the predicate was loosened for. The lookalikes are live too,
 * and the variations below change one row of a live page each, so the
 * loosening is pinned from both sides. The synthetic frames of #3770
 * (`claude-confirm-page-missed-shapes-3770.test.ts`) are not what Claude
 * draws and stay `false`.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAutoYesDeclinedConfirmFrame } from '@/lib/polling/auto-yes-confirm-page';

const DIR = path.resolve(__dirname, '../../../fixtures/claude-confirm-live-3791');
const live = (name: string): string => readFileSync(path.join(DIR, name), 'utf8');
/** The live frame with its SGR colours taken out, so one row can be edited as text. */
// eslint-disable-next-line no-control-regex
const plain = (name: string): string => live(name).replace(/\x1b\[[0-9;]*m/g, '');

const PAGES = [
  'confirm-200x60.txt',
  'question-wrapped-24x1000.txt',
  'tab-row-wrapped-16x1000.txt',
  'tab-row-far-above-40x1000.txt',
  'head-cut-40x30.txt',
  'head-cut-200x12.txt',
];

function replaceOnce(frame: string, from: string, to: string): string {
  if (!frame.includes(from)) throw new Error(`fixture drifted: ${from}`);
  return frame.replace(from, to);
}

/** The frame with `rows` inserted right after the row holding `after`. */
function insertAfterRow(frame: string, after: string, rows: string[]): string {
  const lines = frame.split('\n');
  const at = lines.findIndex(line => line.includes(after));
  if (at < 0) throw new Error(`fixture drifted: ${after}`);
  lines.splice(at + 1, 0, ...rows);
  return lines.join('\n');
}

describe('[#3791] Claude confirm page shapes captured live', () => {
  it('positive control: the 200-column page reads as the page', () => {
    expect(isAutoYesDeclinedConfirmFrame('claude', live('confirm-200x60.txt'))).toBe(true);
  });

  it.each([
    ['the question wrapped onto two rows (24 columns)', 'question-wrapped-24x1000.txt'],
    ['the tab bar, heading, question and option 1 wrapped (16 columns)', 'tab-row-wrapped-16x1000.txt'],
    ['the tab bar more than 200 rows above the question (long questions, 40 columns)', 'tab-row-far-above-40x1000.txt'],
    ['the head cut off by a short pane, only the answer list left (40x30)', 'head-cut-40x30.txt'],
    ['the head cut off by a short pane, the heading left (200x12)', 'head-cut-200x12.txt'],
  ])('positive: %s', (_label, name) => {
    expect(isAutoYesDeclinedConfirmFrame('claude', live(name))).toBe(true);
  });

  it.each([
    ['an AskUserQuestion that asks the sentence with `Submit answers` / `Cancel` options', 'lookalike-askuserquestion-200x60.txt'],
    ['a Bash approval whose command prints the page', 'lookalike-bash-approval-200x60.txt'],
    ["a Bash command's output quoting the page above the idle input box", 'lookalike-bash-output-quoted-200x60.txt'],
  ])('negative (live lookalike): %s', (_label, name) => {
    expect(isAutoYesDeclinedConfirmFrame('claude', live(name))).toBe(false);
  });
});

describe('[#3791] one row of a live page changed is not the page', () => {
  it.each(PAGES)('control: %s with its colours taken out still reads as the page', (name) => {
    expect(isAutoYesDeclinedConfirmFrame('claude', plain(name))).toBe(true);
  });

  it('an unknown footer under `2. Cancel` (never drawn live) is still not read', () => {
    const frame = insertAfterRow(plain('confirm-200x60.txt'), '2. Cancel', ['', 'Enter to select · Esc to cancel']);
    expect(isAutoYesDeclinedConfirmFrame('claude', frame)).toBe(false);
  });

  it('a question row that carries more than the sentence', () => {
    const frame = replaceOnce(
      plain('confirm-200x60.txt'),
      'Ready to submit your answers?',
      'Ready to submit your answers? (2 questions)',
    );
    expect(isAutoYesDeclinedConfirmFrame('claude', frame)).toBe(false);
  });

  it('a wrapped question with one more word', () => {
    const frame = replaceOnce(plain('question-wrapped-24x1000.txt'), 'answers?', 'answers now?');
    expect(isAutoYesDeclinedConfirmFrame('claude', frame)).toBe(false);
  });

  it('a wrapped option 1 whose second row is not `answers`', () => {
    const frame = replaceOnce(plain('tab-row-wrapped-16x1000.txt'), '     answers', '     everything');
    expect(isAutoYesDeclinedConfirmFrame('claude', frame)).toBe(false);
  });

  it('the far tab bar: a heading that is not `Review your answers`', () => {
    const frame = replaceOnce(plain('tab-row-far-above-40x1000.txt'), 'Review your answers', 'Review your notes');
    expect(isAutoYesDeclinedConfirmFrame('claude', frame)).toBe(false);
  });

  it('the far tab bar: a row in the answer list that is not one of its rows', () => {
    const frame = insertAfterRow(plain('tab-row-far-above-40x1000.txt'), 'Question 2:', ['Do you want to proceed?']);
    expect(isAutoYesDeclinedConfirmFrame('claude', frame)).toBe(false);
  });

  it('the far tab bar: the heading with no tab bar above it', () => {
    const frame = replaceOnce(plain('tab-row-far-above-40x1000.txt'), '✔ Submit', '✔ Done');
    expect(isAutoYesDeclinedConfirmFrame('claude', frame)).toBe(false);
  });

  it('the head cut: a reply row above the answer list', () => {
    const frame = plain('head-cut-40x30.txt').replace(/^[^\n]*\n/, '⏺ Here is what the page will look like:\n');
    expect(isAutoYesDeclinedConfirmFrame('claude', frame)).toBe(false);
  });

  it('the head cut: an idle input box under it (the page replaces the input box)', () => {
    // The input box, as the live quoted-output frame draws it: separator, `❯`, separator, mode row.
    const rows = plain('lookalike-bash-output-quoted-200x60.txt').split('\n').filter(row => row.trim() !== '');
    const inputBox = rows.slice(rows.findIndex(row => /^─+$/.test(row)));
    expect(inputBox[1]?.trim()).toBe('❯');
    const frame = `${plain('head-cut-40x30.txt').trimEnd()}\n${inputBox.join('\n')}\n`;
    expect(isAutoYesDeclinedConfirmFrame('claude', frame)).toBe(false);
  });

  it('the head cut: no cursor on either option', () => {
    const frame = replaceOnce(plain('head-cut-200x12.txt'), '❯ 1. Submit answers', '  1. Submit answers');
    expect(isAutoYesDeclinedConfirmFrame('claude', frame)).toBe(false);
  });
});
