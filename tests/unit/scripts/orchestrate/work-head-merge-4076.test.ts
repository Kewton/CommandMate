/**
 * The records of a merge the worker resolved a develop conflict in (Issue #4076, part A),
 * and the title of a new PR (part B).
 *
 * W (HEAD_A) is the worker's fix. M (MERGE) merges develop into it; the worker
 * resolved a conflict there (its own edit of src/a.ts) and was verified on M
 * (wait-verify --after-reinstruct, consistency-review --head M). Before #4076
 * workHeads passed over every merge, so publish-pr / merge-pr looked for W's
 * verify and stopped on `verify: no result for aaaaaaa`.
 *
 * git and gh are the fake of ./pr-fake.ts (precheck's own below): nothing is
 * pushed, opened or merged. The run record, the worktree and HOME are under
 * os.tmpdir() and removed after each test.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendRecord, readRecords, summarize } from '../../../../scripts/orchestrate/run-log.mjs';
import { manifestHash, takeManifest } from '../../../../scripts/orchestrate/env-manifest.mjs';
import { mergeOwnFiles, missingRecords, workHeadOf, workHeads } from '../../../../scripts/orchestrate/pr-common.mjs';
import { main as precheck } from '../../../../scripts/orchestrate/precheck.mjs';
import { main as publish, prTitle, withIssueNumber } from '../../../../scripts/orchestrate/publish-pr.mjs';
import { main as merge } from '../../../../scripts/orchestrate/merge-pr.mjs';
import { DEVELOP, HEAD_A, HEAD_B, fakeGit, openPr } from './pr-fake';

const W = HEAD_A;
const X = HEAD_B;
const MERGE = '5'.repeat(40);
const M2 = '2'.repeat(40);
const FOLD = '3'.repeat(40);
const REFRESH = '6'.repeat(40);
const DEVELOP2 = '4'.repeat(40);
const ISSUE = 3477;
const KEY = '3477:3477:t-1:a1';

let tmp: string;
let runDir: string;
let worktree: string;
let home: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-orchestrate-4076-')));
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
const FULL_UNIT = 'exit=0(passed) passed=lint,typecheck,unit failed=-';
const UNIT_RELATED = 'exit=0(passed) passed=lint,typecheck,unit-related failed=-';

/** verify / review / findings on `head` (the worker's checks), optionally of a work item. */
function recordWork(head: string, { verify = 'ok', item, note = FULL_UNIT }: { verify?: string; item?: string; note?: string } = {}) {
  appendRecord(runDir, '3477', { issue: ISSUE, item, stage: 'verify', result: verify, head, note });
  for (const stage of ['review', 'findings']) appendRecord(runDir, '3477', { issue: ISSUE, item, stage, result: 'ok', head });
}
function recordPrecheck(head: string, workHead?: string, item?: string) {
  appendRecord(runDir, '3477', { issue: ISSUE, item, stage: 'precheck', result: 'ok', head, workHead, note: 'tsc=ok tests=ok' });
}

/** M on W: the worker merged develop and resolved a conflict in src/a.ts there (its own edit). */
function workerMerge(extra: Parameters<typeof fakeGit>[0] = {}) {
  return fakeGit({
    head: MERGE,
    firstParent: [`${MERGE} ${W} ${DEVELOP}`, `${W} ${DEVELOP}`],
    commitFiles: { [W]: ['src/a.ts'], [MERGE]: ['src/a.ts'] },
    ...extra,
  });
}

const argv = (...extra: string[]) => ['--run-dir', runDir, '--issues', '3477', '--issue', String(ISSUE), '--worktree', worktree, ...extra];
function runPublish(fake: ReturnType<typeof fakeGit>, ...extra: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = publish(argv(...extra), { run: fake.run, home, log: (l: string) => out.push(l), error: (l: string) => err.push(l) } as Parameters<typeof publish>[1]);
  return { code, out: out.join('\n'), err: err.join('\n') };
}
function runMerge(fake: ReturnType<typeof fakeGit>, ...extra: string[]) {
  const out: string[] = [];
  const code = merge(argv(...extra), {
    run: fake.run, home, sleep: () => {}, now: () => new Date(Date.UTC(2026, 10, 1, 3, 0)),
    findTestsNaming: () => [], log: (l: string) => out.push(l), error: (l: string) => out.push(l),
  } as Parameters<typeof merge>[1]);
  return { code, out: out.join('\n') };
}
const titleCalls = (fake: ReturnType<typeof fakeGit>) => fake.calls.filter((c) => c.command === 'gh' && c.args[0] === 'api');

