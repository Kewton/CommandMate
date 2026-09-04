/**
 * Issue #2326 — a Command Code picker is not the pane it is painted on.
 *
 * Issue #2309 stopped tail-slicing a selection list, because a search-type
 * picker is tens of rows long and the arrows could reach rows the 16-row window
 * had already thrown away. "No tail" was implemented as "every compacted row",
 * with one carve-out for opencode, whose overlay is painted mid-transcript.
 *
 * Command Code has the same shape and was not carved out. It is an INLINE tool
 * (`alternate_on=0`): `/model` does not clear the pane, it paints the picker
 * under whatever the session has already printed. So on a session with a few
 * turns behind it the card drew the conversation, put the picker below the
 * fold, and the arrow-moved highlight — which {@link findHighlightLineIndex}
 * does now locate correctly (Issue #2323) — was scrolled to inside a box whose
 * visible rows were somebody's earlier answers.
 *
 * ## The captures
 *
 * Taken live for this Issue on 2026-09-05: Command Code **1.47.1**, private
 * tmux socket (`tmux -L cm2326`), one throwaway directory under the session
 * scratchpad, pane at the production 200x1000 (`TUI_PANE_WIDTH` x
 * `TUI_PANE_HEIGHT`), five turns of conversation, then `/model`. Four states of
 * the same session are committed — the picker as it opens, after 32 ▼, after 72
 * ▼, and the pane immediately after `Escape` closed it. **Nothing was confirmed
 * with `Enter`**; the picker was closed with `Escape` and the host's default
 * model is unchanged. See the fixture README.
 *
 * Every frame is 333 content rows of which **256 are banner and transcript** and
 * 77 are the picker, which is the defect stated as a number.
 *
 * ## What this suite refuses to let happen
 *
 * The row counts below would all pass on a rule that cropped to some incidental
 * rectangle, so each case names the rows on BOTH sides of the cut: what must be
 * in the card (the heading, the filter row, models at both ends of the list, the
 * footer) and what must not (the shell line, the boot banner, the five prompts,
 * the model's answers). The last describe block is the positive control — the
 * pre-#2326 output on the same bytes, which contains every one of those
 * conversation rows.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractDialogFrameTail } from '@/lib/chat/dialog-frame';
import { extractCommandCodeSelectionListFrame } from '@/lib/detection/selection-shape';
import { stripAnsi } from '@/lib/detection/ansi';
import { compactBlankRuns, isPaintedPanelRow } from '@/lib/terminal-display-normalize';

const FIXTURE_ROOT = path.resolve(__dirname, '../../../fixtures');
const DIR = path.join(FIXTURE_ROOT, 'chat-dialog-card-2254');

function fixture(name: string): string {
  return fs.readFileSync(path.join(DIR, name), 'utf8');
}

/** The three picker states, and the model each one has the arrows on. */
const PICKER_STATES = [
  ['command-code-model-1-47-1-open.txt', 'DeepSeek V4 Flash (latest) (default)'],
  ['command-code-model-1-47-1-middle.txt', 'Tencent Hy4 Preview'],
  ['command-code-model-1-47-1-bottom.txt', 'Grok 4.6'],
] as const;

/** The pane after `Escape` — no picker, so no footer to cut to. */
const CLOSED = 'command-code-model-1-47-1-closed.txt';

/**
 * Rows that are the SESSION and never the dialog.
 *
 * The five prompts were sent verbatim; `echo boot-ok` is the shell line the
 * pane opened with; the banner is Command Code's own boot logo caption. Any of
 * them inside the card is this Issue's defect.
 */
const CONVERSATION_ROWS = [
  'echo boot-ok',
  '# Command Code v1.47.1',
  'List the numbers 1 to 50, one per line, nothing else.',
  'List the numbers 201 to 260, one per line, nothing else.',
  'Name 3 primary colors, one per line.',
  'List the numbers 301 to 345, one per line, nothing else.',
] as const;

/** What the card renders for a frame the surface has classified as a picker. */
function card(name: string): string {
  return extractDialogFrameTail(fixture(name), { selectionList: true });
}

// ---------------------------------------------------------------------------
// The captures still describe the defect
// ---------------------------------------------------------------------------

