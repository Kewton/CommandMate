/**
 * Issue #4265: the precheck merge-pr.mjs runs on the HEAD its own 6-2 refresh made
 * leaves the heavy steps (`related` / `tests` under `cpu.heavy`) to the PR's CI
 * (`--heavy-to-ci`), so a lock another worker's `wait --verify` holds no longer
 * stops the merge with exit 3. The light steps still run and still stop the push;
 * the CI of the refreshed HEAD is still waited for before the merge. The first
 * precheck, and one merge-pr runs without a refresh, still take the lock.
 *
 * `git`, `gh` and `npx` are the fake of ./pr-fake.ts and the lock is a fake
 * (precheck-heavy-3884.test.ts): nothing is pushed or merged, no lock file is
 * made. The run record is under os.tmpdir().
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendRecord, readRecords, summarize, unmetStage } from '../../../../scripts/orchestrate/run-log.mjs';
import { main } from '../../../../scripts/orchestrate/merge-pr.mjs';
import {
  EXIT_HELD,
  HEAVY_TEST_FILES,
  TO_CI,
  main as precheckMain,
  parseNote,
} from '../../../../scripts/orchestrate/precheck.mjs';
import { DEVELOP, HEAD_A, HEAD_B, HEAD_M, type Check, fakeGit, openPr } from './pr-fake';

let tmp: string;
let runDir: string;
let worktree: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-merge-heavy-to-ci-4265-'));
  runDir = path.join(tmp, 'runs', '2026-11-08');
  worktree = path.join(tmp, 'wt');
  fs.mkdirSync(path.join(worktree, 'dev-reports', 'module-reference'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'dev-reports', 'module-reference', 'issue-3477.md'), '追記なし\n');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const RUN_LINK = 'https://github.com/Kewton/CommandMate/actions/runs/555/job/1';
const pass = (name: string): Check => ({ name, bucket: 'pass', link: RUN_LINK });
const pending = (name: string): Check => ({ name, bucket: 'pending', link: RUN_LINK });
const GREEN = [pass('Lint'), pass('Build'), pass('Unit Tests')];
const OPTS = 'opts=base:origin/develop,kind:-,metrics:false,allow-removed:false,build:false';
const manyTests = Array.from({ length: HEAVY_TEST_FILES }, (_, i) => `tests/unit/many/t${i}.test.ts`);

const argv = (...extra: string[]) => ['--run-dir', runDir, '--issues', '3477', '--issue', '3477', '--worktree', worktree, ...extra];

function recordWork(head = HEAD_A, { precheck = true } = {}) {
  appendRecord(runDir, '3477', { issue: 3477, stage: 'verify', result: 'ok', head, note: 'exit=0(passed) passed=lint,typecheck failed=-' });
  appendRecord(runDir, '3477', { issue: 3477, stage: 'review', result: 'ok', head });
  appendRecord(runDir, '3477', { issue: 3477, stage: 'findings', result: 'ok', head });
  if (precheck) appendRecord(runDir, '3477', { issue: 3477, stage: 'precheck', result: 'ok', head, note: `tsc=ok tests=ok ${OPTS}` });
}

/** cpu.heavy as another process holds it for the whole budget (acquired: false), or free. */
function heavyLock(acquired: boolean) {
  const calls: number[] = [];
  return {
    calls,
    acquireHeavyLock: (timeoutMs: number) => {
      calls.push(timeoutMs);
      return { acquired, waitedMs: acquired ? 0 : timeoutMs, heldBy: acquired ? null : 'pid 1 on elsewhere', release: () => {} };
    },
  };
}

