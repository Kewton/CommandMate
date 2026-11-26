/**
 * Issue #4573 (1): a codex approval dialog under a STALE composer left in the
 * scrollback read as `running / thinking_indicator`, so `wait --on-prompt human`
 * saw `prompt=false` for the whole timeout.
 *
 * The frame (`tests/fixtures/codex-dialogs-4573/`) is the S10 judge's screen in
 * the shape tmux hands it over: the idle screen that was on the pane before the
 * `\e[2J` stays in the history (its composer drawn with SGR —
 * `ESC[1m›ESC[0m ESC[2mAsk Codex…` — and its status bar), and the visible part
 * below it is the approval dialog, drawn without SGR. `findCodexBottomGlyphRow`
 * only classifies rows that carry attributes, so it skipped the plain
 * `› 1. Yes, proceed (y)` and returned the history's composer; the live-region
 * veto (#2841 / #3183, `isCodexComposerAtBottom`) then said "the composer is the
 * pane's bottom, no dialog is open", and the `• Running git push …` row fell to
 * the thinking branch.
 *
 * What is pinned here:
 *   - R1 (positive): both fixtures (1000-row padding, and none) are `waiting`
 *     with an active prompt — red before the fix;
 *   - R2 (positive): the same holds while the dialog shares the screen with a
 *     codex thinking row (`• Running …` matches `CODEX_THINKING_PATTERN`);
 *   - controls that must not move: the real 0155 / 0157 approval captures stay
 *     `waiting`, 0157's quoted approval stays `ready`, #3205's tc104 (a numbered
 *     dialog TYPED INTO the composer, no status bar in between) stays the
 *     composer, and the same history with the dialog's real SGR on `› 1.` is
 *     `waiting` before and after the fix;
 *   - (review P2-1) tc104 with a status-bar-looking row typed into the
 *     composer above `› 1.` stays the composer / `ready` — red before the
 *     bar search was limited to the first row after the input box;
 *   - the status-bar patterns `cli-patterns.ts` writes out for the rule are the
 *     same as `patterns.ts`'s (they are copied, not imported, because
 *     `patterns.ts` imports `cli-patterns.ts` — an import would be a cycle).
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { detectSessionStatus } from '@/lib/detection/status-detector';
import {
  CODEX_COMPOSER_CLOSING_STATUS_BAR_PATTERNS,
  isCodexComposerAtBottom,
} from '@/lib/detection/tools/codex/cli-patterns';
import {
  CODEX_STATUS_BAR_PATTERN,
  CODEX_THINKING_PATTERN,
  CODEX_TRAILED_STATUS_BAR_PATTERN,
} from '@/lib/detection/tools/codex/patterns';
import { normalizeFrame } from '@/lib/detection/tools/frame';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');

function fixture(rel: string): string {
  return readFileSync(path.join(FIXTURES, rel), 'utf-8');
}

const PADDED = fixture('codex-dialogs-4573/stale-composer-approval-padded.txt');
const UNPADDED = fixture('codex-dialogs-4573/stale-composer-approval.txt');

const ESC = '\u001b';
const OPTION_ROW = '› 1. Yes, proceed (y)';

function verdictOf(frame: string): string {
  const r = detectSessionStatus(frame, 'codex');
  return `${r.status}/${r.reason}${r.hasActivePrompt ? '/prompt' : ''}`;
}

function composerAtBottom(frame: string): boolean {
  const f = normalizeFrame(frame);
  return isCodexComposerAtBottom(f.raw, f.contentLines, f.contentLines.length);
}

describe('#4573 fixture shape (the preconditions the tests below rely on)', () => {
  it.each([
    ['padded', PADDED],
    ['unpadded', UNPADDED],
  ])('%s: history composer with SGR, then its status bar, then a plain › 1. row', (_label, frame) => {
    const rows = frame.split('\n');
    const composer = rows.findIndex((r) => r.startsWith(`${ESC}[1m›${ESC}[0m ${ESC}[2mAsk Codex`));
    const bar = rows.findIndex((r) => CODEX_STATUS_BAR_PATTERN.test(r));
    const option = rows.indexOf(OPTION_ROW);
    expect(composer).toBeGreaterThanOrEqual(0);
    expect(bar).toBeGreaterThan(composer);
    expect(option).toBeGreaterThan(bar);
    // No other row carries SGR: the dialog is drawn plain, like the judge's frame.
    expect(rows.slice(composer + 1).some((r) => r.includes(ESC))).toBe(false);
  });

  it('the padded fixture is a 1000-row pane below a 12-row history', () => {
    expect(PADDED.split('\n')).toHaveLength(1012);
  });
});

describe('#4573 R1: an approval dialog under a stale composer is a prompt', () => {
  it.each([
    ['padded', PADDED],
    ['unpadded', UNPADDED],
  ])('%s → waiting / prompt_detected / prompt', (_label, frame) => {
    const r = detectSessionStatus(frame, 'codex');
    expect(r.status).toBe('waiting');
    expect(r.reason).toBe('prompt_detected');
    expect(r.hasActivePrompt).toBe(true);
    expect(r.promptDetection.isPrompt).toBe(true);
  });

  it.each([
    ['padded', PADDED],
    ['unpadded', UNPADDED],
  ])('%s: the stale composer is not the bottom', (_label, frame) => {
    expect(composerAtBottom(frame)).toBe(false);
  });
});

describe('#4573 R2: a thinking row on the same screen does not hide the prompt', () => {
  it('the visible screen carries a codex thinking row (• Running …)', () => {
    const visible = UNPADDED.split('\n').slice(12).join('\n');
    expect(CODEX_THINKING_PATTERN.test(visible)).toBe(true);
  });

  it('a second thinking row above the dialog: still waiting / prompt', () => {
    const frame = PADDED.replace(
      '• Running git push origin feature/x',
      '• Ran git status\n  └ On branch feature/x\n\n• Running git push origin feature/x',
    );
    expect(frame).not.toBe(PADDED);
    expect(verdictOf(frame)).toBe('waiting/prompt_detected/prompt');
  });
});

describe('#4573 controls (same verdict before and after the fix)', () => {
  it.each([
    ['codex-dialogs-0155/dialog-approval-run-command.txt', 'waiting/prompt_detected/prompt'],
    ['codex-dialogs-0157/approval.txt', 'waiting/prompt_detected/prompt'],
    ['codex-dialogs-0157/quoted-approval-idle.txt', 'ready/input_prompt'],
    ['codex-multiline-composer-3205/tc104-raw-pane.txt', 'ready/input_prompt'],
  ])('%s → %s', (rel, verdict) => {
    expect(verdictOf(fixture(rel))).toBe(verdict);
  });

  it('#3205 tc104: a numbered dialog typed INTO the composer keeps the composer at the bottom', () => {
    const tc104 = fixture('codex-multiline-composer-3205/tc104-raw-pane.txt');
    expect(tc104).toContain('  › 1. Yes, proceed (y)');
    expect(composerAtBottom(tc104)).toBe(true);
  });

  // Review P2-1: a status-bar-looking row TYPED INTO the composer's
  // continuation rows (above the typed `› 1.`) is not the bar that closes the
  // composer. Only the first non-blank row after the input box counts.
  it('#3205 tc104 with a bar-looking row typed above › 1.: the composer stays the bottom → ready', () => {
    const tc104 = fixture('codex-multiline-composer-3205/tc104-raw-pane.txt');
    const typedBar = '  gpt-5 default · ~/repo';
    const frame = tc104.replace('  › 1. Yes, proceed (y)', `${typedBar}\n  › 1. Yes, proceed (y)`);
    expect(frame).not.toBe(tc104);
    expect(CODEX_STATUS_BAR_PATTERN.test(typedBar)).toBe(true);
    expect(composerAtBottom(frame)).toBe(true);
    expect(verdictOf(frame)).toBe('ready/input_prompt');
  });

  it('0157 quoted approval: the composer stays the bottom', () => {
    expect(composerAtBottom(fixture('codex-dialogs-0157/quoted-approval-idle.txt'))).toBe(true);
  });

  it.each([
    ['bold + colour (0157 dialog SGR)', `${ESC}[1m${ESC}[38;5;6m${OPTION_ROW}${ESC}[0m`],
    ['bold + reverse (0155 dialog SGR)', `${ESC}[1;7m${OPTION_ROW}${ESC}[0m`],
  ])('same history, › 1. drawn with %s → waiting', (_label, row) => {
    const frame = PADDED.replace(OPTION_ROW, row);
    expect(frame).not.toBe(PADDED);
    expect(verdictOf(frame)).toBe('waiting/prompt_detected/prompt');
  });
});

describe('#4573 the status-bar patterns cli-patterns.ts copies', () => {
  it('match patterns.ts exactly', () => {
    expect(CODEX_COMPOSER_CLOSING_STATUS_BAR_PATTERNS.map((p) => [p.source, p.flags])).toEqual([
      [CODEX_STATUS_BAR_PATTERN.source, CODEX_STATUS_BAR_PATTERN.flags],
      [CODEX_TRAILED_STATUS_BAR_PATTERN.source, CODEX_TRAILED_STATUS_BAR_PATTERN.flags],
    ]);
  });
});

// ---------------------------------------------------------------------------
// The range table (s12/review-4573-pr1-range.md §1, 20 rows A–Q). Each row is
// a screen built from the judge's frame (`U`), real fixtures and #3205's tc104,
// and the verdict the BOTTOM of that screen calls for: a dialog below a stale
// composer → waiting / prompt; only text typed into the live composer → ready.
// N / N2 only pin "no prompt": their `running` comes from the input box being
// cut at a typed blank line (`findCodexInputBox`), outside this rule's range,
// and is the same as before #4573. Q is a known miss (see its row).
// ---------------------------------------------------------------------------

type RangeExpect = { status?: 'waiting' | 'ready' | 'running'; prompt: boolean };

const RANGE_TC104 = fixture('codex-multiline-composer-3205/tc104-raw-pane.txt');
const RANGE_U_ROWS = UNPADDED.split('\n');
const RANGE_HIST = RANGE_U_ROWS.slice(0, 12).join('\n');
const RANGE_DIALOG_TAIL = [
  '› 1. Yes, proceed (y)',
  "  2. Yes, and don't ask again for commands that start with `git push` (p)",
  '  3. No, and tell Codex what to do differently (esc)',
  '',
  '  Press enter to confirm or esc to cancel',
].join('\n');
const RANGE_PAD = '\n'.repeat(900);
const RANGE_BAR = '  gpt-5.6-sol default · ~/accrepo-feature-a';
const RANGE_SGR_COMPOSER = `${ESC}[1m›${ESC}[0m `;
const WAITING_PROMPT: RangeExpect = { status: 'waiting', prompt: true };
const READY: RangeExpect = { status: 'ready', prompt: false };

function rangeSlashPopupTyped(): string {
  const r = fixture('codex-dialogs-0155/composer-typed-slash.txt').split('\n');
  r.splice(11, 0, '  gpt-5 default · ~/repo', '  › 1. Yes, proceed (y)', '    2. No (esc)');
  return r.join('\n');
}

const RANGE_TABLE: [string, string, RangeExpect][] = [
  ['A: the judge frame itself', `${UNPADDED}${RANGE_PAD}`, WAITING_PROMPT],
  [
    'B: A without the banner',
    `${RANGE_HIST}\n\n  Would you like to run the following command?\n\n  $ git push origin feature/x\n\n${RANGE_DIALOG_TAIL}${RANGE_PAD}`,
    WAITING_PROMPT,
  ],
  [
    'C: B without the blank row after the bar',
    `${RANGE_HIST}\n  Would you like to run the following command?\n\n  $ git push origin feature/x\n\n${RANGE_DIALOG_TAIL}${RANGE_PAD}`,
    WAITING_PROMPT,
  ],
  [
    'D: banner, short dialog under • Running',
    `${RANGE_U_ROWS.slice(0, 17).join('\n')}\n\n• Running git push origin feature/x\n\n${RANGE_DIALOG_TAIL}${RANGE_PAD}`,
    WAITING_PROMPT,
  ],
  [
    'E: a blank row between the stale composer and its bar',
    UNPADDED.replace(`\n${RANGE_BAR}`, `\n\n${RANGE_BAR}`) + RANGE_PAD,
    WAITING_PROMPT,
  ],
  [
    'F: tc104 with a bar-looking row typed above › 1.',
    RANGE_TC104.replace('  › 1. Yes, proceed (y)', '  gpt-5 default · ~/repo\n  › 1. Yes, proceed (y)'),
    READY,
  ],
  [
    'G: history, then the dialog with no blank rows',
    `${RANGE_HIST}\n  Would you like to run the following command?\n${RANGE_DIALOG_TAIL}${RANGE_PAD}`,
    WAITING_PROMPT,
  ],
  [
    'H: history, a blank row, then the dialog',
    `${RANGE_HIST}\n\n  Would you like to run the following command?\n${RANGE_DIALOG_TAIL}${RANGE_PAD}`,
    WAITING_PROMPT,
  ],
  [
    'I: answered, back to a plain idle composer and a new bar',
    `${UNPADDED}\n\n› Ask Codex to do anything\n\n${RANGE_BAR}${RANGE_PAD}`,
    READY,
  ],
  ['J1: U, then the real 0157 idle', `${UNPADDED}\n${fixture('codex-dialogs-0157/idle.txt')}`, READY],
  [
    'J2: U, then the real 0157 running',
    `${UNPADDED}\n${fixture('codex-dialogs-0157/running.txt')}`,
    { status: 'running', prompt: false },
  ],
  [
    'J3: U, then the real 0157 quoted approval',
    `${UNPADDED}\n${fixture('codex-dialogs-0157/quoted-approval-idle.txt')}`,
    READY,
  ],
  ['K: tc104 as captured', RANGE_TC104, READY],
  [
    'L: a two-row stale composer, then its bar and the dialog (G)',
    `${RANGE_U_ROWS.slice(0, 10).join('\n')}\n${RANGE_SGR_COMPOSER}hello\n  world\n${RANGE_BAR}\n  Would you like to run the following command?\n${RANGE_DIALOG_TAIL}${RANGE_PAD}`,
    WAITING_PROMPT,
  ],
  [
    'L2: a two-row stale composer, then the rest of U (A)',
    `${RANGE_U_ROWS.slice(0, 10).join('\n')}\n${RANGE_SGR_COMPOSER}hello\n  world\n${RANGE_U_ROWS.slice(11).join('\n')}${RANGE_PAD}`,
    WAITING_PROMPT,
  ],
  [
    'M: tc104 with two typed bar + › 1. stages',
    RANGE_TC104.replace(
      '  › 1. Yes, proceed (y)',
      '  gpt-5 default · ~/repo\n  › 1. Yes, proceed (y)\n  gpt-5 default · ~/other\n  › 1. again (y)',
    ),
    READY,
  ],
  [
    'N: tc104 with a typed blank row around a bar-looking row (no prompt only)',
    RANGE_TC104.replace('  › 1. Yes, proceed (y)', '\n  gpt-5 default · ~/repo\n\n  › 1. Yes, proceed (y)'),
    { prompt: false },
  ],
  [
    'N2: tc104 whose last typed stage is bar-looking (no prompt only)',
    RANGE_TC104.replace('  Would you like to run the following command?', '  gpt-5 default · ~/repo\n'),
    { prompt: false },
  ],
  ['P: 0155 slash popup with a typed bar and › 1. above it', rangeSlashPopupTyped(), READY],
  [
    // Known miss: an option row ending in the bar's shape (`· ~/path`) makes
    // the bottom-most bar sit below `› 1.`, the same shape as F. codex's real
    // options all end in a key hint (`(y)` / `(p)` / `(esc)`), so this is not
    // drawn; missing it is the pre-#4573 verdict, never a false prompt.
    'Q: options ending in the bar shape (known miss: no prompt)',
    `${RANGE_HIST}\n  Would you like to run the following command?\n› 1. Yes, proceed (y)\n  2. Yes, allow writes · ~/accrepo-feature-a\n  3. No (esc)\n\n  Press enter to confirm or esc to cancel${RANGE_PAD}`,
    { prompt: false },
  ],
];

describe('#4573 range table (review-4573-pr1-range §1)', () => {
  it('has the 20 rows A–Q', () => {
    expect(RANGE_TABLE).toHaveLength(20);
  });

  it.each(RANGE_TABLE)('%s', (_label, frame, want) => {
    const r = detectSessionStatus(frame, 'codex');
    if (want.status !== undefined) expect(r.status).toBe(want.status);
    expect(r.hasActivePrompt).toBe(want.prompt);
  });
});
