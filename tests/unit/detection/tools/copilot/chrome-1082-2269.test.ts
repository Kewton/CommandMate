/**
 * copilot 1.0.82's chrome boundary (Issue #2269).
 *
 * The frames are `tests/unit/lib/detection/fixtures/copilot-live-2269/`, raw
 * `capture-pane -e` output at the production 200x1000 geometry. Read that
 * directory's README for what 1.0.82 changed; the short version is that the two
 * full-width `─` rules `COPILOT_RULE_ROW` was written for became a `╻▄` / `╹▀`
 * half-block frame and the composer lost its `❯`, so `findCopilotChromeStart`
 * returned -1 on every frame and the whole pane -- 199 `▀` and the
 * `← open sidebar …` footer included -- was saved as the agent's reply.
 *
 * Every assertion here is positional, and the mutation case at the end is what
 * keeps it from being vacuous: with the 1.0.82 fence taken back out of
 * `COPILOT_RULE_ROW`, the boundary is gone and the wall comes back.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import {
  findCopilotChromeStart,
  readCopilotStatusBar,
  stripAnsi,
} from '@/lib/detection/cli-patterns';

const FIXTURE_DIR = fileURLToPath(
  new URL('../../../lib/detection/fixtures/copilot-live-2269/', import.meta.url),
);

function frame(name: string): string[] {
  return readFileSync(`${FIXTURE_DIR}${name}.txt`, 'utf-8').split('\n');
}

/** The five rows 1.0.82 pins to the bottom of the pane, cwd row first. */
const CHROME_ROWS = 5;

/**
 * Every 1.0.82 frame in the corpus. All of them carry copilot's own chrome: a
 * dialog is the one shape that does not, and that case is read off 1.0.80's
 * permission dialog below (see the fixture README for why).
 */
const CHROME_FRAMES = [
  'boot-idle',
  'turn-complete',
  'turn-complete-oneword',
  'turn-running',
  'turn-tool-rows',
  'turn-tool-badges',
  'turn-shell-block',
  'turn-oneword-echo-askuser',
] as const;

