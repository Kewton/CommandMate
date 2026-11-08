/**
 * scripts/orchestrate/merge-pr.mjs `--queue` and the merge lock (Issue #4277).
 *
 * `git` / `gh` are the fake of ./pr-fake.ts, one per worktree, behind a router: nothing is pushed or
 * merged. The run record, the worktrees and the lock root are under os.tmpdir() and removed after
 * each test. Holders of the merge lock in another process are fixtures/lock-actor-4277.mjs.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendRecord, readRecords, queueSummary } from '../../../../scripts/orchestrate/run-log.mjs';
import {
  INNER_ENV,
  LAST_REQUIRED_CHECKS,
  innerSpawnOptions,
  main,
  mergeLockName,
  parseArgs,
  parseQueue,
  readUnresolved,
  runOuter,
} from '../../../../scripts/orchestrate/merge-pr.mjs';
import { acquireMachineLockSync, lockPathOf } from '../../../../scripts/orchestrate/machine-lock-sync.mjs';
import { HEAD_A, type Check, fakeGit, openPr } from './pr-fake';

const REPO = path.resolve(__dirname, '../../../..');
const SCRIPT = path.join(REPO, 'scripts/orchestrate/merge-pr.mjs');
const SYNC_MODULE = path.join(REPO, 'scripts/orchestrate/machine-lock-sync.mjs');
const ACTOR = path.join(REPO, 'tests/unit/verification/fixtures/lock-actor-4277.mjs');
const LOCK = mergeLockName('Kewton/CommandMate', 'develop');

let tmp: string;
let runDir: string;
let lockRoot: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-merge-queue-4277-'));
  runDir = path.join(tmp, 'runs', '2026-11-09');
  lockRoot = path.join(tmp, 'locks');
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

const ISSUES = '4243-4257';
const fullCi = (): Check[] => LAST_REQUIRED_CHECKS.map((name) => ({ name, bucket: 'pass' }));

interface Unit {
  issue: number;
  item?: string;
  pr: number;
  /** false: the run record has no `pr` stage for it (an older run, named with @pr). */
  recorded?: boolean;
}

/** Worktrees, records and one fake per worktree, behind a router that answers like one machine with one GitHub. */
function world(units: Unit[]) {
  const issueState = new Map<number, 'OPEN' | 'CLOSED'>();
  const order: { verb: string; n: string; t: number }[] = [];
  const wts = units.map((u) => {
    const tag = `${u.issue}${u.item ? `-${u.item}` : ''}-${u.pr}`;
    const wt = path.join(tmp, `wt-${tag}`);
    const branch = `feature/${tag}`;
    fs.mkdirSync(path.join(wt, 'dev-reports', 'module-reference'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'dev-reports', 'module-reference', `issue-${u.issue}.md`), '追記なし\n');
    const item = u.item ?? null;
    if (!readRecords(runDir, ISSUES).records.some((r: { issue: number; item?: string; stage: string }) => r.issue === u.issue && (r.item ?? null) === item && r.stage === 'verify')) {
      for (const stage of ['verify', 'review', 'findings', 'precheck']) {
        appendRecord(runDir, ISSUES, { issue: u.issue, item, stage, result: 'ok', head: HEAD_A, note: stage === 'verify' ? 'exit=0(passed) passed=lint,typecheck,unit failed=-' : 'tsc=ok tests=ok' });
      }
    }
    if (u.recorded !== false) appendRecord(runDir, ISSUES, { issue: u.issue, item, stage: 'pr', result: 'ok', head: HEAD_A, note: `pr=#${u.pr} opened` });
    issueState.set(u.issue, 'OPEN');
    const fake = fakeGit({
      branch,
      prs: [openPr({ number: u.pr, headRefName: branch, title: `feat: #${u.issue}`, url: `https://github.com/Kewton/CommandMate/pull/${u.pr}` })],
      checks: [fullCi()],
      changelogStatus: `A\tchangelog.d/${u.issue}.md`,
      changed: [`changelog.d/${u.issue}.md`, 'scripts/orchestrate/merge-pr.mjs'],
    });
    return { unit: u, wt, branch, fake };
  });
  const listed = new Set(wts.map((w) => w.wt));
  const byWt = (wt: string) => wts.find((w) => w.wt === wt);
  const byPr = (n: string) => wts.find((w) => String(w.unit.pr) === n);
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const run = (command: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) => {
    if (command === 'git' && args[2] === 'worktree') {
      return ok(wts.filter((w) => listed.has(w.wt)).map((w) => `worktree ${w.wt}\nHEAD ${HEAD_A}\nbranch refs/heads/${w.branch}\n`).join('\n'));
    }
    if (command === 'git') {
      const target = byWt(args[1]);
      if (!target) throw new Error(`git in an unknown worktree ${args[1]}`);
      return target.fake.run(command, args, opts);
    }
    if (command === 'gh') {
      const key = args.slice(0, 2).join(' ');
      if (key === 'issue view') return ok(JSON.stringify({ state: issueState.get(Number(args[2])) ?? 'OPEN' }));
      if (key === 'issue close') {
        issueState.set(Number(args[2]), 'CLOSED');
        order.push({ verb: 'issue close', n: `${args[2]} ${args[args.indexOf('--comment') + 1]}`, t: Date.now() });
        return ok();
      }
      if (key === 'pr list' && args.includes('--head')) {
        const target = wts.find((x) => x.branch === args[args.indexOf('--head') + 1]);
        return target ? target.fake.run(command, args, opts) : ok('[]');
      }
      if (['pr view', 'pr checks', 'pr merge'].includes(key)) {
        const target = byPr(args[2]);
        if (!target) return { status: 1, stdout: '', stderr: 'no pull requests found' };
        if (key === 'pr merge') order.push({ verb: 'pr merge', n: args[2], t: Date.now() });
        return target.fake.run(command, args, opts);
      }
      throw new Error(`unexpected gh ${args.join(' ')}`);
    }
    return wts[0].fake.run(command, args, opts);
  };
  const writes = () => order.filter((o) => o.verb === 'pr merge').map((o) => Number(o.n));
  return { wts, run, order, writes, issueState, unlist: (wt: string) => listed.delete(wt) };
}

