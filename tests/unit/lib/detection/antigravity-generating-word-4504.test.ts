/**
 * agy's own thought heading must not keep an idle pane "generating" (Issue #4504).
 *
 * agy prints its reasoning as
 *
 *   ▸ Thought for 3s, 507 tokens
 *     Generating the specified file
 *
 * and the word in that body matched `ANTIGRAVITY_THINKING_PATTERN` with no
 * positional reading. `afterThinking` applied it to the last 15 rows BEFORE it
 * looked at the status row under the input box, so a frame that ended in the
 * idle composer (`? for shortcuts`) was still published as `running` for as
 * long as the heading stayed in the window. The send gate (`isAntigravityReady`)
 * applied the same word test when the status row had no `? for shortcuts`
 * (agy 1.2.1 after a tool turn, #2478), so `send` / `ask` waited 15 s and failed.
 *
 * The frames the Issue names are built here from the live captures rather than
 * committed as new fixture files: `antigravity-live-2364/` and
 * `antigravity-live-2478/` already pin their exact membership and the 200x1000
 * geometry in suites outside this Issue's scope (#2845's test builds its quoted
 * frames the same way). Nothing is invented — the rows come from the captures:
 *
 *  - (a) `idle-after-deny.txt`'s FIRST turn only, followed by that capture's own
 *        input box and `? for shortcuts` status row: a resting pane whose tail
 *        still holds `Generating the specified file`.
 *  - (b) `after-tool-turn.txt` with `▸ Thought for 2s` and
 *        `  Generating the specified file` inserted above the turn's last body
 *        row: an agy 1.2.1 resting pane with no `? for shortcuts`.
 *
 * @vitest-environment node
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripAnsi } from '@/lib/detection/cli-patterns';
import { detectSessionStatus, STATUS_REASON } from '@/lib/detection/status-detector';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import { isAntigravityReady } from '@/lib/cli-tools/antigravity';
import {
  ANTIGRAVITY_GENERATING_CAPTURE_V1_1_13,
  ANTIGRAVITY_IDLE_CAPTURE_V1_1_13,
  ANTIGRAVITY_IDLE_CAPTURE_V1_1_13_ANSI,
} from '@tests/fixtures/model-info-captures';

const LIVE_2364 = path.resolve(__dirname, '../../../fixtures/antigravity-live-2364');
const LIVE_2478 = path.resolve(__dirname, '../../../fixtures/antigravity-live-2478');

/** The rows of a capture, ANSI intact, without the file's closing newline. */
function rowsOf(dir: string, name: string): string[] {
  const rows = readFileSync(path.join(dir, `${name}.txt`), 'utf8').split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  return rows;
}

const plain = (row: string): string => stripAnsi(row).trim();

/**
 * `idle-after-deny.txt`'s first turn, then the same capture's input box
 * (rule / `>` / rule / `? for shortcuts` status row).
 */
function firstTurnWithIdleComposer(): string {
  const rows = rowsOf(LIVE_2364, 'idle-after-deny');
  const rules = rows.flatMap((row, i) => (/^─{3,}$/.test(plain(row)) ? [i] : []));
  // rule above turn 1, above turn 2, above turn 3, above the box, under it.
  if (rules.length !== 5) throw new Error(`idle-after-deny: expected 5 rules, found ${rules.length}`);
  const firstTurn = rows.slice(0, rules[1]);
  const inputBox = rows.slice(rules[3], rules[3] + 4);
  return [...firstTurn, ...inputBox].join('\n');
}

/**
 * `after-tool-turn.txt` with a thought heading inserted above the last body
 * row of the tool turn. That capture's status row carries only the model label.
 *
 * A composition (review of #4504, P3-3): `  Generating the specified file` is a
 * real row from `antigravity-live-2364/idle-after-deny.txt`, while the wording
 * `▸ Thought for 2s` and this position are estimated — agy 1.2.1 was not
 * captured drawing a thought block here.
 */
function afterToolTurnWithThought(): string {
  const rows = rowsOf(LIVE_2478, 'after-tool-turn');
  const bodyAt = rows.findIndex(row => /^uat-grace initial commit for UAT 2463-2473$/.test(plain(row)));
  if (bodyAt < 0) throw new Error('after-tool-turn: the tool turn body row moved');
  return [
    ...rows.slice(0, bodyAt),
    '▸ Thought for 2s',
    '  Generating the specified file',
    ...rows.slice(bodyAt),
  ].join('\n');
}

const FIRST_TURN = firstTurnWithIdleComposer();
const AFTER_TOOL_WITH_THOUGHT = afterToolTurnWithThought();
const AFTER_TOOL_TURN = rowsOf(LIVE_2478, 'after-tool-turn').join('\n');
const AFTER_PLAIN_TURNS = rowsOf(LIVE_2478, 'after-plain-turns').join('\n');
const IDLE_AFTER_DENY = rowsOf(LIVE_2364, 'idle-after-deny').join('\n');

