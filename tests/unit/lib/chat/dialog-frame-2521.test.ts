/**
 * The dialog card's rows for a screen that draws no footer (Issue #2521).
 *
 * Issue #2326 cut a Command Code picker out of the pane it is painted on by
 * reading the seam between the rule above it and the hint-bar footer below it.
 * `AskUserQuestion` draws the rule and no footer at all, so that reading
 * declined it and `extractDialogFrameTail` fell back to "every compacted row" —
 * which on the capture this Issue was raised from is 409 rows of transcript
 * followed by the question, i.e. exactly the defect #2326 was raised about,
 * reached by the other door.
 *
 * What is asserted below is the cut, from both sides: the rows that must be in
 * the card (the tab strip, the question, all four options, the wrapped
 * continuation) and the rows that must not (the rule itself, the banner, the
 * earlier turns, the 577 rows of padding). The last block is the positive
 * control — the pre-#2521 output on the same bytes — so the assertions cannot
 * pass on a fixture that was already short.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { extractDialogFrameTail, hasDialogFrame } from '@/lib/chat/dialog-frame';
import { extractCommandCodeSelectionListFrame } from '@/lib/detection/selection-shape';
import { stripAnsi } from '@/lib/detection/ansi';
import { compactBlankRuns, isPaintedPanelRow } from '@/lib/terminal-display-normalize';

const FIXTURES = path.resolve(__dirname, '../../../fixtures/command-code-askuserquestion-2521');
const read = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf-8');

const LIVE_200X1000 = read('askuserquestion-wrapped-1530-200x1000.txt');
const MINIMAL = read('askuserquestion-wrapped-minimal.txt');

/** Rows that are the SESSION and never the dialog. */
const TRANSCRIPT_ROWS = [
  '# Command Code v1.53.0',
  'Draft a dispatch plan for the sample backlog.',
  'Summarise wave 1 in one line.',
  'Presenting dispatch decision',
] as const;

/** Rows that are the DIALOG and must all reach the card. */
const DIALOG_ROWS = [
  '● Dispatch | ◯ Review',
  'Approve proceeding from the plan into worktree creation and dispatch?',
  '1. Prepare worktrees + dispatch (Recommended)',
  ' answer).',
  '2. Worktrees only, then pause',
  '3. Stop at the plan',
  '4. Type something...',
] as const;

const card = (frame: string): string =>
  stripAnsi(extractDialogFrameTail(frame, { selectionList: true }));

describe('[#2521] the question screen is cropped to its own rows', () => {
  it('keeps every row of the dialog', () => {
    const rows = card(LIVE_200X1000);
    for (const row of DIALOG_ROWS) expect(rows, row).toContain(row);
  });

  it('keeps the wrapped continuation row attached to its option', () => {
    // ` answer).` is the row the shared prompt parser stopped at, and it is part
    // of option 1's description: a crop that dropped it would show the reader a
    // sentence that ends mid-clause.
    const lines = card(LIVE_200X1000).split('\n');
    const option1 = lines.findIndex((line) => line.includes('1. Prepare worktrees'));
    const continuation = lines.findIndex((line) => line === ' answer).');
    expect(option1).toBeGreaterThanOrEqual(0);
    expect(continuation).toBe(option1 + 2);
  });

  it('drops the transcript, the rule row and the padding', () => {
    const rows = card(LIVE_200X1000);
    for (const row of TRANSCRIPT_ROWS) expect(rows, row).not.toContain(row);
    expect(rows).not.toContain('─'.repeat(40));
    // Thirteen region rows, less the blank the rule left behind — `compactBlankRuns`
    // drops leading and trailing blank runs outright.
    expect(rows.split('\n')).toHaveLength(12);
    expect(rows.endsWith('Type something...')).toBe(true);
  });

  it('does the same for the minimal frame, where the pane is 24 rows', () => {
    const rows = card(MINIMAL);
    for (const row of DIALOG_ROWS) expect(rows, row).toContain(row);
    expect(rows).not.toContain('# Command Code v1.53.0');
    expect(rows).not.toContain('Here is the plan');
  });

  it('ignores `maxLines` for this card, exactly as #2309 left every selection list', () => {
    // The rows are reachable by arrow and the card scrolls; a 12-row tail would
    // throw the tab strip and the question away and leave the options alone.
    expect(card(LIVE_200X1000)).toBe(
      stripAnsi(extractDialogFrameTail(LIVE_200X1000, { selectionList: true, maxLines: 12 })),
    );
  });

  it('still answers the non-selection-list path with a plain tail', () => {
    // `hasDialogFrame` and a pager / unclassified card never set
    // `selectionList`, and the crop must not leak into them: those callers keep
    // the 16-row tail of the whole compacted pane.
    expect(hasDialogFrame(LIVE_200X1000)).toBe(true);
    const plain = stripAnsi(extractDialogFrameTail(LIVE_200X1000)).split('\n');
    expect(plain).toHaveLength(16);
  });

  it('preserves the ANSI the highlight is drawn with', () => {
    // The selected option is the only row carrying its own SGR run, so a
    // stripped card could not say which option the arrows are on.
    const cropped = extractDialogFrameTail(LIVE_200X1000, { selectionList: true });
    const cursorRow = cropped.split('\n').find((line) => line.includes('1. Prepare worktrees'));
    expect(cursorRow).toBeDefined();
    expect(cursorRow).toContain('\x1b[38;2;228;204;255m');
  });
});

describe('[#2521] without the crop the card is the whole pane', () => {
  it('the pre-crop output on the same bytes is the conversation', () => {
    // The positive control, stated the way `dialog-frame-2326.test.ts` states
    // its own: this is what `extractDialogFrameTail({ selectionList: true })`
    // returned for these bytes before the region reading existed, because "no
    // footer" meant "no crop" and #2309's rule is "a selection list keeps every
    // compacted row".
    const wholePane = stripAnsi(
      compactBlankRuns(LIVE_200X1000, { isStructuralRow: isPaintedPanelRow }),
    );

    for (const row of TRANSCRIPT_ROWS) expect(wholePane, row).toContain(row);
    expect(wholePane.split('\n').length).toBeGreaterThan(200);

    // And the crop, on the same bytes, for the comparison the number makes.
    expect(extractCommandCodeSelectionListFrame(LIVE_200X1000)).not.toBeNull();
    expect(card(LIVE_200X1000).split('\n')).toHaveLength(12);
  });
});
