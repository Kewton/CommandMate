/**
 * The gates read precheck.mjs's own record, never a precheck line added by hand (Issue #4589):
 * merge-pr.mjs (M1, M2), publish's pr-common.mjs missingRecords (M3) and the train's C4 / C5
 * (merge-train.mjs classifyEntries, M4).
 *
 * Range: what this guards against is a line written by `run-log.mjs append` by mistake (a leader's
 * note left as `--stage precheck --result ok`). Rewriting the jsonl by hand on purpose is outside it.
 *
 * `git` and `gh` are the fake of ./pr-fake.ts: nothing is pushed or merged. The run record, the
 * worktree and HOME are under os.tmpdir() and removed after each test.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendRecord, main as runLogMain, readRecords } from '../../../../scripts/orchestrate/run-log.mjs';
import { LAST_REQUIRED_CHECKS, main } from '../../../../scripts/orchestrate/merge-pr.mjs';
import { missingRecords } from '../../../../scripts/orchestrate/pr-common.mjs';
import { classifyEntries, parseArgs as parseTrainArgs } from '../../../../scripts/orchestrate/merge-train.mjs';
import { HEAD_A, HEAD_B, type Check, fakeGit, openPr } from './pr-fake';

const ISSUE = 3477;
/** precheck.mjs's own note: an env= whose manifest is not in the run directory (`missing`), and its options. */
const TOOL_NOTE = 'tsc=ok tests=ok env=0123456789ab opts=base:origin/develop,kind:refactor,metrics:false,allow-removed:true,build:false';
const HAND_NOTE = 'leader note: precheck passed (same as the tool) opts=base:origin/develop,kind:-,metrics:false,allow-removed:false,build:false';
const GREEN: Check[] = [{ name: 'Lint', bucket: 'pass' }, { name: 'Build', bucket: 'pass' }, { name: 'Unit Tests', bucket: 'pass' }];

let tmp: string;
let runDir: string;
let worktree: string;
let home: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-merge-pr-hand-4589-'));
  runDir = path.join(tmp, 'runs', '2026-11-26');
  worktree = path.join(tmp, 'wt');
  home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(worktree, 'dev-reports', 'module-reference'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'dev-reports', 'module-reference', `issue-${ISSUE}.md`), '追記なし\n');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function recordWork(head = HEAD_A, verifyNote = 'exit=0(passed) passed=lint,typecheck failed=-') {
  appendRecord(runDir, String(ISSUE), { issue: ISSUE, stage: 'verify', result: 'ok', head, note: verifyNote });
  appendRecord(runDir, String(ISSUE), { issue: ISSUE, stage: 'review', result: 'ok', head });
  appendRecord(runDir, String(ISSUE), { issue: ISSUE, stage: 'findings', result: 'ok', head });
}

/** precheck.mjs's own record: appendRecord called directly. */
const appendTool = (head = HEAD_A, note = TOOL_NOTE) =>
  appendRecord(runDir, String(ISSUE), { issue: ISSUE, stage: 'precheck', result: 'ok', head, key: 'k-tool', note });

/** A leader's line: through the run-log.mjs command line. */
function appendByHand(head = HEAD_A, note = HAND_NOTE) {
  const code = runLogMain(['append', '--run-dir', runDir, '--issues', String(ISSUE), '--issue', String(ISSUE), '--stage', 'precheck', '--result', 'ok', '--head', head, '--note', note]);
  expect(code).toBe(0);
}

function runMerge(fake: ReturnType<typeof fakeGit>, ...extra: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const prechecks: string[][] = [];
  let clock = Date.UTC(2026, 10, 26, 3, 0);
  const code = main(['--run-dir', runDir, '--issues', String(ISSUE), '--issue', String(ISSUE), '--worktree', worktree, ...extra], {
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
      return 0;
    },
  });
  return { code, out: out.join('\n'), err: err.join('\n'), prechecks };
}

const where = () => ({ runDir, worktree, home });

