/**
 * scripts/orchestrate/merge-train.mjs — PR1 of the merge train: a diagnosis without the right to publish
 * (Issue #4369, docs/design/merge-train-4369.md §10 T-E・T-C・T-B・T-A・T-R・T-L, T-P P8).
 *
 * `main` runs end to end. git is real, in repositories under os.tmpdir(): the "origin" is a local bare
 * repository reached through `url.<bare>.insteadOf https://github.com/Kewton/CommandMate.git`, and every
 * git call runs with GIT_ALLOW_PROTOCOL=file, so nothing can reach GitHub. `gh` is a fake that plays
 * GitHub (PRs, checks, the push run of the train). The precheck is the real precheck.mjs `main` with its
 * `node` / `npx` / `npm` steps answered by the fake. Every call is recorded, and the side effects
 * (pushes, gh writes, files, exit) are asserted. Everything is removed after each test.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendRecord, readRecords, summarize } from '../../../../scripts/orchestrate/run-log.mjs';
import { LAST_REQUIRED_CHECKS, mergeLockName } from '../../../../scripts/orchestrate/merge-pr.mjs';
import { acquireMachineLockSync } from '../../../../scripts/orchestrate/machine-lock-sync.mjs';
import {
  NOTICE,
  NOT_RED_LINE,
  REFUSED_MESSAGE,
  TRAIN_ID_PATTERN,
  assertTrainRef,
  bucketOf,
  buildReport,
  createTrainRef,
  deleteTrainRef,
  formatReport,
  judgeTrain,
  main,
  parseArgs,
  trainId,
  trainLockName,
  trainTarget,
} from '../../../../scripts/orchestrate/merge-train.mjs';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SYNC_MODULE = path.join(REPO_ROOT, 'scripts/orchestrate/machine-lock-sync.mjs');
const ACTOR = path.join(REPO_ROOT, 'tests/unit/verification/fixtures/lock-actor-4277.mjs');
const GITHUB_URL = 'https://github.com/Kewton/CommandMate.git';
const ISSUES = '4401-4409';
const GIT_ENV = { GIT_ALLOW_PROTOCOL: 'file', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };

let tmp: string;
const children: ChildProcess[] = [];
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-merge-train-4369-'));
});
afterEach(() => {
  for (const child of children.splice(0)) {
    for (const target of [child.pid ? -child.pid : 0, child.pid ?? 0]) {
      try {
        if (target) process.kill(target, 'SIGKILL');
      } catch {
        // gone
      }
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function g(cwd: string, ...args: string[]): string {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${out.stderr}`);
  return out.stdout.trim();
}

type Call = { command: string; args: string[] };
type Job = { name: string; status: string; conclusion: string | null };
const job = (name: string, conclusion: string | null = 'success', status = 'completed'): Job => ({ name, status, conclusion });
const greenJobs = () => LAST_REQUIRED_CHECKS.map((name) => job(name));

interface Unit {
  issue: number;
  pr: number;
  /** The file the PR changes and its content. */
  file?: string;
  content?: string;
}

/**
 * A repository with a bare origin, one worktree per PR, and the run record a merge-pr would read.
 * `ci` decides what the fake GitHub answers for the train's push run, look by look.
 */