describe('[#2326] the captures are a picker at the bottom of a real session', () => {
  it.each(PICKER_STATES.map(([name]) => name))('%s is 256 rows of session + 77 of picker', (name) => {
    // Asserted rather than assumed: a re-captured fixture taken on a fresh
    // session — no transcript above the picker — would let every crop
    // assertion below pass without cropping anything.
    const lines = fixture(name).replace(/\r\n/g, '\n').split('\n');
    let last = lines.length - 1;
    while (last >= 0 && stripAnsi(lines[last]).trim() === '') last -= 1;
    expect(last).toBe(332);

    const footer = lines.findIndex((line) => /enter to select · esc to cancel/i.test(stripAnsi(line)));
    expect(footer).toBe(332);
    // The rule row is the seam, and there is exactly ONE of them on the pane
    // while the picker has the screen: Command Code does not draw the
    // composer's own two rules over a dialog.
    const rules = lines.flatMap((line, i) => {
      const plain = stripAnsi(line).trim();
      return /^─+$/.test(plain) && plain.length >= 40 ? [i] : [];
    });
    expect(rules).toEqual([255]);
  });

  it.each(PICKER_STATES.map(([name]) => name))('%s still carries its raw SGR', (name) => {
    // The selection mark is a background colour (Issue #2323), so a fixture
    // stripped of its escapes would make the highlight cases vacuous.
    expect(fixture(name)).toContain('\x1b[');
    expect(fixture(name)).toContain('48;2;45;43;85');
  });
});

// ---------------------------------------------------------------------------
// The cut
// ---------------------------------------------------------------------------

