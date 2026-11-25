/**
 * Issue #4532 (S10 r2) — invariants M1 and M2: the reply markers are ONE piece
 * of data (`.claude/skills/orchestrate-monitor/scripts/reply-markers.tsv`) and
 * every reader takes them from there and from nowhere else.
 *
 * Review-4532-opus P2-1 was the 4th `[pane-reading-miss]`: claude draws its
 * reply marker as one glyph on macOS and another everywhere else, and only the
 * macOS one was written into the readers. The cause was that the set was spread
 * over bash, JS and the docs; this file pins the single source.
 *
 *   M1  the data has the expected shape, and bash (`ML_REPLY_MARKERS`) and JS
 *       (`readReplyMarkers`) read the same set out of it. A made-up marker put
 *       only in a copy of the data is stripped by both — they read the data.
 *   M2  none of the readers' files carries a marker glyph outside the data,
 *       except the named allowances below.
 *
 * Every file this writes is under os.tmpdir().
 *
 * @vitest-environment node
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';
import {
  REPLY_MARKERS_FILE,
  makePaneLineNormalizer,
  readReplyMarkers,
} from '../../../../scripts/orchestrate/wait-verify.mjs';

const ROOT = process.cwd();
const SCRIPTS = path.join(ROOT, '.claude/skills/orchestrate-monitor/scripts');
const DATA = path.join(SCRIPTS, 'reply-markers.tsv');
const LIB = path.join(SCRIPTS, 'monitor-lib.sh');

/** The data, parsed here independently of both readers. */
function parse(text: string): Array<{ tool: string; platform: string; marker: string; source: string }> {
  return text
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const [tool, platform, marker, source, ...rest] = line.split('\t');
      expect(rest, `extra fields in: ${line}`).toEqual([]);
      return { tool, platform, marker, source };
    });
}
const ROWS = parse(readFileSync(DATA, 'utf8'));
const MARKERS = [...new Set(ROWS.map((r) => r.marker))];

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('M1: the reply markers are one piece of data', () => {
  it('every row is tool / platform / marker / source, and the measured markers are there', () => {
    expect(ROWS.length).toBeGreaterThanOrEqual(4);
    for (const row of ROWS) {
      expect(CLI_TOOL_IDS as readonly string[]).toContain(row.tool);
      expect(['macos', 'other', 'any']).toContain(row.platform);
      expect(row.marker).toMatch(/^\S+$/u);
      expect(row.marker).not.toMatch(/[ -~]/);
      expect(row.source.trim().length).toBeGreaterThan(0);
    }
    const keys = ROWS.map((r) => `${r.tool}/${r.platform}`);
    expect(new Set(keys).size).toBe(keys.length);
    // claude draws a different glyph on macOS and elsewhere (review P2-1).
    expect(keys).toEqual(expect.arrayContaining(['claude/macos', 'claude/other', 'codex/any', 'command-code/any']));
    expect(ROWS.find((r) => r.tool === 'claude' && r.platform === 'macos')?.marker).not.toBe(
      ROWS.find((r) => r.tool === 'claude' && r.platform === 'other')?.marker,
    );
  });

  it('JS reads exactly the rows of the data', () => {
    expect(REPLY_MARKERS_FILE).toBe(DATA);
    expect(readReplyMarkers()).toEqual(ROWS);
  });

  it('bash reads exactly the set of the data', () => {
    const out = spawnSync('bash', ['-c', `. "${LIB}" ; printf '%s' "$ML_REPLY_MARKERS"`], { encoding: 'utf8' });
    expect(out.status, out.stderr).toBe(0);
    expect(out.stderr).toBe('');
    expect(out.stdout.split(' ')).toEqual(MARKERS);
  });

  it('a marker that exists only in a copy of the data is stripped by both readers (they read the data)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'reply-markers-4532-'));
    dirs.push(dir);
    copyFileSync(LIB, path.join(dir, 'monitor-lib.sh'));
    const data = path.join(dir, 'reply-markers.tsv');
    writeFileSync(data, '# a made-up marker\nclaude\tany\t◆\ttest only\n');
    const pane = path.join(dir, 'pane.txt');
    writeFileSync(pane, '◆ DONE: #4532 abcdef1 verify exit 0\n⏺ DONE: #4532 abcdef1 verify exit 0\n');
    const out = spawnSync('bash', ['-c', `. "${dir}/monitor-lib.sh" ; ml_pane_lines "$1"`, 'bash', pane], { encoding: 'utf8' });
    expect(out.status, out.stderr).toBe(0);
    // The made-up one is stripped; the real one is not in this copy, so it stays.
    expect(out.stdout).toBe('DONE: #4532 abcdef1 verify exit 0\n⏺ DONE: #4532 abcdef1 verify exit 0\n');
    const js = makePaneLineNormalizer(readReplyMarkers(data).map((r: { marker: string }) => r.marker));
    expect(js('◆ DONE: #4532 abcdef1 verify exit 0')).toBe('DONE: #4532 abcdef1 verify exit 0');
    expect(js('⏺ DONE: #4532 abcdef1 verify exit 0')).toBe('⏺ DONE: #4532 abcdef1 verify exit 0');
  });

  it('a missing data file is an error on both sides, never an empty set', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'reply-markers-4532-'));
    dirs.push(dir);
    copyFileSync(LIB, path.join(dir, 'monitor-lib.sh'));
    const out = spawnSync('bash', ['-c', `. "${dir}/monitor-lib.sh"`], { encoding: 'utf8' });
    expect(out.stderr).toContain('reply-markers.tsv');
    expect(() => readReplyMarkers(path.join(dir, 'reply-markers.tsv'))).toThrow(/reply-markers\.tsv/);
  });
});