describe('workHeads: which merge is the work HEAD (#4076)', () => {
  it('a merge with a verify of its own is the work HEAD (positive control: before #4076 it was passed over)', () => {
    recordWork(MERGE);
    const fake = workerMerge();
    expect(workHeads(fake.run, worktree, MERGE, { records: records(), issue: ISSUE, item: null })).toEqual([MERGE]);
  });

  it('a failed verify of the merge marks it too: the pass under it does not cover it', () => {
    recordWork(W);
    recordWork(MERGE, { verify: 'fail' });
    const fake = workerMerge();
    expect(workHeadOf(fake.run, worktree, MERGE, { records: records(), issue: ISSUE, item: null })).toBe(MERGE);
  });

  it('a clean refresh with no verify is passed over as before (negative control)', () => {
    recordWork(W);
    const fake = workerMerge({ commitFiles: { [W]: ['src/a.ts'] } });
    expect(workHeads(fake.run, worktree, MERGE, { records: records(), issue: ISSUE, item: null })).toEqual([MERGE, W]);
    // Without the run record (no context) a clean merge is passed over too.
    expect(workHeads(fake.run, worktree, MERGE)).toEqual([MERGE, W]);
  });

  it('a merge that changed src itself, with no verify of its own, is the work HEAD — W’s pass is not taken for it', () => {
    recordWork(W);
    const fake = workerMerge();
    expect(workHeads(fake.run, worktree, MERGE, { records: records(), issue: ISSUE, item: null })).toEqual([MERGE]);
  });

  it('a merge that edited only ORCHESTRATOR_FILES itself is passed over (the machine resolution of module-reference)', () => {
    const fake = workerMerge({ commitFiles: { [W]: ['src/a.ts'], [MERGE]: ['docs/module-reference.md'] } });
    expect(mergeOwnFiles(fake.run, worktree, MERGE, [W, DEVELOP])).toEqual([]);
    expect(workHeads(fake.run, worktree, MERGE, { records: [], issue: ISSUE, item: null })).toEqual([MERGE, W]);
  });

  it('the fold and a clean refresh on top of the verified merge are passed over down to it', () => {
    recordWork(MERGE);
    const fake = fakeGit({
      head: FOLD,
      firstParent: [`${FOLD} ${REFRESH}`, `${REFRESH} ${MERGE} ${DEVELOP2}`, `${MERGE} ${W} ${DEVELOP}`, `${W} ${DEVELOP}`],
      commitFiles: { [FOLD]: ['docs/module-reference.md'], [W]: ['src/a.ts'], [MERGE]: ['src/a.ts'] },
    });
    expect(workHeads(fake.run, worktree, FOLD, { records: records(), issue: ISSUE, item: null })).toEqual([FOLD, REFRESH, MERGE]);
  });

  it('another work item’s verify of the same merge does not mark it', () => {
    recordWork(MERGE, { item: 'd2' });
    const fake = workerMerge({ commitFiles: { [W]: ['src/a.ts'] } });
    expect(workHeadOf(fake.run, worktree, MERGE, { records: records(), issue: ISSUE, item: null })).toBe(W);
    expect(workHeadOf(fake.run, worktree, MERGE, { records: records(), issue: ISSUE, item: 'd1' })).toBe(W);
    expect(workHeadOf(fake.run, worktree, MERGE, { records: records(), issue: ISSUE, item: 'd2' })).toBe(MERGE);
  });

  it('a git that cannot answer merge-tree reads the merge as before (no edits of its own)', () => {
    const fake = workerMerge();
    const run = (command: string, args: string[]) =>
      command === 'git' && args[2] === 'merge-tree' ? { status: 129, stdout: '', stderr: 'unknown option' } : fake.run(command, args);
    expect(mergeOwnFiles(run, worktree, MERGE, [W, DEVELOP])).toBeNull();
    expect(workHeads(run, worktree, MERGE, { records: [], issue: ISSUE, item: null })).toEqual([MERGE, W]);
  });
});

