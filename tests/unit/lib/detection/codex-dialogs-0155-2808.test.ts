/**
 * Issue #2808 — codex 0.155.1's dialogs, re-measured under #2798's row rule.
 *
 * ## The question
 *
 * #2798 changed `readCodexGlyphRowKind` so a coloured glyph counts as a dialog
 * option only when the label is drawn in the glyph's OWN colour (one span), and
 * a dim label is the composer's placeholder. It measured that on one 0.155.1
 * frame — the idle composer. If 0.155.1 had also redrawn a dialog's highlighted
 * row as "coloured glyph → reset → undecorated label", the new rule would read
 * that row as the composer and publish `ready` for a session blocked on a
 * keypress: #2310's defect, the other way round from #2798's.
 *
 * ## What these tests are read off
 *
 * `tests/fixtures/codex-dialogs-0155/` — the five screens of the Issue's table
 * (command approval, `/model`, `/experimental`, `/keymap`, directory trust) plus
 * three idle-side frames, captured from codex-cli 0.155.1 on a private tmux
 * socket at 200x1000 and anonymised by two same-length substitutions. The README
 * has the provenance, the edits, and the proof that the edits moved no reading.
 * The frames are RAW on purpose: the question is the SGR attributes.
 *
 * ## The answer
 *
 * Every highlighted row is one span, byte-identical in shape to the 0.146.0 –
 * 0.153.2 captures, and every one of the five screens reads `waiting`. One idle
 * frame outside the table read `running` for a reason unrelated to the row
 * rule; #2808 pinned it as a finding and held `CODEX_VERIFIED_AGAINST` back.
 * Issue #2818 fixed it (the titled status bar is now a boundary) and advanced
 * the stamp — see the last block below and `codex-thread-title-bar-2818.test.ts`.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectSessionStatus, SELECTION_LIST_REASONS } from '@/lib/detection/status-detector';
import {
  CODEX_STATUS_BAR_PATTERN,
  CODEX_THINKING_PATTERN,
  CODEX_TRAILED_STATUS_BAR_PATTERN,
  stripAnsi,
} from '@/lib/detection/cli-patterns';
import { STATUS_REASON } from '@/lib/detection/status-reason';
import { CODEX_VERIFIED_AGAINST } from '@/lib/detection/tools/verified-against';
import {
  findCodexBottomGlyphRow,
  readCodexDialogFrame,
  readCodexGlyphRowKind,
  resetCodexDialogFooterDriftForTests,
} from '@/lib/detection/tools/codex/cli-patterns';

const DIR = join(__dirname, '../../../fixtures/codex-dialogs-0155');

const read = (name: string): string => readFileSync(join(DIR, `${name}.txt`), 'utf-8');

/** The five screens of the Issue's table, in its order. */
const TABLE = [
  'dialog-approval-run-command',
  'dialog-model-picker',
  'dialog-experimental-toggles',
  'dialog-keymap-editor',
  'dialog-trust-directory',
] as const;

/** The idle-side frames captured in the same session. */
const IDLE_SIDE = ['idle-composer', 'composer-typed-slash', 'idle-after-declined-approval'] as const;

const ALL = [...TABLE, ...IDLE_SIDE];

/** `current-output`'s `isSelectionListActive`, restated from `current-output-builder.ts`. */
function isSelectionListActive(frame: string): boolean {
  const result = detectSessionStatus(frame, 'codex');
  return result.status === 'waiting' && SELECTION_LIST_REASONS.has(result.reason);
}

/** The rows `readCodexDialogFrame` is handed by `detect.ts`: stripped, trailing blanks cut. */
function contentOf(frame: string): { lines: string[]; end: number } {
  const lines = stripAnsi(frame).split('\n');
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  return { lines: lines.slice(0, end), end };
}

/** Every `›` row the row reader classified, as `row:kind`. */
function rowKinds(frame: string): string {
  return frame
    .split('\n')
    .flatMap((row, i) => {
      const kind = readCodexGlyphRowKind(row);
      return kind === null ? [] : [`${i}:${kind}`];
    })
    .join(' ');
}

/** Replace one row of a frame, leaving every other byte where it was. */
function withRow(frame: string, index: number, row: string): string {
  const rows = frame.split('\n');
  rows[index] = row;
  return rows.join('\n');
}

beforeEach(() => {
  resetCodexDialogFooterDriftForTests();
});

// ---------------------------------------------------------------------------
// The fixtures are the measurement. If this fails, nothing below means anything.
// ---------------------------------------------------------------------------

