/**
 * Issue #2400: codex gets the bottom-pinned-chrome reader every other inline
 * tool already had.
 *
 * ## The defect
 *
 * codex draws two rows below the transcript on every settled frame — the
 * composer (`› Ask Codex to do anything`) and the status bar (`model · cwd`) —
 * and, unlike claude (#1289), copilot (#1897), opencode (#1911) and Command Code
 * (#2250), nothing told `response-checker.ts` where they start. Below the
 * capture window that cost nothing: codex extraction begins at the saved line
 * cursor. Once the pane outgrows `CACHE_MAX_CAPTURE_LINES` the cursor stops
 * being a position in the capture and #1670 switches the anchor to "the newest
 * echoed user prompt", searched from the bottom of the pane — and the first `›`
 * from the bottom is the COMPOSER. Extraction then started on the row after it,
 * so the reply saved for every turn on a saturated pane was one row:
 *
 * ```text
 * gpt-6-astra xhigh · ~/share/work/github_kewton/CommandAgent-develop
 * ```
 *
 * Identical on every turn, so `isDuplicateResponse` locked on it afterwards.
 *
 * ## What these tests are read off
 *
 * Live codex-cli 0.153.4 captures at the production 200x1000 geometry, added to
 * `tests/fixtures/codex-live-2310/` by this Issue — see that directory's README
 * for how each was taken. They are RAW on purpose: the whole rule rests on the
 * SGR attributes #2310 measured, and a stripped frame would let a reader that
 * takes every `›` for the composer pass the file.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  isCodexTurnActive,
  findCodexChromeStart,
  findCodexUserEchoIndex,
  CODEX_USER_ECHO_PATTERN,
  CODEX_STATUS_BAR_PATTERN,
  stripAnsi,
} from '@/lib/detection/cli-patterns';
import { readCodexGlyphRowKind } from '@/lib/detection/tools/codex/cli-patterns';

const LIVE_2310 = join(__dirname, '../../../fixtures/codex-live-2310');

const read = (name: string): string => readFileSync(join(LIVE_2310, `${name}.txt`), 'utf-8');
const rows = (name: string): string[] => read(name).split('\n');

/** The frames this Issue captured, plus the two #2310 already had. */
const CODEX_2400_FRAMES = [
  'saturated-idle-tail',
  'turn-submitted-no-status',
  'steer-queued-running',
] as const;

// ---------------------------------------------------------------------------
// Premises. If the fixtures stopped being raw, nothing below means anything.
// ---------------------------------------------------------------------------