describe('publish-pr over the worker’s merge (#4076)', () => {
  it('W without verify, M with verify / review / findings and its precheck: nothing is missing, M is published', () => {
    recordWork(MERGE);
    recordPrecheck(MERGE);
    const fake = workerMerge();
    expect(missingRecords(records(), ISSUE, { head: MERGE, workHead: MERGE }, null)).toEqual([]);
    const r = runPublish(fake);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const pr = records().find((x) => x.stage === 'pr');
    expect(pr).toMatchObject({ head: MERGE });
    expect(pr).not.toHaveProperty('workHead');
  });

  it('M’s verify failed after W passed: missing, and nothing is pushed, opened or titled', () => {
    recordWork(W);
    recordPrecheck(W);
    recordWork(MERGE, { verify: 'fail' });
    recordPrecheck(MERGE);
    const fake = workerMerge();
    const r = runPublish(fake);
    expect(r.code).toBe(1);
    expect(r.err).toContain('verify: fail at 5555555');
    expect(fake.gitCalls('push')).toHaveLength(0);
    expect(fake.ghCalls('pr create')).toHaveLength(0);
    expect(titleCalls(fake)).toHaveLength(0);
  });

  it('M needs its own review and findings: W’s do not stand for them', () => {
    recordWork(W);
    appendRecord(runDir, '3477', { issue: ISSUE, stage: 'verify', result: 'ok', head: MERGE, note: FULL_UNIT });
    recordPrecheck(MERGE);
    const r = runPublish(workerMerge());
    expect(r.code).toBe(1);
    expect(r.err).toContain('review: no result for 5555555');
    expect(r.err).toContain('findings: no result for 5555555');
  });

  it('a commit X that changed src after W passed: still missing', () => {
    recordWork(W);
    recordPrecheck(X);
    const fake = fakeGit({ head: X, firstParent: [`${X} ${W}`, `${W} ${DEVELOP}`], commitFiles: { [X]: ['src/b.ts'], [W]: ['src/a.ts'] } });
    const r = runPublish(fake);
    expect(r.code).toBe(1);
    expect(r.err).toContain('verify: no result for bbbbbbb');
    expect(fake.gitCalls('push')).toHaveLength(0);
  });

  it('a later merge M2 that rewrote src after W passed, or after M was verified: still missing', () => {
    recordWork(W);
    recordPrecheck(M2);
    const onW = fakeGit({ head: M2, firstParent: [`${M2} ${W} ${DEVELOP2}`, `${W} ${DEVELOP}`], commitFiles: { [W]: ['src/a.ts'], [M2]: ['src/a.ts'] } });
    let r = runPublish(onW);
    expect(r.code).toBe(1);
    expect(r.err).toContain('verify: no result for 2222222');

    recordWork(MERGE);
    const onM = fakeGit({
      head: M2,
      firstParent: [`${M2} ${MERGE} ${DEVELOP2}`, `${MERGE} ${W} ${DEVELOP}`, `${W} ${DEVELOP}`],
      commitFiles: { [W]: ['src/a.ts'], [MERGE]: ['src/a.ts'], [M2]: ['src/b.ts'] },
    });
    r = runPublish(onM);
    expect(r.code).toBe(1);
    expect(r.err).toContain('verify: no result for 2222222');
    expect(onM.gitCalls('push')).toHaveLength(0);
  });

  it('another work item’s records on M are not this PR’s', () => {
    recordWork(MERGE, { item: 'd2' });
    recordPrecheck(MERGE, undefined, 'd2');
    let r = runPublish(workerMerge());
    expect(r.code).toBe(1);
    expect(r.err).toContain('verify: no result for 5555555');
    r = runPublish(workerMerge(), '--item', 'd1');
    expect(r.code).toBe(1);
    expect(r.err).toContain('verify: no result for 5555555');
  });

  it('the module-reference fold on top of M is passed over: M’s records stand, the fold needs its precheck', () => {
    recordWork(MERGE);
    recordPrecheck(MERGE);
    const fake = fakeGit({
      head: FOLD,
      firstParent: [`${FOLD} ${MERGE}`, `${MERGE} ${W} ${DEVELOP}`, `${W} ${DEVELOP}`],
      commitFiles: { [FOLD]: ['docs/module-reference.md'], [W]: ['src/a.ts'], [MERGE]: ['src/a.ts'] },
    });
    let r = runPublish(fake);
    expect(r.code).toBe(1);
    expect(r.err).toContain('precheck: no result for 3333333');
    expect(r.err).not.toContain('verify:');
    recordPrecheck(FOLD, MERGE);
    r = runPublish(fake);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(records().find((x) => x.stage === 'pr')).toMatchObject({ head: FOLD, workHead: MERGE });
  });

  it('the fold on top of W still reads W’s records (negative control)', () => {
    recordWork(W);
    recordPrecheck(FOLD, W);
    const fake = fakeGit({
      head: FOLD,
      firstParent: [`${FOLD} ${W}`, `${W} ${DEVELOP}`],
      commitFiles: { [FOLD]: ['docs/module-reference.md'], [W]: ['src/a.ts'] },
    });
    expect(runPublish(fake).code).toBe(0);
  });
});