function world(units: Unit[], options: { precheckOpts?: Record<number, string> } = {}) {
  const bare = path.join(tmp, 'origin.git');
  const repo = path.join(tmp, 'repo');
  const runDir = path.join(tmp, 'runs', '2026-11-14');
  const home = path.join(tmp, 'home');
  const tmpdir = path.join(tmp, 'tmpdir');
  const lockRoot = path.join(tmp, 'locks', 'train');
  const mergeLocks = path.join(tmp, 'locks', 'merge');
  for (const dir of [home, tmpdir]) fs.mkdirSync(dir, { recursive: true });
  g(tmp, 'init', '-q', '--bare', '-b', 'develop', bare);
  g(tmp, 'init', '-q', '-b', 'develop', repo);
  g(repo, 'config', 'user.name', 'fixture');
  g(repo, 'config', 'user.email', 'fixture@localhost');
  g(repo, 'config', 'commit.gpgsign', 'false');
  g(repo, 'config', `url.${bare}.insteadOf`, GITHUB_URL);
  g(repo, 'remote', 'add', 'origin', GITHUB_URL);
  fs.writeFileSync(path.join(repo, '.gitignore'), '/node_modules\n/dev-reports/\n');
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"fixture"}\n');
  fs.writeFileSync(path.join(repo, 'package-lock.json'), '{"lockfileVersion":3}\n');
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'one\ntwo\nthree\n');
  g(repo, 'add', '-A');
  g(repo, 'commit', '-q', '-m', 'base');
  g(repo, 'push', '-q', '-u', 'origin', 'develop');

  const prs = new Map<number, Record<string, unknown>>();
  const wts = units.map((u) => {
    const branch = `feature/${u.issue}-x`;
    const wt = path.join(tmp, `wt-${u.issue}`);
    g(repo, 'worktree', 'add', '-q', '-b', branch, wt, 'develop');
    fs.writeFileSync(path.join(wt, u.file ?? `f${u.issue}.txt`), u.content ?? `issue ${u.issue}\n`);
    fs.mkdirSync(path.join(wt, 'changelog.d'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'changelog.d', `${u.issue}.md`), `<!-- ### Added -->\n- **feat(x): y** (#${u.issue}): z\n`);
    g(wt, 'add', '-A');
    g(wt, 'commit', '-q', '-m', `feat: #${u.issue}`);
    g(wt, 'push', '-q', 'origin', branch);
    fs.mkdirSync(path.join(wt, 'dev-reports', 'module-reference'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'dev-reports', 'module-reference', `issue-${u.issue}.md`), '追記なし\n');
    const head = g(wt, 'rev-parse', 'HEAD');
    const opts = options.precheckOpts?.[u.issue] ?? 'opts=base:origin/develop,kind:-,metrics:false,allow-removed:false,build:false';
    appendRecord(runDir, ISSUES, { issue: u.issue, stage: 'verify', result: 'ok', head, note: 'exit=0(passed) passed=lint,typecheck,unit failed=-' });
    appendRecord(runDir, ISSUES, { issue: u.issue, stage: 'review', result: 'ok', head });
    appendRecord(runDir, ISSUES, { issue: u.issue, stage: 'findings', result: 'ok', head });
    appendRecord(runDir, ISSUES, { issue: u.issue, stage: 'precheck', result: 'ok', head, note: `tsc=ok tests=ok ${opts}` });
    appendRecord(runDir, ISSUES, { issue: u.issue, stage: 'pr', result: 'ok', head, note: `pr=#${u.pr} opened` });
    prs.set(u.pr, {
      number: u.pr, state: 'OPEN', headRefOid: head, headRefName: branch, baseRefName: 'develop',
      headRepository: { name: 'CommandMate' }, headRepositoryOwner: { login: 'Kewton' }, isCrossRepository: false,
    });
    return { unit: u, wt, branch, head };
  });
  // Each worktree has its node_modules (the train borrows the first adopted one's by default).
  for (const w of wts) fs.mkdirSync(path.join(w.wt, 'node_modules'));

  const calls: Call[] = [];
  const state = {
    prChecks: new Map<number, { name: string; bucket: string }[]>(),
    prView: null as null | ((n: number) => { status: number; stdout: string; stderr: string } | null),
    attempt: 1,
    looks: 0,
    /** Per look: the runs listed for the train. Default: the one manifest run, completed. */
    runs: null as null | ((ctx: { sha: string; branch: string; look: number; pushed: boolean }) => Record<string, unknown>[]),
    /** Per look and attempt: the run's jobs, or 'fail' for a page that cannot be read. */
    jobs: ((_ctx: { look: number; attempt: number }) => greenJobs()) as (ctx: { look: number; attempt: number }) => Job[] | 'fail',
    checkRuns: ((_ctx: { look: number; latest: boolean }) => []) as (ctx: { look: number; latest: boolean }) => Record<string, unknown>[],
    statuses: ((_ctx: { look: number }) => []) as (ctx: { look: number }) => { context: string; state: string }[],
    rulesAnswer: { status: 0, stdout: '[]', stderr: '' },
    rerunRefusals: [] as string[],
    cancelFails: false,
    onLook: null as null | ((look: number) => void),
    precheck: null as null | ((args: string[]) => number),
  };
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const failed = (stderr: string, status = 1) => ({ status, stdout: '', stderr });
  const pushedRef = (branch: string) => spawnSync('git', ['ls-remote', bare, `refs/heads/${branch}`], { encoding: 'utf8' }).stdout.trim() !== '';

  const gh = (args: string[]) => {
    const key = args.slice(0, 2).join(' ');
    if (key === 'pr view') {
      const n = Number(args[2]);
      const custom = state.prView?.(n);
      if (custom) return custom;
      const pr = prs.get(n);
      return pr ? ok(JSON.stringify(pr)) : failed('no pull requests found for branch');
    }
    if (key === 'pr checks') {
      const answer = state.prChecks.get(Number(args[2])) ?? LAST_REQUIRED_CHECKS.map((name) => ({ name, bucket: 'pass' }));
      return { status: answer.some((c) => c.bucket === 'pending') ? 8 : 0, stdout: JSON.stringify(answer), stderr: '' };
    }
    if (key === 'run rerun') {
      const refusal = state.rerunRefusals.shift();
      if (refusal !== undefined) return failed(refusal);
      state.attempt += 1;
      return ok();
    }
    if (key === 'run view') return ok(JSON.stringify({ attempt: state.attempt }));
    if (key === 'run cancel') return state.cancelFails ? failed('cannot cancel') : ok();
    if (args[0] === 'api') {
      const apiPath = args[args.length - 1];
      if (apiPath.endsWith('/protection')) return failed('gh: Branch not protected (HTTP 404)');
      if (apiPath.includes('/rules/branches/')) return state.rulesAnswer;
      if (args[1] === 'graphql') return ok(JSON.stringify({ data: { repository: { mergeQueue: null } } }));
      const runsMatch = /actions\/runs\?head_sha=([0-9a-f]+)&event=push&branch=([^&]+)/.exec(apiPath);
      if (runsMatch) {
        state.looks += 1;
        state.onLook?.(state.looks);
        const sha = runsMatch[1];
        const branch = decodeURIComponent(runsMatch[2]);
        const ctx = { sha, branch, look: state.looks, pushed: pushedRef(branch) };
        const runs = state.runs
          ? state.runs(ctx)
          : ctx.pushed
            ? [{ id: 900, path: '.github/workflows/ci-pr.yml', event: 'push', head_sha: sha, head_branch: branch, run_attempt: state.attempt, check_suite_id: 77, status: 'completed' }]
            : [];
        return ok(JSON.stringify([{ total_count: runs.length, workflow_runs: runs }]));
      }
      if (/actions\/runs\/\d+\/attempts\/(\d+)\/jobs/.test(apiPath)) {
        const attempt = Number(/attempts\/(\d+)\//.exec(apiPath)![1]);
        const jobs = state.jobs({ look: state.looks, attempt });
        if (jobs === 'fail') return failed('gh: HTTP 404 page 2');
        return ok(JSON.stringify([{ jobs }]));
      }
      if (/commits\/[0-9a-f]+\/check-runs/.test(apiPath)) {
        return ok(JSON.stringify([{ check_runs: state.checkRuns({ look: state.looks, latest: apiPath.includes('filter=latest') }) }]));
      }
      if (/commits\/[0-9a-f]+\/status$/.test(apiPath)) return ok(JSON.stringify({ statuses: state.statuses({ look: state.looks }) }));
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };

  const run = (command: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) => {
    calls.push({ command, args });
    if (command === 'git') {
      const out = spawnSync('git', args, { cwd: opts.cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, ...(opts.env ?? {}) }, maxBuffer: 64 * 1024 * 1024 });
      return { status: out.status ?? 1, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
    }
    if (command === 'gh') return gh(args);
    // precheck's node / npx / npm steps
    return ok(`${command} ${args.slice(0, 2).join(' ')} ok\n`);
  };

  let clock = Date.parse('2026-11-14T00:00:00.000Z');
  let seq = 0;
  const out: string[] = [];
  const err: string[] = [];
  const logs: string[] = [];
  const deps = (extra: Record<string, unknown> = {}) => ({
    run,
    sleep: (ms: number) => {
      clock += ms;
    },
    now: () => new Date(clock),
    random: () => (++seq).toString(16).padStart(6, '0'),
    pid: 4369,
    home,
    repoDir: repo,
    tmpdir,
    lockRoot,
    mergeLockRoot: mergeLocks,
    log: (line: string) => logs.push(line),
    error: (line: string) => err.push(line),
    out: (text: string) => out.push(text),
    ...(state.precheck ? { runPrecheck: (args: string[]) => state.precheck!(args) } : {}),
    ...extra,
  });
  const argv = (queue: string, ...extra: string[]) => ['--run-dir', runDir, '--issues', ISSUES, '--queue', queue, '--poll', '30', ...extra];
  const go = (queue: string, extra: string[] = [], depsExtra: Record<string, unknown> = {}) => {
    const code = main(argv(queue, ...extra), deps(depsExtra));
    // The report's human text is one call of log (exit 0) or error (otherwise), the last one.
    const report = (code === 0 ? logs : err).at(-1) ?? '';
    return { code, out: out.join('\n'), err: err.join('\n'), log: logs.join('\n'), report };
  };
  const reports = () => {
    const dir = path.join(runDir, 'train');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => /^\d{8}T\d{9}Z-\d+-[0-9a-f]{6}\.json$/.test(f)).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  };
  const remoteTrainRefs = () => lines(spawnSync('git', ['ls-remote', bare, 'refs/heads/train/*'], { encoding: 'utf8' }).stdout);
  const pushes = () => calls.filter((c) => c.command === 'git' && c.args.includes('push'));
  return { bare, repo, runDir, home, tmpdir, lockRoot, mergeLocks, wts, prs, calls, state, go, deps, argv, reports, remoteTrainRefs, pushes, outLines: out, errLines: err };
}

const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);
type World = ReturnType<typeof world>;