describe('[#2808] the fixtures still carry what was measured', () => {
  it.each(ALL)('%s is raw and a whole 200x1000 pane', name => {
    const frame = read(name);
    expect(frame).toContain('\x1b[');
    // `capture-pane -p -e` of the visible pane: 1000 rows plus the final newline.
    const rows = frame.split('\n');
    expect(rows).toHaveLength(1001);
    expect(rows[1000]).toBe('');
  });

  it.each(ALL.filter(name => name !== 'dialog-trust-directory'))('%s carries the 0.155.1 banner', name => {
    expect(stripAnsi(read(name))).toContain('OpenAI Codex (v0.155.1)');
  });

  it('the trust screen, which precedes the banner, is the one for the probe repo', () => {
    expect(stripAnsi(read('dialog-trust-directory'))).toContain('/T/codex0155-probe-XXXXXX/repo');
  });
});

// ---------------------------------------------------------------------------
// The highlighted rows, byte for byte — the Issue's measurement.
// ---------------------------------------------------------------------------

const SELECTED = [
  { name: 'dialog-approval-run-command', row: 26, raw: '\x1b[1m\x1b[38;5;6m› 1. Yes, proceed (y)\x1b[0m' },
  {
    name: 'dialog-model-picker',
    row: 15,
    raw: '\x1b[1m\x1b[38;5;6m› 3. gpt-5.6-terra (current)  Balanced agentic coding model for everyday work.\x1b[0m',
  },
  {
    name: 'dialog-experimental-toggles',
    row: 13,
    raw:
      '\x1b[1m\x1b[38;5;6m› [ ] Network proxy                ' +
      'Apply network proxy restrictions to sandboxed sessions that already have network access.\x1b[0m',
  },
  {
    name: 'dialog-keymap-editor',
    row: 17,
    raw: '\x1b[1m\x1b[38;5;6m› Global       - Open Agents                unbound\x1b[0m',
  },
  { name: 'dialog-trust-directory', row: 5, raw: '\x1b[38;5;6m› 1. Yes, continue\x1b[39m' },
] as const;

