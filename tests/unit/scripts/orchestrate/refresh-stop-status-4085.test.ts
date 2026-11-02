/**
 * Where `run-log status` resumes after merge-pr stopped on its own refresh (Issue #4085).
 *
 * W (HEAD_A) is the worker's commit, verified and prechecked. develop moved, so
 * merge-pr's step 4 merges it into W and makes M (HEAD_M). When M is its own work
 * HEAD (its own change cannot be told, or it changed src itself), W's records do
 * not cover it and merge-pr stops before the push. Before #4085 nothing of M was
 * recorded, so `status` (headsOf reads only the record) kept W and pointed past
 * M's own verify. The real flow is run here: merge-pr → the record → summarize.
 *
 * git and gh are the fake of ./pr-fake.ts: nothing is pushed or merged. The run
 * record, the worktree and HOME are under os.tmpdir() and removed after each test.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendRecord, readRecords, summarize } from '../../../../scripts/orchestrate/run-log.mjs';
import { main as merge } from '../../../../scripts/orchestrate/merge-pr.mjs';
import { DEVELOP, HEAD_A, HEAD_M, fakeGit, openPr } from './pr-fake';

const W = HEAD_A;
const M = HEAD_M; // what the fake's `git merge` makes on W and develop
const ISSUE = 3477;
const FULL_UNIT = 'exit=0(passed) passed=lint,typecheck,unit failed=-';
const PASS = (name: string) => ({ name, bucket: 'pass' });

let tmp: string;
let runDir: string;
let worktree: string;
let home: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-orchestrate-4085-')));
  runDir = path.join(tmp, 'runs', '2026-11-01');
  worktree = path.join(tmp, 'wt');
  home = path.join(tmp, 'home');
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write(path.join(worktree, 'package.json'), JSON.stringify({ devDependencies: { vitest: '4.1.2' } }));
  write(path.join(worktree, 'package-lock.json'), '{"lockfileVersion":3}\n');
  write(path.join(worktree, '.claude', 'settings.local.json'), '{"model":"opus[1m]"}\n');
  write(path.join(worktree, 'node_modules', 'vitest', 'package.json'), '{"version":"4.1.2"}');
  write(path.join(worktree, 'dev-reports', 'module-reference', 'issue-3477.md'), '追記なし\n');
  write(path.join(home, '.claude', 'settings.json'), '{"model":"opus[1m]"}\n');
  fs.mkdirSync(runDir, { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const records = () => readRecords(runDir, '3477').records;
const unitOf = (item: string | null = null) => summarize(records()).find((u: { item?: string }) => (u.item ?? null) === item);

/** contract / send, then W's verify / review / findings and its precheck, as the run writes them. */
function recordW(item?: string) {
  for (const stage of ['contract', 'send']) appendRecord(runDir, '3477', { issue: ISSUE, item, stage, result: 'ok' });
  appendRecord(runDir, '3477', { issue: ISSUE, item, stage: 'verify', result: 'ok', head: W, note: FULL_UNIT });
  for (const stage of ['review', 'findings']) appendRecord(runDir, '3477', { issue: ISSUE, item, stage, result: 'ok', head: W });
  appendRecord(runDir, '3477', { issue: ISSUE, item, stage: 'precheck', result: 'ok', head: W, note: 'tsc=ok tests=ok' });
}

/** W published; develop moved, so step 4 refreshes W into M. */
function behindW(extra: Parameters<typeof fakeGit>[0] = {}) {
  return fakeGit({
    head: W,
    behind: true,
    firstParent: [`${W} ${DEVELOP}`],
    commitFiles: { [W]: ['src/a.ts'] },
    changed: ['src/a.ts'],
    prs: [openPr({ headRefOid: W })],
    checks: [[PASS('Lint'), PASS('Build')]],
    ...extra,
  });
}
const mergeTreeFails = (fake: ReturnType<typeof fakeGit>) => ({
  ...fake,
  run: (command: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }) =>
    command === 'git' && args[2] === 'merge-tree' ? { status: 129, stdout: '', stderr: 'unknown option' } : fake.run(command, args, opts),
});