/** X2: no write outside the own train ref and the manifest's run, in any path. */
function assertNoPublish(w: World) {
  const report = w.reports().at(-1);
  const allowedIds = new Set<string>([...w.reports().map((r) => r.id), ...w.reports().flatMap((r) => (r.refs?.pruned ?? []).map((p: { id: string }) => p.id))]);
  for (const c of w.calls) {
    const text = c.args.join(' ');
    if (c.command === 'gh') {
      expect(text).not.toMatch(/^pr (create|merge|close|edit|ready)|^issue (close|edit|comment)|^api .*(-X|--method) (PUT|PATCH|DELETE|POST)/);
      if (c.args[0] === 'run' && ['rerun', 'cancel'].includes(c.args[1])) expect(c.args[2]).toBe('900');
    }
    if (c.command === 'git' && c.args.includes('push') && !c.args.includes('-q')) {
      const refspec = c.args[c.args.length - 1];
      const lease = c.args.find((a) => a.startsWith('--force-with-lease='));
      if (refspec.startsWith(':')) {
        // A deletion: always with a lease on the same ref, only of an own or pruned ID.
        expect(lease).toBeDefined();
        expect(lease!.slice('--force-with-lease='.length).split(':')[0]).toBe(refspec.slice(1));
      }
      const target = refspec.split(':').at(-1)!;
      const m = /^refs\/heads\/train\/develop\/(.+)$/.exec(target);
      expect(m, `push to ${target}`).not.toBeNull();
      expect(allowedIds.has(m![1]), `push to ${target}`).toBe(true);
      expect(c.args).not.toContain('--force');
    }
  }
  if (report) expect(report.publishable).toBe(false);
}

const fixtureCount = (w: World) => g(w.repo, 'worktree', 'list', '--porcelain');

describe('T-E entries and candidates', () => {
  it('E1 (negative control): three eligible PRs make one train, one push, one green CI; exit 0', () => {
    const w = world([{ issue: 4401, pr: 5401 }, { issue: 4402, pr: 5402 }, { issue: 4403, pr: 5403 }]);
    const r = w.go('4401,4402,4403');
    expect(r.code, r.err).toBe(0);
    const [report] = w.reports();
    expect(report.verdict).toBe('green');
    expect(report.adopted.map((a: { pr: number }) => a.pr)).toEqual([5401, 5402, 5403]);
    expect(report.adopted.every((a: { ciVerified: boolean }) => a.ciVerified === false)).toBe(true);
    expect(report.verified.sha).toBe(report.adopted[2].T);
    expect(report.verified).toMatchObject({ runId: 900, attempt: 1, checkSuiteId: 77, workflow: 'ci-pr.yml', event: 'push', ref: report.ref });
    // The chain is single-parent, on B0.
    expect(g(w.repo, 'rev-list', '--parents', '-n', '1', report.adopted[0].T).split(' ')[1]).toBe(report.B0);
    expect(g(w.repo, 'rev-list', '--parents', '-n', '1', report.adopted[2].T).split(' ')).toHaveLength(2);
    expect(w.pushes().filter((c) => !c.args.includes('-q') && !c.args.some((a) => a.startsWith('--force-with-lease')))).toHaveLength(1);
    expect(w.remoteTrainRefs()).toHaveLength(1);
    assertNoPublish(w);
  });

  const DROPS: [string, (w: World) => void, RegExp][] = [
    ['CLOSED', (w) => (w.prs.get(5401)!.state = 'CLOSED'), /^state=CLOSED$/],
    ['MERGED', (w) => (w.prs.get(5401)!.state = 'MERGED'), /^state=MERGED$/],
    ['another base', (w) => (w.prs.get(5401)!.baseRefName = 'main'), /^base=main$/],
    ['a fork', (w) => Object.assign(w.prs.get(5401)!, { isCrossRepository: true, headRepositoryOwner: { login: 'someone' } }), /^fork=/],
    ['a dirty tree', (w) => fs.writeFileSync(path.join(w.wts[0].wt, 'stray.txt'), 'x'), /^dirty$/],
    ['HEAD ≠ the PR head', (w) => (w.prs.get(5401)!.headRefOid = 'e'.repeat(40)), /^head-mismatch/],
    ['no review', (w) => {
      const file = path.join(w.runDir, `run-${ISSUES}.jsonl`);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').filter((l) => !(l.includes('"review"') && l.includes('4401'))).join('\n'));
    }, /^records-missing=review/],
    ['no fragment', (w) => fs.rmSync(path.join(w.wts[0].wt, 'dev-reports', 'module-reference', 'issue-4401.md')), /^fragments-missing$/],
    ['its CI pending', (w) => w.state.prChecks.set(5401, [{ name: 'Lint', bucket: 'pending' }]), /^pr-ci=pending$/],
    ['its CI failed', (w) => w.state.prChecks.set(5401, [{ name: 'Lint', bucket: 'fail' }]), /^pr-ci=fail$/],
    ['an unresolved write of it', (w) => {
      const dir = path.join(w.mergeLocks, `${mergeLockName('Kewton/CommandMate', 'develop')}.unresolved`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 't.json'), JSON.stringify({ pr: 5401, issue: 4401, phase: 'merge' }));
    }, /^unresolved$/],
  ];
  it.each(DROPS)('E2: %s is dropped with its reason and the rest goes on (R18)', (_name, mutate, reason) => {
    const w = world([{ issue: 4401, pr: 5401 }, { issue: 4402, pr: 5402 }]);
    mutate(w);
    const r = w.go('4401,4402');
    expect(r.code, r.err).toBe(0);
    const [report] = w.reports();
    expect(report.dropped).toHaveLength(1);
    expect(report.dropped[0]).toMatchObject({ entry: '4401', pr: 5401 });
    expect(report.dropped[0].reason).toMatch(reason);
    expect(report.adopted.map((a: { pr: number }) => a.pr)).toEqual([5402]);
    assertNoPublish(w);
  });

  it('E3: a precheck record without opts= is dropped precheck-options-unknown (C4)', () => {
    const w = world([{ issue: 4401, pr: 5401 }, { issue: 4402, pr: 5402 }], { precheckOpts: { 4401: '' } });
    expect(w.go('4401,4402').code).toBe(0);
    expect(w.reports()[0].dropped).toEqual([{ entry: '4401', pr: 5401, reason: 'precheck-options-unknown' }]);
  });

  it('E4: a precheck that allowed removed tests is dropped removed-tests-allowed (C5)', () => {
    const w = world([{ issue: 4401, pr: 5401 }, { issue: 4402, pr: 5402 }], {
      precheckOpts: { 4401: 'opts=base:origin/develop,kind:-,metrics:false,allow-removed:true,build:false' },
    });
    expect(w.go('4401,4402').code).toBe(0);
    expect(w.reports()[0].dropped).toEqual([{ entry: '4401', pr: 5401, reason: 'removed-tests-allowed' }]);
  });

  const USAGE: [string, (w: World) => string][] = [
    ['the same PR twice', () => '4401@5401,4402@5401'],
    ['an OPEN PR with no worktree', (w) => {
      g(w.repo, 'worktree', 'remove', '--force', w.wts[0].wt);
      return '4401,4402';
    }],
    ['an OPEN PR with two worktrees', (w) => {
      // A second worktree reported on the same branch (git refuses to make one; the list is read as given).
      const extra = path.join(tmp, 'wt-extra');
      g(w.repo, 'worktree', 'add', '-q', '--detach', extra, 'develop');
      fs.writeFileSync(path.join(w.repo, '.git', 'worktrees', 'wt-extra', 'HEAD'), `ref: refs/heads/${w.wts[0].branch}\n`);
      return '4401,4402';
    }],
    ['an entry that is not <issue>[/<item>][@<pr>]', () => '4401,nope'],
    ['no pr record and no @pr', () => '4409'],
    ['a PR gh does not know', () => '4401@7777'],
  ];
  it.each(USAGE)('E5: %s stops everything with exit 2 and creates nothing (R23)', (_name, queueOf) => {
    const w = world([{ issue: 4401, pr: 5401 }, { issue: 4402, pr: 5402 }]);
    const queue = queueOf(w);
    const r = w.go(queue);
    expect(r.code).toBe(2);
    expect(w.remoteTrainRefs()).toEqual([]);
    expect(fs.readdirSync(w.tmpdir)).toEqual([]);
    expect(w.calls.filter((c) => c.command === 'gh' && c.args[0] === 'run')).toEqual([]);
    expect(r.err).toContain('publishable: false');
    assertNoPublish(w);
  });

  it('E6: gh pr view answering 5xx after every retry is exit 1, not a dropped PR', () => {
    const w = world([{ issue: 4401, pr: 5401 }]);
    w.state.prView = () => ({ status: 1, stdout: '', stderr: 'HTTP 502 Bad Gateway' });
    const r = w.go('4401');
    expect(r.code).toBe(1);
    expect(w.calls.filter((c) => c.command === 'gh' && c.args[1] === 'view' && c.args[0] === 'pr').length).toBe(4);
    expect(w.reports()[0].dropped).toEqual([]);
    expect(w.remoteTrainRefs()).toEqual([]);
  });

  it('E7 / T4: every candidate dropped (or in conflict) pushes nothing: exit 0, state=empty (R23)', () => {
    const w = world([{ issue: 4401, pr: 5401, file: 'shared.txt', content: 'A\n' }, { issue: 4402, pr: 5402 }]);
    w.prs.get(5402)!.state = 'CLOSED';
    w.prs.get(5401)!.state = 'CLOSED';
    const r = w.go('4401,4402');
    expect(r.code, r.err).toBe(0);
    expect(w.reports()[0].verdict).toBe('empty');
    expect(w.remoteTrainRefs()).toEqual([]);
    const lineStates = readRecords(w.runDir, ISSUES).logRecords.map((l: { note: string }) => /state=(\S+)/.exec(l.note)![1]);
    expect(lineStates).toEqual(['empty']);
  });

  it('E7: two candidates in conflict on the same line keep the first; all-conflict is empty', () => {
    const w = world([{ issue: 4401, pr: 5401, file: 'shared.txt', content: 'A\n' }, { issue: 4402, pr: 5402, file: 'shared.txt', content: 'B\n' }]);
    expect(w.go('4401,4402').code).toBe(0);
    expect(w.reports()[0].dropped[0]).toMatchObject({ pr: 5402, reason: 'conflict files=shared.txt' });
  });

  it('E8: past --max-prs the rest is dropped over-limit', () => {
    const w = world([{ issue: 4401, pr: 5401 }, { issue: 4402, pr: 5402 }]);
    expect(w.go('4401,4402', ['--max-prs', '1']).code).toBe(0);
    expect(w.reports()[0].dropped).toEqual([{ entry: '4402', pr: 5402, reason: 'over-limit' }]);
  });

  it('E9: an unresolved write of a PR not in the train goes on and is reported', () => {
    const w = world([{ issue: 4401, pr: 5401 }]);
    const dir = path.join(w.mergeLocks, `${mergeLockName('Kewton/CommandMate', 'develop')}.unresolved`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 't.json'), JSON.stringify({ pr: 6000, issue: 4999, phase: 'merge' }));
    expect(w.go('4401').code).toBe(0);
    expect(w.reports()[0].unresolved).toMatchObject([{ pr: 6000, issue: 4999, phase: 'merge' }]);
  });

  it('E10 (R24): after a run only `train` lines are added; no Issue gains merge / ci / precheck, progress is unchanged', () => {
    const w = world([{ issue: 4401, pr: 5401 }, { issue: 4402, pr: 5402 }]);
    const before = readRecords(w.runDir, ISSUES);
    expect(w.go('4401,4402').code).toBe(0);
    const after = readRecords(w.runDir, ISSUES);
    expect(after.records).toEqual(before.records);
    expect(summarize(after.records)).toEqual(summarize(before.records));
    expect(after.logRecords.every((l: { stage: string; head?: string }) => l.stage === 'train' && !l.head)).toBe(true);
    expect(after.logRecords.map((l: { note: string }) => /state=(\S+)/.exec(l.note)![1])).toEqual(['pushed', 'green']);
    // The train's precheck wrote to its own run-dir.
    expect(fs.existsSync(path.join(w.runDir, 'train', `run-${ISSUES}.jsonl`))).toBe(true);
  });
});