function runMerge(fake: ReturnType<typeof fakeGit>, lock: ReturnType<typeof heavyLock>, ...extra: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  let clock = Date.UTC(2026, 10, 8, 3, 0);
  const code = main(argv(...extra), {
    run: fake.run,
    sleep: (ms: number) => {
      clock += ms;
    },
    now: () => new Date(clock),
    // Both heavy steps are wide: HEAVY_TEST_FILES tests name a changed path, and as many reach the changed source.
    findTestsNaming: () => manyTests,
    estimateRelatedTests: () => HEAVY_TEST_FILES,
    acquireHeavyLock: lock.acquireHeavyLock,
    home: tmp,
    log: (l: string) => out.push(l),
    error: (l: string) => err.push(l),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const vitestCalls = (fake: ReturnType<typeof fakeGit>) =>
  fake.calls.filter((c) => c.command === 'npx' && c.args[0] === 'vitest').map((c) => c.args.slice(0, 2).join(' '));
const lastPrecheck = () => readRecords(runDir, '3477').records.filter((r: { stage: string }) => r.stage === 'precheck').at(-1);

describe('merge-pr after its own refresh leaves the heavy steps to CI (#4265)', () => {
  it('does not stop with exit 3 while cpu.heavy is held: waits for the CI of the refreshed HEAD, then merges — positive control', () => {
    recordWork();
    const lock = heavyLock(false);
    // The CI of the refreshed HEAD is pending at the first look: merge-pr waits for it.
    const fake = fakeGit({ prs: [openPr()], behind: true, checks: [[pass('Lint'), pending('Build')], GREEN] });
    const { code, err, out } = runMerge(fake, lock);
    expect(err).not.toContain('on hold');
    expect(code).toBe(0);
    // cpu.heavy is not asked for, and neither heavy step runs here.
    expect(lock.calls).toEqual([]);
    expect(vitestCalls(fake)).toEqual([]);
    // The light steps ran on the refreshed HEAD.
    expect(fake.calls.some((c) => c.command === 'npx' && c.args[0] === 'tsc')).toBe(true);
    expect(fake.calls.some((c) => c.command === 'npx' && c.args[0] === 'eslint')).toBe(true);
    expect(fake.calls.some((c) => c.command === 'git' && c.args[2] === 'grep')).toBe(true);
    // The record says the heavy steps were left to CI, and the precheck passed for the HEAD it ran on.
    const precheck = lastPrecheck();
    expect(precheck).toMatchObject({ result: 'ok', head: HEAD_M, workHead: HEAD_A, mutexSec: 0 });
    expect(parseNote(precheck.note)).toMatchObject({ related: TO_CI, tests: TO_CI, tsc: 'ok', eslint: 'ok' });
    expect(out).toContain(`tests ${TO_CI} (not run: left to the PR's CI`);
    // Pushed, the CI of that HEAD waited for (two looks), then merged at that HEAD.
    expect(fake.gitCalls('push')[0].args).toEqual(['-C', worktree, 'push', 'origin', `${HEAD_M}:refs/heads/feature/3477-worktree`]);
    expect(fake.ghCalls('pr checks').length).toBeGreaterThanOrEqual(2);
    expect(fake.ghCalls('pr merge')[0].args).toContain(HEAD_M);
    expect(summarize(readRecords(runDir, '3477').records)[0]).toMatchObject({ reached: 'merge', next: null });
  });

  it('still waits for every check of the refreshed HEAD with --last, and does not merge before', () => {
    recordWork();
    const lock = heavyLock(false);
    const fake = fakeGit({ prs: [openPr()], behind: true, checks: [[pass('Build'), pending('Unit Tests'), pending('Integration Tests')]] });
    const { code } = runMerge(fake, lock, '--last', '--ci-timeout', '60');
    expect(code).toBe(124);
    expect(lock.calls).toEqual([]);
    expect(fake.gitCalls('push')).toHaveLength(1);
    expect(fake.ghCalls('pr merge')).toHaveLength(0);
  });

  it('still stops before the push when a light step fails on the refreshed HEAD', () => {
    recordWork();
    const lock = heavyLock(false);
    const fake = fakeGit({ prs: [openPr()], behind: true, failCommands: ['npx tsc'], checks: [GREEN] });
    const { code, err } = runMerge(fake, lock);
    expect(code).toBe(1);
    expect(err).toContain('did not pass after the refresh');
    expect(lock.calls).toEqual([]);
    expect(fake.gitCalls('push')).toHaveLength(0);
    expect(lastPrecheck()).toMatchObject({ result: 'fail', head: HEAD_M });
  });

  it('a precheck that left the heavy steps to CI meets the precheck stage for run-log status and merge-pr (unmetStage)', () => {
    recordWork();
    expect(runMerge(fakeGit({ prs: [openPr()], behind: true, checks: [[pending('Build')]] }), heavyLock(false), '--ci-timeout', '60').code).toBe(124);
    const precheck = lastPrecheck();
    expect(parseNote(precheck.note).tests).toBe(TO_CI);
    expect(unmetStage('precheck', precheck, { head: HEAD_M, workHead: HEAD_A })).toBeNull();
    // `status` moves past the precheck: what is next is the PR's own stage, as after a full precheck.
    const [summary] = summarize(readRecords(runDir, '3477').records);
    expect(summary.reason ?? '').not.toContain('precheck');
    expect(summary.next).not.toBe('precheck');
    // A rerun on the same HEAD does not run the precheck again (and so does not ask for cpu.heavy).
    const lock = heavyLock(false);
    const again = fakeGit({
      head: HEAD_M,
      firstParent: [`${HEAD_M} ${HEAD_A} ${DEVELOP}`, `${HEAD_A} ${DEVELOP}`],
      prs: [openPr({ headRefOid: HEAD_M })],
      checks: [GREEN],
    });
    expect(runMerge(again, lock).code).toBe(0);
    expect(lock.calls).toEqual([]);
    expect(fake0Precheck(again)).toBe(false);
  });
});

describe('a HEAD whose heavy steps were left to CI waits for CI Unit Tests without --last (#4265)', () => {
  const FULL_UNIT = 'exit=0(passed) passed=lint,typecheck,unit failed=-';
  const unitPending = [pass('Lint'), pass('Build'), pending('Unit Tests')];

  it('refreshed, heavy steps left to CI, no --last, the worker verify ran the full unit: does not merge while Unit Tests is pending — positive control', () => {
    recordWork();
    appendRecord(runDir, '3477', { issue: 3477, stage: 'verify', result: 'ok', head: HEAD_A, note: FULL_UNIT });
    const fake = fakeGit({ prs: [openPr()], behind: true, checks: [unitPending] });
    const { code } = runMerge(fake, heavyLock(false), '--ci-timeout', '60');
    expect(parseNote(lastPrecheck().note).tests).toBe(TO_CI);
    expect(code).toBe(124);
    expect(fake.gitCalls('push')).toHaveLength(1);
    expect(fake.ghCalls('pr merge')).toHaveLength(0);
  });

  it('refreshed, heavy steps left to CI: merges once Unit Tests passes, recorded as unit=pass', () => {
    recordWork();
    appendRecord(runDir, '3477', { issue: 3477, stage: 'verify', result: 'ok', head: HEAD_A, note: FULL_UNIT });
    const fake = fakeGit({ prs: [openPr()], behind: true, checks: [unitPending, GREEN] });
    expect(runMerge(fake, heavyLock(false)).code).toBe(0);
    expect(fake.ghCalls('pr merge')[0].args).toContain(HEAD_M);
    const ci = readRecords(runDir, '3477').records.filter((r: { stage: string }) => r.stage === 'ci').at(-1);
    expect(ci.note).toContain('unit=pass');
  });

  it('without a refresh, the worker verify ran the full unit: Unit Tests is not waited for, as before — negative control', () => {
    recordWork();
    appendRecord(runDir, '3477', { issue: 3477, stage: 'verify', result: 'ok', head: HEAD_A, note: FULL_UNIT });
    const fake = fakeGit({ prs: [openPr()], behind: false, checks: [unitPending] });
    expect(runMerge(fake, heavyLock(true), '--ci-timeout', '60').code).toBe(0);
    expect(fake.ghCalls('pr merge')[0].args).toContain(HEAD_A);
    const ci = readRecords(runDir, '3477').records.filter((r: { stage: string }) => r.stage === 'ci').at(-1);
    expect(ci.note).toContain('unit=-');
  });
});

/** Whether a run touched any precheck step (tsc is in every precheck). */
const fake0Precheck = (fake: ReturnType<typeof fakeGit>) => fake.calls.some((c) => c.command === 'npx' && c.args[0] === 'tsc');

describe('without a refresh the precheck takes cpu.heavy as before (#4265 negative controls)', () => {
  it('merge-pr without a refresh, on a HEAD with no precheck yet, waits for the lock and holds with exit 3', () => {
    recordWork(HEAD_A, { precheck: false });
    // The options come from another HEAD's precheck=ok.
    appendRecord(runDir, '3477', { issue: 3477, stage: 'precheck', result: 'ok', head: HEAD_B, note: `tsc=ok ${OPTS}` });
    const lock = heavyLock(false);
    const fake = fakeGit({ prs: [openPr()], behind: false, checks: [GREEN] });
    const { code, err } = runMerge(fake, lock);
    expect(code).toBe(3);
    expect(err).toContain('on hold');
    expect(lock.calls.length).toBeGreaterThan(0);
    expect(fake.gitCalls('push')).toHaveLength(0);
    expect(fake.ghCalls('pr merge')).toHaveLength(0);
  });

  it('merge-pr on a refreshed HEAD publish-pr already pushed (no refresh in this run) still takes the lock', () => {
    recordWork();
    const lock = heavyLock(true);
    const fake = fakeGit({
      head: HEAD_M,
      firstParent: [`${HEAD_M} ${HEAD_A} ${DEVELOP}`, `${HEAD_A} ${DEVELOP}`],
      prs: [openPr({ headRefOid: HEAD_M })],
      checks: [GREEN],
    });
    expect(runMerge(fake, lock).code).toBe(0);
    expect(lock.calls).toHaveLength(2);
    expect(vitestCalls(fake)).toEqual(['vitest related', 'vitest run']);
    expect(parseNote(lastPrecheck().note)).toMatchObject({ related: 'ok', tests: 'ok' });
  });

  describe('precheck.mjs itself', () => {
    const preArgv = (...extra: string[]) => ['--run-dir', runDir, '--issues', '3477', '--issue', '3477', '--worktree', worktree, ...extra];
    const runPre = (lock: ReturnType<typeof heavyLock>, fake: ReturnType<typeof fakeGit>, ...extra: string[]) =>
      precheckMain(preArgv(...extra), {
        run: fake.run,
        findTestsNaming: () => manyTests,
        estimateRelatedTests: () => HEAVY_TEST_FILES,
        acquireHeavyLock: lock.acquireHeavyLock,
        home: tmp,
        now: () => new Date(Date.UTC(2026, 10, 8, 3, 0)),
        log: () => {},
        error: () => {},
      });

    it('the first precheck (no --heavy-to-ci) takes the lock and holds with exit 3 while it is held', () => {
      const lock = heavyLock(false);
      expect(runPre(lock, fakeGit())).toBe(EXIT_HELD);
      expect(lock.calls).toHaveLength(1);
      expect(lastPrecheck().result).toBe('skip');
    });

    it('a --heavy-to-ci record is reused only by another --heavy-to-ci precheck; without the flag the heavy steps run', () => {
      expect(runPre(heavyLock(false), fakeGit(), '--heavy-to-ci')).toBe(0);
      const reuse = fakeGit();
      expect(runPre(heavyLock(false), reuse, '--heavy-to-ci')).toBe(0);
      expect(fake0Precheck(reuse)).toBe(false);
      const lock = heavyLock(true);
      const full = fakeGit();
      expect(runPre(lock, full)).toBe(0);
      expect(lock.calls).toHaveLength(2);
      expect(vitestCalls(full)).toEqual(['vitest related', 'vitest run']);
      expect(readRecords(runDir, '3477').records.map((r: { result: string }) => r.result)).toEqual(['ok', 'ok']);
    });

    it('leaves a narrow step to run with --heavy-to-ci: only a step that would take cpu.heavy goes to CI', () => {
      const lock = heavyLock(true);
      const fake = fakeGit();
      const code = precheckMain(preArgv('--heavy-to-ci'), {
        run: fake.run,
        findTestsNaming: () => [],
        estimateRelatedTests: () => 0,
        acquireHeavyLock: lock.acquireHeavyLock,
        home: tmp,
        now: () => new Date(Date.UTC(2026, 10, 8, 3, 0)),
        log: () => {},
        error: () => {},
      });
      expect(code).toBe(0);
      expect(lock.calls).toEqual([]);
      expect(vitestCalls(fake)).toEqual(['vitest related', 'vitest run']);
      expect(parseNote(lastPrecheck().note)).toMatchObject({ related: 'ok', tests: 'ok' });
    });
  });
});