function runMerge(fake: { run: ReturnType<typeof fakeGit>['run'] }, ...extra: string[]) {
  const out: string[] = [];
  const argv = ['--run-dir', runDir, '--issues', '3477', '--issue', String(ISSUE), '--worktree', worktree, ...extra];
  const code = merge(argv, {
    run: fake.run, home, sleep: () => {}, now: () => new Date(Date.UTC(2026, 10, 1, 3, 0)),
    findTestsNaming: () => [], log: (l: string) => out.push(l), error: (l: string) => out.push(l),
  } as Parameters<typeof merge>[1]);
  return { code, out: out.join('\n') };
}

describe('merge-pr stopped on its refresh: status resumes at M’s verify (#4085)', () => {
  it('the refresh’s own change cannot be told: M is recorded as head and work HEAD, next is M’s verify (positive control)', () => {
    recordW();
    const fake = behindW();
    const r = runMerge(mergeTreeFails(fake));
    expect(r.code, r.out).toBe(1);
    expect(fake.gitCalls('push')).toHaveLength(0);
    expect(fake.ghCalls('pr merge')).toHaveLength(0);
    const stop = records().filter((x) => x.stage === 'merge');
    expect(stop).toHaveLength(1);
    expect(stop[0]).toMatchObject({ result: 'fail', head: M });
    expect(stop[0].workHead).toBeUndefined(); // M is its own work HEAD
    expect(records().some((x) => x.stage === 'precheck' && x.head === M)).toBe(false); // no precheck that did not run
    const unit = unitOf();
    expect(unit).toMatchObject({ next: 'verify', head: M, workHead: M });
    expect(unit?.reason).toBe(`verify: no result for ${M.slice(0, 7)}`);
  });

  it('the refresh changed src itself: the same — next is M’s verify, nothing pushed', () => {
    recordW();
    const fake = behindW({ commitFiles: { [W]: ['src/a.ts'], [M]: ['src/a.ts'] } });
    const r = runMerge(fake);
    expect(r.code, r.out).toBe(1);
    expect(fake.gitCalls('push')).toHaveLength(0);
    expect(fake.ghCalls('pr merge')).toHaveLength(0);
    expect(unitOf()).toMatchObject({ next: 'verify', head: M, workHead: M });
  });

  it('after M’s verify / review / findings are recorded, status moves on past them (to M’s precheck)', () => {
    recordW();
    runMerge(mergeTreeFails(behindW()));
    appendRecord(runDir, '3477', { issue: ISSUE, stage: 'verify', result: 'ok', head: M, note: FULL_UNIT });
    for (const stage of ['review', 'findings']) appendRecord(runDir, '3477', { issue: ISSUE, stage, result: 'ok', head: M });
    expect(unitOf()).toMatchObject({ next: 'precheck', head: M, workHead: M });
  });

  it('negative control: a clean refresh with W’s records goes on as before and its records keep W as the work HEAD', () => {
    recordW();
    const fake = behindW();
    const r = runMerge(fake);
    expect(r.code, r.out).toBe(0);
    expect(fake.gitCalls('push')).toHaveLength(1);
    expect(fake.ghCalls('pr merge')).toHaveLength(1);
    expect(records().filter((x) => x.stage === 'merge')).toEqual([expect.objectContaining({ result: 'ok', head: M, workHead: W })]);
    expect(unitOf()).toMatchObject({ reached: 'merge', next: null, head: M, workHead: W });
  });

  it('negative control: a clean refresh that stops later (a conflict marker) keeps W — not moved to M', () => {
    recordW();
    const fake = behindW({ markers: 'src/a.ts\n' });
    const r = runMerge(fake);
    expect(r.code, r.out).toBe(1);
    expect(fake.gitCalls('push')).toHaveLength(0);
    expect(unitOf()).toMatchObject({ next: 'precheck', head: M, workHead: W });
  });

  it('another --item’s stop does not move this work item, nor the Issue’s own records', () => {
    recordW();
    recordW('d1');
    recordW('d2');
    const before = { own: unitOf(), d1: unitOf('d1') };
    const r = runMerge(mergeTreeFails(behindW()), '--item', 'd2');
    expect(r.code, r.out).toBe(1);
    expect(unitOf('d2')).toMatchObject({ next: 'verify', head: M, workHead: M });
    for (const [item, was] of [[null, before.own], ['d1', before.d1]] as const) {
      const now = unitOf(item);
      expect(now).toMatchObject({ next: was?.next, head: W, workHead: W });
    }
  });
});