function runQueue(w: ReturnType<typeof world>, queue: string, extra: string[] = [], extraDeps: Record<string, unknown> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  let clock = Date.UTC(2026, 10, 9, 3, 0);
  const slept: number[] = [];
  const code = main(['--run-dir', runDir, '--issues', ISSUES, '--queue', queue, ...extra], {
    run: w.run,
    sleep: (ms: number) => {
      slept.push(ms);
      clock += ms;
    },
    now: () => new Date(clock),
    findTestsNaming: () => [],
    lockRoot,
    repoDir: tmp,
    log: (l: string) => out.push(l),
    error: (l: string) => err.push(l),
    ...extraDeps,
  });
  return { code, out: out.join('\n'), err: err.join('\n'), slept };
}

const queueStates = () =>
  readRecords(runDir, ISSUES).logRecords.map((r: { issue: number; item?: string; note: string }) => `${r.issue}${r.item ? `/${r.item}` : ''}:${/state=(\S+)/.exec(r.note)?.[1]}`);

/** A merge-lock owner left by a holder that died (`pid` gone): what a killed merge-pr leaves. */
function deadHolder(owner: Record<string, unknown>) {
  const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const lockPath = lockPathOf(lockRoot, LOCK);
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, 'owner'), JSON.stringify({ pid: Number(gone.stdout), host: os.hostname(), token: `dead-${Date.now()}`, acquiredAt: 0, ...owner }));
}