/**
 * M2 — the readers' files. A glyph of the data written here directly is a
 * second copy of the set (the shape of review P2-1). The allowances are lines
 * where the glyph means something else; each must match exactly one line, so a
 * stale allowance fails too.
 */
const READERS = [
  '.claude/skills/orchestrate-monitor/scripts/monitor-lib.sh',
  '.claude/skills/orchestrate-monitor/scripts/monitor.sh',
  '.claude/skills/orchestrate-monitor/scripts/classify-state.sh',
  'scripts/orchestrate/wait-verify.mjs',
  'scripts/orchestrate/launch-worker.mjs',
];
const ALLOWED: Array<{ file: string; line: string; why: string }> = [
  {
    file: '.claude/skills/orchestrate-monitor/scripts/monitor-lib.sh',
    line: "-v RULE='─' -v UPDOWN='↑/↓' -v BULLET='●' -v ELBOW='⎿' -v TRI='▸'",
    why: "agy's tool-row glyph for its busy/dialog anchors (ml__agy_signals, #2606) — not a reply-marker strip",
  },
  {
    file: '.claude/skills/orchestrate-monitor/scripts/monitor-lib.sh',
    line: '# status row `esc to interrupt • 0s • ↓ 0`, the `? for shortcuts` footer, dialogs',
    why: "a comment quoting Command Code's status row, where the glyph is a field separator",
  },
];

describe('M2: no reader carries a marker glyph outside the data', () => {
  it.each(READERS)('%s', (file) => {
    const lines = readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    const allowed = ALLOWED.filter((a) => a.file === file);
    for (const a of allowed) expect(lines.filter((l) => l.includes(a.line)), `stale allowance: ${a.line}`).toHaveLength(1);
    const offending = lines
      .map((text, i) => ({ text, n: i + 1 }))
      .filter(({ text }) => MARKERS.some((m) => text.includes(m)))
      .filter(({ text }) => !allowed.some((a) => text.includes(a.line)))
      .map(({ text, n }) => `${file}:${n}: ${text.trim()}`);
    expect(offending).toEqual([]);
  });
});