describe('[#2400] the new live captures still carry their attributes', () => {
  it.each(CODEX_2400_FRAMES)('%s is stored with ANSI intact', name => {
    expect(read(name)).toContain('\x1b[');
  });

  it('the saturated tail really ends on codex chrome', () => {
    // `saturated-idle-tail.txt` is the LAST 60 rows of an 11,000-row
    // `capture-pane -S -10000` taken on a pane whose `history_size` was 11,025.
    // The 9,940 rows this file does not carry were `transcript row <n>` shell
    // scrollback and are reconstructed by the poller-level suite; what has to be
    // real here is the boundary, so that is what is pinned.
    const lines = rows('saturated-idle-tail');
    const clean = lines.map(stripAnsi);
    const nonBlank = clean.map((l, i) => [l, i] as const).filter(([l]) => l.trim() !== '');
    const [statusBar] = nonBlank[nonBlank.length - 1];
    const [composer] = nonBlank[nonBlank.length - 2];

    expect(CODEX_STATUS_BAR_PATTERN.test(statusBar)).toBe(true);
    expect(composer).toBe('› Ask Codex to do anything');
    // The filler above the codex frame is the shell scrollback that made the
    // pane saturate, not something this suite invented.
    expect(clean.some(l => /^transcript row \d+$/.test(l))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findCodexChromeStart
// ---------------------------------------------------------------------------

describe('[#2400] findCodexChromeStart locates the composer row', () => {
  it.each([
    ['saturated-idle-tail', '› Ask Codex to do anything'],
    ['idle-composer', '› Ask Codex to do anything'],
    ['turn-running', '› Ask Codex to do anything'],
    ['turn-submitted-no-status', '› Ask Codex to do anything'],
    ['steer-queued-running', '› Ask Codex to do anything'],
  ])('%s: chrome starts on the composer', (name, expected) => {
    const lines = rows(name);
    const start = findCodexChromeStart(lines);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(stripAnsi(lines[start])).toBe(expected);
    expect(readCodexGlyphRowKind(lines[start])).toBe('composer');
  });

  it.each(['saturated-idle-tail', 'idle-composer', 'turn-running', 'turn-submitted-no-status'])(
    '%s: everything below the boundary is chrome, and the reply is above it',
    name => {
      const lines = rows(name);
      const start = findCodexChromeStart(lines);
      const below = lines.slice(start).map(stripAnsi).filter(l => l.trim() !== '');

      // The status bar — the row that became the whole saved "reply" — is
      // outside the content region, and nothing else is left below except
      // codex's own notices.
      expect(below.some(l => CODEX_STATUS_BAR_PATTERN.test(l))).toBe(true);
      expect(below[0]).toMatch(/^›/);
    },
  );

  it('a dialog frame has no composer to trim', () => {
    // codex replaces the composer with the dialog, so there is no chrome, and
    // the caller resolves the frame on the prompt path instead. Answering
    // anything else here would cut the dialog out of the extraction it feeds.
    for (const name of ['dialog-permissions-picker', 'dialog-trust-directory', 'dialog-keymap-editor']) {
      expect(findCodexChromeStart(rows(name))).toBe(-1);
    }
  });

  it('an ANSI-stripped frame is still resolved, via the status bar below it', () => {
    // Auto-Yes hands the detection layer a capture that has already been through
    // `stripAnsi`, where all three of codex's `›` uses are one byte. The status
    // bar is the landmark that survives.
    const lines = rows('saturated-idle-tail').map(stripAnsi);
    const start = findCodexChromeStart(lines);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(lines[start]).toBe('› Ask Codex to do anything');
  });

  it('refuses a stripped frame whose status bar is not drawn', () => {
    // Mutation injection: the fallback is the ONLY thing accepting the row on a
    // stripped capture, so removing its landmark has to make the reader give up
    // rather than guess. A reader that just took the bottom-most `›` would pass
    // this file without this case.
    const lines = rows('saturated-idle-tail')
      .map(stripAnsi)
      .filter(l => !CODEX_STATUS_BAR_PATTERN.test(l));

    expect(findCodexChromeStart(lines)).toBe(-1);
  });

  it('does not reach up into the transcript for a composer', () => {
    // Everything from the composer down removed: what is left ends on the reply,
    // whose own rows are not `›` rows. Latching onto the echo further up would
    // delete the reply, which is the failure mode this reader exists to prevent.
    const lines = rows('saturated-idle-tail');
    const start = findCodexChromeStart(lines);
    const withoutChrome = lines.slice(0, start);

    expect(findCodexChromeStart(withoutChrome)).toBe(-1);
  });

  it('a blank pane has no chrome', () => {
    expect(findCodexChromeStart([])).toBe(-1);
    expect(findCodexChromeStart(['', '   ', ''])).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// findCodexUserEchoIndex
// ---------------------------------------------------------------------------

describe('[#2400] findCodexUserEchoIndex anchors on the echo, never on the composer', () => {
  it('the saturated frame anchors on the echoed prompt', () => {
    const lines = rows('saturated-idle-tail');
    const chromeStart = findCodexChromeStart(lines);
    const echo = findCodexUserEchoIndex(lines, chromeStart, lines.length, true);

    expect(stripAnsi(lines[echo])).toBe('› Reply with exactly three short lines describing what a worktree is.');
    // #2310's measurement, restated as the premise of this anchor: a settled
    // echo is drawn with a DIM glyph and the composer with a bold one.
    expect(readCodexGlyphRowKind(lines[echo])).toBe('transcript-echo');
  });

  it('the composer placeholder is never returned, even without a trimmed contentEnd', () => {
    // The defect, reproduced at the level of the reader. Pre-#2400 the codex
    // branch excluded the composer by naming its placeholders (`Implement`,
    // `Find and fix`, `Type`, `Summarize`) — codex 0.1x wording, none of which
    // 0.15x draws. `Ask Codex to do anything` sailed through, and the row after
    // it is the status bar.
    const lines = rows('saturated-idle-tail');
    const echo = findCodexUserEchoIndex(lines, lines.length, lines.length, false);

    expect(stripAnsi(lines[echo])).not.toContain('Ask Codex to do anything');
    expect(stripAnsi(lines[echo])).toBe('› Reply with exactly three short lines describing what a worktree is.');
  });

  it('the placeholder wording is not what excludes it', () => {
    // Mutation injection on the rule itself: reword the placeholder to something
    // no list could carry and the reader must still refuse the row. A reader
    // that had kept the string guard passes every other case in this file and
    // fails here.
    const lines = rows('saturated-idle-tail').map(line =>
      line.replace('Ask Codex to do anything', 'Escribe algo para Codex'),
    );
    const echo = findCodexUserEchoIndex(lines, lines.length, lines.length, false);

    expect(stripAnsi(lines[echo])).toBe('› Reply with exactly three short lines describing what a worktree is.');
  });

  it('a freshly submitted echo is bold, and is still found', () => {
    // Measured for #2400 on 0.153.4: codex draws the echo of a message the
    // operator has JUST submitted as `ESC[1m› ESC[0m<text>` — a BOLD glyph, the
    // composer's own signature — and only re-renders it dim once the turn
    // settles. So attributes alone cannot separate this row from the composer;
    // position is what does, and this is the case that pins it.
    const lines = rows('turn-submitted-no-status');
    const chromeStart = findCodexChromeStart(lines);
    const echo = findCodexUserEchoIndex(lines, chromeStart, lines.length, true);

    expect(stripAnsi(lines[echo])).toBe('› Write a haiku about tmux.');
    expect(readCodexGlyphRowKind(lines[echo])).toBe('composer');
  });

  it('steps over the bottom-most `›` row when the chrome could not be trimmed', () => {
    // `composerTrimmed: false` is the frame whose chrome no reader could locate.
    // There the input box is still the bottom-most `›` row, and stepping over
    // exactly one candidate is the structural spelling of the guard the
    // placeholder list used to be.
    const lines = rows('turn-submitted-no-status');
    const echo = findCodexUserEchoIndex(lines, lines.length, lines.length, false);

    expect(stripAnsi(lines[echo])).toBe('› Write a haiku about tmux.');
  });

  it('never anchors on a dialog option still sitting in the scrollback', () => {
    // codex renders inline, so an approval dialog the operator answered earlier
    // in the SAME turn is still on screen between the echo and the reply
    // (#1160). It sits BELOW the echo, so a reader walking up from the composer
    // meets it first — and anchoring on it would start extraction inside the
    // dialog and cut the answer's opening rows.
    const dialog = rows('dialog-permissions-picker').filter(l => stripAnsi(l).trim() !== '');
    const tail = rows('saturated-idle-tail');
    const echoRow = tail.findIndex(l => stripAnsi(l).startsWith('› Reply with exactly'));
    const lines = [...tail.slice(0, echoRow + 1), ...dialog, ...tail.slice(echoRow + 1)];

    // Positive control: the dialog really did contribute `›` rows below the echo
    // that a reader without the option rule would take, and it did not move the
    // chrome boundary.
    const optionRows = dialog.filter(l => readCodexGlyphRowKind(l) === 'option');
    expect(optionRows.length).toBeGreaterThan(0);
    expect(optionRows.every(l => CODEX_USER_ECHO_PATTERN.test(stripAnsi(l)))).toBe(true);

    const chromeStart = findCodexChromeStart(lines);
    expect(stripAnsi(lines[chromeStart])).toBe('› Ask Codex to do anything');

    const echo = findCodexUserEchoIndex(lines, chromeStart, lines.length, true);
    expect(stripAnsi(lines[echo])).toBe('› Reply with exactly three short lines describing what a worktree is.');
  });

  it('reports -1 when the window holds no echo at all', () => {
    const lines = rows('saturated-idle-tail');
    const chromeStart = findCodexChromeStart(lines);

    // A window that stops above the echo: the #1670 fallback ("a single turn
    // longer than the capture window") has to stay reachable.
    expect(findCodexUserEchoIndex(lines, chromeStart, 2, true)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Item 3 of the Issue: can `isCodexTurnActive` see a steered turn?
// ---------------------------------------------------------------------------

describe('[#2400] the steer measurement', () => {
  /** The window completion detection reads, matching `extractResponse`. */
  const CHECK_LINE_COUNT = 20;

  const trimmed = (name: string): string[] => {
    const lines = rows(name);
    let end = lines.length;
    while (end > 0 && stripAnsi(lines[end - 1]).trim() === '') end--;
    return lines.slice(0, end);
  };

  it('a steered turn is still reported as running', () => {
    // Measured on 0.153.4 at 0.1-0.25s sampling, with a tool call in flight and
    // with pure generation: sending a second message does NOT take the status
    // row away. codex keeps `Working (Ns · esc to interrupt)` and adds
    // `Messages to be submitted after next tool call` with the queued text
    // below it. 132 consecutive samples across a full steer-and-submit cycle
    // held the interrupt hint; none was missing it while the turn was live.
    //
    // So the Issue's premise — "steer makes the scraper say ready" — does not
    // reproduce, and no hold-after-`user_prompt_submit` rule is needed for it.
    const frame = trimmed('steer-queued-running');

    expect(isCodexTurnActive(frame, CHECK_LINE_COUNT)).toBe(true);
    const clean = frame.map(stripAnsi).join('\n');
    expect(clean).toContain('Messages to be submitted after next tool call');
    expect(clean).toContain('esc to interrupt');
  });

  it('the ready window belongs to plain submission, and is ~0.3s wide', () => {
    // What DOES read `ready` on a live turn: the frame between Enter and the
    // first paint of the `Working` row. The echo is already drawn, the status
    // row is not, and there is no activity marker in the band above the
    // composer — so both of `isCodexTurnActive`'s signals are absent and the
    // scraper publishes `ready` / `input_prompt` while the hooks-backed status
    // says `running`. Every send passes through it, steered or not.
    //
    // Left as a measurement rather than a fix: this is the frame the next Issue
    // starts from, and pinning it here is what stops that Issue from being
    // opened against steering again.
    const frame = trimmed('turn-submitted-no-status');

    expect(isCodexTurnActive(frame, CHECK_LINE_COUNT)).toBe(false);
    const clean = frame.map(stripAnsi).join('\n');
    expect(clean).toContain('› Write a haiku about tmux.');
    expect(clean).not.toContain('esc to interrupt');
  });

  it('the same pane one repaint later is running again', () => {
    // The negative control for the window above: `turn-running.txt` is the same
    // layout with the status row painted, and it has always read `running`. So
    // the frame above is a paint-order gap, not a shape codex settles into.
    expect(isCodexTurnActive(trimmed('turn-running'), CHECK_LINE_COUNT)).toBe(true);
  });
});
