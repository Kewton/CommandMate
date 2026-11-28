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
 *     with or without lines of another Issue / work item around them, on a P = W and a P ≠ W tree.
 *     The expected line is found here on its own (from the end, the first tool line on the role's
 *     HEAD), never by calling the scripts' rule, and each role is judged by what its caller does.
 * (b) The list of the readers: the selector's call sites in scripts/orchestrate/*.mjs are R1-R6.
 * (c) A static guard: outside run-log.mjs nothing picks a precheck by findLatest / gatePrecheck.
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

type Shape = 'P=W' | 'P≠W';
type HeadName = 'P' | 'W' | 'X';
/** P = W: the worker's commit is published. P ≠ W: a clean merge of develop (HEAD_M) on the work HEAD (HEAD_A). */
const HEADS: Record<Shape, Record<HeadName, string>> = {
  'P=W': { P: HEAD_A, W: HEAD_A, X: HEAD_B },
  'P≠W': { P: HEAD_M, W: HEAD_A, X: HEAD_B },
};
const FIRST_PARENT: Record<Shape, string[]> = {
  'P=W': [`${HEAD_A} ${DEVELOP}`],
  'P≠W': [`${HEAD_M} ${HEAD_A} ${DEVELOP}`, `${HEAD_A} ${DEVELOP}`],
};
/** The fake of pr-fake.ts on the tree of `shape`: the merge changed nothing itself (pr-common.mjs workHeads passes it over). */
const treeOf = (shape: Shape, extra: Parameters<typeof fakeGit>[0] = {}) =>
  fakeGit({
    head: HEADS[shape].P,
    firstParent: FIRST_PARENT[shape],
    commitFiles: { [HEAD_A]: ['scripts/orchestrate/merge-pr.mjs', 'changelog.d/3477.md'], [HEAD_M]: [] },
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
interface Line {
  n: number;
  writer: Writer;
  result: 'ok' | 'fail';
  head: HeadName;
  /** A line of another Issue or another work item: none of this PR's readers reads it (I5). */
  noise?: 'issue' | 'item';
}
type Role = 'R1' | 'R3' | 'R5' | 'R6';
const at = (n: number) => new Date(Date.UTC(2026, 10, 28, 1, n));
const envOf = (n: number) => n.toString(16).padStart(12, '0');
const opts = (kind: string, allowRemoved = false) => `opts=base:origin/develop,kind:${kind},metrics:false,allow-removed:${allowRemoved},build:false`;

/** Write `line` as its writer does: precheck.mjs by appendRecord, a leader by the run-log.mjs command line. */
function writeLine(shape: Shape, line: Line, note: string) {
  const sha = HEADS[shape][line.head];
  const workHead = shape === 'P≠W' && line.head === 'P' ? HEADS[shape].W : undefined;
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
 * options' roles. Any result; a hand line is never one.
 */
function expectedLine(lines: Line[], role: Role, shape: Shape): Line | null {
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

/** The note precheck.mjs writes on `shape` when every step passed, without its own key= / env= (a record from before env=). */
function fullNote(shape: Shape): string {
  const scratch = path.join(tmp, 'scratch-run');
  expect(runPrecheck(shape, scratch, true).code).toBe(0);
  const record = readRecords(scratch, String(ISSUE)).records.find((r: { stage: string }) => r.stage === 'precheck');
  fs.rmSync(scratch, { recursive: true, force: true });
  return String(record.note).replace(/ key=\S+/, '').replace(/ env=\S+/, '');
}

function runMerge(fake: ReturnType<typeof fakeGit>, runPrecheckStub?: (args: string[]) => number) {
  const out: string[] = [];
  const err: string[] = [];
  const prechecks: string[][] = [];
  let clock = Date.UTC(2026, 10, 28, 3, 0);
  const code = mergeMain(['--run-dir', runDir, '--issues', String(ISSUE), '--issue', String(ISSUE), '--worktree', worktree], {
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
  if (role === 'R1') {
    const note = fullNote(shape);
    for (const line of lines) writeLine(shape, line, note);
    const r = runPrecheck(shape);
    if (expected && expected.result === 'ok') {
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
    recordWork(shape);
    // Every tool line has an env= whose manifest is not kept: the gate (R2) is never met, so the options are always taken.
    for (const line of lines) writeLine(shape, line, `${line.writer === 'hand' ? 'leader note ' : 'tsc=ok '}env=${envOf(line.n)} ${opts(`L${line.n}`)}`);
    const fake = treeOf(shape, { checks: [GREEN] });
    const r = runMerge(fake);
    if (expected) {
      expect(r.prechecks).toHaveLength(1);
      expect(r.prechecks[0]).toEqual(expect.arrayContaining(['--kind', `L${expected.n}`]));
      expect(r.code, r.err).toBe(0);
    } else {
      expect(r.prechecks).toHaveLength(0);
      expect(r.code).toBe(1);
      expect(r.err).toContain('no precheck=ok record to take the options from');
      expect(fake.ghCalls('pr merge')).toHaveLength(0);
    }
    return;
  }
  if (role === 'R5') {
    recordWork(shape);
    for (const line of lines) writeLine(shape, line, `${line.writer === 'hand' ? 'leader note' : 'tsc=ok'} ${opts(`L${line.n}`)}`);
    const { candidates, dropped } = classify(shape);
    if (expected) {
      expect(dropped).toEqual([]);
      expect(candidates).toEqual([expect.objectContaining({ issue: ISSUE, pr: 4242, kind: `L${expected.n}` })]);
    } else {
      expect(dropped).toEqual([{ entry: String(ISSUE), pr: 4242, reason: 'precheck-options-unknown' }]);
    }
    return;
  }
  // R6: each line's env= names it (its manifest is not kept, so a passed line is "environment missing — env=<it>").
  recordWork(shape);
  for (const line of lines) writeLine(shape, line, `${line.writer === 'hand' ? 'leader note' : 'tsc=ok'} env=${envOf(line.n)}`);
  const records = readRecords(runDir, String(ISSUE)).records;
  const reasons = missingRecords(records, ISSUE, { head: p, workHead: HEADS[shape].W }, null, { runDir, worktree, home, warn: () => {} })
    .filter((reason) => String(reason).startsWith('precheck:'));
  if (!expected) expect(reasons).toEqual([`precheck: no result for ${short(p)} (6-1-1)`]);
  else if (expected.result === 'fail') expect(reasons).toEqual([`precheck: fail at ${short(p)} (6-1-1)`]);
  else expect(reasons).toEqual([expect.stringMatching(new RegExp(`^precheck: environment missing — env=${envOf(expected.n)}:`))]);
}

// ---------------------------------------------------------------- (a) the table

type Kind = Pick<Line, 'writer' | 'result'>;
const KINDS: Kind[] = [
  { writer: 'tool', result: 'ok' },
  { writer: 'tool', result: 'fail' },
  { writer: 'hand', result: 'ok' },
];
const HEAD_NAMES: Record<Shape, HeadName[]> = { 'P=W': ['P', 'X'], 'P≠W': ['P', 'W', 'X'] };
const describeLine = (l: Line) => `${l.writer}-${l.result}@${l.head}${l.noise ? `(${l.noise})` : ''}`;

interface Row {
  name: string;
  shape: Shape;
  lines: Line[];
}
function rows(): Row[] {
  const out: Row[] = [];
  for (const shape of ['P=W', 'P≠W'] as Shape[]) {
    const atoms = KINDS.flatMap((kind) => HEAD_NAMES[shape].map((head) => ({ ...kind, head })));
    const sequences = [...atoms.map((a) => [a]), ...atoms.flatMap((a) => atoms.map((b) => [a, b]))];
    for (const sequence of sequences) {
      for (const noisy of [false, true]) {
        // Another Issue's and another work item's tool lines, on P, before, between and after this PR's lines (I5).
        const plan: Omit<Line, 'n'>[] = noisy
          ? [
              { writer: 'tool', result: 'ok', head: 'P', noise: 'issue' },
              ...sequence.flatMap((s, i) => (i === 0 ? [s] : [{ writer: 'tool', result: 'ok', head: 'P', noise: 'item' } as Omit<Line, 'n'>, s])),
              { writer: 'tool', result: 'fail', head: 'P', noise: 'item' },
            ]
          : sequence;
        const lines = plan.map((l, i) => ({ ...l, n: i + 1 }));
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

/** The scripts that read the run record (scripts/orchestrate/*.mjs) and their source. */
const SCRIPTS = fs
  .readdirSync(path.join(REPO, 'scripts', 'orchestrate'))
  .filter((name) => name.endsWith('.mjs'))
  .map((name) => ({ name, source: fs.readFileSync(path.join(REPO, 'scripts', 'orchestrate', name), 'utf8') }));

/** The text of every call `name(...)` in `source` (to its closing parenthesis), with the line it starts on. */
function callsOf(source: string, name: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const pattern = new RegExp(`(?<![\\w.])${name}\\(`, 'g');
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    // The declaration `function name(` is not a call.
    if (/function\s+$/.test(source.slice(Math.max(0, match.index - 20), match.index))) continue;
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

/** The registered readers of the precheck record: file and role of each call of the one selector. */
const READERS = [
  { id: 'R1', file: 'precheck.mjs', role: 'gate', what: 'the reuse of a precheck' },
  { id: 'R2', file: 'merge-pr.mjs', role: 'gate', what: 'the env check before the push' },
  { id: 'R3', file: 'merge-pr.mjs', role: 'options', what: 'the options of the re-run' },
  { id: 'R4', file: 'merge-pr.mjs', role: 'gate', what: 'the CI wait after the push' },
  { id: 'R5', file: 'merge-train.mjs', role: 'options', what: 'the train C4 / C5' },
  { id: 'R6', file: 'pr-common.mjs', role: 'gate', what: 'missingRecords (publish, merge-pr, train)' },
];
const SELECTOR = 'precheckFor';
const tally = (entries: { file: string; role: string }[]) =>
  entries.map(({ file, role }) => `${file} ${role}`).sort();

describe('(b) the readers of the precheck record are R1-R6, each through the one selector', () => {
  it(`the ${SELECTOR}( calls in scripts/orchestrate/*.mjs are the registered readers`, () => {
    const found = SCRIPTS.filter(({ name }) => name !== 'run-log.mjs').flatMap(({ name, source }) =>
      callsOf(source, SELECTOR).map(({ line, text }) => ({ file: name, line, role: /role:\s*'(gate|options)'/.exec(text)?.[1] ?? '(no role)' }))
    );
    expect(tally(found), JSON.stringify(found)).toEqual(tally(READERS));
  });
});

describe('(c) static guard: outside run-log.mjs no script picks a precheck by another rule', () => {
  it('no findLatest( with stage: \'precheck\', and no gatePrecheck( call', () => {
    const offenders = SCRIPTS.filter(({ name }) => name !== 'run-log.mjs').flatMap(({ name, source }) => [
      ...callsOf(source, 'findLatest').filter(({ text }) => /stage:\s*['"]precheck['"]/.test(text)).map(({ line }) => `${name}:${line} findLatest`),
      ...callsOf(source, 'gatePrecheck').map(({ line }) => `${name}:${line} gatePrecheck`),
    ]);
    expect(offenders).toEqual([]);
  });

  it('the guard sees a direct call (control): the pattern finds one in a sample', () => {
    const sample = "const x = findLatest(records, { issue, item, stage: 'precheck', head });\nconst y = gatePrecheck(records, { issue });";
    expect(callsOf(sample, 'findLatest').filter(({ text }) => /stage:\s*['"]precheck['"]/.test(text))).toHaveLength(1);
    expect(callsOf(sample, 'gatePrecheck')).toHaveLength(1);
  });
});