describe('run-log status agrees with publish-pr on the same records (#4076)', () => {
  beforeEach(() => {
    for (const stage of ['contract', 'send']) appendRecord(runDir, '3477', { issue: ISSUE, stage, result: 'ok' });
  });
  /** The records as the scripts write them: precheck carries workHeadOf's answer (precheck.mjs). */
  function judge(fake: ReturnType<typeof fakeGit>, head: string) {
    const all = records();
    const workHead = workHeadOf(fake.run, worktree, head, { records: all, issue: ISSUE, item: null });
    const missing = missingRecords(all, ISSUE, { head, workHead }, null);
    const [status] = summarize(all);
    return { workHead, missing, status };
  }

  it('M verified and prechecked: status says the PR is next, publish lacks nothing', () => {
    recordWork(W, { verify: 'fail' });
    recordWork(MERGE);
    const fake = workerMerge();
    recordPrecheck(MERGE, workHeadOf(fake.run, worktree, MERGE, { records: records(), issue: ISSUE, item: null }));
    const { workHead, missing, status } = judge(fake, MERGE);
    expect(workHead).toBe(MERGE);
    expect(missing).toEqual([]);
    expect(status).toMatchObject({ head: MERGE, workHead: MERGE, next: 'pr' });
  });

  it('M’s verify failed: both stop at verify', () => {
    recordWork(W);
    recordPrecheck(W);
    recordWork(MERGE, { verify: 'fail' });
    const fake = workerMerge();
    const { missing, status } = judge(fake, MERGE);
    expect(status).toMatchObject({ head: MERGE, next: 'verify' });
    expect(status.reason).toBe('verify: fail at 5555555');
    expect(missing[0]).toMatch(/^verify: fail at 5555555/);
  });

  it('a clean refresh R on top of M: both read M’s checks and R’s precheck', () => {
    recordWork(MERGE);
    recordPrecheck(MERGE);
    const fake = fakeGit({
      head: REFRESH,
      firstParent: [`${REFRESH} ${MERGE} ${DEVELOP2}`, `${MERGE} ${W} ${DEVELOP}`, `${W} ${DEVELOP}`],
      commitFiles: { [W]: ['src/a.ts'], [MERGE]: ['src/a.ts'] },
    });
    recordPrecheck(REFRESH, workHeadOf(fake.run, worktree, REFRESH, { records: records(), issue: ISSUE, item: null }));
    const { workHead, missing, status } = judge(fake, REFRESH);
    expect(workHead).toBe(MERGE);
    expect(missing).toEqual([]);
    expect(status).toMatchObject({ head: REFRESH, workHead: MERGE, next: 'pr' });
  });
});

describe('precheck.mjs on the worker’s merge (#4076)', () => {
  function runPrecheck(head: string) {
    const out: string[] = [];
    const fake = workerMerge({ head });
    const deps = {
      run: (command: string, args: string[]) => {
        if (command !== 'git') return { status: 0, stdout: '', stderr: '' };
        const sub = args.slice(2);
        if (sub[0] === 'rev-parse' || sub[0] === 'log' || sub[0] === 'merge-tree' || sub[0] === 'diff-tree') return fake.run(command, args);
        if (sub.includes('--diff-filter=ACMR')) return { status: 0, stdout: 'src/a.ts\n', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      },
      findTestsNaming: () => [],
      now: () => new Date(Date.UTC(2026, 10, 1, 2, 0)),
      home,
      log: (line: string) => out.push(line),
      error: (line: string) => out.push(line),
    };
    const code = precheck(argv('--force'), deps);
    return { code, out: out.join('\n') };
  }

  it('reuses the verify of the same HEAD (M) for lint and records M as its own work HEAD', () => {
    recordWork(MERGE, { note: 'exit=0(passed) passed=lint,typecheck failed=-' });
    const r = runPrecheck(MERGE);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/lint ok \(verify passed lint at 5555555\)/);
    const rec = records().find((x) => x.stage === 'precheck');
    expect(rec).toMatchObject({ head: MERGE, result: 'ok' });
    expect(rec).not.toHaveProperty('workHead');
  });
});