describe('受入基準 9 (K1): the train tree is a shared clone, never a worktree of the repository', () => {
  it('the repository\'s git worktree list is the same before, during (the precheck) and after the run; the clone is removed', () => {
    const w = world([{ issue: 4401, pr: 5401 }, { issue: 4402, pr: 5402 }]);
    const before = fixtureCount(w);
    let during = '';
    let trainDir = '';
    w.state.precheck = (args: string[]) => {
      during = fixtureCount(w);
      trainDir = args[args.indexOf('--worktree') + 1];
      expect(fs.existsSync(path.join(trainDir, '.git', 'objects', 'info', 'alternates'))).toBe(true);
      expect(fs.lstatSync(path.join(trainDir, 'node_modules')).isSymbolicLink()).toBe(true);
      return 0;
    };
    expect(w.go('4401,4402').code).toBe(0);
    expect(during).toBe(before);
    expect(fixtureCount(w)).toBe(before);
    expect(trainDir.startsWith(w.tmpdir)).toBe(true);
    expect(path.basename(trainDir)).toMatch(/^cm-train-Kewton-CommandMate-/);
    expect(fs.existsSync(trainDir)).toBe(false);
    expect(fs.readdirSync(w.tmpdir)).toEqual([]);
    // The source worktree gained nothing.
    expect(g(w.wts[0].wt, 'status', '--porcelain')).toBe('');
  });
});

describe('T-P P8: the precheck on hold', () => {
  it('precheck exit 3 → exit 3, nothing pushed', () => {
    const w = world([{ issue: 4401, pr: 5401 }]);
    w.state.precheck = () => 3;
    expect(w.go('4401').code).toBe(3);
    expect(w.remoteTrainRefs()).toEqual([]);
    expect(w.reports()[0].verdict).toBe('stopped');
  });

  it('the real precheck runs with the train\'s run-dir, B0 by SHA and --heavy-to-ci', () => {
    const w = world([{ issue: 4401, pr: 5401 }]);
    expect(w.go('4401').code).toBe(0);
    const report = w.reports()[0];
    expect(report.precheck.args).toEqual(['--run-dir', path.join(w.runDir, 'train'), '--issues', ISSUES, '--issue', '4401', '--worktree', expect.any(String), '--base', report.B0, '--heavy-to-ci']);
    expect(report.precheck.exit).toBe(0);
  });
});