/**
 * The live generating capture with the status row's `esc to cancel` removed:
 * `⢿  Generating...` is the only generating marker left, as on agy 1.2.1 after
 * a tool turn (where the idle half of the status row is not drawn either).
 */
const GENERATING_WITHOUT_FOOTER = ANTIGRAVITY_GENERATING_CAPTURE_V1_1_13.replace(/esc to cancel/g, '');

const SPINNER_LINE = '⢿  Generating...';

/** The same footer-less frame with the spinner row spelled differently. */
function generatingWithoutFooter(spinner: string): string {
  return ANTIGRAVITY_GENERATING_CAPTURE_V1_1_13
    .replace(/esc to cancel/g, '')
    .replace(SPINNER_LINE, spinner);
}

/**
 * Spinner spellings the shared priority 2 (`detectThinking` over the last 5
 * rows) calls running while the positional reader's `Generating...`/line-leading
 * braille test does not (review of #4504, P2-1). The gate must not open on them.
 */
const BARE_GENERATING = generatingWithoutFooter('  Generating the file');
const MIDROW_BRAILLE = generatingWithoutFooter('● ⢿ Bash(sleep 100)');
const TWO_DOTS = generatingWithoutFooter('Generating..');

/**
 * A footer-less generating frame whose spinner sits in rows 6-15 of the tail,
 * outside priority 2's 5-row window (review of #4504, P3-2): only
 * `afterThinking`'s positional `(3)` branch can answer `running` here.
 */
const SPINNER_OUTSIDE_THINKING_WINDOW = ANTIGRAVITY_GENERATING_CAPTURE_V1_1_13
  .replace(/esc to cancel/g, '')
  .replace(SPINNER_LINE, `${SPINNER_LINE}\n\n\n`);

/** What the status detector publishes for a frame. */
const statusOf = (frame: string): string => detectSessionStatus(frame, 'antigravity').status;

