/**
 * Issue #4532 (S10) — invariants N1 and N2 on one table of pane rows.
 *
 *   N1  the bash row normalization (monitor-lib.sh `ml_pane_lines`) and the JS
 *       one (wait-verify.mjs `normalizePaneLine`) give the same row, and the
 *       monitor's ending scan (`ml_return_line_text`) and the JS readers
 *       (`returnLineOf`, `DONE_LINE_RE` after normalization,
 *       `hasCompletionSignal`) give the same answer.
 *   N2  `DONE:` that is not at the head of a row — mid-sentence, only in the
 *       panel column, inside a quote — is not an ending for any reader.
 *
 * The normalization (one definition, two languages):
 *   1. ANSI (CSI) and the non-breaking space, as ml_strip_ansi does;
 *   2. the right-hand panel: from the first `│` that follows text and two or
 *      more blanks, to the end of the row (claude 2.1.330's diff panel);
 *   3. the blanks at both ends;
 *   4. ONE reply marker at the head (after those blanks) and the one blank
 *      after it — claude `⏺`, codex `•`, Command Code `⠶` only — so a
 *      one-line reply `⏺ DONE: …` is read like the same line on its own row
 *      (lead r1 decision). `❯` / `›` / `>` / `│` / `-` / `*` are not markers.
 *
 * Every file is under os.tmpdir(); nothing in the repository is written.
 *
 * @vitest-environment node
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DONE_LINE_RE,
  hasCompletionSignal,
  normalizePaneLine,
  returnLineOf,
} from '../../../../scripts/orchestrate/wait-verify.mjs';

const LIB = path.join(process.cwd(), '.claude/skills/orchestrate-monitor/scripts/monitor-lib.sh');

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function bash(fn: string, text: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pane-line-4532-'));
  dirs.push(dir);
  const file = path.join(dir, 'pane.txt');
  writeFileSync(file, text);
  const out = spawnSync('bash', ['-c', `. "${LIB}" ; ${fn} "$1"`, 'bash', file], { encoding: 'utf8' });
  expect(out.status, out.stderr).toBe(0);
  return out.stdout;
}

const SHA = 'abcdef1';
const HEX40 = '0123456789abcdef0123456789abcdef01234567';
const DONE = `DONE: #4532 ${SHA} verify exit 0`;
const PANEL = `${' '.repeat(40)}\u001b[38;5;244m│\u001b[39m 3 files edited (show)`;

type Kind = 'DONE' | 'WAIT' | 'STOP' | 'SHAPE_OUTSIDE' | 'none';
/** [name, raw row, the normalized row, the ending it is] */
const ROWS: Array<[string, string, string, Kind]> = [
  ['plain', DONE, DONE, 'DONE'],
  ['indented continuation row', `  ${DONE}`, DONE, 'DONE'],
  ['diff panel after the DONE (P1-B)', `${DONE}${PANEL}`, DONE, 'DONE'],
  ['diff panel, tab and one space before the bar', `${DONE}\t \u001b[2m│\u001b[0m src/a.ts +3 -1`, DONE, 'DONE'],
  ['ANSI around the DONE and the panel', `\u001b[1m${DONE}\u001b[0m${PANEL}`, DONE, 'DONE'],
  ['40-hex sha, not wrapped, with the panel', `DONE: #4532 ${HEX40} verify exit 20${PANEL}`, `DONE: #4532 ${HEX40} verify exit 20`, 'DONE'],
  ['WAIT with the panel: the report has no panel text', `WAIT: 人の判断が要る${PANEL}`, 'WAIT: 人の判断が要る', 'WAIT'],
  ['STOP indented, with the panel', `  STOP: 前提が変わった${PANEL}`, 'STOP: 前提が変わった', 'STOP'],
  ['IMPL_COMPLETED with the panel', `IMPL_COMPLETED head=${SHA}${PANEL}`, `IMPL_COMPLETED head=${SHA}`, 'SHAPE_OUTSIDE'],
  // The reply marker and the one blank after it are stripped (lead r1).
  ['claude marker', `\u001b[38;5;231m\u001b[49m⏺\u001b[39m ${DONE}`, DONE, 'DONE'],
  ['claude marker, non-breaking space', `⏺\u00a0${DONE}`, DONE, 'DONE'],
  ['claude marker on an indented row', `  ⏺ ${DONE}`, DONE, 'DONE'],
  ['codex marker', `\u001b[2m• \u001b[0m${DONE}`, DONE, 'DONE'],
  ['Command Code marker', `\u001b[38;5;147m⠶\u001b[39m ${DONE}`, DONE, 'DONE'],
  ['marker and panel', `⏺ ${DONE}${PANEL}`, DONE, 'DONE'],
  ['codex marker on a WAIT', '• WAIT: 人の判断が要る', 'WAIT: 人の判断が要る', 'WAIT'],
  ['Command Code marker on a STOP', '⠶ STOP: 前提が変わった', 'STOP: 前提が変わった', 'STOP'],
  ['claude marker on IMPL_COMPLETED', '⏺ IMPL_COMPLETED', 'IMPL_COMPLETED', 'SHAPE_OUTSIDE'],
  // claude's marker off macOS (review-4532-opus P2-1; the set is reply-markers.tsv).
  ['claude marker off macOS', `● ${DONE}`, DONE, 'DONE'],
  ['claude marker off macOS on IMPL_COMPLETED', '● IMPL_COMPLETED', 'IMPL_COMPLETED', 'SHAPE_OUTSIDE'],
  // M4 (review P3-3): one blank class, [ \t], for every reader — a CR or a
  // full-width space is not a blank, on either side.
  ['a trailing CR on a DONE', `${DONE}\r`, `${DONE}\r`, 'none'],
  ['a trailing CR on IMPL_COMPLETED', 'IMPL_COMPLETED\r', 'IMPL_COMPLETED\r', 'none'],
  ['a full-width space after IMPL_COMPLETED', 'IMPL_COMPLETED\u3000', 'IMPL_COMPLETED\u3000', 'none'],
  ['a full-width space inside IMPL_COMPLETED head=', `IMPL_COMPLETED\u3000head=${SHA}`, `IMPL_COMPLETED\u3000head=${SHA}`, 'none'],
  ['a full-width space in a DONE', `DONE:\u3000#4532 ${SHA} verify exit 0`, `DONE:\u3000#4532 ${SHA} verify exit 0`, 'none'],
  ['only ONE blank goes with the marker', `⏺  ${DONE}`, ` ${DONE}`, 'none'],
  // N2 — not an ending.
  ['mid-sentence', `最後に ${DONE} と書く`, `最後に ${DONE} と書く`, 'none'],
  ['a prose prefix', `note: ${DONE}`, `note: ${DONE}`, 'none'],
  ['only in the panel column, text on the left', `working on it${PANEL.replace('3 files edited (show)', DONE)}`, 'working on it', 'none'],
  ['only in the panel column, nothing on the left', `${' '.repeat(60)}│ ${DONE}`, `│ ${DONE}`, 'none'],
  ['inside a backtick quote', `  \`${DONE}\``, `\`${DONE}\``, 'none'],
  ['inside a boxed quote', `  │ ${DONE} │`, `│ ${DONE} │`, 'none'],
  ['the user echo', `› ${DONE}`, `› ${DONE}`, 'none'],
  ['the composer (typed, not sent)', `❯ ${DONE}`, `❯ ${DONE}`, 'none'],
  ['a marked reply with DONE: mid-sentence', `⏺ 本文の途中の ${DONE}`, `本文の途中の ${DONE}`, 'none'],
  ['two markers', `⏺⏺ ${DONE}`, `⏺⏺ ${DONE}`, 'none'],
  ['two markers with a blank between (only one goes)', `⏺ • ${DONE}`, `• ${DONE}`, 'none'],
  ['a marker behind a box bar', `│ ⏺ ${DONE}`, `│ ⏺ ${DONE}`, 'none'],
  ['a marker with no blank after it', `•${DONE}`, `•${DONE}`, 'none'],
  ['other glyphs are not markers', `- ${DONE}`, `- ${DONE}`, 'none'],
  ['trailing prose after the DONE', `${DONE} (not the last line)`, `${DONE} (not the last line)`, 'none'],
  ['an indented box row with no left text keeps its text', ' │ Blocked: leading `sleep 25`', '│ Blocked: leading `sleep 25`', 'none'],
];