describe('T-B bucketOf (gh 2.86.0 pkg/cmd/pr/checks/aggregate.go)', () => {
  it.each([
    [{ status: 'completed', conclusion: 'success' }, 'pass'],
    [{ status: 'completed', conclusion: 'skipped' }, 'skipping'],
    [{ status: 'completed', conclusion: 'neutral' }, 'skipping'],
    [{ status: 'completed', conclusion: 'failure' }, 'fail'],
    [{ status: 'completed', conclusion: 'timed_out' }, 'fail'],
    [{ status: 'completed', conclusion: 'action_required' }, 'fail'],
    [{ status: 'completed', conclusion: 'cancelled' }, 'cancel'],
    [{ status: 'completed', conclusion: 'startup_failure' }, 'pending'],
    [{ status: 'completed', conclusion: 'something_new' }, 'pending'],
    [{ status: 'in_progress', conclusion: null }, 'pending'],
    [{ status: 'queued', conclusion: null }, 'pending'],
    [{ state: 'success' }, 'pass'],
    [{ state: 'error' }, 'fail'],
    [{ state: 'failure' }, 'fail'],
    [{ state: 'pending' }, 'pending'],
  ])('%j → %s', (item, bucket) => {
    expect(bucketOf(item)).toBe(bucket);
  });
});