describe('[#2269] copilot 1.0.82 chrome boundary', () => {
  it('keeps the fixtures raw and at the production pane height', () => {
    for (const name of CHROME_FRAMES) {
      const lines = frame(name);
      // 1000 rows + the trailing newline's empty element.
      expect(lines.length, name).toBe(1001);
      expect(lines.join('\n'), name).toContain('[');
    }
  });

  it.each(CHROME_FRAMES)('finds the top of the chrome block on %s', (name) => {
    const lines = frame(name);
    const start = findCopilotChromeStart(lines);

    // The cwd/session row, i.e. five rows up from the status bar at the bottom.
    expect(start).toBe(1000 - CHROME_ROWS);

    const chrome = lines.slice(start, 1000).map((line) => stripAnsi(line));
    expect(chrome).toHaveLength(CHROME_ROWS);
    expect(chrome[0]).toMatch(/Session: [\d.]+ AIC used\s*$/);
    expect(chrome[1]).toMatch(/^╻▄{10,}$/);
    expect(chrome[2].trimEnd()).toMatch(/^┃/);
    expect(chrome[3]).toMatch(/^╹▀{10,}$/);
    expect(chrome[4]).toMatch(/open sidebar|esc interrupt/);
  });

  it('leaves the transcript intact above the boundary', () => {
    const lines = frame('turn-complete');
    const start = findCopilotChromeStart(lines);
    const transcript = lines.slice(0, start).map((line) => stripAnsi(line));

    expect(transcript.some((row) => /^\s*●\s+uat-run1\s*$/.test(row))).toBe(true);
    expect(transcript.join('\n')).not.toContain('open sidebar');
  });

  it('returns -1 for a dialog, which has no composer and no bar', () => {
    // A dialog replaces the whole bottom of the pane, so there is nothing
    // positional to anchor on and the frame belongs to `detectPrompt` instead.
    //
    // Read off 1.0.80's permission dialog rather than 1.0.82's folder-trust one:
    // that frame WAS captured (it is quoted in the fixture README) but is not
    // shipped, because `tests/unit/polling/auto-yes-dialog-gate.test.ts` sweeps
    // every `.txt` under `fixtures/` and pins the answerable dialogs by
    // equality, so a new dialog capture is a change to that file. The verdict
    // being pinned here is the box-over-the-bottom shape, which is identical on
    // both builds -- measured -1 on the 1.0.82 frame as well.
    const dialog = readFileSync(
      fileURLToPath(
        new URL('../../../lib/detection/fixtures/copilot-live-1885/permission-dialog.txt', import.meta.url),
      ),
      'utf-8',
    ).split('\n');

    expect(findCopilotChromeStart(dialog)).toBe(-1);
  });

  it('still reads the 1.0.82 status bar in both directions', () => {
    // The Issue's "known trap": completion detection was never broken on 1.0.82,
    // so a fix that also moved the status-bar reader would be fixing nothing.
    const idle = frame('turn-complete').slice(990).map((line) => stripAnsi(line));
    const working = frame('turn-running').slice(990).map((line) => stripAnsi(line));

    expect(readCopilotStatusBar(idle)).toBe('idle');
    expect(readCopilotStatusBar(working)).toBe('working');
  });

  it('does not mistake the transcript\'s own half-block dividers for the fence', () => {
    // 1.0.82 boxes the echoed prompt between a `▄` run and a `▀` run that carry
    // NO corner glyph. If those counted as fence rows the boundary would land
    // ~985 rows too high and take the reply with it, so the corner is required.
    const lines = frame('turn-complete').map((line) => stripAnsi(line));
    const dividerRows = lines
      .map((row, index) => ({ row: row.trim(), index }))
      .filter(({ row }) => /^[▀▄]{10,}$/.test(row));

    expect(dividerRows.length).toBeGreaterThanOrEqual(2);
    for (const { index } of dividerRows) {
      expect(index).toBeLessThan(1000 - CHROME_ROWS);
    }
  });

  describe('mutation: take the 1.0.82 fence back out of the rule row', () => {
    /**
     * `findCopilotChromeStart`, verbatim, with `COPILOT_RULE_ROW` reverted to the
     * 1.0.80-only `/^─{10,}$/` and the composer glyph to `/^ {0,2}[>❯]/`.
     *
     * A structure-preserving mutation on purpose: the rest of the search — the
     * two-row status-bar window, the 40-row composer window, the composer check,
     * the `openingRule - 1` return — is unchanged, so what the assertions below
     * measure is the fence vocabulary and nothing else.
     */
    function findChromeStartWith1080RulesOnly(lines: readonly string[]): number {
      const RULE = /^─{10,}$/;
      const GLYPH = /^ {0,2}[>❯]/;
      const isRule = (line: string): boolean => RULE.test(stripAnsi(line).trim());

      let lastRow = lines.length - 1;
      while (lastRow >= 0 && stripAnsi(lines[lastRow]).trim() === '') lastRow--;
      if (lastRow < 0) return -1;

      let closingRule = -1;
      for (let i = lastRow; i >= Math.max(0, lastRow - 2); i--) {
        if (isRule(lines[i])) {
          closingRule = i;
          break;
        }
      }
      if (closingRule < 0) return -1;

      let openingRule = -1;
      for (let i = closingRule - 1; i >= Math.max(0, closingRule - 40); i--) {
        if (isRule(lines[i])) {
          openingRule = i;
          break;
        }
      }
      if (openingRule < 0) return -1;
      if (!GLYPH.test(stripAnsi(lines[openingRule + 1] ?? ''))) return -1;
      return Math.max(0, openingRule - 1);
    }

    it.each(CHROME_FRAMES)('loses the boundary on %s', (name) => {
      expect(findChromeStartWith1080RulesOnly(frame(name))).toBe(-1);
    });

    it('puts the wall and the footer back into the extracted region', () => {
      const lines = frame('turn-complete');
      const mutated = findChromeStartWith1080RulesOnly(lines);
      const contentEnd = mutated >= 0 ? mutated : lines.length;
      const region = lines.slice(0, contentEnd).map((line) => stripAnsi(line)).join('\n');

      expect(region).toContain('open sidebar');
      expect(region).toMatch(/╹▀{10,}/);
    });
  });
});