describe('merge-pr reads the tool precheck (#4589)', () => {
  it('M1: the tool record and a later hand line on the same HEAD — the env and the options are the tool record\'s', () => {
    recordWork();
    appendTool();
    appendByHand();
    const r = runMerge(fakeGit({ prs: [openPr()], checks: [GREEN] }));
    // The env of the tool record is checked (missing → precheck again), not skipped as a record without env=.
    expect(r.out).not.toContain('precheck at aaaaaaa: no env= in the record');
    expect(r.prechecks).toHaveLength(1);
    // N2: the options come from the same record: kind:refactor and allow-removed, not the hand line's kind:-.
    expect(r.prechecks[0]).toEqual(expect.arrayContaining(['--kind', 'refactor', '--allow-removed-tests']));
    expect(r.code, r.err).toBe(0);
  });

  it('M2: only a hand line — not a passed precheck; with nothing to take the options from, the stop of today', () => {
    recordWork();
    appendByHand(HEAD_A, TOOL_NOTE);
    const fake = fakeGit({ prs: [openPr()], checks: [GREEN] });
    const r = runMerge(fake);
    expect(r.prechecks).toHaveLength(0);
    expect(r.code).toBe(1);
    expect(r.err).toContain('no precheck=ok record to take the options from');
    expect(fake.ghCalls('pr merge')).toHaveLength(0);
  });

  it('M2: only a hand line on this HEAD — the precheck runs, with the options of the tool record of an earlier HEAD', () => {
    recordWork();
    appendTool(HEAD_B, 'tsc=ok opts=base:origin/develop,kind:-,metrics:false,allow-removed:false,build:false');
    appendByHand(HEAD_A, `reason ${TOOL_NOTE}`);
    const r = runMerge(fakeGit({ prs: [openPr()], checks: [GREEN] }));
    expect(r.prechecks).toHaveLength(1);
    expect(r.prechecks[0]).not.toContain('--kind');
    expect(r.prechecks[0]).not.toContain('--allow-removed-tests');
    expect(r.code, r.err).toBe(0);
  });

  it('negative control: the tool record alone is read as before', () => {
    recordWork();
    appendTool(HEAD_A, 'tsc=ok tests=ok opts=base:origin/develop,kind:-,metrics:false,allow-removed:false,build:false');
    const r = runMerge(fakeGit({ prs: [openPr()], checks: [GREEN] }));
    expect(r.out).toContain('precheck at aaaaaaa: no env= in the record');
    expect(r.prechecks).toHaveLength(0);
    expect(r.code, r.err).toBe(0);
  });
});

describe('merge-pr\'s CI wait reads the tool precheck (#4589 M5)', () => {
  // The worker's verify ran the full unit suite: only the precheck decides whether Build / Unit Tests are waited for.
  const FULL_UNIT = 'exit=0(passed) passed=lint,typecheck,unit failed=-';
  /** precheck.mjs built nothing and left its heavy test steps to CI (--heavy-to-ci). */
  const TOOL_NO_BUILD = 'tsc=ok related=ci tests=ci opts=base:origin/develop,kind:-,metrics:false,allow-removed:false,build:false';
  /** A hand line whose note would waive Build and claims the tests ran here. */
  const HAND_BUILT = 'leader note build=ok build-cli=ok build-server=ok related=ok tests=ok';
  const pass = (name: string): Check => ({ name, bucket: 'pass' });
  const pending = (name: string): Check => ({ name, bucket: 'pending' });

  it('M5: the tool record built nothing and a later hand line says build=ok — Build is waited for (needBuild)', () => {
    recordWork(HEAD_A, FULL_UNIT);
    appendTool(HEAD_A, TOOL_NO_BUILD);
    appendByHand(HEAD_A, HAND_BUILT);
    const fake = fakeGit({ prs: [openPr()], checks: [[pass('Lint'), pending('Build'), pass('Unit Tests')]] });
    const r = runMerge(fake, '--ci-timeout', '60');
    expect(r.prechecks).toHaveLength(0);
    expect(r.code, r.err).toBe(124);
    expect(fake.ghCalls('pr merge')).toHaveLength(0);
  });

  it('M5: leftHeavyToCi is read from the same tool record — Unit Tests is waited for', () => {
    recordWork(HEAD_A, FULL_UNIT);
    appendTool(HEAD_A, TOOL_NO_BUILD);
    appendByHand(HEAD_A, HAND_BUILT);
    const fake = fakeGit({ prs: [openPr()], checks: [[pass('Lint'), pass('Build'), pending('Unit Tests')]] });
    const r = runMerge(fake, '--ci-timeout', '60');
    expect(r.code, r.err).toBe(124);
    expect(fake.ghCalls('pr merge')).toHaveLength(0);
  });

  it('negative control: a tool record that built like CI still waives Build', () => {
    recordWork(HEAD_A, FULL_UNIT);
    appendTool(HEAD_A, 'tsc=ok build=ok build-cli=ok build-server=ok related=ok tests=ok');
    const fake = fakeGit({ prs: [openPr()], checks: [[pass('Lint'), pending('Build'), pass('Unit Tests')]] });
    const r = runMerge(fake, '--ci-timeout', '60');
    expect(r.code, r.err).toBe(0);
    expect(fake.ghCalls('pr merge')).toHaveLength(1);
  });
});