describe('T-C CI evidence and the wait', () => {
  it('C1 (negative control): the manifest run\'s 19 jobs pass, no status, the base still B0 → green, exit 0', () => {
    const w = world([{ issue: 4401, pr: 5401 }]);
    const r = w.go('4401');
    expect(r.code).toBe(0);
    expect(w.reports()[0].verdict).toBe('green');
  });

  it('C2 (R12): another workflow and a pull_request run on T_N are green while the manifest run is pending → wait (124)', () => {
    const w = world([{ issue: 4401, pr: 5401 }]);
    w.state.runs = ({ sha, branch }) => [
      { id: 901, path: '.github/workflows/other.yml', event: 'push', head_sha: sha, head_branch: branch, run_attempt: 1, check_suite_id: 78, status: 'completed' },
      { id: 902, path: '.github/workflows/ci-pr.yml', event: 'pull_request', head_sha: sha, head_branch: branch, run_attempt: 1, check_suite_id: 79, status: 'completed' },
      { id: 900, path: '.github/workflows/ci-pr.yml', event: 'push', head_sha: sha, head_branch: branch, run_attempt: 1, check_suite_id: 77, status: 'in_progress' },
    ];
    w.state.jobs = () => LAST_REQUIRED_CHECKS.map((name) => job(name, null, 'in_progress'));
    const r = w.go('4401', ['--ci-timeout', '120']);
    expect(r.code).toBe(124);
    expect(w.reports()[0].verdict).toBe('timeout');
  });

  it('C3: the 19 names green in another check suite do not stand for the manifest run (pending → wait)', () => {
    const w = world([{ issue: 4401, pr: 5401 }]);
    w.state.jobs = () => [];
    w.state.checkRuns = () => LAST_REQUIRED_CHECKS.map((name, i) => ({ id: i, name, status: 'completed', conclusion: 'success', check_suite: { id: 5 } }));
    expect(w.go('4401', ['--ci-timeout', '60']).code).toBe(124);
  });

  it('C4 (R13): check-runs green, a status context failure → red; pending → wait', () => {
    const red = world([{ issue: 4401, pr: 5401 }]);
    red.state.statuses = () => [{ context: 'external', state: 'failure' }];
    expect(red.go('4401').code).toBe(1);
    expect(red.reports()[0].verdict).toBe('red');
    fs.rmSync(path.join(tmp), { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    const waiting = world([{ issue: 4401, pr: 5401 }]);
    waiting.state.statuses = () => [{ context: 'external', state: 'pending' }];
    expect(waiting.go('4401', ['--ci-timeout', '60']).code).toBe(124);
  });

  it('C5 (R14): attempt 1 red, one re-run, attempt 2 only is read; its green is green-after-rerun-unverified, exit 1', () => {
    const w = world([{ issue: 4401, pr: 5401 }]);
    w.state.jobs = ({ attempt }) => (attempt === 1 ? greenJobs().map((j) => (j.name === 'Lint' ? job('Lint', 'failure') : j)) : greenJobs());
    const r = w.go('4401');
    expect(r.code).toBe(1);
    const [report] = w.reports();
    expect(report.verdict).toBe('green-after-rerun-unverified');
    expect(report.verified.attempt).toBe(2);
    expect(w.calls.filter((c) => c.command === 'gh' && c.args[0] === 'run' && c.args[1] === 'rerun')).toHaveLength(1);
    expect(lines(r.report)[0]).toBe(NOT_RED_LINE);
  });

  it('C5: a re-run attempt not visible yet is not read as the old attempt', () => {
    const w = world([{ issue: 4401, pr: 5401 }]);
    let visible = 1;
    w.state.runs = ({ sha, branch, look }) => {
      if (look >= 4) visible = w.state.attempt;
      return [{ id: 900, path: '.github/workflows/ci-pr.yml', event: 'push', head_sha: sha, head_branch: branch, run_attempt: visible, check_suite_id: 77, status: 'completed' }];
    };
    w.state.jobs = ({ attempt }) => (attempt === 1 ? [job('Lint', 'failure'), ...greenJobs().filter((j) => j.name !== 'Lint')] : greenJobs());
    const r = w.go('4401');
    expect(r.code).toBe(1);
    expect(w.reports()[0].verdict).toBe('green-after-rerun-unverified');
    expect(w.calls.filter((c) => c.command === 'gh' && c.args[1] === 'rerun')).toHaveLength(1);
  });

  it('C5b: check-runs are read with filter=latest and split by check_suite.id', () => {
    const w = world([{ issue: 4401, pr: 5401 }]);
    w.state.checkRuns = ({ latest }) => [
      ...(latest ? [] : [{ id: 1, name: 'external', status: 'completed', conclusion: 'failure', check_suite: { id: 5 } }]),
      { id: 2, name: 'external', status: 'completed', conclusion: 'success', check_suite: { id: 5 } },
      // The manifest run's own check-run of an earlier attempt: its suite is the run's, so it is not an "other" check.
      { id: 3, name: 'Lint', status: 'completed', conclusion: 'failure', check_suite: { id: 77 } },
    ];
    expect(w.go('4401').code).toBe(0);
    expect(w.reports()[0].ci.others).toEqual([{ name: 'external', bucket: 'pass', link: '' }]);
  });

  it('C6: a jobs page that cannot be read is no verdict that look', () => {
    const w = world([{ issue: 4401, pr: 5401 }]);
    w.state.jobs = ({ look }) => (look === 1 ? 'fail' : greenJobs());
    expect(w.go('4401').code).toBe(0);
    expect(w.state.looks).toBe(2);
  });

  it('C7: two runs match the manifest → exit 1, not judged', () => {
    const w = world([{ issue: 4401, pr: 5401 }]);
    w.state.runs = ({ sha, branch }) => [900, 903].map((id) => ({ id, path: '.github/workflows/ci-pr.yml', event: 'push', head_sha: sha, head_branch: branch, run_attempt: 1, check_suite_id: id, status: 'completed' }));
    expect(w.go('4401').code).toBe(1);
    expect(w.reports()[0].reason).toContain('2 runs match the manifest');
  });

  it('C8: still red after the re-run → exit 1 red, with the PRs of the train and the failed job', () => {
    const w = world([{ issue: 4401, pr: 5401 }, { issue: 4402, pr: 5402 }]);
    w.state.jobs = () => greenJobs().map((j) => (j.name === 'Lint' ? job('Lint', 'failure') : j));
    const r = w.go('4401,4402');
    expect(r.code).toBe(1);
    const [report] = w.reports();
    expect(report.verdict).toBe('red');
    expect(report.reason).toContain('#5401, #5402');
    expect(report.ci.failed).toEqual(['Lint:fail']);
    expect(w.calls.filter((c) => c.command === 'gh' && c.args[1] === 'rerun')).toHaveLength(1);
    assertNoPublish(w);
  });

  it('C9 (R21): the base moves after the verdict → stale, exit 4; the own run is cancelled and the own ref lease-deleted', () => {
    const w = world([{ issue: 4401, pr: 5401 }]);
    w.state.onLook = (look) => {
      if (look === 1) {
        const other = path.join(tmp, 'pusher');
        g(tmp, 'clone', '-q', '-b', 'develop', w.bare, other);
        fs.writeFileSync(path.join(other, 'moved.txt'), 'x\n');
        g(other, 'add', '-A');
        g(other, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'moved');
        g(other, 'push', '-q', 'origin', 'develop');
      }
    };
    const r = w.go('4401');
    expect(r.code).toBe(4);
    const [report] = w.reports();
    expect(report.verdict).toBe('stale');
    expect(report.cancel).toBe('ok run=900');
    expect(w.remoteTrainRefs()).toEqual([]);
    expect(readRecords(w.runDir, ISSUES).logRecords.map((l: { note: string }) => /state=(\S+)/.exec(l.note)![1])).toContain('base-moved');
    assertNoPublish(w);
  });

  it('C9 / C10 (R21): --rebuild-max 1 builds once more under a new ID on the new base; the old train\'s run is not read', () => {
    const w = world([{ issue: 4401, pr: 5401 }]);
    let firstSha = '';
    w.state.runs = ({ sha, branch, look, pushed }) => {
      if (look === 1) {
        firstSha = sha;
        const other = path.join(tmp, 'pusher');
        g(tmp, 'clone', '-q', '-b', 'develop', w.bare, other);
        fs.writeFileSync(path.join(other, 'moved.txt'), 'x\n');
        g(other, 'add', '-A');
        g(other, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'moved');
        g(other, 'push', '-q', 'origin', 'develop');
      }
      // The old train's run goes on and turns green late: listed only for its own SHA and ref.
      return pushed || sha === firstSha
        ? [{ id: 900, path: '.github/workflows/ci-pr.yml', event: 'push', head_sha: sha, head_branch: branch, run_attempt: 1, check_suite_id: 77, status: 'completed' }]
        : [];
    };
    const r = w.go('4401', ['--rebuild-max', '1']);
    expect(r.code, r.err).toBe(0);
    const [report] = w.reports();
    expect(report.rebuilds).toBe(1);
    expect(report.verified.sha).not.toBe(firstSha);
    expect(report.B0).toBe(g(w.repo, 'rev-parse', 'origin/develop'));
    const ids = readRecords(w.runDir, ISSUES).logRecords.map((l: { note: string }) => /train=(\S+)/.exec(l.note)![1]);
    expect(new Set(ids).size).toBe(2);
  });

  it('C11 (R11): two IDs in the same millisecond differ; the ID is UTC to the millisecond, pid and random', () => {
    const at = new Date('2026-11-14T01:02:03.004Z');
    const a = trainId(at, 4369, () => 'aaaaaa');
    const b = trainId(at, 4369, () => 'bbbbbb');
    expect(a).toBe('20261114T010203004Z-4369-aaaaaa');
    expect(a).not.toBe(b);
    expect(TRAIN_ID_PATTERN.test(trainId())).toBe(true);
  });

  it('C12: a ref whose SHA is not the lease is not deleted', () => {
    const w = world([{ issue: 4401, pr: 5401 }]);
    const id = '20261114T000000000Z-1-000001';
    const base = g(w.repo, 'rev-parse', 'develop');
    g(w.repo, 'push', '-q', 'origin', `${base}:${trainTarget('develop', id)}`);
    const run = (command: string, args: string[]) => {
      const out = spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
      return { status: out.status ?? 1, stdout: out.stdout, stderr: out.stderr };
    };
    const del = deleteTrainRef(run, w.repo, { target: trainTarget('develop', id), expect: 'f'.repeat(40), base: 'develop', ids: [id] });
    expect(del.deleted).toBe(false);
    expect(w.remoteTrainRefs()).toHaveLength(1);
    expect(deleteTrainRef(run, w.repo, { target: trainTarget('develop', id), expect: base, base: 'develop', ids: [id] }).deleted).toBe(true);
    expect(w.remoteTrainRefs()).toEqual([]);
  });

  it('C13: no run within --register-timeout, or pending past --ci-timeout → 124', () => {
    const w = world([{ issue: 4401, pr: 5401 }]);
    w.state.runs = () => [];
    const r = w.go('4401', ['--register-timeout', '60']);
    expect(r.code).toBe(124);
    expect(w.reports()[0].reason).toContain('train/**');
  });

  it('C14 (R20): another --repo without --required-checks is exit 2', () => {
    expect(parseArgs(['--run-dir', 'r', '--issues', '1', '--queue', '1', '--repo', 'someone/else'])).toMatchObject({ error: expect.stringContaining('--required-checks') });
    expect((parseArgs(['--run-dir', 'r', '--issues', '1', '--queue', '1', '--repo', 'someone/else', '--required-checks', 'ci']) as { options: { required: string[] } }).options.required).toEqual(['ci']);
    expect((parseArgs(['--run-dir', 'r', '--issues', '1', '--queue', '1']) as { options: { required: string[] } }).options.required).toEqual(LAST_REQUIRED_CHECKS);
  });

  it('C15 / C16 (R19): protection 404, rules [], queue null → absent; rules 403 → unknown and PR1 goes on', () => {
    const w = world([{ issue: 4401, pr: 5401 }]);
    expect(w.go('4401').code).toBe(0);
    expect(w.reports()[0].eligibility).toEqual({ protection: 'absent', rules: 'absent', strict: 'absent', queue: 'absent' });
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    const v = world([{ issue: 4401, pr: 5401 }]);
    v.state.rulesAnswer = { status: 1, stdout: '', stderr: 'gh: Resource not accessible (HTTP 403)' };
    expect(v.go('4401').code).toBe(0);
    expect(v.reports()[0].eligibility).toMatchObject({ rules: 'unknown', strict: 'unknown' });
  });

  it('C17 (R20): an origin that is not --repo is exit 2 before anything else', () => {
    const w = world([{ issue: 4401, pr: 5401 }]);
    g(w.repo, 'config', 'remote.origin.url', 'https://github.com/someone/else.git');
    const r = w.go('4401');
    expect(r.code).toBe(2);
    expect(w.calls.filter((c) => c.command === 'gh')).toEqual([]);
  });

  it('judgeTrain: a run not completed is never green', () => {
    const ev = { run: { id: 1, attempt: 1, checkSuiteId: 1, status: 'in_progress' }, jobs: LAST_REQUIRED_CHECKS.map((name) => ({ name, bucket: 'pass' })), others: [], statuses: [] };
    expect(judgeTrain(ev, { required: LAST_REQUIRED_CHECKS }).state).toBe('pending');
    expect(judgeTrain({ ...ev, run: { ...ev.run, status: 'completed' } }, { required: LAST_REQUIRED_CHECKS }).state).toBe('ok');
  });
});

describe('T-R a diagnosis without the right to publish (U2, I12, I1)', () => {
  type Path = [string, (w: World) => string[], string, number];
  const PATHS: Path[] = [
    ['green', () => [], 'green', 0],
    ['red', (w) => {
      w.state.jobs = () => greenJobs().map((j) => (j.name === 'Lint' ? job('Lint', 'failure') : j));
      return [];
    }, 'red', 1],
    ['empty', (w) => {
      w.prs.get(5401)!.state = 'CLOSED';
      return [];
    }, 'empty', 0],
    ['stale', (w) => {
      w.state.onLook = (look) => {
        if (look !== 1) return;
        const other = path.join(tmp, 'pusher');
        g(tmp, 'clone', '-q', '-b', 'develop', w.bare, other);
        fs.writeFileSync(path.join(other, 'moved.txt'), 'x\n');
        g(other, 'add', '-A');
        g(other, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'moved');
        g(other, 'push', '-q', 'origin', 'develop');
      };
      return [];
    }, 'stale', 4],
    ['stopped (the precheck failed)', (w) => {
      w.state.precheck = () => 1;
      return [];
    }, 'stopped', 1],
    ['timeout', (w) => {
      w.state.runs = () => [];
      return ['--register-timeout', '30'];
    }, 'timeout', 124],
    ['green-after-rerun-unverified', (w) => {
      w.state.jobs = ({ attempt }) => (attempt === 1 ? [job('Lint', 'failure'), ...greenJobs().filter((j) => j.name !== 'Lint')] : greenJobs());
      return [];
    }, 'green-after-rerun-unverified', 1],
    ['stale (the cancel and the lease both fail)', (w) => {
      w.state.cancelFails = true;
      w.state.onLook = (look) => {
        if (look !== 1) return;
        const other = path.join(tmp, 'pusher');
        g(tmp, 'clone', '-q', '-b', 'develop', w.bare, other);
        g(other, 'push', '-q', 'origin', `${g(other, 'rev-parse', 'HEAD')}:refs/heads/train/develop/20261114T000000000Z-4369-000001`, '--force');
        fs.writeFileSync(path.join(other, 'moved.txt'), 'x\n');
        g(other, 'add', '-A');
        g(other, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'moved');
        g(other, 'push', '-q', 'origin', 'develop');
      };
      return [];
    }, 'stale', 4],
  ];
  it.each(PATHS)('X1 / X2: %s — publishable: false and the notice in the text, --json and the saved report; no publishing call', (_name, arrange, verdict, exit) => {
    const w = world([{ issue: 4401, pr: 5401 }, { issue: 4402, pr: 5402 }]);
    if (verdict === 'empty') w.prs.get(5402)!.state = 'CLOSED';
    const extra = arrange(w);
    const r = w.go('4401,4402', ['--json', ...extra]);
    expect(r.code, r.err).toBe(exit);
    const saved = w.reports();
    expect(saved).toHaveLength(1);
    const json = JSON.parse(r.out);
    for (const report of [saved[0], json]) {
      expect(report.publishable).toBe(false);
      expect(report.notice).toBe(NOTICE);
      expect(report.verdict).toBe(verdict);
      expect(report.exit).toBe(exit);
    }
    const text = lines(r.report);
    const top = verdict === 'green-after-rerun-unverified' ? [NOT_RED_LINE, 'publishable: false', NOTICE] : ['publishable: false', NOTICE];
    expect(text.slice(0, top.length)).toEqual(top);
    if (verdict === 'green') {
      expect(saved[0].adopted.every((a: { ciVerified: boolean }) => a.ciVerified === false)).toBe(true);
      expect(text.filter((l) => l.includes('has not been through CI'))).toHaveLength(2);
    }
    assertNoPublish(w);
  });

  it.each([
    ['--merge'], ['--push-base'], ['--fast-forward'], ['--create-pr'], ['--publishable'], ['--close', '4401'],
  ])('X1 / X2 / T-A: %s is refused with exit 2 before anything; the early report is publishable: false too', (...flag) => {
    const w = world([{ issue: 4401, pr: 5401 }]);
    const r = w.go('4401', [...flag, '--json']);
    expect(r.code).toBe(2);
    expect(r.err).toContain(REFUSED_MESSAGE);
    expect(lines(r.err).slice(0, 2)).toEqual(['publishable: false', NOTICE]);
    expect(JSON.parse(r.out)).toMatchObject({ publishable: false, notice: NOTICE, verdict: 'stopped', exit: 2 });
    expect(w.calls).toEqual([]);
  });

  it('X1: buildReport cannot be talked into publishable: true; a report without the field is read as false', () => {
    expect(buildReport({ verdict: 'green', exit: 0, publishable: true } as never).publishable).toBe(false);
    expect(buildReport({ verdict: 'green', exit: 0, notice: 'other' } as never).notice).toBe(NOTICE);
    expect(formatReport(buildReport({ verdict: 'red', exit: 1 })).split('\n').slice(0, 2)).toEqual(['publishable: false', NOTICE]);
  });

  it('X3: the push destination check refuses the base and another ID, before any push', () => {
    const calls: unknown[] = [];
    const run = (...args: unknown[]) => {
      calls.push(args);
      return { status: 0, stdout: '', stderr: '' };
    };
    const own = '20261114T000000000Z-1-abcdef';
    const other = '20261114T000000000Z-2-abcdef';
    for (const target of ['refs/heads/develop', trainTarget('develop', other), 'refs/heads/train/develop', `refs/heads/train/main/${own}`]) {
      expect(() => createTrainRef(run, '/nowhere', { target, sha: 'a'.repeat(40), base: 'develop', ownId: own })).toThrow(/refusing to push/);
      expect(() => deleteTrainRef(run, '/nowhere', { target, expect: 'a'.repeat(40), base: 'develop', ids: [own] })).toThrow(/refusing to push/);
    }
    expect(() => deleteTrainRef(run, '/nowhere', { target: trainTarget('develop', own), expect: '', base: 'develop', ids: [own] })).toThrow(/without a lease/);
    expect(() => assertTrainRef(trainTarget('develop', own), { base: 'develop', ids: [own] })).not.toThrow();
    expect(calls).toEqual([]);
  });

  it('X4: merge-train starts no merge-pr and writes none of the records merge-pr reads', () => {
    const w = world([{ issue: 4401, pr: 5401 }]);
    const before = readRecords(w.runDir, ISSUES).records;
    expect(w.go('4401').code).toBe(0);
    expect(w.calls.some((c) => c.args.join(' ').includes('merge-pr'))).toBe(false);
    const after = readRecords(w.runDir, ISSUES).records;
    expect(after).toEqual(before);
    expect(after.filter((r: { stage: string }) => ['ci', 'merge'].includes(r.stage))).toEqual([]);
  });

  it('X6: an old green report (even one claiming publishable) and its ref do not decide the new run', () => {
    const w = world([{ issue: 4401, pr: 5401 }]);
    const oldId = '20261113T000000000Z-1-000001';
    const base = g(w.repo, 'rev-parse', 'develop');
    g(w.repo, 'push', '-q', 'origin', `${base}:${trainTarget('develop', oldId)}`);
    fs.mkdirSync(path.join(w.runDir, 'train'), { recursive: true });
    fs.writeFileSync(path.join(w.runDir, 'train', `${oldId}.json`), JSON.stringify({ id: oldId, base: 'develop', verdict: 'green', exit: 0, publishable: true, pushed: base }));
    w.state.jobs = () => greenJobs().map((j) => (j.name === 'Lint' ? job('Lint', 'failure') : j));
    const r = w.go('4401');
    expect(r.code).toBe(1);
    const latest = w.reports().find((x) => x.id !== oldId)!;
    expect(latest.verdict).toBe('red');
    expect(latest.publishable).toBe(false);
  });

  it('I13 / P3-2: old refs past --keep-refs are lease-deleted only when their report names their SHA; the rest is counted', () => {
    const w = world([{ issue: 4401, pr: 5401 }]);
    const base = g(w.repo, 'rev-parse', 'develop');
    const ids = ['20261110T000000000Z-1-000001', '20261111T000000000Z-1-000002', '20261112T000000000Z-1-000003'];
    fs.mkdirSync(path.join(w.runDir, 'train'), { recursive: true });
    for (const id of ids) g(w.repo, 'push', '-q', 'origin', `${base}:${trainTarget('develop', id)}`);
    // The oldest has its report with the remote SHA; the middle one a report with another SHA; the newest is kept.
    fs.writeFileSync(path.join(w.runDir, 'train', `${ids[0]}.json`), JSON.stringify({ id: ids[0], base: 'develop', pushed: base }));
    fs.writeFileSync(path.join(w.runDir, 'train', `${ids[1]}.json`), JSON.stringify({ id: ids[1], base: 'develop', pushed: 'f'.repeat(40) }));
    expect(w.go('4401', ['--keep-refs', '1']).code).toBe(0);
    const report = w.reports().find((x) => !ids.includes(x.id))!;
    expect(report.refs.pruned).toEqual([{ id: ids[0], sha: base }]);
    expect(report.refs.skipped.map((s: { id: string }) => s.id)).toEqual([ids[1]]);
    expect(report.refs.remaining).toBe(2);
    expect(w.remoteTrainRefs().map((l) => l.split(/\s+/)[1])).toEqual(expect.arrayContaining([trainTarget('develop', ids[1]), trainTarget('develop', ids[2])]));
    assertNoPublish(w);
  });
});

describe('T-L the train lock (R09)', () => {
  it('L1: a second train on the same base waits and ends 124 at --lock-timeout; nothing is pushed', () => {
    const w = world([{ issue: 4401, pr: 5401 }]);
    const held = acquireMachineLockSync(trainLockName('Kewton/CommandMate', 'develop'), { root: w.lockRoot, timeoutMs: 1000 });
    try {
      const r = w.go('4401', ['--lock-timeout', '0']);
      expect(r.code).toBe(124);
      expect(w.remoteTrainRefs()).toEqual([]);
      expect(readRecords(w.runDir, ISSUES).logRecords.map((l: { note: string }) => /state=(\S+)/.exec(l.note)![1])).toEqual(['lock-timeout']);
      expect(r.err).toContain('publishable: false');
    } finally {
      held.release();
    }
  });

  it('L2: a holder whose parent died while its child still runs keeps the lock; once the group is empty the train starts', async () => {
    const w = world([{ issue: 4401, pr: 5401 }]);
    const events = path.join(tmp, 'events.jsonl');
    const child = spawn(process.execPath, [ACTOR, SYNC_MODULE, w.lockRoot, trainLockName('Kewton/CommandMate', 'develop'), '20', '0', '5000', events, 'grandchild'], { detached: true, stdio: 'ignore' });
    children.push(child);
    const event = (name: string) => {
      try {
        return fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.event === name) ?? null;
      } catch {
        return null;
      }
    };
    const waitFor = async (cond: () => boolean) => {
      for (let i = 0; i < 200 && !cond(); i++) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(cond()).toBe(true);
    };
    const gone = (pid: number) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    };
    await waitFor(() => event('grandchild') !== null);
    const grandchild = event('grandchild').child as number;
    process.kill(child.pid as number, 'SIGKILL');
    await waitFor(() => gone(child.pid as number));
    const held = w.go('4401', ['--lock-timeout', '1']);
    expect(held.code).toBe(124);
    expect(held.err).toContain(`pgid ${child.pid}`);
    expect(w.remoteTrainRefs()).toEqual([]);
    process.kill(grandchild, 'SIGKILL');
    await waitFor(() => gone(-(child.pid as number)));
    const free = w.go('4401', ['--lock-timeout', '5']);
    expect(free.code, free.err).toBe(0);
  }, 20000);

  it('L3: setOwnerFields false → stopped(1) before the next outside call', () => {
    const w = world([{ issue: 4401, pr: 5401 }]);
    const fake = () => ({ acquired: true, waitedMs: 0, heldBy: null, setOwnerFields: () => false, release: () => {} });
    const r = w.go('4401', [], { acquireTrainLock: fake });
    expect(r.code).toBe(1);
    expect(w.calls.filter((c) => c.command === 'gh' || c.args.includes('ls-remote') || c.args.includes('push'))).toEqual([]);
    expect(w.reports()[0]).toMatchObject({ verdict: 'stopped', publishable: false });
  });

  it('L4: a train on another base does not wait', () => {
    const w = world([{ issue: 4401, pr: 5401 }]);
    const held = acquireMachineLockSync(trainLockName('Kewton/CommandMate', 'main'), { root: w.lockRoot, timeoutMs: 1000 });
    try {
      expect(w.go('4401', ['--lock-timeout', '0']).code).toBe(0);
    } finally {
      held.release();
    }
  });

  it('L5 (I8): a held merge lock does not stop the train', () => {
    const w = world([{ issue: 4401, pr: 5401 }]);
    const held = acquireMachineLockSync(mergeLockName('Kewton/CommandMate', 'develop'), { root: w.mergeLocks, timeoutMs: 1000 });
    try {
      expect(w.go('4401', ['--lock-timeout', '0']).code).toBe(0);
    } finally {
      held.release();
    }
  });
});

