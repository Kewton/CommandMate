/**
 * Issue #1623 — the blank-row squeeze that makes a pane readable.
 *
 * ## Why the fixtures are real captures and not hand-written
 *
 * The bug this filter exists for is invisible to imagined input. `capture-pane -e`
 * emits rows that LOOK empty but carry an SGR sequence (`ESC[49m`), and those rows
 * defeat `grep -v '^$'`, `less -s`, and any filter written from memory. Every
 * fixture here is a byte-for-byte `tmux capture-pane -pe -S -1000 -E -` of a live
 * session on tmux 3.5a:
 *
 * - `capture-claude-busy.txt`  mcbd-claude-*, alternate screen: 1000 rows,
 *   480 truly empty, **7 SGR-only rows** (`ESC[49m` at 177/236/327/440/522/625/732),
 *   composer at 997-1000.
 * - `capture-claude-idle.txt`  the pathological case the Issue is about: 962 of
 *   1000 rows blank, 38 rows of content, nothing readable when attached.
 * - `capture-codex.txt`        mcbd-codex-*, NOT alternate screen (`alternate_on=0`,
 *   `history_size=1926`), so its frame is a scrollback stream rather than a mostly
 *   blank canvas. Present to prove the squeeze does not damage that shape.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { squeezeTranscript, isVisuallyBlank } from '@/lib/tmux/transcript-squeeze';
import { PAGER_SCRIPT, SQUEEZE_AWK_LOCALE, SQUEEZE_AWK_PROGRAM } from '@/lib/tmux/read-mode-pager';
import { normalizeTerminalOutputForDisplay } from '@/lib/terminal/terminal-display-normalizer';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const FIXTURES = ['capture-claude-busy', 'capture-claude-idle', 'capture-codex'] as const;

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, `${name}.txt`), 'utf-8');
}

describe('squeezeTranscript over real tmux captures (Issue #1623)', () => {
  it('collapses the 1000-row canvas of a busy Claude session', () => {
    const raw = readFixture('capture-claude-busy');
    const result = squeezeTranscript(raw);

    // The frame the app captures is exactly the pinned pane height (Issue #1163).
    // split('\n') sees a 1001st empty element from the trailing newline.
    expect(result.rawLines).toBe(1001);
    expect(result.lines).toBeLessThan(result.rawLines);

    // Every line with printable content survives, in order, unaltered.
    const contentOf = (text: string): string[] =>
      text.split('\n').filter((line) => !isVisuallyBlank(line));
    expect(contentOf(result.text)).toEqual(contentOf(raw));
  });

  it('reduces an idle session from 1000 rows to a screenful', () => {
    const result = squeezeTranscript(readFixture('capture-claude-idle'));
    // 962 of 1000 rows are blank; unsqueezed, `less +G` lands hundreds of rows
    // below the last readable line.
    expect(result.lines).toBeLessThan(60);
    expect(result.text).not.toMatch(/\n\s*\n\s*\n\s*\n/);
  });

  it('lands on the composer, not on padding, for the busy session', () => {
    const result = squeezeTranscript(readFixture('capture-claude-busy'));
    const lastFive = result.text.split('\n').slice(-5).join('\n');
    // What `less +G` shows first: the composer prompt and Claude's status row.
    expect(lastFive).toContain('❯');
    expect(lastFive).toContain('esc to interrupt');
  });

  it('classifies the real SGR-only rows as blank, which `line === \"\"` does not', () => {
    const raw = readFixture('capture-claude-busy');
    const sgrOnly = raw.split('\n').filter((line) => line !== '' && isVisuallyBlank(line));

    // Fixture guard: if a re-capture ever loses these rows, the suite would keep
    // passing while testing nothing of interest. Built with fromCharCode so a
    // raw ESC byte never lands in this source file, where it would be invisible.
    const ESC = String.fromCharCode(27);
    expect(sgrOnly).toHaveLength(7);
    expect(new Set(sgrOnly)).toEqual(new Set([`${ESC}[49m`]));

    // The difference is one of CLASSIFICATION, not of this frame's line count.
    // On this capture all 7 sit as isolated single blanks between content rows,
    // which rule 3 keeps verbatim either way. (Measured. The Issue's "1000 rows
    // -> 129" figure came from a different session; this canvas squeezes to 745
    // because it holds 513 rows of real transcript.)
    expect(sgrOnly.every((line) => line !== '')).toBe(true);
    expect(sgrOnly.every(isVisuallyBlank)).toBe(true);
  });

  it('merges blank runs ACROSS a real SGR-only row instead of splitting on it', () => {
    // Where the classification pays off: the same row inside a longer run. A
    // filter judging blankness by `line === \"\"` sees two runs of 2, keeps both
    // verbatim and leaves 5 rows standing. Treating it as blank makes one run of
    // 5 that collapses to a single row carrying the sequence forward.
    const realSgrRow = readFixture('capture-claude-busy')
      .split('\n')
      .find((line) => line !== '' && isVisuallyBlank(line));
    expect(realSgrRow).toBe(`${String.fromCharCode(27)}[49m`);

    expect(squeezeTranscript(`a\n\n\n${realSgrRow}\n\n\nb`).text).toBe(`a\n${realSgrRow}\nb`);
  });

  it('leaves a non-alternate-screen (codex) frame essentially intact', () => {
    const raw = readFixture('capture-codex');
    const result = squeezeTranscript(raw);

    // Codex keeps real scrollback, so there is almost nothing to squeeze. The
    // point is that the filter is a near no-op here rather than destructive.
    expect(result.lines).toBeGreaterThan(result.rawLines - 10);
    const contentOf = (text: string): string[] =>
      text.split('\n').filter((line) => !isVisuallyBlank(line));
    expect(contentOf(result.text)).toEqual(contentOf(raw));
  });
});

describe('squeezeTranscript rules', () => {
  it('keeps internal blank runs of 1-2 rows verbatim', () => {
    expect(squeezeTranscript('a\n\nb').text).toBe('a\n\nb');
    expect(squeezeTranscript('a\n\n\nb').text).toBe('a\n\n\nb');
  });

  it('collapses internal runs of 3+ rows to one', () => {
    expect(squeezeTranscript('a\n\n\n\nb').text).toBe('a\n\nb');
    expect(squeezeTranscript('a\n\n\n\n\n\n\n\nb').text).toBe('a\n\nb');
  });

  it('preserves ANSI state that spanned a collapsed run', () => {
    const result = squeezeTranscript('a\n\u001b[49m\n\u001b[31m\n\nb');
    expect(result.text).toBe('a\n\u001b[49m\u001b[31m\nb');
  });

  it('drops leading and trailing blank runs entirely', () => {
    expect(squeezeTranscript('\n\n\na\n\n\n').text).toBe('a');
  });

  it('never alters a non-blank line', () => {
    const line = '  \u001b[31mkept  spacing\u001b[39m   ';
    expect(squeezeTranscript(`${line}`).text).toBe(line);
  });

  it('survives degenerate input', () => {
    expect(squeezeTranscript('').text).toBe('');
    expect(squeezeTranscript('\n\n\n\n\n').text).toBe('');
    expect(squeezeTranscript('\u001b[49m\n\u001b[49m').text).toBe('');
    expect(squeezeTranscript('only line').text).toBe('only line');
  });
});

describe('--tail semantics (Issue #1623 decision D5)', () => {
  it('counts lines of the SQUEEZED result, not of the raw frame', () => {
    const raw = readFixture('capture-claude-idle');
    const tailed = squeezeTranscript(raw, { tail: 10 });

    expect(tailed.lines).toBe(10);
    expect(tailed.tailed).toBe(true);
    // Tailing the RAW frame would return 10 rows of blank padding; tailing the
    // squeezed one returns 10 rows a human can read.
    expect(tailed.text.split('\n').some((line) => !isVisuallyBlank(line))).toBe(true);
    expect(tailed.text).toBe(squeezeTranscript(raw).text.split('\n').slice(-10).join('\n'));
  });

  it('is a no-op when the transcript is shorter than the tail', () => {
    const result = squeezeTranscript('a\nb', { tail: 100 });
    expect(result.text).toBe('a\nb');
    expect(result.tailed).toBe(false);
  });
});

/**
 * Every awk on this machine, so a portability bug cannot hide behind whichever
 * one happens to be `/usr/bin/awk` here.
 *
 * macOS ships BWK awk; Linux distributions ship mawk, and installing gawk
 * silently promotes it to `awk` because Debian ranks the gawk alternative above
 * mawk. Testing only `awk` is how a gawk-specific defect shipped green from a
 * Mac and red on `ubuntu-latest`.
 */