describe('merge-pr over the worker’s merge (#4076)', () => {
  const PASS = (name: string) => ({ name, bucket: 'pass' });

  it('reads M’s verify for the first look and for whether to wait for Unit Tests', () => {
    recordWork(MERGE, { note: FULL_UNIT });
    recordPrecheck(MERGE);
    const fake = workerMerge({ prs: [openPr({ headRefOid: MERGE })], checks: [[PASS('Lint'), PASS('Build')]] });
    const r = runMerge(fake);
    expect(r.code, r.out).toBe(0);
    expect(fake.ghCalls('pr merge')).toHaveLength(1);
    expect(records().find((x) => x.stage === 'merge')).toMatchObject({ result: 'ok', head: MERGE });
  });

  it('M’s verify ran unit-related while W’s ran the full suite: it waits for Unit Tests (M’s record, not W’s)', () => {
    recordWork(W, { note: FULL_UNIT });
    recordWork(MERGE, { note: UNIT_RELATED });
    recordPrecheck(MERGE);
    const fake = workerMerge({ prs: [openPr({ headRefOid: MERGE })], checks: [[PASS('Lint'), PASS('Build')]] });
    const r = runMerge(fake, '--ci-timeout', '0');
    expect(r.code).toBe(124);
    expect(r.out).toMatch(/waiting for Unit Tests/);
    expect(fake.ghCalls('pr merge')).toHaveLength(0);
  });

  it('M’s verify failed after W passed: not merged, nothing pushed', () => {
    recordWork(W);
    recordPrecheck(W);
    recordWork(MERGE, { verify: 'fail' });
    recordPrecheck(MERGE);
    const fake = workerMerge({ prs: [openPr({ headRefOid: MERGE })], checks: [[PASS('Lint'), PASS('Build'), PASS('Unit Tests')]] });
    const r = runMerge(fake);
    expect(r.code).toBe(1);
    expect(r.out).toContain('verify: fail at 5555555');
    expect(fake.gitCalls('push')).toHaveLength(0);
    expect(fake.ghCalls('pr merge')).toHaveLength(0);
  });

  describe('the environment of M’s verify, on its own key and env=', () => {
    /** The verify record wait-verify.mjs writes on M: env=<hash> and the manifest kept under its key. */
    function recordEnvVerify({ keep = true } = {}) {
      const manifest = takeManifest({ worktree, home });
      if (keep) fs.writeFileSync(path.join(runDir, 'wait-3477.env.json'), `${JSON.stringify({ key: KEY, start: manifest, verify: manifest, end: manifest }, null, 2)}\n`);
      appendRecord(runDir, '3477', {
        issue: ISSUE, stage: 'verify', result: 'ok', head: MERGE, key: KEY,
        note: `exit=0(passed) result=passed passed=lint,typecheck,unit failed=- key=${KEY} env=${manifestHash(manifest)}`,
      });
      for (const stage of ['review', 'findings']) appendRecord(runDir, '3477', { issue: ISSUE, stage, result: 'ok', head: MERGE });
      recordPrecheck(MERGE);
    }
    /** R (a refresh of M, pushed earlier) is the HEAD; its precheck failed once. */
    function refreshed() {
      appendRecord(runDir, '3477', { issue: ISSUE, stage: 'precheck', result: 'fail', head: REFRESH, workHead: MERGE, note: 'tests=fail' });
      return fakeGit({
        head: REFRESH,
        firstParent: [`${REFRESH} ${MERGE} ${DEVELOP2}`, `${MERGE} ${W} ${DEVELOP}`, `${W} ${DEVELOP}`],
        commitFiles: { [W]: ['src/a.ts'], [MERGE]: ['src/a.ts'] },
        changed: ['src/a.ts'],
        prs: [openPr({ headRefOid: REFRESH })],
        checks: [[PASS('Lint'), PASS('Build'), PASS('Unit Tests')]],
      });
    }
    const lockfile = () => fs.writeFileSync(path.join(worktree, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}\n');

    it('only the dependencies differ: deferred to the precheck of R, then judged again and merged', () => {
      recordEnvVerify();
      lockfile();
      const fake = refreshed();
      const r = runMerge(fake);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toMatch(/verify at 5555555: .*lockfile — waits for the precheck of 6666666/);
      const prechecksOfR = records().filter((x) => x.stage === 'precheck' && x.head === REFRESH);
      expect(prechecksOfR.map((x) => x.result)).toEqual(['fail', 'ok']);
      expect(prechecksOfR[1]).toMatchObject({ workHead: MERGE });
      expect(fake.ghCalls('pr merge')).toHaveLength(1);
    });

    it('a changed setting is not deferred: not merged', () => {
      recordEnvVerify();
      fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{"model":"fable"}\n');
      const fake = refreshed();
      const r = runMerge(fake);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/verify: environment changed — .*globalModel/);
      expect(fake.ghCalls('pr merge')).toHaveLength(0);
    });

    it('a manifest that is not kept: not merged', () => {
      recordEnvVerify({ keep: false });
      const fake = refreshed();
      const r = runMerge(fake);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/verify: environment missing — env=/);
      expect(fake.ghCalls('pr merge')).toHaveLength(0);
    });
  });
});

