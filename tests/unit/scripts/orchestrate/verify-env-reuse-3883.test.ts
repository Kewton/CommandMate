/**
 * A passed verify is used only in the environment it was taken in (Issue #3883 N3).
 *
 * wait-verify.mjs records `env=<hash>` and keeps the manifest under the
 * execution key (`<log>.env.json`); precheck's reuse of the verify's gates and
 * publish / merge (pr-common.mjs missingRecords) compare it with the worktree
 * now. A record without `env=` (taken before #3883 H-8) is used as before, with
 * a warning. git and gh are the fake of ./pr-fake.ts (precheck's own fake
 * below); the worktree, HOME and the run record are under os.tmpdir().
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendRecord } from '../../../../scripts/orchestrate/run-log.mjs';
import { FOLLOWS_HEAD, manifestHash, takeManifest, verifyEnvState } from '../../../../scripts/orchestrate/env-manifest.mjs';
import { missingRecords } from '../../../../scripts/orchestrate/pr-common.mjs';
import { main as precheck } from '../../../../scripts/orchestrate/precheck.mjs';
import { main as publish } from '../../../../scripts/orchestrate/publish-pr.mjs';
import { main as merge } from '../../../../scripts/orchestrate/merge-pr.mjs';
import { HEAD_A, HEAD_B, fakeGit, openPr } from './pr-fake';

const KEY = '3477:3477:t-1:a1';
let tmp: string;
let runDir: string;
let worktree: string;
let home: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-verify-env-')));
  runDir = path.join(tmp, 'runs', '2026-10-25');
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

/** The verify record wait-verify.mjs writes: `env=<hash>` and the manifest kept under its key. */
function recordVerify(head = HEAD_A, { withEnv = true, keep = true } = {}) {
  const manifest = takeManifest({ worktree, home });
  if (keep) fs.writeFileSync(path.join(runDir, 'wait-3477.env.json'), `${JSON.stringify({ key: KEY, start: manifest, verify: manifest, end: manifest }, null, 2)}\n`);
  const env = withEnv ? ` env=${manifestHash(manifest)}` : '';
  appendRecord(runDir, '3477', {
    issue: 3477, stage: 'verify', result: 'ok', head, key: KEY,
    note: `exit=0(passed) result=passed passed=work-evidence,scope,lint,typecheck failed=- key=${KEY}${env} auto-yes=off`,
  });
}
function recordRest(head = HEAD_A) {
  for (const stage of ['review', 'findings', 'precheck']) appendRecord(runDir, '3477', { issue: 3477, stage, result: 'ok', head, note: stage === 'precheck' ? 'tsc=ok tests=ok' : '' });
}
const globalModel = (model: string) => fs.writeFileSync(path.join(home, '.claude', 'settings.json'), `{"model":"${model}"}\n`);
const lockfile = () => fs.writeFileSync(path.join(worktree, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}\n');
const latestVerify = () => JSON.parse(fs.readFileSync(fs.readdirSync(runDir).filter((f) => f.startsWith('run-')).map((f) => path.join(runDir, f))[0], 'utf8').trim().split('\n').pop()!);

/**
 * precheck.mjs at `head` with a fake git and fake checks; `during` runs inside the first check (an input that
 * moves while the precheck runs).
 */
function runPrecheck({ head = HEAD_A, force = true, during }: { head?: string; force?: boolean; during?: () => void } = {}) {
  const out: string[] = [];
  const checks: string[] = [];
  const deps = {
    run: (command: string, args: string[]) => {
      if (command === 'git') {
        const sub = args.slice(2);
        if (sub[0] === 'rev-parse') return { status: 0, stdout: `${head}\n`, stderr: '' };
        if (sub[0] === 'log') return { status: 0, stdout: `${head} ${'f'.repeat(40)}\n`, stderr: '' };
        if (sub[0] === 'diff-tree') return { status: 0, stdout: 'src/a.ts\n', stderr: '' };
        if (sub.includes('--diff-filter=ACMR')) return { status: 0, stdout: 'src/a.ts\n', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      }
      if (checks.length === 0) during?.();
      checks.push(args[0]);
      return { status: 0, stdout: '', stderr: '' };
    },
    findTestsNaming: () => [],
    now: () => new Date(Date.UTC(2026, 9, 25, 2, 0)),
    home,
    log: (line: string) => out.push(line),
    error: (line: string) => out.push(line),
  };
  const code = precheck(['--run-dir', runDir, '--issues', '3477', '--issue', '3477', '--worktree', worktree, ...(force ? ['--force'] : [])], deps);
  return { code, out: out.join('\n'), checks };
}
const allRecords = () =>
  fs.readdirSync(runDir).filter((f) => f.startsWith('run-')).flatMap((f) =>
    fs.readFileSync(path.join(runDir, f), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  );

describe('verifyEnvState', () => {
  const where = () => ({ runDir, worktree, home });

  it('same environment: same; a changed input: changed, naming it', () => {
    recordVerify();
    expect(verifyEnvState(latestVerify(), where()).state).toBe('same');
    globalModel('fable');
    expect(verifyEnvState(latestVerify(), where())).toMatchObject({ state: 'changed', fields: ['globalModel'] });
  });

  it('a record without env= (before H-8) is unrecorded; env= whose manifest is not kept is missing', () => {
    recordVerify(HEAD_A, { withEnv: false });
    expect(verifyEnvState(latestVerify(), where()).state).toBe('unrecorded');
    fs.rmSync(runDir, { recursive: true });
    fs.mkdirSync(runDir);
    recordVerify(HEAD_A, { keep: false });
    expect(verifyEnvState(latestVerify(), where()).state).toBe('missing');
  });

  it('a manifest kept under another key is not this record’s', () => {
    recordVerify();
    const file = path.join(runDir, 'wait-3477.env.json');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(KEY, '3477:3477:t-9:a1'));
    expect(verifyEnvState(latestVerify(), where()).state).toBe('missing');
  });

  it('the lockfile is left out only when the caller says another check covers it; the models never (#3883 N9)', () => {
    recordVerify();
    lockfile();
    // A HEAD difference alone no longer leaves anything out.
    expect(verifyEnvState(latestVerify(), where())).toMatchObject({ state: 'changed', fields: ['lockfile'] });
    expect(verifyEnvState(latestVerify(), { ...where(), ignore: FOLLOWS_HEAD }).state).toBe('same');
    globalModel('fable');
    expect(verifyEnvState(latestVerify(), { ...where(), ignore: FOLLOWS_HEAD })).toMatchObject({ state: 'changed', fields: ['globalModel'] });
  });
});

describe('precheck: the verify’s gates are reused only in the same environment', () => {
  const run = () => runPrecheck();

  it('same environment: lint / typecheck are not repeated (negative control)', () => {
    recordVerify();
    const r = run();
    expect(r.code).toBe(0);
    expect(r.checks).not.toContain('tsc');
    expect(r.out).toMatch(/tsc ok \(verify passed typecheck at aaaaaaa\)/);
  });

  it('the global model changed since the verify: they run again', () => {
    recordVerify();
    globalModel('fable');
    const r = run();
    expect(r.checks).toContain('tsc');
    expect(r.checks).toContain('eslint');
    expect(r.out).toMatch(/verify at aaaaaaa not reused: environment changed — .*globalModel/);
  });

  it('env= without its manifest: they run again; a record from before env=: reused, with a warning', () => {
    recordVerify(HEAD_A, { keep: false });
    expect(run().checks).toContain('tsc');
    fs.rmSync(runDir, { recursive: true });
    fs.mkdirSync(runDir);
    recordVerify(HEAD_A, { withEnv: false });
    const legacy = run();
    expect(legacy.checks).not.toContain('tsc');
    expect(legacy.out).toMatch(/warning: verify at aaaaaaa: no env= in the record/);
  });
});

describe('publish / merge: a verify of another environment is a missing verify', () => {
  function publishNow() {
    const out: string[] = [];
    const err: string[] = [];
    const fake = fakeGit();
    const code = publish(['--run-dir', runDir, '--issues', '3477', '--issue', '3477', '--worktree', worktree], {
      run: fake.run, home, log: (l: string) => out.push(l), error: (l: string) => err.push(l),
    } as Parameters<typeof publish>[1]);
    return { code, out: out.join('\n'), err: err.join('\n'), fake };
  }
  function mergeNow() {
    const out: string[] = [];
    const err: string[] = [];
    const fake = fakeGit({ prs: [openPr()], checks: [[{ name: 'Lint', bucket: 'pass' }, { name: 'Build', bucket: 'pass' }, { name: 'Unit Tests', bucket: 'pass' }]] });
    const code = merge(['--run-dir', runDir, '--issues', '3477', '--issue', '3477', '--worktree', worktree], {
      run: fake.run, home, sleep: () => {}, now: () => new Date(Date.UTC(2026, 9, 25, 3, 0)),
      findTestsNaming: () => [], log: (l: string) => out.push(l), error: (l: string) => err.push(l),
    } as Parameters<typeof merge>[1]);
    return { code, out: out.join('\n'), err: err.join('\n'), fake };
  }

  it('publish: same environment publishes (negative control); a changed one stops before the push', () => {
    recordVerify();
    recordRest();
    expect(publishNow().code).toBe(0);
    globalModel('fable');
    const r = publishNow();
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/verify: environment changed — env=[0-9a-f]{12} \(wait-3477\.env\.json\) differs now in globalModel; verify again \(3-3 \/ 5-1\)/);
  });

  it('publish: a record from before env= is published as before, and the log says so', () => {
    recordVerify(HEAD_A, { withEnv: false });
    recordRest();
    const r = publishNow();
    expect(r.code).toBe(0);
    expect(r.out).toContain('warning: verify at aaaaaaa: no env= in the record');
  });

  it('merge: a changed lockfile at the verified HEAD stops the merge; the same environment merges', () => {
    recordVerify();
    recordRest();
    lockfile();
    const stopped = mergeNow();
    expect(stopped.code).toBe(1);
    expect(stopped.err).toContain('verify: environment changed');
    expect(stopped.fake.ghCalls('pr merge')).toHaveLength(0);
    fs.writeFileSync(path.join(worktree, 'package-lock.json'), '{"lockfileVersion":3}\n');
    expect(mergeNow().code).toBe(0);
  });

  it('missingRecords without the environment argument reads as before (callers that do not pass it)', () => {
    recordVerify();
    recordRest();
    globalModel('fable');
    const records = fs.readdirSync(runDir).filter((f) => f.startsWith('run-')).flatMap((f) =>
      fs.readFileSync(path.join(runDir, f), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    );
    expect(missingRecords(records, 3477, { head: HEAD_A, workHead: HEAD_A }, null)).toEqual([]);
    expect(missingRecords(records, 3477, { head: HEAD_A, workHead: HEAD_A }, null, { runDir, worktree, home })).toHaveLength(1);
  });
});

describe('a precheck is tied to the environment it ran in (#3883 N9)', () => {
  it('records env= under its key, and its early return is taken only in the same environment', () => {
    const first = runPrecheck({ force: false });
    expect(first.code).toBe(0);
    const record = allRecords().find((r) => r.stage === 'precheck');
    expect(record.note).toMatch(/ key=3477:3477:precheck-aaaaaaa:a1 env=[0-9a-f]{12}$/);
    expect(record.key).toBe('3477:3477:precheck-aaaaaaa:a1');
    expect(verifyEnvState(record, { runDir, worktree, home }).state).toBe('same');
    // Same HEAD, options and environment: reused (negative control).
    const again = runPrecheck({ force: false });
    expect(again.checks).toEqual([]);
    expect(again.out).toContain('reused: ok at aaaaaaa');
    // Only the installed version moved: run again, not reused.
    fs.writeFileSync(path.join(worktree, 'node_modules', 'vitest', 'package.json'), '{"version":"4.2.0"}');
    const moved = runPrecheck({ force: false });
    expect(moved.checks.length).toBeGreaterThan(0);
    expect(moved.out).toMatch(/was taken in another environment \(changed — .*packages\.vitest/);
  });

  it('a precheck record from before env= is still reused, with a warning', () => {
    const first = runPrecheck({ force: false });
    expect(first.code).toBe(0);
    const file = fs.readdirSync(runDir).find((f) => f.startsWith('run-'))!;
    const legacy = fs.readFileSync(path.join(runDir, file), 'utf8').replace(/ key=\S+ env=[0-9a-f]{12}/, '');
    fs.writeFileSync(path.join(runDir, file), legacy);
    globalModel('fable');
    const r = runPrecheck({ force: false });
    expect(r.checks).toEqual([]);
    expect(r.out).toMatch(/warning: precheck at aaaaaaa: no env= in the record/);
  });

  it('an input that moves while the precheck runs fails it', () => {
    const r = runPrecheck({ during: lockfile });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/the inputs changed during the precheck \(lockfile; see precheck-3477-aaaaaaa\.env\.json\) — fail/);
    expect(allRecords().find((x) => x.stage === 'precheck')).toMatchObject({ result: 'fail' });
  });

  it('a verify of an earlier HEAD: a changed lockfile is covered only by a precheck of this HEAD in this environment', () => {
    const where = { runDir, worktree, home };
    recordVerify(HEAD_A);
    for (const stage of ['review', 'findings']) appendRecord(runDir, '3477', { issue: 3477, stage, result: 'ok', head: HEAD_A });
    lockfile();
    const heads = { head: HEAD_B, workHead: HEAD_A };
    // No precheck of HEAD_B: the HEAD difference alone does not leave the lockfile out.
    expect(missingRecords(allRecords(), 3477, heads, null, where).join('\n')).toMatch(/verify: environment changed — .*lockfile \(no precheck of bbbbbbb in this environment/);
    // A precheck of HEAD_B taken now covers it.
    expect(runPrecheck({ head: HEAD_B }).code).toBe(0);
    expect(missingRecords(allRecords(), 3477, heads, null, where)).toEqual([]);
    // The versions move again after that precheck: neither it nor the verify holds.
    fs.writeFileSync(path.join(worktree, 'node_modules', 'vitest', 'package.json'), '{"version":"4.2.0"}');
    const reasons = missingRecords(allRecords(), 3477, heads, null, where).join('\n');
    expect(reasons).toMatch(/precheck: environment changed — .*packages\.vitest/);
    expect(reasons).toMatch(/verify: environment changed — .*packages\.vitest/);
  });

  it('merge runs the precheck of its HEAD again when the inputs moved since it passed', () => {
    // The precheck ran before the lockfile moved; the verify after (so it is the current environment's).
    for (const stage of ['review', 'findings']) appendRecord(runDir, '3477', { issue: 3477, stage, result: 'ok', head: HEAD_A });
    expect(runPrecheck().code).toBe(0);
    lockfile();
    recordVerify();
    const prechecks = () => allRecords().filter((r) => r.stage === 'precheck');
    const out: string[] = [];
    const fake = fakeGit({ prs: [openPr()], checks: [[{ name: 'Lint', bucket: 'pass' }, { name: 'Build', bucket: 'pass' }, { name: 'Unit Tests', bucket: 'pass' }]] });
    const code = merge(['--run-dir', runDir, '--issues', '3477', '--issue', '3477', '--worktree', worktree], {
      run: fake.run, home, sleep: () => {}, now: () => new Date(Date.UTC(2026, 9, 25, 3, 0)),
      findTestsNaming: () => [], log: (l: string) => out.push(l), error: (l: string) => out.push(l),
    } as Parameters<typeof merge>[1]);
    expect(code, out.join('\n')).toBe(0);
    // A second precheck of the same HEAD, in the environment of now.
    expect(prechecks()).toHaveLength(2);
    expect(verifyEnvState(prechecks()[1], { runDir, worktree, home }).state).toBe('same');
    expect(out.join('\n')).toMatch(/was taken in another environment \(changed — .*lockfile/);
  });
});

describe('merge after a refresh: a dependencies-only difference waits for the precheck of the new HEAD (#3883 N10)', () => {
  const GREEN = [{ name: 'Lint', bucket: 'pass' as const }, { name: 'Build', bucket: 'pass' as const }, { name: 'Unit Tests', bucket: 'pass' as const }];
  /**
   * H (HEAD_A): verify, review, findings and a precheck pass. R (HEAD_B, a merge of develop on H): the lockfile
   * changed and R's precheck failed once. `change` moves something else too before the retry.
   */
  function retryAfterRefresh({ change, failCommands = [] as string[] }: { change?: () => void; failCommands?: string[] } = {}) {
    recordVerify(HEAD_A);
    for (const stage of ['review', 'findings']) appendRecord(runDir, '3477', { issue: 3477, stage, result: 'ok', head: HEAD_A });
    expect(runPrecheck({ head: HEAD_A }).code).toBe(0);
    lockfile();
    // R's precheck failed (e.g. a test with the new dependency): the latest record of R.
    appendRecord(runDir, '3477', { issue: 3477, stage: 'precheck', result: 'fail', head: HEAD_B, workHead: HEAD_A, note: 'tests=fail' });
    change?.();
    const out: string[] = [];
    const fake = fakeGit({
      head: HEAD_B,
      firstParent: [`${HEAD_B} ${HEAD_A} ${'d'.repeat(40)}`, `${HEAD_A} ${'d'.repeat(40)}`],
      prs: [openPr({ headRefOid: HEAD_B })],
      checks: [GREEN],
      failCommands,
    });
    const code = merge(['--run-dir', runDir, '--issues', '3477', '--issue', '3477', '--worktree', worktree], {
      run: fake.run, home, sleep: () => {}, now: () => new Date(Date.UTC(2026, 9, 25, 3, 0)),
      findTestsNaming: () => [], log: (l: string) => out.push(l), error: (l: string) => out.push(l),
    } as Parameters<typeof merge>[1]);
    const prechecksOfR = allRecords().filter((r) => r.stage === 'precheck' && r.head === HEAD_B);
    return { code, out: out.join('\n'), fake, prechecksOfR };
  }

  it('the retry runs the precheck of R, and with it passed the merge goes on', () => {
    const r = retryAfterRefresh();
    expect(r.code, r.out).toBe(0);
    expect(r.prechecksOfR.map((x) => x.result)).toEqual(['fail', 'ok']);
    expect(verifyEnvState(r.prechecksOfR[1], { runDir, worktree, home }).state).toBe('same');
    expect(r.out).toMatch(/verify at aaaaaaa: .*lockfile — waits for the precheck of bbbbbbb/);
    expect(r.fake.ghCalls('pr merge')).toHaveLength(1);
  });

  it('a precheck of R that fails again: not merged (the check is not passed over)', () => {
    const r = retryAfterRefresh({ failCommands: ['npx vitest'] });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/the precheck of bbbbbbb did not pass — not pushed/);
    expect(r.fake.ghCalls('pr merge')).toHaveLength(0);
  });

  it('a model or a local setting that moved too is not deferred: it stops before any precheck, asking for verify', () => {
    for (const change of [() => globalModel('fable'), () => fs.writeFileSync(path.join(worktree, '.claude', 'settings.local.json'), '{"model":"sonnet"}\n')]) {
      fs.rmSync(runDir, { recursive: true, force: true });
      fs.writeFileSync(path.join(worktree, 'package-lock.json'), '{"lockfileVersion":3}\n');
      globalModel('opus[1m]');
      fs.writeFileSync(path.join(worktree, '.claude', 'settings.local.json'), '{"model":"opus[1m]"}\n');
      fs.mkdirSync(runDir, { recursive: true });
      const r = retryAfterRefresh({ change });
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/verify: environment changed — .*(globalModel|localSettings)/);
      expect(r.prechecksOfR).toHaveLength(1);
      expect(r.fake.ghCalls('pr merge')).toHaveLength(0);
    }
  });

  it('the same verify HEAD as now: a dependencies-only difference is not deferred (verify again)', () => {
    recordVerify(HEAD_A);
    for (const stage of ['review', 'findings']) appendRecord(runDir, '3477', { issue: 3477, stage, result: 'ok', head: HEAD_A });
    expect(runPrecheck({ head: HEAD_A }).code).toBe(0);
    lockfile();
    const deferred: string[] = [];
    const reasons = missingRecords(allRecords(), 3477, { head: HEAD_A, workHead: HEAD_A }, null, { runDir, worktree, home, defer: (r: string) => deferred.push(r) });
    expect(deferred).toEqual([]);
    expect(reasons.join('\n')).toMatch(/verify: environment changed — .*lockfile/);
  });
});