describe('[#2326] the card is the picker and nothing above it', () => {
  it.each(PICKER_STATES)('%s draws the dialog only', (name, highlighted) => {
    const rows = stripAnsi(card(name)).split('\n');

    // Top edge: the heading is the first row, so the rule above it and every
    // one of the 255 rows above THAT are gone.
    expect(rows[0]).toBe('Select model');
    // Bottom edge: the footer is the last row.
    expect(rows[rows.length - 1]).toMatch(/^type to search · ↑\/↓ navigate/);
    expect(rows).toHaveLength(76);

    // The whole list survives the cut — this is what #2309 bought and what
    // #2326 must not spend. Both ends of it, and the row the arrows are on.
    expect(rows).toContain('› Type to search models...');
    expect(rows.some((row) => row.startsWith('DeepSeek V4 Pro (latest)'))).toBe(true);
    expect(rows.some((row) => row.startsWith('Grok 4.6'))).toBe(true);
    expect(rows.some((row) => row.startsWith(highlighted))).toBe(true);
  });

  it.each(PICKER_STATES.map(([name]) => name))('%s contains no row of the session', (name) => {
    const plain = stripAnsi(card(name));
    for (const row of CONVERSATION_ROWS) expect(plain, row).not.toContain(row);
    // The answers, not just the prompts: the five turns printed the numbers
    // 1–50, 101–160, 201–260 and 301–345 one per line, and a card that kept
    // any of the model list's own rows by accident would still fail here.
    expect(plain).not.toContain('TASTE');
    expect(plain.split('\n').filter((row) => /^\s*\d+\s*$/.test(row))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Not cropping is a real answer, and this is when it is given
// ---------------------------------------------------------------------------

describe('[#2326] a frame with no picker on it falls back to every row', () => {
  it('the pane right after Escape closed the picker keeps its old behaviour', () => {
    // The flags and the capture can disagree by one poll: the surface is told
    // a selection list is up and the pane it captures no longer has one. A
    // crop on a guess would blank the card, which is worse than the defect.
    const raw = fixture(CLOSED);
    expect(extractCommandCodeSelectionListFrame(raw)).toBeNull();

    const rows = stripAnsi(card(CLOSED)).split('\n');
    expect(rows.length).toBeGreaterThan(200);
    expect(rows.join('\n')).toContain('❯ Ask your question...');
  });

  it('is not empty for any of the four captures — the failure mode that is worse', () => {
    for (const name of [...PICKER_STATES.map(([f]) => f), CLOSED]) {
      expect(card(name), name).not.toBe('');
      expect(stripAnsi(card(name)).trim(), name).not.toBe('');
    }
  });

  it('crops nothing when the footer is there and no rule row is above it', () => {
    // copilot's `/model` footer is `↑/↓ to navigate · … · enter to select ·
    // esc to cancel` and matches the same pattern, but copilot draws its
    // picker in a corner-bordered box — no row is nothing-but-rule, so the
    // reading declines and copilot's card is unchanged. Stated on a
    // constructed frame because the shape, not the tool, is the rule.
    const boxed = [
      '  some answer text',
      '╭────────────────────────────────────────────────────────────────╮',
      '│ ❯  Search models…                                              │',
      '│    gpt-5.6-sol                                                 │',
      '╰────────────────────────────────────────────────────────────────╯',
      '  ↑/↓ to navigate · enter to select · esc to cancel',
    ].join('\n');
    expect(extractCommandCodeSelectionListFrame(boxed)).toBeNull();

    // …and the same frame WITH a bare rule above the box does crop, so the
    // case above is a refusal and not an inability.
    const ruled = [boxed.split('\n')[0], '─'.repeat(64), ...boxed.split('\n').slice(1)].join('\n');
    const cropped = extractCommandCodeSelectionListFrame(ruled);
    expect(cropped).not.toBeNull();
    expect(cropped).not.toContain('some answer text');
  });

  it('crops nothing when there is no footer at all', () => {
    expect(extractCommandCodeSelectionListFrame('')).toBeNull();
    expect(extractCommandCodeSelectionListFrame('─'.repeat(200) + '\nSelect model\n')).toBeNull();
  });

  it('takes the LAST footer, so a footer quoted in the transcript loses', () => {
    // An agent that printed its own picker footer into an answer would
    // otherwise pull the top edge up above the real dialog.
    const frame = [
      '  the footer reads: enter to select · esc to cancel',
      '─'.repeat(200),
      'Select model',
      'gpt-5.6-sol',
      'type to search · enter to select · esc to cancel',
    ].join('\n');
    expect(stripAnsi(extractCommandCodeSelectionListFrame(frame) ?? '')).toBe(
      ['Select model', 'gpt-5.6-sol', 'type to search · enter to select · esc to cancel'].join('\n'),
    );
  });
});

// ---------------------------------------------------------------------------
// Nothing else in tests/fixtures is touched
// ---------------------------------------------------------------------------

describe('[#2326] the reading fires on Command Code frames and no others', () => {
  /** Every committed `.txt` capture in the repository. */
  function everyCapture(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.txt')) out.push(full);
      }
    };
    walk(FIXTURE_ROOT);
    return out.sort();
  }

  it('crops exactly the Command Code /model captures, out of every fixture', () => {
    // The sweep, not a hand-written list: this is what says claude, codex,
    // copilot, gemini and opencode are untouched, and it re-derives itself
    // whenever a capture is added.
    const cropped = everyCapture()
      .filter((file) => extractCommandCodeSelectionListFrame(fs.readFileSync(file, 'utf8')) !== null)
      .map((file) => path.relative(FIXTURE_ROOT, file));

    expect(cropped.sort()).toEqual([
      'chat-dialog-card-2254/command-code-model-1-40-1.txt',
      'chat-dialog-card-2254/command-code-model-1-47-1-bottom.txt',
      'chat-dialog-card-2254/command-code-model-1-47-1-middle.txt',
      'chat-dialog-card-2254/command-code-model-1-47-1-open.txt',
    ]);
  });

  it('leaves the opencode overlay to the opencode reader', () => {
    // Order inside `SELECTION_LIST_FRAME_CROPPERS` is only safe while the two
    // signatures are disjoint. This is the half the sweep above cannot state:
    // opencode's palette is a selection list and the Command Code reading must
    // decline it, or the registry's order would start mattering silently.
    const overlay = fs.readFileSync(
      path.join(FIXTURE_ROOT, 'opencode-live-2047/w200/command-palette.txt'),
      'utf8',
    );
    expect(extractCommandCodeSelectionListFrame(overlay)).toBeNull();
    expect(stripAnsi(extractDialogFrameTail(overlay, { selectionList: true }))).toContain('Commands');
  });
});

// ---------------------------------------------------------------------------
// The positive control
// ---------------------------------------------------------------------------

describe('[#2326] the pre-crop output on the same bytes is the defect', () => {
  it.each(PICKER_STATES.map(([name]) => name))('%s: without the crop the session is back', (name) => {
    // This is what `extractDialogFrameTail` returned for these frames before
    // this Issue, spelled out: the whole compacted pane. Without it the "no
    // conversation rows" assertions above could pass on a fixture that never
    // had any, and the sweep could pass on a reading that cropped nothing.
    const uncropped = compactBlankRuns(fixture(name).replace(/\r\n/g, '\n'), {
      isStructuralRow: isPaintedPanelRow,
    });
    const plain = stripAnsi(uncropped);

    expect(plain.split('\n').length).toBeGreaterThan(300);
    for (const row of CONVERSATION_ROWS) expect(plain, row).toContain(row);
    // …and it still ends with the picker, so the difference between the two is
    // the 256 rows above it and nothing else.
    expect(plain.trimEnd().split('\n').pop()).toMatch(/^type to search · ↑\/↓ navigate/);
  });
});