describe('[#4504] a thought heading named "Generating" does not make an idle agy busy', () => {
  describe('the frames themselves', () => {
    it('(a) holds the thought body AND the idle status row', () => {
      expect(FIRST_TURN).toContain('Generating the specified file');
      expect(FIRST_TURN).toMatch(/^\?\s+for\s+shortcuts/m);
      expect(FIRST_TURN).not.toMatch(/esc to cancel/);
    });

    it('(b) holds the thought body and has no `? for shortcuts`', () => {
      expect(AFTER_TOOL_WITH_THOUGHT).toContain('Generating the specified file');
      expect(AFTER_TOOL_WITH_THOUGHT).not.toMatch(/\?\s+for\s+shortcuts/);
      expect(AFTER_TOOL_WITH_THOUGHT).not.toMatch(/esc to cancel/);
    });
  });

  describe('陽性: an idle pane whose tail still says "Generating" is ready', () => {
    it.each([
      ['(a) first turn + idle composer', FIRST_TURN],
      ['(b) after-tool-turn + thought heading', AFTER_TOOL_WITH_THOUGHT],
      ['idle-after-deny.txt', IDLE_AFTER_DENY],
      ['after-tool-turn.txt', AFTER_TOOL_TURN],
      ['after-plain-turns.txt', AFTER_PLAIN_TURNS],
    ])('%s', (_label, frame) => {
      const result = detectSessionStatus(frame, 'antigravity');
      expect(result.status).toBe('ready');
      expect(result.reason).toBe(STATUS_REASON.INPUT_PROMPT);
      expect(isAntigravityReady(frame)).toBe(true);
    });
  });

  describe('陰性対照: a real turn in flight stays busy', () => {
    it('the generating capture (`esc to cancel` on the status row)', () => {
      expect(statusOf(ANTIGRAVITY_GENERATING_CAPTURE_V1_1_13)).toBe('running');
      expect(isAntigravityReady(ANTIGRAVITY_GENERATING_CAPTURE_V1_1_13)).toBe(false);
    });

    it('generating with no status-row footer: `⢿  Generating...` alone still reads busy', () => {
      expect(GENERATING_WITHOUT_FOOTER).toContain('⢿  Generating...');
      expect(GENERATING_WITHOUT_FOOTER).not.toContain('esc to cancel');
      expect(GENERATING_WITHOUT_FOOTER).not.toMatch(/\?\s+for\s+shortcuts/);
      expect(statusOf(GENERATING_WITHOUT_FOOTER)).toBe('running');
      expect(isAntigravityReady(GENERATING_WITHOUT_FOOTER)).toBe(false);
    });

    // Review of #4504 P2-1: the detector's priority 2 is `detectThinking` over
    // the last 5 rows; the gate's positional reader was narrower, so these three
    // spellings published `running` while the send gate opened.
    it.each([
      ['bare `Generating` (no braille, no ellipsis)', BARE_GENERATING],
      ['braille in the middle of the row', MIDROW_BRAILLE],
      ['`Generating..` (two dots)', TWO_DOTS],
    ])('the shared 5-row thinking word still closes the gate: %s', (_label, frame) => {
      expect(statusOf(frame)).toBe('running');
      expect(isAntigravityReady(frame)).toBe(false);
    });

    // Review of #4504 P3-2: the marker outside priority 2's window but inside
    // the 15-row tail is the only frame `afterThinking`'s positional (3) answers.
    it('a marker in rows 6-15 of the tail is read by afterThinking (3), and the gate agrees', () => {
      const tail = normalizeFrame(SPINNER_OUTSIDE_THINKING_WINDOW, 'antigravity');
      expect(tail.thinkingLines).not.toContain('Generating');
      expect(tail.lastLines).toContain('Generating...');
      expect(statusOf(SPINNER_OUTSIDE_THINKING_WINDOW)).toBe('running');
      expect(isAntigravityReady(SPINNER_OUTSIDE_THINKING_WINDOW)).toBe(false);
    });
  });

  describe('陰性対照: the screens read before the composer are unchanged', () => {
    it.each(['picker-switch-model', 'trust-dialog', 'popup-slash-commands', 'dialog-bash-wrapped'])(
      '%s is not ready',
      (name) => {
        const frame = rowsOf(LIVE_2364, name).join('\n');
        expect(isAntigravityReady(frame)).toBe(false);
        expect(statusOf(frame)).not.toBe('ready');
      }
    );
  });

  describe('不変条件: afterThinking と isAntigravityReady agree on every frame', () => {
    it.each([
      ['(a) first turn + idle composer', FIRST_TURN],
      ['(b) after-tool-turn + thought heading', AFTER_TOOL_WITH_THOUGHT],
      ['idle-after-deny.txt', IDLE_AFTER_DENY],
      ['after-tool-turn.txt', AFTER_TOOL_TURN],
      ['after-plain-turns.txt', AFTER_PLAIN_TURNS],
      ['generating (1.1.13)', ANTIGRAVITY_GENERATING_CAPTURE_V1_1_13],
      ['generating without footer', GENERATING_WITHOUT_FOOTER],
      ['bare `Generating`', BARE_GENERATING],
      ['mid-row braille', MIDROW_BRAILLE],
      ['`Generating..`', TWO_DOTS],
      ['spinner in rows 6-15', SPINNER_OUTSIDE_THINKING_WINDOW],
      ['picker-switch-model', rowsOf(LIVE_2364, 'picker-switch-model').join('\n')],
      ['trust-dialog', rowsOf(LIVE_2364, 'trust-dialog').join('\n')],
      ['dialog-bash-wrapped', rowsOf(LIVE_2364, 'dialog-bash-wrapped').join('\n')],
    ])('%s', (_label, frame) => {
      expect(isAntigravityReady(frame)).toBe(statusOf(frame) === 'ready');
    });
  });

  // Review of #4504 P2-1: the gate must never be looser than the detector. The
  // shared priority 2 runs before `afterThinking`, so this one direction is what
  // a frame the gate opens must satisfy — every real capture, plus the
  // position-derived frames this Issue adds.
  describe('不変条件: ゲートが true なら状態は ready', () => {
    const realFrames: Array<[string, string]> = [
      ...readdirSync(LIVE_2364)
        .filter((file) => file.endsWith('.txt'))
        .sort()
        .map((file) => [`2364/${file}`, readFileSync(path.join(LIVE_2364, file), 'utf8')] as [string, string]),
      ...readdirSync(LIVE_2478)
        .filter((file) => file.endsWith('.txt'))
        .sort()
        .map((file) => [`2478/${file}`, readFileSync(path.join(LIVE_2478, file), 'utf8')] as [string, string]),
      ['model-info-captures/generating (1.1.13)', ANTIGRAVITY_GENERATING_CAPTURE_V1_1_13],
      ['model-info-captures/idle (1.1.13)', ANTIGRAVITY_IDLE_CAPTURE_V1_1_13],
      ['model-info-captures/idle ANSI (1.1.13)', ANTIGRAVITY_IDLE_CAPTURE_V1_1_13_ANSI],
    ];
    const syntheticFrames: Array<[string, string]> = [
      ['(a) first turn + idle composer', FIRST_TURN],
      ['(b) after-tool-turn + thought heading', AFTER_TOOL_WITH_THOUGHT],
      ['bare `Generating`', BARE_GENERATING],
      ['mid-row braille', MIDROW_BRAILLE],
      ['`Generating..`', TWO_DOTS],
      ['spinner in rows 6-15', SPINNER_OUTSIDE_THINKING_WINDOW],
    ];

    it.each([...realFrames, ...syntheticFrames])('%s', (_label, frame) => {
      if (!isAntigravityReady(frame)) return;
      expect(statusOf(frame)).toBe('ready');
    });
  });
});