function availableAwks(): Array<{ name: string; argv: string[] }> {
  const candidates: Array<{ name: string; argv: string[] }> = [
    { name: 'awk', argv: ['awk'] },
    { name: 'mawk', argv: ['mawk'] },
    { name: 'gawk', argv: ['gawk'] },
    { name: 'original-awk', argv: ['original-awk'] },
    { name: 'nawk', argv: ['nawk'] },
    { name: 'busybox awk', argv: ['busybox', 'awk'] },
    { name: 'goawk', argv: ['goawk'] },
  ];
  return candidates.filter(({ argv }) => {
    try {
      execFileSync(argv[0], [...argv.slice(1), 'BEGIN { exit 0 }'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  });
}

/** Run the shipped awk program exactly the way the shipped script runs it. */
function runAwk(argv: string[], input: string): string {
  return execFileSync(argv[0], [...argv.slice(1), SQUEEZE_AWK_PROGRAM], {
    input,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
    // The locale is part of the contract, not of the ambient environment.
    env: { ...process.env, LC_ALL: SQUEEZE_AWK_LOCALE, LANG: SQUEEZE_AWK_LOCALE },
  }).replace(/\n$/, '');
}

const AWKS = availableAwks();

/** Built by code point, never typed literally — see EDGE_CASES. */
const ESC = String.fromCharCode(27);
const NBSP = String.fromCharCode(160);

/**
 * Inputs that separate a correct squeeze from a plausible one.
 *
 * ESC and NBSP are assembled from code points rather than typed. The regression
 * that made this list necessary was invisible for exactly that reason: the NBSP
 * case had been written with a raw U+00A0 that renders as a space in a diff, in
 * a terminal, and in vitest's own failure output — which reported
 * `'a\n \n \n \nb'` and sent everyone hunting for a bug in the trim regex's
 * whitespace class instead of in the NBSP fold.
 */
const EDGE_CASES: Array<[string, string]> = [
  ['collapse a long blank run', 'a\n\n\n\nb'],
  ['ANSI carried across a run', `a\n${ESC}[49m\n${ESC}[31m\n\nb`],
  ['leading and trailing runs', '\n\n\na\n\n\n'],
  ['isolated SGR-only row', `a\n${ESC}[49m\nb`],
  ['content with inner spacing', `  ${ESC}[31mkept  spacing${ESC}[39m   `],
  ['ASCII-space-only rows', 'a\n \n \n \nb'],
  ['NBSP-only rows (U+00A0)', `a\n${NBSP}\n${NBSP}\n${NBSP}\nb`],
  ['tab-only rows', 'a\n\t\n\t\n\t\nb'],
  ['NBSP next to real content', `x${NBSP}not blank`],
  ['mixed NBSP and empty run', `a\n${NBSP}\n\n${NBSP}\nb`],
];

describe('conformance: the three implementations must not drift', () => {
  it('matches the Web UI normalizer (Issue #1172) byte-for-byte', () => {
    // Same problem, same rules. This module is a separate entry point only
    // because the CLI's tsconfig cannot resolve the normalizer's `@/` import.
    for (const name of FIXTURES) {
      const raw = readFixture(name);
      expect(squeezeTranscript(raw).text, name).toBe(normalizeTerminalOutputForDisplay(raw));
    }
  });

  it('found at least one awk to test against', () => {
    // Without this, a machine with no awk at all would report a green
    // conformance suite that had compared nothing.
    expect(AWKS.length).toBeGreaterThan(0);
  });

  it.each(AWKS.map((a) => a.name))('%s matches on the real captures, byte-for-byte', (name) => {
    const { argv } = AWKS.find((a) => a.name === name)!;
    for (const fixture of FIXTURES) {
      const raw = readFixture(fixture);
      expect(runAwk(argv, raw), `${name} / ${fixture}`).toBe(squeezeTranscript(raw).text);
    }
  });

  it.each(AWKS.map((a) => a.name))('%s matches on the blankness edge cases', (name) => {
    const { argv } = AWKS.find((a) => a.name === name)!;
    for (const [label, input] of EDGE_CASES) {
      expect(runAwk(argv, input), `${name} / ${label}`).toBe(squeezeTranscript(input).text);
    }
  });

  it('pins the locale on the awk the popup runs', () => {
    // The program builds NBSP out of the bytes C2 A0 via sprintf("%c"). gawk in
    // a UTF-8 locale reads those as CHARACTER codes, producing U+00C2 (C3 82)
    // and a matcher that can never fire — so NBSP-only rows stop being blank and
    // the frame comes back unsqueezed. A byte locale is what makes every awk
    // agree.
    //
    // Static on purpose: it fails on a mawk-only machine too, where the
    // divergence itself cannot be reproduced and the matrix above proves nothing.
    const highCodePoints = [...SQUEEZE_AWK_PROGRAM.matchAll(/sprintf\("(?:%c)+"((?:,\s*\d+)+)\)/g)]
      .flatMap((m) => m[1].split(',').map((n) => Number(n.trim())))
      .filter((code) => code > 127);
    expect(highCodePoints.length).toBeGreaterThan(0);

    expect(SQUEEZE_AWK_LOCALE).toBe('C');
    expect(PAGER_SCRIPT).toContain(`LC_ALL=${SQUEEZE_AWK_LOCALE} awk '`);
  });
});