describe('publish (pr-common.mjs missingRecords) reads the tool precheck (#4589)', () => {
  it('M3: the tool record and a later hand line — the tool record\'s env is judged (as M1)', () => {
    recordWork();
    appendTool();
    appendByHand();
    const warn = vi.fn();
    const missing = missingRecords(readRecords(runDir, String(ISSUE)).records, ISSUE, { head: HEAD_A, workHead: HEAD_A }, null, { ...where(), warn });
    expect(missing).toEqual([expect.stringMatching(/^precheck: environment missing — env=0123456789ab/)]);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('precheck at'));
  });

  it('M3: only a hand line — no precheck for the HEAD (as M2)', () => {
    recordWork();
    appendByHand(HEAD_A, TOOL_NOTE);
    const records = readRecords(runDir, String(ISSUE)).records;
    expect(missingRecords(records, ISSUE, { head: HEAD_A, workHead: HEAD_A }, null, { ...where(), warn: () => {} })).toEqual([
      'precheck: no result for aaaaaaa (6-1-1)',
    ]);
    expect(missingRecords(records, ISSUE, { head: HEAD_A, workHead: HEAD_A }, null)).toEqual(['precheck: no result for aaaaaaa (6-1-1)']);
  });

  it('negative control: without a hand line nothing changes', () => {
    recordWork();
    appendTool(HEAD_A, 'tsc=ok');
    expect(missingRecords(readRecords(runDir, String(ISSUE)).records, ISSUE, { head: HEAD_A, workHead: HEAD_A }, null)).toEqual([]);
  });
});

describe('the train C4 / C5 (merge-train.mjs classifyEntries) reads the tool precheck (#4589)', () => {
  function classify() {
    appendRecord(runDir, String(ISSUE), { issue: ISSUE, stage: 'pr', result: 'ok', head: HEAD_A, note: `pr=#4242 opened` });
    const parsed = parseTrainArgs(['--run-dir', runDir, '--issues', String(ISSUE), '--queue', String(ISSUE)]);
    if (!('options' in parsed)) throw new Error(parsed.error);
    const fake = fakeGit({ prs: [openPr()], checks: [LAST_REQUIRED_CHECKS.map((name: string) => ({ name, bucket: 'pass' }))] });
    const run = (command: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }) => {
      if (command === 'git' && args.includes('worktree') && args.includes('list')) {
        return { status: 0, stdout: `worktree ${worktree}\nHEAD ${HEAD_A}\nbranch refs/heads/${openPr().headRefName}\n\n`, stderr: '' };
      }
      return fake.run(command, args, opts);
    };
    return classifyEntries(parsed.options, { run, repoDir: worktree, home, mergeLockRoot: path.join(tmp, 'locks') });
  }

  it('M4: the tool record and a later hand line — the options are the tool record\'s (as M1)', () => {
    recordWork();
    appendTool();
    appendByHand();
    // The tool record allowed removed tests (C5); the hand line's options would have adopted it.
    expect(classify().dropped).toEqual([{ entry: String(ISSUE), pr: 4242, reason: 'removed-tests-allowed' }]);
  });

  it('M4: only a hand line — no precheck options (as M2)', () => {
    recordWork();
    appendByHand();
    expect(classify().dropped).toEqual([{ entry: String(ISSUE), pr: 4242, reason: 'precheck-options-unknown' }]);
  });

  it('negative control: the tool record alone is read as before', () => {
    recordWork();
    appendTool(HEAD_A, 'tsc=ok opts=base:origin/develop,kind:refactor,metrics:false,allow-removed:false,build:false');
    const { candidates, dropped } = classify();
    expect(dropped).toEqual([]);
    expect(candidates).toEqual([expect.objectContaining({ issue: ISSUE, pr: 4242, kind: 'refactor' })]);
  });
});
