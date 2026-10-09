/**
 * scripts/orchestrate/merge-pr.mjs — refresh, wait for CI, merge once (Issue #3477, PR 3).
 *
 * `git`, `gh` and `npx` are the fake of ./pr-fake.ts: nothing is pushed,
 * re-run or merged. The run record and dev-reports/ are under os.tmpdir().
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendRecord, readRecords, summarize } from '../../../../scripts/orchestrate/run-log.mjs';
import { judgeChecks, judgedByUnitRelated, main, parseArgs, runIdsOf, validate } from '../../../../scripts/orchestrate/merge-pr.mjs';
import { workHeads } from '../../../../scripts/orchestrate/pr-common.mjs';
import { DEVELOP, HEAD_A, HEAD_B, HEAD_M, type Check, fakeGit, openPr } from './pr-fake';

let tmp: string;
let runDir: string;
let worktree: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-orchestrate-merge-'));
  runDir = path.join(tmp, 'runs', '2026-10-09');
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
const fail = (name: string): Check => ({ name, bucket: 'fail', link: RUN_LINK });
const GREEN = [pass('Lint'), pass('Build'), pass('Unit Tests')];

const argv = (...extra: string[]) => ['--run-dir', runDir, '--issues', '3477', '--issue', '3477', '--worktree', worktree, ...extra];

function recordReady(head = HEAD_A, { verifyNote = 'exit=0(passed) passed=lint,typecheck failed=-', review = 'ok' } = {}) {
  appendRecord(runDir, '3477', { issue: 3477, stage: 'verify', result: 'ok', head, note: verifyNote });
  appendRecord(runDir, '3477', { issue: 3477, stage: 'review', result: review, head });
  appendRecord(runDir, '3477', { issue: 3477, stage: 'findings', result: 'ok', head });
  appendRecord(runDir, '3477', { issue: 3477, stage: 'precheck', result: 'ok', head, note: 'tsc=ok tests=ok' });
}

function runMain(fake: ReturnType<typeof fakeGit>, ...extra: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  let clock = Date.UTC(2026, 9, 9, 3, 0);
  const code = main(argv(...extra), {
    run: fake.run,
    sleep: (ms: number) => {
      clock += ms;
    },
    now: () => new Date(clock),
    findTestsNaming: () => ['tests/unit/scripts/orchestrate/orchestrate-md-calls.test.ts'],
    log: (l: string) => out.push(l),
    error: (l: string) => err.push(l),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const stages = () => readRecords(runDir, '3477').records.map((r) => `${r.stage}=${r.result}`);

describe('judgeChecks (6-3)', () => {
  const need = { needBuild: true, needUnit: false, last: false };

  it('fails on fail or cancel in bucket', () => {
    expect(judgeChecks([pass('Build'), fail('Lint')], need).state).toBe('fail');
    expect(judgeChecks([pass('Build'), { name: 'Lint', bucket: 'cancel' }], need).state).toBe('fail');
  });

  it('waits for Build, and for Unit Tests only when the test gate was unit-related', () => {
    expect(judgeChecks([pending('Build'), pending('Unit Tests')], need)).toMatchObject({ state: 'pending', waiting: ['Build'] });
    expect(judgeChecks([pass('Build'), pending('Unit Tests')], need).state).toBe('ok');
    expect(judgeChecks([pass('Build'), pending('Unit Tests')], { ...need, needUnit: true }).waiting).toEqual(['Unit Tests']);
    expect(judgeChecks([pending('Build')], { ...need, needBuild: false }).state).toBe('ok');
  });

  it('waits for every check of the last PR, skipping counts as settled', () => {
    const checks = [pass('Build'), { name: 'E2E', bucket: 'skipping' }, pending('Integration Tests')];
    expect(judgeChecks(checks, { ...need, last: true }).waiting).toEqual(['Integration Tests']);
    expect(judgeChecks([pass('Build'), { name: 'E2E', bucket: 'skipping' }], { ...need, last: true }).state).toBe('ok');
  });

  it('treats no checks yet as pending', () => {
    expect(judgeChecks([], need).state).toBe('pending');
  });

  it('reads run ids and the unit-related verdict', () => {
    expect(runIdsOf([fail('A'), fail('B'), { name: 'C', bucket: 'fail' }])).toEqual(['555']);
    expect(judgedByUnitRelated({ result: 'ok', note: 'passed=lint,unit-related@contract failed=-' })).toBe(true);
    expect(judgedByUnitRelated({ result: 'ok', note: 'passed=lint,typecheck failed=-' })).toBe(false);
  });
});

describe('workHeads', () => {
  it('walks back over merges of develop and the module-reference fold to the worker commit', () => {
    const fold = 'e'.repeat(40);
    const fake = fakeGit({
      firstParent: [`${fold} ${HEAD_M}`, `${HEAD_M} ${HEAD_A} ${DEVELOP}`, `${HEAD_A} ${HEAD_B}`, `${HEAD_B} ${DEVELOP}`],
      commitFiles: { [fold]: ['docs/module-reference.md'], [HEAD_A]: ['src/a.ts'] },
    });
    expect(workHeads(fake.run, worktree, fold)).toEqual([fold, HEAD_M, HEAD_A]);
  });
});

describe('parseArgs', () => {
  it('closes the Issue by default, - keeps it open', () => {
    const base = ['--run-dir', 'r', '--issues', '1', '--issue', '3477', '--worktree', '/w'];
    expect(parseArgs(base).options?.close).toBe('3477');
    expect(parseArgs([...base, '--close', '-']).options?.close).toBe('-');
    expect(validate(parseArgs([...base, '--close', 'x']).options)).toMatch(/--close/);
    expect(validate(parseArgs([...base, '--ci-timeout', '1h']).options)).toMatch(/--ci-timeout/);
    expect(main([...base, '--close', 'x'], { error: () => {} })).toBe(2);
    expect(parseArgs([...base, '--last', '--unit-related']).options).toMatchObject({ last: true, unitRelated: true });
  });
});

describe('main: stops before merging', () => {
  it('stops when the review record is missing for this HEAD (positive control)', () => {
    appendRecord(runDir, '3477', { issue: 3477, stage: 'verify', result: 'ok', head: HEAD_A });
    appendRecord(runDir, '3477', { issue: 3477, stage: 'findings', result: 'ok', head: HEAD_A });
    appendRecord(runDir, '3477', { issue: 3477, stage: 'precheck', result: 'ok', head: HEAD_A });
    const fake = fakeGit({ prs: [openPr()], checks: [GREEN] });
    const { code, err } = runMain(fake);
    expect(code).toBe(1);
    expect(err).toContain('review: no record for aaaaaaa (5-2b)');
    expect(fake.ghCalls('pr merge')).toHaveLength(0);
    expect(fake.gitCalls('fetch')).toHaveLength(0);
  });

  it('accepts review=skip for an Issue 5-2b does not cover', () => {
    recordReady(HEAD_A, { review: 'skip' });
    expect(runMain(fakeGit({ prs: [openPr()], checks: [GREEN] })).code).toBe(0);
  });

  it('stops on verify=fail recorded after verify=ok', () => {
    recordReady();
    appendRecord(runDir, '3477', { issue: 3477, stage: 'verify', result: 'fail', head: HEAD_A });
    const fake = fakeGit({ prs: [openPr()], checks: [GREEN] });
    const { code, err } = runMain(fake);
    expect(code).toBe(1);
    expect(err).toContain('verify: fail at aaaaaaa');
  });

  it('does not merge with fail in the checks after one re-run of the failed jobs', () => {
    recordReady();
    const fake = fakeGit({ prs: [openPr()], checks: [[pass('Build'), fail('Lint')]] });
    const { code, err } = runMain(fake);
    expect(code).toBe(1);
    expect(err).toContain('Lint:fail');
    expect(fake.ghCalls('run rerun')).toHaveLength(1);
    expect(fake.ghCalls('run rerun')[0].args).toEqual(['run', 'rerun', '555', '--failed', '--repo', 'Kewton/CommandMate']);
    expect(fake.ghCalls('pr merge')).toHaveLength(0);
    expect(stages()).toEqual(['verify=ok', 'review=ok', 'findings=ok', 'precheck=ok', 'ci=fail', 'ci=fail']);
  });

  it('does not re-run again when run again after the re-run was recorded', () => {
    recordReady();
    const first = fakeGit({ prs: [openPr()], checks: [[fail('Lint')]] });
    runMain(first);
    const second = fakeGit({ prs: [openPr()], checks: [[fail('Lint')]] });
    expect(runMain(second).code).toBe(1);
    expect(second.ghCalls('run rerun')).toHaveLength(0);
  });

  it('merges when the re-run passes', () => {
    recordReady();
    const fake = fakeGit({ prs: [openPr()], checks: [[pass('Build'), fail('Lint')], [pass('Build'), pending('Lint')], GREEN] });
    expect(runMain(fake).code).toBe(0);
    expect(fake.ghCalls('pr merge')).toHaveLength(1);
  });

  it('waits for Build, and gives up with 124 at the CI timeout', () => {
    recordReady();
    const fake = fakeGit({ prs: [openPr()], checks: [[pending('Build'), pass('Lint')]] });
    const { code, err } = runMain(fake, '--ci-timeout', '120', '--poll', '30');
    expect(code).toBe(124);
    expect(err).toContain('waiting for Build');
    expect(fake.ghCalls('pr merge')).toHaveLength(0);
  });

  it('does not wait for Build when the precheck of this HEAD has build=ok', () => {
    recordReady();
    appendRecord(runDir, '3477', { issue: 3477, stage: 'precheck', result: 'ok', head: HEAD_A, note: 'tsc=ok build=ok' });
    const fake = fakeGit({ prs: [openPr()], checks: [[pending('Build'), pass('Lint')]] });
    expect(runMain(fake).code).toBe(0);
  });

  it('waits for Unit Tests when verify passed unit-related', () => {
    recordReady(HEAD_A, { verifyNote: 'exit=0(passed) passed=lint,typecheck,unit-related@contract failed=-' });
    const fake = fakeGit({ prs: [openPr()], checks: [[pass('Build'), pending('Unit Tests')]] });
    expect(runMain(fake, '--ci-timeout', '60').code).toBe(124);
  });

  it('aborts a conflicting refresh and leaves it to the orchestrator', () => {
    recordReady();
    const fake = fakeGit({ prs: [openPr()], behind: true, mergeConflict: ['src/a.ts'], checks: [GREEN] });
    const { code, err } = runMain(fake);
    expect(code).toBe(1);
    expect(err).toContain('conflicts in src/a.ts');
    expect(fake.calls.some((c) => c.command === 'git' && c.args.includes('--abort'))).toBe(true);
    expect(fake.gitCalls('push')).toHaveLength(0);
  });

  it('does not push a refresh with conflict markers or a tsc failure', () => {
    recordReady();
    const marked = fakeGit({ prs: [openPr()], behind: true, markers: 'src/lib/x.ts\n', checks: [GREEN] });
    expect(runMain(marked).code).toBe(1);
    expect(marked.gitCalls('push')).toHaveLength(0);
    const broken = fakeGit({ prs: [openPr()], behind: true, failCommands: ['npx tsc'], checks: [GREEN] });
    expect(runMain(broken).code).toBe(1);
    expect(broken.gitCalls('push')).toHaveLength(0);
    expect(stages().filter((s) => s.startsWith('merge'))).toEqual(['merge=fail', 'merge=fail']);
  });
});

describe('main: merges once', () => {
  it('merges the HEAD with --squash and closes the Issue (negative control)', () => {
    recordReady();
    const fake = fakeGit({ prs: [openPr()], checks: [GREEN] });
    expect(runMain(fake).code).toBe(0);
    const merge = fake.ghCalls('pr merge');
    expect(merge).toHaveLength(1);
    expect(merge[0].args).toEqual(['pr', 'merge', '4242', '--repo', 'Kewton/CommandMate', '--squash', '--match-head-commit', HEAD_A]);
    expect(merge[0].args).not.toContain('--auto');
    expect(fake.ghCalls('issue close')).toHaveLength(1);
    expect(fake.gitCalls('push')).toHaveLength(0);
    expect(summarize(readRecords(runDir, '3477').records)[0]).toMatchObject({ reached: 'merge', next: null });
  });

  it('keeps the Issue open with --close -', () => {
    recordReady();
    const fake = fakeGit({ prs: [openPr()], checks: [GREEN] });
    expect(runMain(fake, '--close', '-').code).toBe(0);
    expect(fake.ghCalls('issue')).toHaveLength(0);
  });

  it('does not merge twice: a rerun records the merge once and only closes the Issue', () => {
    recordReady();
    const fake = fakeGit({ prs: [openPr()], checks: [GREEN] });
    expect(runMain(fake).code).toBe(0);
    fake.state.issueState = 'OPEN'; // the first run died before closing
    expect(runMain(fake).code).toBe(0);
    expect(runMain(fake).code).toBe(0);
    expect(fake.ghCalls('pr merge')).toHaveLength(1);
    expect(fake.ghCalls('issue close')).toHaveLength(2);
    expect(stages().filter((s) => s === 'merge=ok')).toHaveLength(1);
  });

  it('records a merge it finds done (a crash after gh pr merge) without merging', () => {
    const fake = fakeGit({ prs: [openPr({ state: 'MERGED' })] });
    const { code, out } = runMain(fake);
    expect(code).toBe(0);
    expect(out).toContain('already merged');
    expect(fake.ghCalls('pr merge')).toHaveLength(0);
    expect(stages()).toEqual(['merge=ok']);
  });

  it('refreshes a PR behind develop: sweep, tsc, the PR tests with CI=true, push, then merges the new HEAD', () => {
    recordReady();
    const fake = fakeGit({ prs: [openPr()], behind: true, checks: [GREEN] });
    const { code } = runMain(fake);
    expect(code).toBe(0);
    expect(fake.calls.find((c) => c.command === 'git' && c.args[2] === 'grep')?.args).toEqual(
      ['-C', worktree, 'grep', '-l', '-E', '^(<<<<<<< |>>>>>>> |={7}$)', '--', '.']
    );
    const vitest = fake.calls.find((c) => c.command === 'npx' && c.args[0] === 'vitest');
    expect(vitest?.args).toEqual([
      'vitest', 'run', 'tests/unit/scripts/orchestrate/merge-pr.test.ts', 'tests/unit/scripts/orchestrate/orchestrate-md-calls.test.ts',
    ]);
    expect(vitest?.env).toEqual({ CI: 'true' });
    expect(fake.gitCalls('push')[0].args).toEqual(['-C', worktree, 'push', 'origin', 'HEAD:feature/3477-worktree']);
    expect(fake.ghCalls('pr merge')[0].args).toContain(HEAD_M);
  });

  it('a precheck build=ok of the pre-refresh HEAD does not waive Build for the merged HEAD', () => {
    recordReady();
    appendRecord(runDir, '3477', { issue: 3477, stage: 'precheck', result: 'ok', head: HEAD_A, note: 'build=ok' });
    const fake = fakeGit({ prs: [openPr()], behind: true, checks: [[pending('Build')]] });
    expect(runMain(fake, '--ci-timeout', '60').code).toBe(124);
  });

  it('waits for every check with --last', () => {
    recordReady();
    const fake = fakeGit({ prs: [openPr()], checks: [[...GREEN, pending('Integration Tests')]] });
    expect(runMain(fake, '--last', '--ci-timeout', '60').code).toBe(124);
    const done = fakeGit({ prs: [openPr()], checks: [[...GREEN, pending('Integration Tests')], [...GREEN, pass('Integration Tests')]] });
    expect(runMain(done, '--last').code).toBe(0);
  });
});
