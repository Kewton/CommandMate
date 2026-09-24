/**
 * A dialog the model QUOTED is not a dialog agy has open (Issue #2845).
 *
 * agy paints no `>` composer while one of its dialogs is open — the dialog takes
 * its place — so a `↑/↓ Navigate` footer with the composer drawn UNDER it is a
 * reply that quotes agy's own screen (or a dialog left in the scrollback), and
 * the pane is idle. Before the fix `locateAntigravityDialogRegion` took the last
 * footer on the frame for a live one and branch 0.9 of the status detector took
 * the words alone: `detectSessionStatus` answered `waiting` / `prompt_detected`
 * and `detectAntigravityNumberedDialogPrompt` — the reader Auto-Yes's poller
 * asks first — answered a four-option prompt, over a pane sitting at its input
 * box.
 *
 * The quoted frames are built from the live agy 1.1.27 captures in
 * `tests/fixtures/antigravity-live-2364/`: `idle-after-deny.txt` (the pane at its
 * composer) with the dialog's own rows, indented two columns as a reply would
 * carry them, inserted right above the input box. The control group is every
 * real frame in that directory and in `antigravity-live-2478/`, pinned to the
 * reading it had before the fix.
 *
 * @vitest-environment node
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_NAVIGATE_FOOTER_PATTERN,
  locateAntigravityDialogRegion,
  stripAnsi,
  stripBoxDrawing,
} from '@/lib/detection/cli-patterns';
import { detectSessionStatus, STATUS_REASON } from '@/lib/detection/status-detector';
import { detectAntigravityNumberedDialogPrompt } from '@/lib/detection/tools/antigravity/dialog';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const DIR_2364 = path.join(FIXTURES, 'antigravity-live-2364');
const DIR_2478 = path.join(FIXTURES, 'antigravity-live-2478');

const FOOTER = /↑\/↓ Navigate/;

/** The rows a fixture holds, ANSI intact; the file's closing newline is not a row. */
function rowsOf(dir: string, name: string): string[] {
  const rows = readFileSync(path.join(dir, name), 'utf8').split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  return rows;
}

const plain = (row: string): string => stripAnsi(row).trim();

/**
 * `idle-after-deny.txt` with rows of `source` quoted, two columns in, directly
 * above the input box — from the first row matching `from` through the first
 * row after it matching `to`. Trailing blank padding gives way row for row, so
 * the pane stays 1000 rows tall.
 */
function quoteAboveComposer(source: string, from: RegExp, to: RegExp, base = 'idle-after-deny.txt'): string {
  const baseRows = rowsOf(DIR_2364, base);
  const sourceRows = rowsOf(DIR_2364, source);

  const first = sourceRows.findIndex(row => from.test(plain(row)));
  const last = sourceRows.findIndex((row, i) => i >= first && to.test(plain(row)));
  if (first < 0 || last < 0) throw new Error(`${source} no longer holds the rows ${from} … ${to}`);
  const quoted = sourceRows.slice(first, last + 1).map(row => (row === '' ? row : `  ${row}`));

  let composerAt = -1;
  baseRows.forEach((row, i) => {
    if (/^>$/.test(plain(row))) composerAt = i;
  });
  const topRuleAt = composerAt - 1;
  if (composerAt < 0 || !/^─{3,}$/.test(plain(baseRows[topRuleAt]))) {
    throw new Error(`${base} no longer ends in a rule / bare \`>\` / rule input box`);
  }

  const rows = [...baseRows.slice(0, topRuleAt), ...quoted, ...baseRows.slice(topRuleAt)];
  for (let excess = quoted.length; excess > 0; excess--) {
    if (rows[rows.length - 1] !== '') throw new Error(`${base} has no blank padding left to give up`);
    rows.pop();
  }
  return `${rows.join('\n')}\n`;
}

