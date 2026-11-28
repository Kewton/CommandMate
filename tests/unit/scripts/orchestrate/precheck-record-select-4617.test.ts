/**
 * Every reader of the precheck record picks the same one line (Issue #4614, #4617): the latest
 * precheck that precheck.mjs wrote itself (any result; a line added by hand never counts) on the
 * HEAD of its role.
 *
 *   - the gate's roles read the published HEAD (P): R1 precheck.mjs's reuse, R2 merge-pr's env check,
 *     R4 merge-pr's CI wait, R6 pr-common.mjs missingRecords;
 *   - the options' roles read the work HEAD (W), else P — never another HEAD: R3 merge-pr's re-run,
 *     R5 the train's C4 / C5.
 *
 * (a) A table: the run records are 1 or 2 precheck lines (writer × result × HEAD, in both orders),
 *     each with its opts= (the usual, none, allow-removed) and with or without env=, with or without
 *     lines of another Issue / work item on P, W and X around them, on a P = W and a P ≠ W tree.
 *     The expected line is found here on its own (from the end, the first tool line on the role's
 *     HEAD), never by calling the scripts' rule, and each role is judged by what its caller does
 *     (R3's rows judge R2 first). Named rows: Y1-Y9 of the plan, M1 (the PR's HEAD is a merge made by
 *     hand and merge-pr refreshes it), R4 (the CI wait).
 * (b) The list of the readers: each call of the selector in scripts/orchestrate/*.mjs (by name, alias,
 *     namespace or optional call) carries its mark `precheck-reader: R<n>` and is one of R1-R6.
 * (c) A static guard: outside run-log.mjs nothing picks a precheck by findLatest, nor imports or
 *     calls toolPrecheck / gatePrecheck.
 * (d) #4617 acceptance 3: after merge-pr's precheck, the verify is judged again by the tool line.
 *
 * `git` and `gh` are fakes (./pr-fake.ts, and precheck's own below): nothing is pushed or merged.
 * The run record, the worktree and HOME are under os.tmpdir() and removed after each test.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendRecord, main as runLogMain, readRecords } from '../../../../scripts/orchestrate/run-log.mjs';
import { LAST_REQUIRED_CHECKS, main as mergeMain } from '../../../../scripts/orchestrate/merge-pr.mjs';
import { missingRecords } from '../../../../scripts/orchestrate/pr-common.mjs';
import { main as precheckMain } from '../../../../scripts/orchestrate/precheck.mjs';
import { classifyEntries, parseArgs as parseTrainArgs } from '../../../../scripts/orchestrate/merge-train.mjs';
import { manifestHash, takeManifest } from '../../../../scripts/orchestrate/env-manifest.mjs';
import { DEVELOP, HEAD_A, HEAD_B, HEAD_M, MERGE_TREE, type Check, fakeGit, openPr } from './pr-fake';

const ISSUE = 3477;
const OTHER_ISSUE = 3478;
const OTHER_ITEM = 'd1';
const REPO = path.resolve(__dirname, '../../../..');
const GREEN: Check[] = [{ name: 'Lint', bucket: 'pass' }, { name: 'Build', bucket: 'pass' }, { name: 'Unit Tests', bucket: 'pass' }];
const short = (sha: string) => sha.slice(0, 7);

let tmp: string;
let runDir: string;
let worktree: string;
let home: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-precheck-select-4617-')));
  runDir = path.join(tmp, 'runs', '2026-11-28');
  worktree = path.join(tmp, 'wt');
  home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.join(worktree, 'dev-reports', 'module-reference'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'dev-reports', 'module-reference', `issue-${ISSUE}.md`), '追記なし\n');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- the trees

type Shape = 'P=W' | 'P≠W' | 'M1';
type HeadName = 'P' | 'W' | 'X';
/**
 * P = W: the worker's commit is published. P ≠ W: a clean merge of develop (HEAD_M) on the work HEAD
 * (HEAD_A). M1: the PR's HEAD is a clean merge of develop made by hand (HEAD_B) on the work HEAD; a
 * refresh by merge-pr then makes HEAD_M on it (the fake's `git merge`).
 */
const HEADS: Record<Shape, Record<HeadName, string>> = {
  'P=W': { P: HEAD_A, W: HEAD_A, X: HEAD_B },
  'P≠W': { P: HEAD_M, W: HEAD_A, X: HEAD_B },
  M1: { P: HEAD_B, W: HEAD_A, X: HEAD_M },
};
const FIRST_PARENT: Record<Shape, string[]> = {
  'P=W': [`${HEAD_A} ${DEVELOP}`],
  'P≠W': [`${HEAD_M} ${HEAD_A} ${DEVELOP}`, `${HEAD_A} ${DEVELOP}`],
  M1: [`${HEAD_B} ${HEAD_A} ${DEVELOP}`, `${HEAD_A} ${DEVELOP}`],
};
/** The fake of pr-fake.ts on the tree of `shape`: the merges changed nothing themselves (pr-common.mjs workHeads passes them over). */
const treeOf = (shape: Shape, extra: Parameters<typeof fakeGit>[0] = {}) =>
  fakeGit({
    head: HEADS[shape].P,
    firstParent: FIRST_PARENT[shape],
    commitFiles: { [HEAD_A]: ['scripts/orchestrate/merge-pr.mjs', 'changelog.d/3477.md'], [HEAD_M]: [], [HEAD_B]: [] },
    prs: [openPr({ headRefOid: HEADS[shape].P })],
    ...extra,
  });