describe('publish-pr: the title of a new PR (#4076 B)', () => {
  const titleOf = (fake: ReturnType<typeof fakeGit>) => {
    const args = fake.ghCalls('pr create')[0].args;
    return args[args.indexOf('--title') + 1];
  };
  function ready() {
    recordWork(W);
    recordPrecheck(W);
  }
  const subjectFake = (extra: Parameters<typeof fakeGit>[0] = {}) =>
    fakeGit({ subjects: { [W]: 'fix: lastSend の要求の番号による比較を取り消す' }, issueTitle: 'fix(session): 最初の送信の提出判定の残り', ...extra });

  it('without --title: the Issue’s title with (#N), not the last commit’s subject (positive control)', () => {
    ready();
    const fake = subjectFake();
    expect(runPublish(fake).code).toBe(0);
    expect(titleOf(fake)).toBe('fix(session): 最初の送信の提出判定の残り (#3477)');
    // Read before the push.
    const order = fake.calls.map((c) => (c.command === 'gh' && c.args[0] === 'api' ? 'title' : c.command === 'git' && c.args[2] === 'push' ? 'push' : null)).filter(Boolean);
    expect(order).toEqual(['title', 'push']);
  });

  it('an Issue title that already names (#N) is not given it twice', () => {
    ready();
    const fake = subjectFake({ issueTitle: 'fix(session): 残り (#3477)' });
    expect(runPublish(fake).code).toBe(0);
    expect(titleOf(fake)).toBe('fix(session): 残り (#3477)');
    expect(withIssueNumber('x (#3477)', 3477)).toBe('x (#3477)');
    expect(withIssueNumber('x (#34770)', 3477)).toBe('x (#34770) (#3477)');
  });

  it('--title is used as given and the Issue’s title is not read', () => {
    ready();
    const fake = subjectFake();
    expect(runPublish(fake, '--title', 'chosen').code).toBe(0);
    expect(titleOf(fake)).toBe('chosen');
    expect(titleCalls(fake)).toHaveLength(0);
  });

  it('an open PR keeps its title: the Issue’s title is not read', () => {
    ready();
    const fake = subjectFake({ prs: [openPr()] });
    expect(runPublish(fake).code).toBe(0);
    expect(titleCalls(fake)).toHaveLength(0);
    expect(fake.ghCalls('pr create')).toHaveLength(0);
  });

  it('a title that cannot be read stops before the push (exit 1), asking for --title', () => {
    ready();
    const fake = subjectFake({ issueTitle: null });
    const r = runPublish(fake);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/could not read the title of #3477: .*pass --title; not pushed/);
    expect(fake.gitCalls('push')).toHaveLength(0);
    expect(fake.ghCalls('pr create')).toHaveLength(0);
    expect(records().filter((x) => x.stage === 'pr')).toHaveLength(0);
    // An empty title is not one either.
    expect(prTitle(subjectFake({ issueTitle: '  ' }).run, { repo: 'Kewton/CommandMate' }, ISSUE)).toMatchObject({ error: expect.stringMatching(/no title/) });
  });

  it('a work item’s PR (--item) is named the same way', () => {
    for (const stage of ['verify', 'review', 'findings', 'precheck']) {
      appendRecord(runDir, '3477', { issue: ISSUE, item: 'd1', stage, result: 'ok', head: W, note: stage === 'verify' ? FULL_UNIT : '' });
    }
    fs.writeFileSync(path.join(worktree, 'dev-reports', 'module-reference', 'issue-3477.md'), '追記なし\n');
    const fake = subjectFake();
    const r = runPublish(fake, '--item', 'd1');
    expect(r.err).toBe('');
    expect(titleOf(fake)).toBe('fix(session): 最初の送信の提出判定の残り (#3477)');
  });
});