/** Every marker of reply-markers.tsv × every text ending, as a one-line reply (M3 on the row level). */
const DATA_MARKERS = [
  ...new Set(
    readFileSync(path.join(process.cwd(), '.claude/skills/orchestrate-monitor/scripts/reply-markers.tsv'), 'utf8')
      .split('\n')
      .filter((l) => l !== '' && !l.startsWith('#'))
      .map((l) => l.split('\t')[2]),
  ),
];
const ENDING_ROWS: Array<[string, Kind]> = [
  [DONE, 'DONE'],
  ['WAIT: 人の判断が要る', 'WAIT'],
  ['STOP: 前提が変わった', 'STOP'],
  [`IMPL_COMPLETED head=${SHA}`, 'SHAPE_OUTSIDE'],
];
for (const m of DATA_MARKERS) {
  for (const [row, kind] of ENDING_ROWS) ROWS.push([`data marker ${m}: ${kind}`, `${m} ${row}`, row, kind]);
  ROWS.push([`data marker ${m} doubled`, `${m}${m} ${DONE}`, `${m}${m} ${DONE}`, 'none']);
  ROWS.push([`data marker ${m} behind the composer`, `❯ ${m} ${DONE}`, `❯ ${m} ${DONE}`, 'none']);
}

describe('N1: the bash and JS row normalization are one definition', () => {
  it('normalizes the whole table to the same rows, in one file', () => {
    const bashRows = bash('ml_pane_lines', `${ROWS.map((r) => r[1]).join('\n')}\n`).split('\n').slice(0, ROWS.length);
    expect(bashRows).toEqual(ROWS.map((r) => normalizePaneLine(r[1])));
  });

  it.each(ROWS)('%s: normalized row', (_name, raw, normalized) => {
    expect(normalizePaneLine(raw)).toBe(normalized);
    expect(bash('ml_pane_lines', `${raw}\n`)).toBe(`${normalized}\n`);
  });
});

describe('N1/N2: every reader gives the same ending on the same row', () => {
  it.each(ROWS)('%s: %s', (_name, raw, normalized, kind) => {
    const monitor = bash('ml_return_line_text', `${raw}\n`).trim();
    const js = returnLineOf(raw);
    expect(js.kind).toBe(kind);
    if (kind === 'none') {
      expect(monitor).toBe('none');
    } else {
      expect(js.line).toBe(normalized);
      expect(monitor).toBe(kind === 'SHAPE_OUTSIDE' ? `SHAPE_OUTSIDE ${normalized}` : normalized);
    }
    // DONE_LINE_RE after the normalization, and the completion signal, agree.
    expect(DONE_LINE_RE.test(normalizePaneLine(raw))).toBe(kind === 'DONE');
    expect(hasCompletionSignal(raw)).toBe(kind === 'DONE' || kind === 'SHAPE_OUTSIDE');
  });
});