/** The worker's checks, on the work HEAD. */
function recordWork(shape: Shape, verifyNote = 'exit=0(passed) passed=lint,typecheck failed=-', key?: string) {
  const w = HEADS[shape].W;
  appendRecord(runDir, String(ISSUE), { issue: ISSUE, stage: 'verify', result: 'ok', head: w, key, note: verifyNote });
  appendRecord(runDir, String(ISSUE), { issue: ISSUE, stage: 'review', result: 'ok', head: w });
  appendRecord(runDir, String(ISSUE), { issue: ISSUE, stage: 'findings', result: 'ok', head: w });
}

// ---------------------------------------------------------------- the lines

type Writer = 'tool' | 'hand';
/** The `opts=` of a line: the usual one, none at all, or one that allows removed tests. */
type Form = 'std' | 'none' | 'allow';
interface Line {
  n: number;
  writer: Writer;
  result: 'ok' | 'fail';
  head: HeadName;
  /** Its `opts=` (std when absent). */
  form?: Form;
  /** Whether it has an env= (whose manifest is not kept: `missing`). */
  env?: boolean;
  /** A line of another Issue or another work item: none of this PR's readers reads it (I5). */
  noise?: 'issue' | 'item';
}
type Role = 'R1' | 'R3' | 'R5' | 'R6';
const at = (n: number) => new Date(Date.UTC(2026, 10, 28, 1, n));
const envOf = (n: number) => n.toString(16).padStart(12, '0');
const opts = (kind: string, allowRemoved = false) => `opts=base:origin/develop,kind:${kind},metrics:false,allow-removed:${allowRemoved},build:false`;
/** The opts= of `line`, named by its kind L<n> so the options a caller passes on say which line it read. */
const optsOf = (line: Line) => (line.form === 'none' ? '' : opts(`L${line.n}`, line.form === 'allow'));
const envWord = (line: Line) => (line.env ? `env=${envOf(line.n)}` : '');
const words = (...parts: string[]) => parts.filter(Boolean).join(' ');

/** Write `line` as its writer does: precheck.mjs by appendRecord, a leader by the run-log.mjs command line. */
function writeLine(shape: Shape, line: Line, note: string) {
  const sha = HEADS[shape][line.head];
  const workHead = HEADS[shape].P !== HEADS[shape].W && line.head === 'P' ? HEADS[shape].W : undefined;
  const issue = line.noise === 'issue' ? OTHER_ISSUE : ISSUE;
  const item = line.noise === 'item' ? OTHER_ITEM : undefined;
  if (line.writer === 'tool') {
    appendRecord(runDir, String(ISSUE), { issue, item, stage: 'precheck', result: line.result, head: sha, workHead, key: `k-${line.n}`, note }, at(line.n));
    return;
  }
  const code = runLogMain(
    [
      'append', '--run-dir', runDir, '--issues', String(ISSUE), '--issue', String(issue), '--stage', 'precheck', '--result', line.result,
      '--head', sha, ...(workHead ? ['--work-head', workHead] : []), ...(item ? ['--item', item] : []), '--key', `k-${line.n}`, '--note', note,
    ],
    at(line.n)
  );
  expect(code).toBe(0);
}

/**
 * The line a role must read, found without the scripts: from the end, the first line precheck.mjs
 * wrote for this Issue's own records on the role's HEAD — P for the gate's roles, W then P for the
 * options' roles. Any result, any opts= and env=; a hand line (ok or fail) is never one.
 */
function expectedLine(lines: Line[], role: Role | 'R2', shape: Shape): Line | null {
  const targets = role === 'R3' || role === 'R5' ? ['W', 'P'] : ['P'];
  for (const target of targets) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.noise || line.writer !== 'tool') continue;
      if (HEADS[shape][line.head] === HEADS[shape][target as HeadName]) return line;
    }
  }
  return null;
}

// ---------------------------------------------------------------- the callers