describe('T-A arguments', () => {
  const base = ['--run-dir', 'r', '--issues', '1', '--queue', '1'];
  it.each([
    [['--run-dir', 'r', '--issues', '1'], /--queue is required/],
    [[...base, '--rebuild-max', '2'], /--rebuild-max must be 0 or 1/],
    [[...base, '--keep-refs', '-1'], /--keep-refs must be a non-negative integer/],
    [[...base, '--max-prs', '0'], /--max-prs must be 1-20/],
    [[...base, '--max-prs', '21'], /--max-prs must be 1-20/],
    [[...base, '--base', 'train/develop/x'], /must not be a train ref/],
  ])('%j → exit 2 (%s)', (argv, message) => {
    const parsed = parseArgs(argv);
    expect('error' in parsed && parsed.error).toMatch(message);
    const err: string[] = [];
    expect(main(argv, { error: (l: string) => err.push(l), run: () => { throw new Error('no call expected'); } })).toBe(2);
    expect(err.join('\n')).toContain('publishable: false');
  });

  it('T5: a git older than 2.40 is exit 2 before the lock', () => {
    const err: string[] = [];
    const calls: string[][] = [];
    const run = (command: string, args: string[]) => {
      calls.push([command, ...args]);
      return { status: 0, stdout: 'git version 2.39.5\n', stderr: '' };
    };
    expect(main([...base], { run, error: (l: string) => err.push(l) })).toBe(2);
    expect(calls).toEqual([['git', '--version']]);
    expect(err.join('\n')).toContain('2.40');
  });
});