function startActor({ holdMs, mode, detached = false }: { holdMs: number; mode?: string; detached?: boolean }) {
  const events = path.join(tmp, `events-${children.length}.jsonl`);
  const child = spawn(process.execPath, [ACTOR, SYNC_MODULE, lockRoot, LOCK, '50', String(holdMs), '20000', events, ...(mode ? [mode] : [])], { stdio: 'ignore', detached });
  children.push(child);
  const read = (): { event: string; t: number; child?: number }[] =>
    fs.existsSync(events) ? fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { child, event: (kind: string) => read().find((e) => e.event === kind) ?? null };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('parseQueue / parseArgs', () => {
  it('reads <issue>[/<item>][@<pr>] and keeps two named PRs of one Issue apart (review 2, finding 4)', () => {
    expect(parseQueue('4245,4257/d1,3883@3889')).toEqual({
      entries: [
        { text: '4245', issue: 4245, item: null, pr: null },
        { text: '4257/d1', issue: 4257, item: 'd1', pr: null },
        { text: '3883@3889', issue: 3883, item: null, pr: 3889 },
      ],
    });
    expect('entries' in parseQueue('3883@3889,3883@3895')).toBe(true);
    expect(parseQueue('3883,3883')).toMatchObject({ error: expect.stringContaining('twice') });
    expect(parseQueue('3883@3889,3883@3889')).toMatchObject({ error: expect.stringContaining('twice') });
    expect(parseQueue('3883,3883@3895')).toMatchObject({ error: expect.stringContaining('same unit') });
    expect(parseQueue('3883/d1,3883/d2')).toHaveProperty('entries');
    expect(parseQueue('x')).toHaveProperty('error');
  });

  it('refuses the single-PR flags and a --close other than -', () => {
    const base = ['--run-dir', 'r', '--issues', '1', '--queue', '1,2'];
    expect(parseArgs(base).error).toBeUndefined();
    expect(parseArgs([...base, '--issue', '1']).error).toMatch(/--queue cannot be combined with --issue/);
    expect(parseArgs([...base, '--worktree', '/w']).error).toMatch(/--worktree/);
    expect(parseArgs([...base, '--close', '7']).error).toMatch(/--close -/);
    expect(parseArgs([...base, '--close', '-', '--last']).error).toBeUndefined();
  });

  it('caps --merge-lock-timeout at 86400', () => {
    const w = world([{ issue: 4245, pr: 4263 }]);
    expect(runQueue(w, '4245', ['--merge-lock-timeout', '86401']).code).toBe(2);
    expect(w.writes()).toEqual([]);
  });
});

describe('--queue: one PR at a time (acceptance: the queue)', () => {
  it('positive control: three entries are merged one by one, in order, each Issue closed after its own merge', () => {
    const w = world([{ issue: 4245, pr: 4263 }, { issue: 4257, pr: 4264 }, { issue: 4243, pr: 4265 }]);
    const r = runQueue(w, '4245,4257,4243');
    expect(r.code, r.err).toBe(0);
    expect(w.writes()).toEqual([4263, 4264, 4265]);
    expect(w.order.map((o) => o.verb)).toEqual(['pr merge', 'issue close', 'pr merge', 'issue close', 'pr merge', 'issue close']);
    expect(queueSummary(readRecords(runDir, ISSUES).logRecords).map((q: { issue: number; state: string | null }) => `${q.issue}:${q.state}`)).toEqual(['4245:merged', '4257:merged', '4243:merged']);
    // The progress record is the same as three single calls: a merge stage per Issue.
    expect(readRecords(runDir, ISSUES).records.filter((x: { stage: string; result: string }) => x.stage === 'merge' && x.result === 'ok')).toHaveLength(3);
  });

  it('retries exit 3 (60 s apart) and exit 4 (at once), and ends with 0', () => {
    const w = world([{ issue: 4245, pr: 4263 }, { issue: 4257, pr: 4264 }, { issue: 4243, pr: 4265 }]);
    const answers: Record<string, number[]> = { '4245': [0], '4257': [3, 0], '4243': [4, 0] };
    const calls: string[] = [];
    const r = runQueue(w, '4245,4257,4243', [], {
      mergeOne: (o: { issue: string; last: boolean }) => {
        calls.push(`${o.issue}${o.last ? ':last' : ''}`);
        return answers[o.issue].shift();
      },
    });
    expect(r.code, r.err).toBe(0);
    expect(calls).toEqual(['4245', '4257', '4257', '4243:last', '4243:last']);
    expect(r.slept).toEqual([60000]);
    const notes = readRecords(runDir, ISSUES).logRecords.map((x: { note: string }) => x.note);
    expect(notes.some((n: string) => n.includes('state=retry') && n.includes('exit=3 next-in=60s'))).toBe(true);
    expect(notes.some((n: string) => n.includes('state=retry') && n.includes('exit=4 next-in=0s'))).toBe(true);
  });

  it('negative control: exit 1 stops the queue — later entries are not merged and stay waiting', () => {
    const w = world([{ issue: 4245, pr: 4263 }, { issue: 4257, pr: 4264 }, { issue: 4243, pr: 4265 }]);
    w.wts[1].fake.state.failCommands.push('gh pr merge');
    const r = runQueue(w, '4245,4257,4243');
    expect(r.code).toBe(1);
    expect(w.writes()).toEqual([4263, 4264]);
    expect(r.err).toContain('stopped at 4257 (exit 1)');
    expect(r.err).toContain('not started: 4243');
    const latest = queueSummary(readRecords(runDir, ISSUES).logRecords).map((q: { issue: number; state: string | null }) => `${q.issue}:${q.state}`);
    expect(latest).toEqual(['4245:merged', '4257:stopped', '4243:waiting']);
  });

  it('negative control: past the retry limits it stops with that exit (3 after 3 tries, 4 after 6)', () => {
    for (const [exit, tries] of [[3, 3], [4, 6]]) {
      fs.rmSync(runDir, { recursive: true, force: true });
      const w = world([{ issue: 4245, pr: 4263 }, { issue: 4257, pr: 4264 }]);
      let n = 0;
      const r = runQueue(w, '4245,4257', [], {
        mergeOne: (o: { issue: string }) => {
          if (o.issue === '4257') throw new Error('not reached');
          n += 1;
          return exit;
        },
      });
      expect(r.code).toBe(exit);
      expect(n).toBe(tries);
    }
  });

  it('the single-PR call is the same as before: it merges and closes (negative control)', () => {
    const w = world([{ issue: 4245, pr: 4263 }]);
    const out: string[] = [];
    const code = main(['--run-dir', runDir, '--issues', ISSUES, '--issue', '4245', '--worktree', w.wts[0].wt], {
      run: w.run,
      sleep: () => {},
      findTestsNaming: () => [],
      lockRoot,
      log: (l: string) => out.push(l),
      error: (l: string) => out.push(l),
    });
    expect(code, out.join('\n')).toBe(0);
    expect(w.writes()).toEqual([4263]);
    expect(fs.existsSync(lockPathOf(lockRoot, LOCK))).toBe(false);
  });
});

describe('R5: every entry is resolved before anything is written', () => {
  it('two work items of one Issue go to their own PR, branch and worktree; a rerun after the first merge goes on from the second', () => {
    const w = world([{ issue: 3883, item: 'd1', pr: 3889 }, { issue: 3883, item: 'd2', pr: 3895 }]);
    w.wts[1].fake.state.failCommands.push('gh pr merge');
    expect(runQueue(w, '3883/d1,3883/d2').code).toBe(1);
    expect(w.writes()).toEqual([3889, 3895]);
    // d1 is merged and its worktree cleaned up; the same call goes on from d2.
    w.unlist(w.wts[0].wt);
    w.wts[1].fake.state.failCommands.length = 0;
    const again = runQueue(w, '3883/d1,3883/d2');
    expect(again.code, again.err).toBe(0);
    expect(w.writes()).toEqual([3889, 3895, 3895]);
    // Work items do not close the Issue.
    expect(w.order.filter((o) => o.verb === 'issue close')).toEqual([]);
  });

  it('negative control: an ambiguous pr record, a missing worktree, two entries for one PR — exit 2, nothing written', () => {
    // 2026-10-24: #3883 had two item-less pr records (#3889, #3895).
    const w = world([{ issue: 3883, pr: 3889 }, { issue: 3883, pr: 3895, recorded: true }, { issue: 4245, pr: 4263 }]);
    const ambiguous = runQueue(w, '3883');
    expect(ambiguous.code).toBe(2);
    expect(ambiguous.err).toContain('#3889 and #3895');
    w.unlist(w.wts[2].wt);
    const noWorktree = runQueue(w, '4245');
    expect(noWorktree.code).toBe(2);
    expect(noWorktree.err).toContain('no worktree');
    const samePr = runQueue(w, '3883@3889,4245@3889');
    expect(samePr.code).toBe(2);
    expect(w.writes()).toEqual([]);
    expect(readRecords(runDir, ISSUES).logRecords).toEqual([]);
    expect(fs.existsSync(lockPathOf(lockRoot, LOCK))).toBe(false);
  });

  it('S4 (review 2, finding 4): two named PRs of an old run\'s Issue are merged in turn, and only the last closes it', () => {
    const w = world([{ issue: 3883, pr: 3889, recorded: false }, { issue: 3883, pr: 3895, recorded: false }]);
    const r = runQueue(w, '3883@3889,3883@3895');
    expect(r.code, r.err).toBe(0);
    expect(w.writes()).toEqual([3889, 3895]);
    expect(w.order.filter((o) => o.verb === 'issue close').map((o) => o.n)).toEqual(['3883 #3895 でマージした。']);
  });
});

describe('S2 (review 2, finding 2): a write a dead holder left unconfirmed stops every later run until it is finished', () => {
  it('positive control: B stops, and C stops too; a queue naming that PR finishes it first and clears the stop', () => {
    const w = world([{ issue: 5000, pr: 5001 }, { issue: 4245, pr: 4263 }]);
    deadHolder({ phase: 'merge', entry: '5000', issue: 5000, pr: 5001, pgid: undefined });

    const b = runQueue(w, '4245');
    expect(b.code).toBe(1);
    expect(b.err).toContain('died while writing #5000 (pr=#5001) phase=merge');
    const c = runQueue(w, '4245');
    expect(c.code).toBe(1);
    expect(w.writes()).toEqual([]);
    expect(queueStates().filter((s: string) => s.endsWith('recovered-stop'))).toHaveLength(2);
    expect(readUnresolved(lockRoot, LOCK)).toHaveLength(1);
    // A single-PR call on another PR stops as well.
    const single = main(['--run-dir', runDir, '--issues', ISSUES, '--issue', '4245', '--worktree', w.wts[1].wt], {
      run: w.run, sleep: () => {}, findTestsNaming: () => [], lockRoot, log: () => {}, error: () => {},
    });
    expect(single).toBe(1);
    expect(w.writes()).toEqual([]);

    // The dead holder's merge did land (GitHub says MERGED): the queue that names it records it first.
    w.wts[0].fake.state.prs[0].state = 'MERGED';
    const d = runQueue(w, '4245,5000');
    expect(d.code, d.err).toBe(0);
    expect(w.writes()).toEqual([4263]);
    expect(w.order.map((o) => `${o.verb} ${o.n.split(' ')[0]}`)).toEqual(['issue close 5000', 'pr merge 4263', 'issue close 4245']);
    expect(readUnresolved(lockRoot, LOCK)).toEqual([]);
  });

  it('negative control: a holder that died while only reading (ci-wait) is recovered and the queue goes on', () => {
    const w = world([{ issue: 4245, pr: 4263 }]);
    deadHolder({ phase: 'ci-wait', entry: '4999', issue: 4999, pr: 5009 });
    const r = runQueue(w, '4245');
    expect(r.code, r.err).toBe(0);
    expect(queueStates()).toContain('4245:recovered');
    expect(readUnresolved(lockRoot, LOCK)).toEqual([]);
  });
});

describe('R2: the merge lock lives as long as any process of its holder\'s group', () => {
  it('positive control: a holder killed while its child still runs keeps the lock; once the group is empty the queue starts', async () => {
    const holder = startActor({ holdMs: 0, mode: 'grandchild', detached: true });
    await waitFor(() => holder.event('grandchild') !== null);
    const grandchild = holder.event('grandchild')!.child as number;
    process.kill(holder.child.pid as number, 'SIGKILL');
    await waitFor(() => {
      try {
        process.kill(holder.child.pid as number, 0);
        return false;
      } catch {
        return true;
      }
    });
    const w = world([{ issue: 4245, pr: 4263 }]);
    const held = runQueue(w, '4245', ['--merge-lock-timeout', '1']);
    expect(held.code).toBe(124);
    expect(held.err).toContain(`pgid ${holder.child.pid}`);
    expect(w.writes()).toEqual([]);
    expect(queueStates()).toContain('4245:lock-timeout');

    process.kill(grandchild, 'SIGKILL');
    await waitFor(() => {
      try {
        process.kill(-(holder.child.pid as number), 0);
        return false;
      } catch {
        return true;
      }
    });
    const free = runQueue(w, '4245', ['--merge-lock-timeout', '5']);
    expect(free.code, free.err).toBe(0);
    expect(w.writes()).toEqual([4263]);
  }, 20000);

  it('negative control: a holder killed with no child left is recovered at once', async () => {
    const holder = startActor({ holdMs: 30000 });
    await waitFor(() => holder.event('acquired') !== null);
    process.kill(holder.child.pid as number, 'SIGKILL');
    await waitFor(() => {
      try {
        process.kill(holder.child.pid as number, 0);
        return false;
      } catch {
        return true;
      }
    });
    const w = world([{ issue: 4245, pr: 4263 }]);
    const r = runQueue(w, '4245', ['--merge-lock-timeout', '5']);
    expect(r.code, r.err).toBe(0);
    expect(queueStates()).toContain('4245:recovered');
  }, 20000);
});

describe('(d) the queue does not wait for itself', () => {
  it('positive control: one merge lock for the whole queue — taken once, the later entries start without a wait', () => {
    const w = world([{ issue: 4245, pr: 4263 }, { issue: 4257, pr: 4264 }, { issue: 4243, pr: 4265 }]);
    const takes: string[] = [];
    const r = runQueue(w, '4245,4257,4243', [], {
      acquireMergeLock: (name: string, options: Parameters<typeof acquireMachineLockSync>[1]) => {
        takes.push(name);
        return acquireMachineLockSync(name, options);
      },
    });
    expect(r.code, r.err).toBe(0);
    expect(takes).toEqual([LOCK]);
    expect(w.writes()).toEqual([4263, 4264, 4265]);
  });

  it('negative control: while another process holds the merge lock the queue waits, and starts once it is released', async () => {
    const holder = startActor({ holdMs: 800 });
    await waitFor(() => holder.event('acquired') !== null);
    const w = world([{ issue: 4245, pr: 4263 }]);
    const r = runQueue(w, '4245', ['--merge-lock-timeout', '10']);
    expect(r.code, r.err).toBe(0);
    expect(w.order[0].t).toBeGreaterThanOrEqual(holder.event('released')!.t);
  }, 20000);
});

describe('S3 (review 2, finding 3): the inner process keeps the parent\'s environment', () => {
  it('innerSpawnOptions: detached, the whole environment, and the inner mark', () => {
    const env = { PATH: '/usr/bin:/opt/gh/bin', GH_TOKEN: 'secret', CM_VERIFY_LOCK_ROOT: '/tmp/locks-x', HOME: '/home/u' };
    const options = innerSpawnOptions(env);
    expect(options.detached).toBe(true);
    expect(options.stdio).toBe('inherit');
    expect(options.env).toEqual({ ...env, [INNER_ENV]: '1' });
  });

  it('runOuter starts the script itself with those options and returns its exit code', async () => {
    const seen: { file: string; args: string[]; options: ReturnType<typeof innerSpawnOptions> }[] = [];
    const fakeSpawn = (file: string, args: string[], options: ReturnType<typeof innerSpawnOptions>) => {
      seen.push({ file, args, options });
      const listeners: Record<string, (...a: unknown[]) => void> = {};
      setTimeout(() => listeners.exit?.(7, null), 0);
      return { pid: 999999, on: (event: string, fn: (...a: unknown[]) => void) => (listeners[event] = fn) };
    };
    const code = await runOuter(['--queue', '1'], { spawnImpl: fakeSpawn as never, script: SCRIPT, env: { PATH: '/x', CM_VERIFY_LOCK_ROOT: '/y' } });
    expect(code).toBe(7);
    expect(seen[0].file).toBe(process.execPath);
    expect(seen[0].args).toEqual([SCRIPT, '--queue', '1']);
    expect(seen[0].options.env).toMatchObject({ PATH: '/x', CM_VERIFY_LOCK_ROOT: '/y', [INNER_ENV]: '1' });
  });

  it('the real command goes through the inner process (a usage error is its exit 2)', () => {
    const env = { ...process.env };
    delete env[INNER_ENV];
    const r = spawnSync(process.execPath, [SCRIPT, '--run-dir', runDir, '--issues', ISSUES, '--queue', 'x'], { encoding: 'utf8', env });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('is not <issue>[/<item>][@<pr>]');
  });
});

describe('orchestrate.md 6-2 calls the queue in a form it accepts', () => {
  const body = fs.readFileSync(path.join(REPO, '.claude/commands/orchestrate.md'), 'utf8');
  const section = body.slice(body.indexOf('### 6-2.'), body.indexOf('### 6-3.'));

  it('has a --queue call whose flags parse, and points at the rules in ci-merge.md', () => {
    const line = section.split('\n').find((l) => l.includes('merge-pr.mjs') && l.includes('--queue')) ?? '';
    expect(line).not.toBe('');
    const args = line.slice(line.indexOf('merge-pr.mjs') + 'merge-pr.mjs'.length).replace(/#.*$/, '').replace(/\\$/, '').trim().split(/\s+/).map((a) => a.replace(/^"|"$/g, ''));
    const parsed = parseArgs(args);
    expect(parsed.error).toBeUndefined();
    expect(parsed.options?.queue).toBe('$MERGE_ISSUES');
    expect(section).toContain('docs/orchestrate/ci-merge.md#6-2-マージの列--queue');
    const doc = fs.readFileSync(path.join(REPO, 'docs/orchestrate/ci-merge.md'), 'utf8');
    expect(doc).toContain('## 6-2 マージの列（--queue）');
  });
});