describe('[#2808] 0.155.1 draws every highlighted row as one span', () => {
  it.each(SELECTED)('$name: row $row is byte-identical to the capture', ({ name, row, raw }) => {
    expect(read(name).split('\n')[row]).toBe(raw);
  });

  it.each(SELECTED)('$name: no attribute changes between the glyph and the end of the label', ({ raw }) => {
    // The shape the Issue was afraid of is an SGR right after the glyph. Strip
    // the opening and closing runs; nothing may be left in between.
    const inner = raw.replace(/^(?:\x1b\[[0-9;]*m)+/, '').replace(/(?:\x1b\[[0-9;]*m)+$/, '');
    expect(inner.startsWith('›')).toBe(true);
    expect(inner).not.toContain('\x1b');
  });

  it('the rows next to the highlight carry no glyph, and their labels no colour', () => {
    const approval = read('dialog-approval-run-command').split('\n');
    expect(approval[27]).toBe(
      "  2. Yes, and don't ask again for commands that start with `touch probe.txt` (\x1b[2mp\x1b[0m)",
    );
    expect(approval[28]).toBe('  3. No, and tell Codex what to do differently (\x1b[2mesc\x1b[0m)');
    expect(read('dialog-trust-directory').split('\n')[6]).toBe('  2. No, quit');
    expect(read('dialog-model-picker').split('\n')[16]).toBe(
      '  4. gpt-5.6-luna             \x1b[2mFast and affordable agentic coding model.\x1b[0m',
    );
  });
});

// ---------------------------------------------------------------------------
// The verdicts — the table the Issue asked for.
// ---------------------------------------------------------------------------

describe('[#2808] the five screens of the table read `waiting`', () => {
  /**
   * `[name, status, reason, hasActivePrompt, every › row's kind, dialog]`, where
   * `dialog` is `readCodexDialogFrame`'s `[by, option count, last footer row]`.
   */
  const VERDICTS: ReadonlyArray<
    readonly [string, string, string, boolean, string, readonly [string, number, string]]
  > = [
    [
      'dialog-approval-run-command', 'waiting', STATUS_REASON.PROMPT_DETECTED, true, '10:transcript-echo 26:option',
      ['glyph', 3, 'Press enter to confirm or esc to cancel'],
    ],
    [
      'dialog-model-picker', 'waiting', STATUS_REASON.CODEX_SELECTION_LIST, false, '15:option',
      ['glyph', 5, 'Press enter to confirm or esc to go back'],
    ],
    [
      'dialog-experimental-toggles', 'waiting', STATUS_REASON.CODEX_SELECTION_LIST, false, '13:option',
      ['glyph', 0, 'Press space to select or enter to save'],
    ],
    [
      'dialog-keymap-editor', 'waiting', STATUS_REASON.CODEX_SELECTION_LIST, false, '17:option',
      ['glyph', 0, 'left/right group · enter edit shortcut · * custom · - unbound · esc close'],
    ],
    [
      'dialog-trust-directory', 'waiting', STATUS_REASON.PROMPT_DETECTED, true, '5:option',
      ['glyph', 2, 'Press enter to continue'],
    ],
  ];

  it.each(VERDICTS)('%s', (name, status, reason, hasActivePrompt, kinds, [by, optionCount, footerTail]) => {
    const frame = read(name);
    const result = detectSessionStatus(frame, 'codex');
    expect({
      status: result.status,
      reason: result.reason,
      hasActivePrompt: result.hasActivePrompt,
      kinds: rowKinds(frame),
    }).toEqual({ status, reason, hasActivePrompt, kinds });

    const { lines, end } = contentOf(frame);
    const dialog = readCodexDialogFrame(frame, lines, end);
    expect(dialog?.by).toBe(by);
    expect(dialog?.options).toHaveLength(optionCount);
    expect(dialog?.footer.split('\n').at(-1)).toBe(footerTail);
    expect(dialog?.footerRecognised).toBe(true);
  });

  it('the numbered dialogs publish the options a human (or Auto-Yes) would answer', () => {
    const labels = (name: string): string[] => {
      const data = detectSessionStatus(read(name), 'codex').promptDetection?.promptData;
      return data?.type === 'multiple_choice' ? data.options.map(o => o.label) : [];
    };
    expect(labels('dialog-approval-run-command')).toEqual([
      'Yes, proceed (y)',
      "Yes, and don't ask again for commands that start with `touch probe.txt` (p)",
      'No, and tell Codex what to do differently (esc)',
    ]);
    expect(labels('dialog-trust-directory')).toEqual(['Yes, continue', 'No, quit']);
  });

  it('the pickers and menus publish `isSelectionListActive: true`', () => {
    for (const name of ['dialog-model-picker', 'dialog-experimental-toggles', 'dialog-keymap-editor']) {
      expect(isSelectionListActive(read(name)), name).toBe(true);
    }
  });

  it("an ANSI-stripped capture keeps the numbered ones; the unnumbered menus hit #2310's pinned limit", () => {
    const stripped = (name: string): string => {
      const result = detectSessionStatus(stripAnsi(read(name)), 'codex');
      return `${result.status}/${result.reason}`;
    };
    expect(stripped('dialog-approval-run-command')).toBe('waiting/prompt_detected');
    expect(stripped('dialog-model-picker')).toBe('waiting/codex_selection_list');
    expect(stripped('dialog-trust-directory')).toBe('waiting/prompt_detected');
    // Unchanged from 0.153.2: without attributes and without numbers there is
    // nothing left to read (codex-structural-dialog-2310.test.ts pins the same).
    expect(stripped('dialog-experimental-toggles')).toBe('ready/input_prompt');
    expect(stripped('dialog-keymap-editor')).toBe('ready/input_prompt');
  });
});

describe('[#2808] the idle composers of the same session read `ready`', () => {
  it.each([
    ['idle-composer', '\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m'],
    ['composer-typed-slash', '\x1b[1m›\x1b[0m /model'],
  ] as const)('%s', (name, composerRow) => {
    const frame = read(name);
    expect(frame.split('\n')[10]).toBe(composerRow);
    expect(findCodexBottomGlyphRow(frame)).toEqual({ kind: 'composer', row: 10 });
    const result = detectSessionStatus(frame, 'codex');
    expect(result.status).toBe('ready');
    expect(result.reason).toBe(STATUS_REASON.INPUT_PROMPT);
    expect(isSelectionListActive(frame)).toBe(false);
    const { lines, end } = contentOf(frame);
    expect(readCodexDialogFrame(frame, lines, end)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mutation: the verdicts above depend on the one-span shape.
// ---------------------------------------------------------------------------

describe('[#2808] the shape the Issue feared would be read as the composer', () => {
  /** "Coloured glyph → reset → undecorated label": close every attribute after the glyph. */
  const resetAfterGlyph = (raw: string): string =>
    raw.replace('›', '›\x1b[0m').replace(/(?:\x1b\[[0-9;]*m)+$/, '');

  it.each(SELECTED)('$name: the row flips from `option` to `composer`', ({ raw }) => {
    expect(readCodexGlyphRowKind(raw)).toBe('option');
    expect(readCodexGlyphRowKind(resetAfterGlyph(raw))).toBe('composer');
  });

  it.each(SELECTED.filter(s => s.name === 'dialog-experimental-toggles' || s.name === 'dialog-keymap-editor'))(
    '$name: the unnumbered menu would publish `ready` — #2310 in the other direction',
    ({ name, row, raw }) => {
      const mutated = withRow(read(name), row, resetAfterGlyph(raw));
      const result = detectSessionStatus(mutated, 'codex');
      expect(result.status).toBe('ready');
      expect(result.reason).toBe(STATUS_REASON.INPUT_PROMPT);
    },
  );
});

// ---------------------------------------------------------------------------
// Outside the table: #2808's finding, fixed by Issue #2818.
// ---------------------------------------------------------------------------

describe('[#2808 → #2818] an idle frame after a declined approval reads `ready`', () => {
  /**
   * The operator pressed Esc on the approval, codex printed `■ Conversation
   * interrupted` and went back to its composer — an idle session. #2798's row
   * rule read it correctly; the status did not: #2808 pinned `running` here
   * because the bar carries the thread's title after the path, the boundary
   * was lost, and branch D's 15-row tail reached the declined command's `• Ran`
   * row. #2818 made the titled bar a boundary, so the rows between the bar and
   * the composer are windowed exactly as they are under an untitled bar.
   */
  const NAME = 'idle-after-declined-approval';
  const STATUS_BAR_ROW = 25;

  it("the row rule is right: the bottom `›` is the composer and there is no dialog", () => {
    const frame = read(NAME);
    expect(rowKinds(frame)).toBe('10:transcript-echo 23:composer');
    const { lines, end } = contentOf(frame);
    expect(readCodexDialogFrame(frame, lines, end)).toBeNull();
  });

  it('the status is `ready` / `input_prompt` (was `running` / `thinking_indicator`)', () => {
    const result = detectSessionStatus(read(NAME), 'codex');
    expect(result.status).toBe('ready');
    expect(result.reason).toBe(STATUS_REASON.INPUT_PROMPT);
    expect(result.hasActivePrompt).toBe(false);
    // Auto-Yes hands the detector a stripped capture; it must read the same.
    expect(detectSessionStatus(stripAnsi(read(NAME)), 'codex').status).toBe('ready');
  });

  it('the bar carries a thread title after the path, which only the trailed pattern accepts', () => {
    const bar = stripAnsi(read(NAME).split('\n')[STATUS_BAR_ROW]);
    expect(bar).toMatch(/ · Run touch probe\.txt$/);
    expect(CODEX_STATUS_BAR_PATTERN.test(bar)).toBe(false);
    expect(CODEX_TRAILED_STATUS_BAR_PATTERN.test(bar)).toBe(true);
    // The same session's bar before any thread had a title is the other shape.
    const untitledBar = stripAnsi(read('idle-composer').split('\n')[12]);
    expect(CODEX_STATUS_BAR_PATTERN.test(untitledBar)).toBe(true);
    expect(CODEX_TRAILED_STATUS_BAR_PATTERN.test(untitledBar)).toBe(false);
    // The declined command's record is still in the frame; it is simply no longer read.
    expect(CODEX_THINKING_PATTERN.test(stripAnsi(read(NAME).split('\n')[17]))).toBe(true);
  });

  it('reads the same with the thread title taken off the bar', () => {
    const frame = read(NAME);
    const bar = frame.split('\n')[STATUS_BAR_ROW];
    const untitled = bar.replace(/ · \x1b\[0m\x1b\[38;2;156;222;211mRun touch probe\.txt\x1b\[39m$/, '');
    expect(untitled).not.toBe(bar);
    const result = detectSessionStatus(withRow(frame, STATUS_BAR_ROW, untitled), 'codex');
    expect(result.status).toBe('ready');
    expect(result.reason).toBe(STATUS_REASON.INPUT_PROMPT);
  });

  it('lets the detector-wide stamp advance to 0.155.1', () => {
    // `CODEX_VERIFIED_AGAINST` claims the rules answer for the build it names.
    // #2808 held it at 0.148.0 while the frame above was misread.
    expect(CODEX_VERIFIED_AGAINST.version).toBe('0.155.1');
    expect(CODEX_VERIFIED_AGAINST.capturedAt).toBe('2026-09-21');
    expect(CODEX_VERIFIED_AGAINST.paneGeometry).toBe('200x1000');
  });
});