/** precheck.mjs's fake git on `shape`, and the checks it ran. */
function precheckDeps(shape: Shape, out: string[], checks: string[]) {
  return {
    run: (command: string, args: string[]) => {
      if (command === 'git') {
        const sub = args.slice(2);
        if (sub[0] === 'rev-parse') return { status: 0, stdout: `${HEADS[shape].P}\n`, stderr: '' };
        if (sub[0] === 'log') return { status: 0, stdout: `${FIRST_PARENT[shape].join('\n')}\n`, stderr: '' };
        if (sub[0] === 'merge-tree') return { status: 0, stdout: `${MERGE_TREE}\n`, stderr: '' };
        if (sub[0] === 'diff-tree') return { status: 0, stdout: sub.includes(MERGE_TREE) ? '' : 'src/a.ts\n', stderr: '' };
        if (sub.includes('--diff-filter=ACMR')) return { status: 0, stdout: 'src/a.ts\n', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      }
      checks.push(args[0]);
      return { status: 0, stdout: '', stderr: '' };
    },
    findTestsNaming: () => [],
    now: () => new Date(Date.UTC(2026, 10, 28, 3, 0)),
    home,
    log: (l: string) => out.push(l),
    error: (l: string) => out.push(l),
  };
}

function runPrecheck(shape: Shape, dir = runDir, force = false) {
  const out: string[] = [];
  const checks: string[] = [];
  const code = precheckMain(
    ['--run-dir', dir, '--issues', String(ISSUE), '--issue', String(ISSUE), '--worktree', worktree, ...(force ? ['--force'] : [])],
    precheckDeps(shape, out, checks)
  );
  return { code, out: out.join('\n'), checks };
}

const FULL_NOTES = new Map<Shape, string>();
/** The note precheck.mjs writes on `shape` when every step passed, without its own key= / env= (a record from before env=). */
function fullNote(shape: Shape): string {
  const known = FULL_NOTES.get(shape);
  if (known) return known;
  const scratch = path.join(tmp, 'scratch-run');
  expect(runPrecheck(shape, scratch, true).code).toBe(0);
  const record = readRecords(scratch, String(ISSUE)).records.find((r: { stage: string }) => r.stage === 'precheck');
  fs.rmSync(scratch, { recursive: true, force: true });
  const note = String(record.note).replace(/ key=\S+/, '').replace(/ env=\S+/, '');
  expect(note).toContain(` ${opts('-')}`);
  FULL_NOTES.set(shape, note);
  return note;
}

function runMerge(fake: ReturnType<typeof fakeGit>, runPrecheckStub?: (args: string[]) => number, extra: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const prechecks: string[][] = [];
  let clock = Date.UTC(2026, 10, 28, 3, 0);
  const code = mergeMain(['--run-dir', runDir, '--issues', String(ISSUE), '--issue', String(ISSUE), '--worktree', worktree, ...extra], {
    run: fake.run,
    sleep: (ms: number) => {
      clock += ms;
    },
    now: () => new Date(clock),
    findTestsNaming: () => [],
    log: (l: string) => out.push(l),
    error: (l: string) => err.push(l),
    home,
    runPrecheck: (args: string[]) => {
      prechecks.push(args);
      return runPrecheckStub ? runPrecheckStub(args) : 0;
    },
  } as Parameters<typeof mergeMain>[1]);
  return { code, out: out.join('\n'), err: err.join('\n'), prechecks };
}

function classify(shape: Shape) {
  const p = HEADS[shape].P;
  appendRecord(runDir, String(ISSUE), { issue: ISSUE, stage: 'pr', result: 'ok', head: p, note: 'pr=#4242 opened' });
  const parsed = parseTrainArgs(['--run-dir', runDir, '--issues', String(ISSUE), '--queue', String(ISSUE)]);
  if (!('options' in parsed)) throw new Error(parsed.error);
  const fake = treeOf(shape, { checks: [LAST_REQUIRED_CHECKS.map((name: string) => ({ name, bucket: 'pass' }))] });
  const run = (command: string, args: string[], o?: { cwd?: string; env?: Record<string, string> }) => {
    if (command === 'git' && args.includes('worktree') && args.includes('list')) {
      return { status: 0, stdout: `worktree ${worktree}\nHEAD ${p}\nbranch refs/heads/${openPr().headRefName}\n\n`, stderr: '' };
    }
    return fake.run(command, args, o);
  };
  return classifyEntries(parsed.options, { run, repoDir: worktree, home, mergeLockRoot: path.join(tmp, 'locks') });
}

/** Run `role`'s caller on `lines` and check it acted on the line expectedLine names. */
function judge(role: Role, shape: Shape, lines: Line[]) {
  const expected = expectedLine(lines, role, shape);
  const p = HEADS[shape].P;
  const prefix = (line: Line) => (line.writer === 'hand' ? 'leader note' : `tsc=${line.result}`);
  if (role === 'R1') {
    // Each line is precheck.mjs's full note, with its own opts= and env= (the run's are the std ones, no env= kept).
    const note = fullNote(shape);
    for (const line of lines) {
      const own = note.replace(` ${opts('-')}`, line.form === 'none' ? '' : ` ${opts('-', line.form === 'allow')}`);
      writeLine(shape, line, words(own, envWord(line)));
    }
    const r = runPrecheck(shape);
    if (expected && expected.result === 'ok' && (expected.form ?? 'std') === 'std' && !expected.env) {
      // Reused: the line it names by its time is the expected one.
      expect(r.out).toContain(`reused: ok at ${short(p)} (${at(expected.n).toISOString()})`);
      expect(r.checks).toEqual([]);
    } else {
      expect(r.out).not.toContain('reused');
      expect(r.checks.length).toBeGreaterThan(0);
    }
    return;
  }
  if (role === 'R3') {
    // R2 first: the gate is met by an ok line without env= (used as before, with a warning); then R3 is not read.
    recordWork(shape);
    for (const line of lines) writeLine(shape, line, words(prefix(line), envWord(line), optsOf(line)));
    const gate = expectedLine(lines, 'R2', shape);
    const fake = treeOf(shape, { checks: [GREEN] });
    const r = runMerge(fake);
    if (gate && gate.result === 'ok' && !gate.env) {
      expect(r.out).toContain(`precheck at ${short(p)}: no env= in the record`);
      expect(r.prechecks).toHaveLength(0);
      expect(r.code, r.err).toBe(0);
    } else if (!expected) {
      expect(r.prechecks).toHaveLength(0);
      expect(r.code).toBe(1);
      expect(r.err).toContain('no precheck=ok record to take the options from');
      expect(fake.ghCalls('pr merge')).toHaveLength(0);
    } else {
      expect(r.prechecks, r.err).toHaveLength(1);
      const args = r.prechecks[0];
      if (expected.form === 'none') expect(args).not.toContain('--kind');
      else expect(args).toEqual(expect.arrayContaining(['--kind', `L${expected.n}`]));
      expect(args.includes('--allow-removed-tests')).toBe(expected.form === 'allow');
      expect(r.code, r.err).toBe(0);
    }
    return;
  }
  if (role === 'R5') {
    recordWork(shape);
    for (const line of lines) writeLine(shape, line, words(prefix(line), envWord(line), optsOf(line)));
    const { candidates, dropped } = classify(shape);
    const drop = (reason: string) => expect(dropped).toEqual([{ entry: String(ISSUE), pr: 4242, reason }]);
    if (!expected || expected.form === 'none') drop('precheck-options-unknown');
    else if (expected.form === 'allow') drop('removed-tests-allowed');
    else {
      expect(dropped).toEqual([]);
      expect(candidates).toEqual([expect.objectContaining({ issue: ISSUE, pr: 4242, kind: `L${expected.n}` })]);
    }
    return;
  }
  // R6: a passed line with env= is "environment missing — env=<its own>"; one without passes, as before.
  recordWork(shape);
  for (const line of lines) writeLine(shape, line, words(prefix(line), envWord(line), optsOf(line)));
  const records = readRecords(runDir, String(ISSUE)).records;
  const reasons = missingRecords(records, ISSUE, { head: p, workHead: HEADS[shape].W }, null, { runDir, worktree, home, warn: () => {} })
    .filter((reason) => String(reason).startsWith('precheck:'));
  if (!expected) expect(reasons).toEqual([`precheck: no result for ${short(p)} (6-1-1)`]);
  else if (expected.result === 'fail') expect(reasons).toEqual([`precheck: fail at ${short(p)} (6-1-1)`]);
  else if (expected.env) expect(reasons).toEqual([expect.stringMatching(new RegExp(`^precheck: environment missing — env=${envOf(expected.n)}:`))]);
  else expect(reasons).toEqual([]);
}

// ---------------------------------------------------------------- (a) the table

type Kind = Pick<Line, 'writer' | 'result'>;
const KINDS: Kind[] = [
  { writer: 'tool', result: 'ok' },
  { writer: 'tool', result: 'fail' },
  { writer: 'hand', result: 'ok' },
  { writer: 'hand', result: 'fail' },
];
const FORMS: Form[] = ['std', 'none', 'allow'];
const HEAD_NAMES: Record<'P=W' | 'P≠W', HeadName[]> = { 'P=W': ['P', 'X'], 'P≠W': ['P', 'W', 'X'] };
const describeLine = (l: Line) =>
  `${l.writer}-${l.result}@${l.head}${l.form === 'std' ? '' : `[${l.form === 'none' ? 'no-opts' : 'allow-removed'}]`}${l.env ? '[env]' : ''}${l.noise ? `(${l.noise})` : ''}`;

interface Row {
  name: string;
  shape: Shape;
  lines: Line[];
}
/**
 * The sequences of 1-2 lines (writer × result × HEAD), each in three variants: the opts= of the lines
 * cycle through FORMS from a different start (so a line without opts= follows one with it, and the
 * other way round), env= on every line / on none / on every other one, and in the last variant with
 * other Issues' and work items' lines on P, W and X before, between and after them (I5).
 */
function rows(): Row[] {
  const out: Row[] = [];
  const variants: { noisy: boolean; start: number; env: (n: number) => boolean }[] = [
    { noisy: false, start: 0, env: () => true },
    { noisy: false, start: 2, env: () => false },
    { noisy: true, start: 1, env: (n) => n % 2 === 0 },
  ];
  for (const shape of ['P=W', 'P≠W'] as const) {
    const atoms = KINDS.flatMap((kind) => HEAD_NAMES[shape].map((head) => ({ ...kind, head })));
    const sequences: Omit<Line, 'n'>[][] = [...atoms.map((a) => [a]), ...atoms.flatMap((a) => atoms.map((b) => [a, b]))];
    for (const sequence of sequences) {
      for (const variant of variants) {
        const plan: Omit<Line, 'n'>[] = variant.noisy
          ? [
              { writer: 'tool', result: 'ok', head: 'P', noise: 'issue' },
              ...sequence.flatMap((s, i) => (i === 0 ? [s] : [{ writer: 'tool', result: 'ok', head: 'W', noise: 'item' } as Omit<Line, 'n'>, s])),
              { writer: 'tool', result: 'fail', head: 'X', noise: 'item' },
              { writer: 'tool', result: 'ok', head: 'W', noise: 'issue' },
            ]
          : sequence;
        const lines: Line[] = plan.map((l, i) => ({ ...l, n: i + 1, form: FORMS[(i + variant.start) % 3], env: variant.env(i + 1) }));
        out.push({ name: `${shape} ${lines.map(describeLine).join(' → ')}`, shape, lines });
      }
    }
  }
  return out;
}
const TABLE = rows();

describe('(a) each role reads the latest tool precheck on its HEAD (#4614, #4617)', () => {
  for (const role of ['R1', 'R3', 'R5', 'R6'] as Role[]) {
    it.each(TABLE.map((row) => [row.name, row] as const))(`${role}: %s`, (_name, row) => {
      judge(role, row.shape, row.lines);
    });
  }
});

// ---------------------------------------------------------------- the named rows

describe('the rows of the plan (Y1, Y2, Y2b, Y8, Y9) and the positive control (I3)', () => {
  it('Y1 (#4614): only a hand line on P (every step ok, the same options) — the precheck runs, not reused', () => {
    const note = fullNote('P=W');
    writeLine('P=W', { n: 1, writer: 'hand', result: 'ok', head: 'P' }, note);
    const r = runPrecheck('P=W');
    expect(r.out).not.toContain('reused');
    expect(r.checks.length).toBeGreaterThan(0);
    expect(r.code).toBe(0);
  });

  it('I3: the tool line alone with the same steps, options and work HEAD is reused, exit 0 (P = W and P ≠ W)', () => {
    for (const shape of ['P=W', 'P≠W'] as Shape[]) {
      fs.rmSync(runDir, { recursive: true, force: true });
      fs.mkdirSync(runDir, { recursive: true });
      writeLine(shape, { n: 1, writer: 'tool', result: 'ok', head: 'P' }, fullNote(shape));
      const r = runPrecheck(shape);
      expect(r.out).toContain(`reused: ok at ${short(HEADS[shape].P)} (${at(1).toISOString()})`);
      expect(r.checks).toEqual([]);
      expect(r.code).toBe(0);
    }
  });

  it('Y2 (#4617): on P = W a tool ok (kind:-) then a tool fail (kind:refactor, allow-removed, env=) — env and options are both the fail line\'s', () => {
    recordWork('P=W');
    writeLine('P=W', { n: 1, writer: 'tool', result: 'ok', head: 'P' }, `tsc=ok ${opts('-')}`);
    writeLine('P=W', { n: 2, writer: 'tool', result: 'fail', head: 'P' }, `tsc=fail env=${envOf(2)} ${opts('refactor', true)}`);
    const r = runMerge(treeOf('P=W', { checks: [GREEN] }));
    expect(r.prechecks).toHaveLength(1);
    expect(r.prechecks[0]).toEqual(expect.arrayContaining(['--kind', 'refactor', '--allow-removed-tests']));
    expect(r.code, r.err).toBe(0);
  });

  it('Y2b gate (P ≠ W): P\'s latest tool line passes in the env it names, though a W line came after — no precheck again', () => {
    recordWork('P≠W');
    writeLine('P≠W', { n: 1, writer: 'tool', result: 'fail', head: 'P' }, `tsc=fail env=${envOf(1)} ${opts('L1')}`);
    writeLine('P≠W', { n: 2, writer: 'tool', result: 'ok', head: 'P' }, `tsc=ok ${opts('L2')}`);
    writeLine('P≠W', { n: 3, writer: 'tool', result: 'ok', head: 'W' }, `tsc=ok env=${envOf(3)} ${opts('L3')}`);
    const r = runMerge(treeOf('P≠W', { checks: [GREEN] }));
    // R2 reads L2 (no env=: used as before, with the warning), not the later W line.
    expect(r.out).toContain(`precheck at ${short(HEAD_M)}: no env= in the record`);
    expect(r.prechecks).toHaveLength(0);
    expect(r.code, r.err).toBe(0);
    // R6 judges the same L2.
    const records = readRecords(runDir, String(ISSUE)).records;
    expect(missingRecords(records, ISSUE, { head: HEAD_M, workHead: HEAD_A }, null)).toEqual([]);
  });

  it('Y2b options (P ≠ W): W has a tool ok, P two tool lines — merge-pr and the train take W\'s options', () => {
    recordWork('P≠W');
    writeLine('P≠W', { n: 1, writer: 'tool', result: 'ok', head: 'W' }, `tsc=ok env=${envOf(1)} ${opts('LW')}`);
    writeLine('P≠W', { n: 2, writer: 'tool', result: 'ok', head: 'P' }, `tsc=ok env=${envOf(2)} ${opts('LP1')}`);
    writeLine('P≠W', { n: 3, writer: 'tool', result: 'fail', head: 'P' }, `tsc=fail env=${envOf(3)} ${opts('LP2')}`);
    const r = runMerge(treeOf('P≠W', { checks: [GREEN] }));
    expect(r.prechecks).toHaveLength(1);
    expect(r.prechecks[0]).toEqual(expect.arrayContaining(['--kind', 'LW']));
    expect(r.code, r.err).toBe(0);
    const { candidates } = classify('P≠W');
    expect(candidates).toEqual([expect.objectContaining({ kind: 'LW' })]);
  });

  it('Y8: only a hand line on P and a tool ok on another HEAD X — merge-pr stops before the precheck (no options of X)', () => {
    recordWork('P=W');
    writeLine('P=W', { n: 1, writer: 'tool', result: 'ok', head: 'X' }, `tsc=ok ${opts('LX')}`);
    writeLine('P=W', { n: 2, writer: 'hand', result: 'ok', head: 'P' }, `leader note ${opts('refactor', true)}`);
    const fake = treeOf('P=W', { checks: [GREEN] });
    const r = runMerge(fake);
    expect(r.prechecks).toHaveLength(0);
    expect(r.code).toBe(1);
    expect(r.err).toContain('no precheck=ok record to take the options from');
    expect(fake.ghCalls('pr merge')).toHaveLength(0);
  });

  it('Y9: a tool ok on P, then a tool line of another HEAD X — missingRecords judges P\'s line (I5)', () => {
    recordWork('P=W');
    writeLine('P=W', { n: 1, writer: 'tool', result: 'ok', head: 'P' }, 'tsc=ok');
    writeLine('P=W', { n: 2, writer: 'tool', result: 'fail', head: 'X' }, 'tsc=fail');
    const records = readRecords(runDir, String(ISSUE)).records;
    expect(missingRecords(records, ISSUE, { head: HEAD_A, workHead: HEAD_A }, null)).toEqual([]);
  });
});

describe('the options of the PR\'s HEAD when merge-pr refreshes it (#4617 review a P2-1)', () => {
  /** W verified; M1, a merge of develop made by hand, is the PR's HEAD with the tool's precheck ok; develop moved again. */
  function m1() {
    recordWork('M1');
    writeLine('M1', { n: 1, writer: 'tool', result: 'ok', head: 'P' }, `tsc=ok env=${envOf(1)} ${opts('LM1')}`);
  }

  it('M1-refresh: merge-pr\'s refresh makes M2 — R3 runs its precheck with the options of M1\'s line', () => {
    m1();
    const fake = treeOf('M1', { behind: true, checks: [GREEN] });
    const r = runMerge(fake);
    expect(r.prechecks, r.err).toHaveLength(1);
    expect(r.prechecks[0]).toEqual(expect.arrayContaining(['--kind', 'LM1', '--heavy-to-ci']));
    expect(r.code, r.err).toBe(0);
    expect(fake.ghCalls('pr merge')[0].args).toContain(HEAD_M);
  });

  it('M1-train: the train, on the same records, takes the same M1 line', () => {
    m1();
    const { candidates, dropped } = classify('M1');
    expect(dropped).toEqual([]);
    expect(candidates).toEqual([expect.objectContaining({ issue: ISSUE, pr: 4242, kind: 'LM1' })]);
  });
});

describe('R4: merge-pr\'s CI wait reads the tool line of the HEAD, not a later hand line (#4617 review b P2-4)', () => {
  const FULL_UNIT = 'exit=0(passed) passed=lint,typecheck,unit failed=-';
  const pass = (name: string): Check => ({ name, bucket: 'pass' });
  const pending = (name: string): Check => ({ name, bucket: 'pending' });

  it('R4-build: a tool line that built like CI, then a hand line without build= — Build is not waited for', () => {
    recordWork('P=W', FULL_UNIT);
    writeLine('P=W', { n: 1, writer: 'tool', result: 'ok', head: 'P' }, 'tsc=ok build=ok build-cli=ok build-server=ok related=ok tests=ok');
    writeLine('P=W', { n: 2, writer: 'hand', result: 'ok', head: 'P' }, 'leader note tsc=ok');
    const fake = treeOf('P=W', { checks: [[pass('Lint'), pending('Build'), pass('Unit Tests')]] });
    const r = runMerge(fake, undefined, ['--ci-timeout', '60']);
    expect(r.prechecks).toHaveLength(0);
    expect(r.code, r.err).toBe(0);
    expect(fake.ghCalls('pr merge')).toHaveLength(1);
  });

  it('R4-unit: a tool line that left the tests to CI, then a hand line saying they ran — Unit Tests is waited for', () => {
    recordWork('P=W', FULL_UNIT);
    writeLine('P=W', { n: 1, writer: 'tool', result: 'ok', head: 'P' }, 'tsc=ok build=ok build-cli=ok build-server=ok related=ci tests=ci');
    writeLine('P=W', { n: 2, writer: 'hand', result: 'ok', head: 'P' }, 'leader note build=ok build-cli=ok build-server=ok related=ok tests=ok');
    const fake = treeOf('P=W', { checks: [[pass('Lint'), pass('Build'), pending('Unit Tests')]] });
    const r = runMerge(fake, undefined, ['--ci-timeout', '60']);
    expect(r.prechecks).toHaveLength(0);
    expect(r.code, r.err).toBe(124);
    expect(fake.ghCalls('pr merge')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- (d) #4617 acceptance 3

describe('(d) after merge-pr\'s precheck the verify is judged again by the tool line (merge-pr.mjs, the re-read after the precheck)', () => {
  const KEY = '3477:3477:t-1:a1';
  /** A verify of W in the environment of then; the lockfile moves after it, so on P ≠ W it waits for P's precheck (#3883 N10). */
  function deferredVerify() {
    fs.writeFileSync(path.join(worktree, 'package.json'), JSON.stringify({ devDependencies: { vitest: '4.1.2' } }));
    fs.writeFileSync(path.join(worktree, 'package-lock.json'), '{"lockfileVersion":3}\n');
    const manifest = takeManifest({ worktree, home });
    fs.writeFileSync(path.join(runDir, 'wait-3477.env.json'), `${JSON.stringify({ key: KEY, start: manifest, verify: manifest, end: manifest })}\n`);
    recordWork('P≠W', `exit=0(passed) result=passed passed=lint,typecheck failed=- key=${KEY} env=${manifestHash(manifest)}`, KEY);
    fs.writeFileSync(path.join(worktree, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}\n');
  }
  /** What precheck.mjs would write on P in this environment: its own line and its manifest. */
  function toolLineNow() {
    const manifest = takeManifest({ worktree, home });
    fs.writeFileSync(path.join(runDir, 'precheck-3477-ccccccc.env.json'), `${JSON.stringify({ key: 'k-pre', start: manifest, end: manifest })}\n`);
    appendRecord(runDir, String(ISSUE), {
      issue: ISSUE, stage: 'precheck', result: 'ok', head: HEAD_M, workHead: HEAD_A, key: 'k-pre', note: `tsc=ok ${opts('-')} key=k-pre env=${manifestHash(manifest)}`,
    }, at(10));
  }
  const handLine = () => writeLine('P≠W', { n: 11, writer: 'hand', result: 'ok', head: 'P' }, `leader note ${opts('-')}`);

  it('the tool line and a later hand line: the verify passes under the tool line, and the PR is merged', () => {
    deferredVerify();
    writeLine('P≠W', { n: 1, writer: 'tool', result: 'ok', head: 'W' }, `tsc=ok ${opts('-')}`);
    const fake = treeOf('P≠W', { checks: [GREEN] });
    const r = runMerge(fake, () => {
      toolLineNow();
      handLine();
      return 0;
    });
    expect(r.prechecks, `${r.err}\n${r.out}`).toHaveLength(1);
    expect(r.code, r.err).toBe(0);
    expect(fake.ghCalls('pr merge')).toHaveLength(1);
  });

  it('only a hand line after the precheck: stopped before the push and the merge', () => {
    deferredVerify();
    writeLine('P≠W', { n: 1, writer: 'tool', result: 'ok', head: 'W' }, `tsc=ok ${opts('-')}`);
    const fake = treeOf('P≠W', { checks: [GREEN] });
    const r = runMerge(fake, () => {
      handLine();
      return 0;
    });
    expect(r.prechecks).toHaveLength(1);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/after the precheck the run record still lacks:\n {2}verify: environment changed/);
    expect(fake.gitCalls('push')).toHaveLength(0);
    expect(fake.ghCalls('pr merge')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- (b) the readers, (c) the static guard

/** The scripts that read the run record (scripts/orchestrate/*.mjs, run-log.mjs aside) and their source. */
const SCRIPTS = fs
  .readdirSync(path.join(REPO, 'scripts', 'orchestrate'))
  .filter((name) => name.endsWith('.mjs') && name !== 'run-log.mjs')
  .map((name) => ({ name, source: fs.readFileSync(path.join(REPO, 'scripts', 'orchestrate', name), 'utf8') }));

const RUN_LOG_IMPORT = /import\s*(\*\s*as\s*(\w+)|\{([^}]*)\})\s*from\s*['"]\.\/run-log\.mjs['"]/g;
/** How `source` reaches run-log.mjs's `name`: the local names it is imported as, and the namespaces run-log.mjs is imported as. */
function bindingsOf(source: string, name: string): { locals: string[]; namespaces: string[] } {
  const locals: string[] = [];
  const namespaces: string[] = [];
  for (const match of source.matchAll(RUN_LOG_IMPORT)) {
    if (match[2]) namespaces.push(match[2]);
    for (const spec of (match[3] ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
      const [imported, local] = spec.split(/\s+as\s+/).map((s) => s.trim());
      if (imported === name) locals.push(local ?? imported);
    }
  }
  return { locals, namespaces };
}
const escape = (s: string) => s.replace(/[$.*+?^()[\]{}|\\]/g, '\\$&');

/**
 * Every call of run-log.mjs's `name` in `source` — by its name, an alias (`{ name as x }` → `x(`),
 * a namespace (`ns.name(`, `ns?.name(`), and as an optional call (`name?.(`) — with its text to the
 * closing parenthesis and the line it starts on.
 */
function callsOf(source: string, name: string): { line: number; text: string }[] {
  const { locals, namespaces } = bindingsOf(source, name);
  const callees = [
    ...locals.map((local) => `(?<![\\w$.])${escape(local)}`),
    ...namespaces.map((ns) => `(?<![\\w$.])${escape(ns)}\\s*\\??\\.\\s*${escape(name)}`),
  ];
  if (callees.length === 0) return [];
  const pattern = new RegExp(`(?:${callees.join('|')})\\s*(?:\\?\\.)?\\s*\\(`, 'g');
  const out: { line: number; text: string }[] = [];
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++;
      else if (source[end] === ')' && --depth === 0) break;
    }
    out.push({ line: source.slice(0, match.index).split('\n').length, text: source.slice(match.index, end + 1) });
  }
  return out;
}

/** The mark of a reader: `// precheck-reader: R<n>` on its line or in the comment lines right above it. */
function markOf(source: string, line: number): string | null {
  const lines = source.split('\n');
  for (let i = line - 1; i >= 0; i--) {
    if (i < line - 1 && !/^\s*\/\//.test(lines[i])) break;
    const match = /\/\/\s*precheck-reader:\s*(R\d+)\b/.exec(lines[i]);
    if (match) return match[1];
  }
  return null;
}

/** The registered readers of the precheck record: each mark, its file and its role (one call each). */
const READERS = [
  { id: 'R1', file: 'precheck.mjs', role: 'gate', what: 'the reuse of a precheck' },
  { id: 'R2', file: 'merge-pr.mjs', role: 'gate', what: 'the env check before the push' },
  { id: 'R3', file: 'merge-pr.mjs', role: 'options', what: 'the options of the re-run' },
  { id: 'R4', file: 'merge-pr.mjs', role: 'gate', what: 'the CI wait after the push' },
  { id: 'R5', file: 'merge-train.mjs', role: 'options', what: 'the train C4 / C5' },
  { id: 'R6', file: 'pr-common.mjs', role: 'gate', what: 'missingRecords (publish, merge-pr, train)' },
];
const SELECTOR = 'precheckFor';
/** The selectors run-log.mjs keeps for itself: no script imports them. */
const PRIVATE_SELECTORS = ['toolPrecheck', 'gatePrecheck'];

/** The selector's calls in `scripts`, each with its mark and role. */
function readersIn(scripts: { name: string; source: string }[]) {
  return scripts.flatMap(({ name, source }) =>
    callsOf(source, SELECTOR).map(({ line, text }) => ({
      id: markOf(source, line) ?? `(no mark at ${name}:${line})`,
      file: name,
      role: /role:\s*'(gate|options)'/.exec(text)?.[1] ?? '(no role)',
    }))
  );
}
/** What the guard (c) finds in `scripts`. */
function offendersIn(scripts: { name: string; source: string }[]) {
  return scripts.flatMap(({ name, source }) => [
    ...callsOf(source, 'findLatest').filter(({ text }) => /stage:\s*['"]precheck['"]/.test(text)).map(({ line }) => `${name}:${line} findLatest`),
    ...PRIVATE_SELECTORS.filter((selector) => bindingsOf(source, selector).locals.length > 0).map((selector) => `${name} imports ${selector}`),
    ...PRIVATE_SELECTORS.flatMap((selector) => callsOf(source, selector).map(({ line }) => `${name}:${line} ${selector}`)),
  ]);
}

/** The forms a call could slip through by: an alias, a namespace, an optional call, and the private selectors. */
const SAMPLE = {
  name: 'sample.mjs',
  source: [
    "import * as runLog from './run-log.mjs';",
    "import { precheckFor as pick, findLatest as latest, gatePrecheck, toolPrecheck as tool } from './run-log.mjs';",
    '// precheck-reader: R1',
    "const a = runLog.precheckFor(records, { issue, item, role: 'gate', head });",
    '// precheck-reader: R2',
    "const b = pick?.(records, { issue, item, role: 'gate', head });",
    "const c = runLog?.precheckFor(records, { issue, item, role: 'options', head, workHead });",
    "const d = latest(records, { issue, item, stage: 'precheck', head });",
    "const e = runLog.findLatest?.(records, { issue, stage: 'precheck' });",
    'const f = gatePrecheck(records, { issue });',
    'const g = tool(records, { issue, head });',
    "const h = runLog.toolPrecheck(records, { issue, head });",
  ].join('\n'),
};

describe('(b) the readers of the precheck record are R1-R6, each through the one selector', () => {
  it(`each ${SELECTOR}( call in scripts/orchestrate/*.mjs is one registered reader, by its mark, file and role`, () => {
    const found = readersIn(SCRIPTS);
    const key = (r: { id: string; file: string; role: string }) => `${r.id} ${r.file} ${r.role}`;
    expect(found.map(key).sort(), JSON.stringify(found)).toEqual(READERS.map(key).sort());
  });

  it('the reader list sees the alias, the namespace and the optional calls (control)', () => {
    expect(readersIn([SAMPLE])).toEqual([
      { id: 'R1', file: 'sample.mjs', role: 'gate' },
      { id: 'R2', file: 'sample.mjs', role: 'gate' },
      { id: '(no mark at sample.mjs:7)', file: 'sample.mjs', role: 'options' },
    ]);
  });
});

describe('(c) static guard: outside run-log.mjs no script picks a precheck by another rule', () => {
  it('no findLatest( with stage: \'precheck\', and no import or call of toolPrecheck / gatePrecheck', () => {
    expect(offendersIn(SCRIPTS)).toEqual([]);
  });

  it('the guard sees every form in a sample (control)', () => {
    expect(offendersIn([SAMPLE])).toEqual([
      'sample.mjs:8 findLatest',
      'sample.mjs:9 findLatest',
      'sample.mjs imports toolPrecheck',
      'sample.mjs imports gatePrecheck',
      'sample.mjs:11 toolPrecheck',
      'sample.mjs:12 toolPrecheck',
      'sample.mjs:10 gatePrecheck',
    ]);
  });
});