const QUOTED_FRAMES: Record<string, string> = {
  'the Bash approval dialog (question, four options, footer)': quoteAboveComposer(
    'dialog-bash-oneline.txt',
    /^Do you want to proceed\?$/,
    FOOTER,
  ),
  'the `/model` picker footer': quoteAboveComposer('picker-switch-model.txt', FOOTER, FOOTER),
  'the whole `/model` picker': quoteAboveComposer('picker-switch-model.txt', /^Switch Model$/, FOOTER),
};

/** The two spellings the status path is handed: as captured, and with ANSI removed. */
const spellings = (raw: string): Array<[string, string]> => [
  ['ANSI intact', raw],
  ['stripAnsi', stripAnsi(raw)],
];

// ---------------------------------------------------------------------------
// The quoted frames
// ---------------------------------------------------------------------------

describe('[#2845] a dialog quoted above the composer is not an open dialog', () => {
  describe.each(Object.entries(QUOTED_FRAMES))('%s', (_label, raw) => {
    it('is built as a reply above a live input box, 1000 rows tall', () => {
      const text = stripAnsi(raw);
      const rows = text.split('\n').filter(row => row.trim() !== '');
      const footerAt = rows.findLastIndex(row => FOOTER.test(row));
      expect(footerAt).toBeGreaterThan(-1);
      // Under the quoted footer: the input box's rule, the bare `>`, its rule and the status row.
      expect(rows.slice(footerAt + 1).map(row => row.trim()).filter(row => !/^─+$/.test(row))).toEqual([
        '>',
        expect.stringMatching(/^\? for shortcuts/),
      ]);
      expect(raw.split('\n')).toHaveLength(1001);
    });

    it.each(spellings(raw))('detectSessionStatus does not read it as waiting (%s)', (_spelling, text) => {
      const result = detectSessionStatus(text, 'antigravity');

      expect(result.status).not.toBe('waiting');
      expect(result.hasActivePrompt).toBe(false);
      expect(result.promptDetection.isPrompt).toBe(false);
      // The pane is at its composer with the idle status row: ready, as `idle-after-deny.txt` itself is.
      expect(result.status).toBe('ready');
      expect(result.reason).toBe(STATUS_REASON.INPUT_PROMPT);
    });

    it('detectAntigravityNumberedDialogPrompt reads nothing (status spelling and poller spelling)', () => {
      expect(detectAntigravityNumberedDialogPrompt(stripAnsi(raw))).toBeNull();
      expect(detectAntigravityNumberedDialogPrompt(stripBoxDrawing(stripAnsi(raw)))).toBeNull();
    });

    it('locateAntigravityDialogRegion finds no dialog', () => {
      expect(locateAntigravityDialogRegion(stripAnsi(raw).split('\n'))).toBeNull();
      expect(locateAntigravityDialogRegion(stripBoxDrawing(stripAnsi(raw)).split('\n'))).toBeNull();
    });
  });

  it('keeps a generating pane generating: the quotation does not turn `esc to cancel` into ready', () => {
    const raw = QUOTED_FRAMES['the Bash approval dialog (question, four options, footer)'].replace(
      /\? for shortcuts/,
      'esc to cancel   ',
    );
    expect(stripAnsi(raw)).toContain('esc to cancel');

    for (const [, text] of spellings(raw)) {
      const result = detectSessionStatus(text, 'antigravity');
      expect(result.status).toBe('running');
      expect(result.reason).toBe(STATUS_REASON.THINKING_INDICATOR);
      expect(result.hasActivePrompt).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The control group: every real frame keeps the reading it had before the fix
// ---------------------------------------------------------------------------

interface Reading {
  status: string;
  reason: string;
  hasActivePrompt: boolean;
  promptType: string | null;
}

const READY: Reading = { status: 'ready', reason: STATUS_REASON.INPUT_PROMPT, hasActivePrompt: false, promptType: null };
const SELECTION_LIST: Reading = {
  status: 'waiting',
  reason: STATUS_REASON.ANTIGRAVITY_SELECTION_LIST,
  hasActivePrompt: false,
  promptType: null,
};
const PROMPT: Reading = {
  status: 'waiting',
  reason: STATUS_REASON.PROMPT_DETECTED,
  hasActivePrompt: true,
  promptType: 'multiple_choice',
};

/**
 * `reading`: `detectSessionStatus` on the frame, as captured and ANSI-stripped.
 * `options`: how many options `detectAntigravityNumberedDialogPrompt` reads off
 * the poller's spelling of it, or null when it reads nothing.
 */
const REAL_FRAMES: Record<string, { reading: Reading; options: number | null }> = {
  'antigravity-live-2364/boot-idle.txt': { reading: READY, options: null },
  'antigravity-live-2364/dialog-bash-oneline.txt': { reading: PROMPT, options: 4 },
  'antigravity-live-2364/dialog-bash-wrapped-highlight-4.txt': { reading: PROMPT, options: 4 },
  'antigravity-live-2364/dialog-bash-wrapped-six.txt': { reading: PROMPT, options: 6 },
  'antigravity-live-2364/dialog-bash-wrapped.txt': { reading: PROMPT, options: 4 },
  'antigravity-live-2364/dialog-create-file-highlight-2.txt': { reading: PROMPT, options: 2 },
  'antigravity-live-2364/dialog-create-file.txt': { reading: PROMPT, options: 2 },
  // `/feedback`: numbered rows under a `1-6 Select` footer — no `↑/↓ Navigate`, so the generic parser's.
  'antigravity-live-2364/dialog-feedback-category.txt': { reading: PROMPT, options: null },
  'antigravity-live-2364/idle-after-deny.txt': { reading: READY, options: null },
  'antigravity-live-2364/picker-switch-model.txt': { reading: SELECTION_LIST, options: null },
  'antigravity-live-2364/popup-slash-commands.txt': { reading: SELECTION_LIST, options: null },
  'antigravity-live-2364/survey-after-deny.reconstructed.txt': { reading: SELECTION_LIST, options: null },
  'antigravity-live-2364/trust-dialog.txt': { reading: SELECTION_LIST, options: null },
  'antigravity-live-2478/after-plain-turns.txt': { reading: READY, options: null },
  'antigravity-live-2478/after-tool-turn.txt': { reading: READY, options: null },
};

const readingOf = (text: string): Reading => {
  const result = detectSessionStatus(text, 'antigravity');
  return {
    status: result.status,
    reason: result.reason,
    hasActivePrompt: result.hasActivePrompt,
    promptType: result.promptDetection.promptData?.type ?? null,
  };
};

describe('[#2845] the real agy frames keep the reading they had before the fix', () => {
  it('pins every frame the two fixture directories hold', () => {
    const held = [
      ...readdirSync(DIR_2364).filter(f => f.endsWith('.txt')).map(f => `antigravity-live-2364/${f}`),
      ...readdirSync(DIR_2478).filter(f => f.endsWith('.txt')).map(f => `antigravity-live-2478/${f}`),
    ].sort();
    expect(held).toEqual(Object.keys(REAL_FRAMES).sort());
  });

  describe.each(Object.entries(REAL_FRAMES))('%s', (name, expected) => {
    const raw = readFileSync(path.join(FIXTURES, name), 'utf8');

    it.each(spellings(raw))('detectSessionStatus (%s)', (_spelling, text) => {
      expect(readingOf(text)).toEqual(expected.reading);
    });

    it('detectAntigravityNumberedDialogPrompt reads what it read', () => {
      const prompt = detectAntigravityNumberedDialogPrompt(stripBoxDrawing(stripAnsi(raw)));
      const options = prompt?.promptData?.type === 'multiple_choice' ? prompt.promptData.options.length : null;
      expect(options).toBe(expected.options);
    });

    it('locateAntigravityDialogRegion finds a dialog exactly where the frame has a footer', () => {
      const text = stripAnsi(raw);
      const region = locateAntigravityDialogRegion(text.split('\n'));
      expect(region !== null).toBe(ANTIGRAVITY_NAVIGATE_FOOTER_PATTERN.test(text));
    });
  });
});
