/**
 * scripts/orchestrate/pr-common.mjs `withGhRetry` — GitHub's 5xx is asked
 * again (Issue #3633 D).
 *
 * On 2026-10-12 GitHub answered `gh pr view` / `pr list` / `pr checks` with
 * `HTTP 504 Gateway Timeout` while "Partially Degraded", and merge-pr.mjs
 * stopped with exit 1 more than ten times. 502 / 503 / 504 and a dropped
 * connection are tried again a few times, apart, and said so; a 4xx or a real
 * failure is the answer and is not.
 *
 * `gh` is the fake of ./pr-fake.ts and `sleep` is replaced: nothing waits.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendRecord, readRecords } from '../../../../scripts/orchestrate/run-log.mjs';
import {
  GH_ATTEMPTS,
  GH_RETRY_DELAYS_MS,
  ghWrite,
  isGhRead,
  isTransientGhFailure,
  withGhRetry,
} from '../../../../scripts/orchestrate/pr-common.mjs';
import { main as mergeMain } from '../../../../scripts/orchestrate/merge-pr.mjs';
import { main as publishMain } from '../../../../scripts/orchestrate/publish-pr.mjs';
import { HEAD_A, fakeGit, openPr } from './pr-fake';

type Out = { status: number; stdout: string; stderr: string };
const ok = (stdout = '{}'): Out => ({ status: 0, stdout, stderr: '' });
const failed = (stderr: string, status = 1): Out => ({ status, stdout: '', stderr });
const GATEWAY_TIMEOUT = 'HTTP 504: Gateway Timeout (https://api.github.com/graphql)';

/** A `run` that answers from a list (the last repeats), counting calls. */
function scripted(answers: Out[]) {
  const calls: { command: string; args: string[] }[] = [];
  const run = (command: string, args: string[]) => {
    calls.push({ command, args });
    return answers[Math.min(calls.length - 1, answers.length - 1)];
  };
  return { run, calls };
}

function retrying(answers: Out[]) {
  const { run, calls } = scripted(answers);
  const sleeps: number[] = [];
  const notices: string[] = [];
  const wrapped = withGhRetry(run, { sleep: (ms: number) => sleeps.push(ms), notice: (line: string) => notices.push(line) });
  return { wrapped, calls, sleeps, notices };
}

describe('isTransientGhFailure', () => {
  it.each([
    GATEWAY_TIMEOUT,
    'HTTP 502: Bad Gateway (https://api.github.com/repos/Kewton/CommandMate/pulls)',
    'HTTP 503: Service Unavailable',
    'error connecting to api.github.com',
    'Post "https://api.github.com/graphql": read tcp 10.0.0.2:51234->140.82.112.6:443: read: connection reset by peer',
    'dial tcp: lookup api.github.com: i/o timeout',
  ])('a gateway error or a dropped connection is transient: %s', (stderr) => {
    expect(isTransientGhFailure(failed(stderr))).toBe(true);
  });

  it.each([
    'HTTP 404: Not Found (https://api.github.com/repos/Kewton/CommandMate/pulls/1)',
    'HTTP 422: Validation Failed',
    'HTTP 401: Bad credentials',
    'no pull requests found for branch "feature/x"',
    'Pull request #1 is not mergeable: the merge commit cannot be cleanly created.',
  ])('a 4xx or a real failure is not (negative control): %s', (stderr) => {
    expect(isTransientGhFailure(failed(stderr))).toBe(false);
  });

  it('a success is never transient, whatever it prints', () => {
    expect(isTransientGhFailure({ status: 0, stdout: 'HTTP 504 in a PR title', stderr: '' })).toBe(false);
  });
});

describe('withGhRetry', () => {
  it('asks again after a 504, apart, and says so; the answer that came is returned', () => {
    const r = retrying([failed(GATEWAY_TIMEOUT), failed(GATEWAY_TIMEOUT), ok('[1]')]);
    expect(r.wrapped('gh', ['pr', 'view', '4242'])).toEqual(ok('[1]'));
    expect(r.calls).toHaveLength(3);
    expect(r.sleeps).toEqual(GH_RETRY_DELAYS_MS.slice(0, 2));
    expect(r.notices).toHaveLength(2);
    expect(r.notices[0]).toMatch(/^gh pr view: HTTP 504: Gateway Timeout .* retrying in 10s \(attempt 2\/4\)$/);
  });

  it('gives up after GH_ATTEMPTS tries and returns the last failure as gh said it', () => {
    const r = retrying([failed(GATEWAY_TIMEOUT)]);
    expect(r.wrapped('gh', ['pr', 'checks', '4242'])).toEqual(failed(GATEWAY_TIMEOUT));
    expect(r.calls).toHaveLength(GH_ATTEMPTS);
    expect(r.sleeps).toHaveLength(GH_ATTEMPTS - 1);
  });

  it('does not ask again on a 4xx (negative control)', () => {
    const r = retrying([failed('HTTP 422: Validation Failed'), ok()]);
    expect(r.wrapped('gh', ['pr', 'create'])).toEqual(failed('HTTP 422: Validation Failed'));
    expect(r.calls).toHaveLength(1);
    expect(r.sleeps).toEqual([]);
    expect(r.notices).toEqual([]);
  });

  it('does not ask again on pending checks (gh pr checks exits 8 with the JSON on stdout)', () => {
    const r = retrying([{ status: 8, stdout: '[{"name":"Build","bucket":"pending"}]', stderr: '' }]);
    expect(r.wrapped('gh', ['pr', 'checks', '4242']).status).toBe(8);
    expect(r.calls).toHaveLength(1);
  });

  it('leaves every command but gh alone, even one that prints the same words (negative control)', () => {
    const r = retrying([failed('fatal: unable to access: The requested URL returned error: 504'), ok()]);
    expect(r.wrapped('git', ['push']).status).toBe(1);
    expect(r.calls).toHaveLength(1);
  });
});

describe('only reading gh calls are asked again (#3633 consistency review P2)', () => {
  it.each([
    ['pr', 'view', '4242'],
    ['pr', 'list', '--head', 'x'],
    ['pr', 'checks', '4242'],
    ['issue', 'view', '3633'],
    ['run', 'view', '555'],
    ['run', 'list'],
    ['api', 'repos/Kewton/CommandMate/pulls'],
    ['api', '-X', 'GET', 'repos/x/y'],
    ['api', '--method=get', 'repos/x/y'],
  ])('reads: %s', (...args) => {
    expect(isGhRead(args)).toBe(true);
  });

  it.each([
    ['pr', 'create', '--title', 't'],
    ['pr', 'merge', '4242', '--squash'],
    ['pr', 'edit', '4242'],
    ['run', 'rerun', '555', '--failed'],
    ['issue', 'close', '3633'],
    ['issue', 'comment', '3633'],
    ['api', '-X', 'POST', 'repos/x/y/issues'],
    ['api', '--method', 'PATCH', 'repos/x/y'],
    ['api', '-XDELETE', 'repos/x/y'],
    ['api', 'repos/x/y/issues', '-f', 'title=t'],
    ['api', 'repos/x/y/issues', '--field=title=t'],
    ['api', 'graphql', '-Fquery=@q.graphql'],
    ['some', 'thing'],
  ])('writes (or unknown) are not: %s', (...args) => {
    expect(isGhRead(args)).toBe(false);
  });

  it.each([['pr', 'create'], ['pr', 'merge', '4242'], ['run', 'rerun', '555', '--failed'], ['issue', 'close', '3633']])(
    'withGhRetry sends a write once, even on a 504: %s',
    (...args) => {
      const r = retrying([failed(GATEWAY_TIMEOUT), ok()]);
      expect(r.wrapped('gh', args)).toEqual(failed(GATEWAY_TIMEOUT));
      expect(r.calls).toHaveLength(1);
      expect(r.sleeps).toEqual([]);
    }
  );
});

describe('ghWrite: a write that met a 504 is read back, never sent again', () => {
  function writing(answer: Out) {
    const { run, calls } = scripted([answer]);
    const notices: string[] = [];
    let confirms = 0;
    return {
      calls,
      notices,
      confirms: () => confirms,
      send: (done: string | null | (() => string | null)) =>
        ghWrite(run, ['pr', 'merge', '4242'], {
          notice: (line: string) => notices.push(line),
          confirm: () => {
            confirms += 1;
            return typeof done === 'function' ? done() : done;
          },
        }),
    };
  }

  it('done on GitHub: a success with what the read gave, sent once', () => {
    const w = writing(failed(GATEWAY_TIMEOUT));
    expect(w.send('https://github.com/x/y/pull/1\n')).toEqual({ status: 0, stdout: 'https://github.com/x/y/pull/1\n', stderr: '', confirmed: true });
    expect(w.calls).toHaveLength(1);
    expect(w.notices).toEqual([expect.stringMatching(/^gh pr merge: HTTP 504.* — not sent again; it went through$/)]);
  });

  it('not done: the call\'s own failure, sent once', () => {
    const w = writing(failed(GATEWAY_TIMEOUT));
    expect(w.send(null)).toEqual(failed(GATEWAY_TIMEOUT));
    expect(w.calls).toHaveLength(1);
    expect(w.notices).toEqual([expect.stringContaining('not sent again; it did not go through')]);
  });

  it('the read back fails too: the call\'s own failure', () => {
    const w = writing(failed(GATEWAY_TIMEOUT));
    expect(
      w.send(() => {
        throw new Error('gh pr view failed: HTTP 504');
      })
    ).toEqual(failed(GATEWAY_TIMEOUT));
    expect(w.calls).toHaveLength(1);
    expect(w.notices[0]).toContain('could not read whether it went through');
  });

  it('a success or a 4xx is returned as it is, without reading back (negative control)', () => {
    const done = writing(ok('merged'));
    expect(done.send(null)).toEqual(ok('merged'));
    expect(done.confirms()).toBe(0);
    const refused = writing(failed('HTTP 405: Pull Request is not mergeable'));
    expect(refused.send('')).toEqual(failed('HTTP 405: Pull Request is not mergeable'));
    expect(refused.confirms()).toBe(0);
    expect(refused.notices).toEqual([]);
  });
});

describe('merge-pr.mjs and publish-pr.mjs ask through withGhRetry', () => {
  let tmp: string;
  let runDir: string;
  let worktree: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-orchestrate-gh-retry-'));
    runDir = path.join(tmp, 'runs', '2026-10-12');
    worktree = path.join(tmp, 'wt');
    fs.mkdirSync(path.join(worktree, 'dev-reports', 'module-reference'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'dev-reports', 'module-reference', 'issue-3477.md'), '追記なし\n');
    for (const stage of ['verify', 'review', 'findings', 'precheck']) {
      appendRecord(runDir, '3477', {
        issue: 3477, stage, result: 'ok', head: HEAD_A,
        note: stage === 'precheck' ? 'tsc=ok tests=ok' : stage === 'verify' ? 'exit=0(passed) passed=lint,typecheck failed=-' : undefined,
      });
    }
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const argv = () => ['--run-dir', runDir, '--issues', '3477', '--issue', '3477', '--worktree', worktree];

  /** The fake, with the first `failures` calls of `gh <key>` answered by `stderr`. */
  function flaky(fake: ReturnType<typeof fakeGit>, key: string, stderr: string, failures: number) {
    let left = failures;
    return (command: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }) => {
      if (command === 'gh' && args.slice(0, 2).join(' ') === key && left > 0) {
        left -= 1;
        fake.calls.push({ command, args });
        return failed(stderr);
      }
      return fake.run(command, args, opts);
    };
  }

  function deps(run: ReturnType<typeof flaky>) {
    const err: string[] = [];
    const sleeps: number[] = [];
    let clock = Date.UTC(2026, 9, 12, 3, 0);
    return {
      err,
      sleeps,
      deps: {
        run,
        sleep: (ms: number) => {
          sleeps.push(ms);
          clock += ms;
        },
        now: () => new Date(clock),
        findTestsNaming: () => [],
        log: () => {},
        error: (line: string) => err.push(line),
      },
    };
  }

  it('merge-pr: a 504 on gh pr view is asked again and the PR is merged', () => {
    const fake = fakeGit({ prs: [openPr()], checks: [[{ name: 'Build', bucket: 'pass' }, { name: 'Lint', bucket: 'pass' }, { name: 'Unit Tests', bucket: 'pass' }]] });
    const d = deps(flaky(fake, 'pr view', GATEWAY_TIMEOUT, 2));
    expect(mergeMain(argv(), d.deps)).toBe(0);
    expect(fake.ghCalls('pr merge')).toHaveLength(1);
    expect(d.err.filter((line) => line.includes('retrying'))).toHaveLength(2);
    expect(d.sleeps.slice(0, 2)).toEqual(GH_RETRY_DELAYS_MS.slice(0, 2));
  });

  it('merge-pr: a 404 on gh pr list stops as before, without asking again (negative control)', () => {
    const fake = fakeGit({ prs: [openPr()] });
    const d = deps(flaky(fake, 'pr list', 'HTTP 404: Not Found (https://api.github.com/graphql)', 1));
    expect(mergeMain(argv(), d.deps)).toBe(1);
    expect(fake.ghCalls('pr list')).toHaveLength(1);
    expect(d.err.join('\n')).toContain('HTTP 404');
    expect(d.err.join('\n')).not.toContain('retrying');
  });

  it('publish-pr: a 503 on gh pr list is asked again and the PR is opened', () => {
    const fake = fakeGit();
    const d = deps(flaky(fake, 'pr list', 'HTTP 503: Service Unavailable', 1));
    expect(publishMain(argv(), d.deps)).toBe(0);
    expect(fake.ghCalls('pr create')).toHaveLength(1);
    expect(d.err.filter((line) => line.includes('retrying'))).toHaveLength(1);
  });
  /** The fake, with `gh <key>` answered by a 504 — after doing it (`done`) or without. */
  function timedOut(fake: ReturnType<typeof fakeGit>, key: string, done: boolean) {
    return (command: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }) => {
      if (command === 'gh' && args.slice(0, 2).join(' ') === key) {
        if (done) fake.run(command, args, opts);
        else fake.calls.push({ command, args });
        return failed(GATEWAY_TIMEOUT);
      }
      return fake.run(command, args, opts);
    };
  }

  const GREEN_CHECKS = [{ name: 'Build', bucket: 'pass' }, { name: 'Lint', bucket: 'pass' }, { name: 'Unit Tests', bucket: 'pass' }];
  const RUN_LINK = 'https://github.com/Kewton/CommandMate/actions/runs/555/job/1';

  it('publish-pr: pr create answered 504 but opened: not sent again, recorded as opened', () => {
    const fake = fakeGit();
    const d = deps(timedOut(fake, 'pr create', true));
    expect(publishMain(argv(), d.deps)).toBe(0);
    expect(fake.ghCalls('pr create')).toHaveLength(1);
    expect(d.err.join('\n')).toContain('gh pr create: HTTP 504');
    expect(d.err.join('\n')).toContain('it went through');
    expect(readRecords(runDir, '3477').records.find((r) => r.stage === 'pr')?.note).toContain('pr=#9001');
  });

  it('publish-pr: pr create answered 504 and not opened: not sent again, fails as before', () => {
    const fake = fakeGit();
    const d = deps(timedOut(fake, 'pr create', false));
    expect(publishMain(argv(), d.deps)).toBe(1);
    expect(fake.ghCalls('pr create')).toHaveLength(1);
    expect(d.err.join('\n')).toContain('gh pr create failed: HTTP 504');
    expect(readRecords(runDir, '3477').records.some((r) => r.stage === 'pr')).toBe(false);
  });

  it('merge-pr: pr merge answered 504 but merged: not sent again, recorded as merged', () => {
    const fake = fakeGit({ prs: [openPr()], checks: [GREEN_CHECKS] });
    const d = deps(timedOut(fake, 'pr merge', true));
    expect(mergeMain(argv(), d.deps)).toBe(0);
    expect(fake.ghCalls('pr merge')).toHaveLength(1);
    expect(d.err.join('\n')).toContain('it went through');
    expect(readRecords(runDir, '3477').records.filter((r) => r.stage === 'merge').map((r) => r.result)).toEqual(['ok']);
    expect(fake.ghCalls('issue close')).toHaveLength(1);
  });

  it('merge-pr: pr merge answered 504 and not merged: not sent again, fails as before', () => {
    const fake = fakeGit({ prs: [openPr()], checks: [GREEN_CHECKS] });
    const d = deps(timedOut(fake, 'pr merge', false));
    expect(mergeMain(argv(), d.deps)).toBe(1);
    expect(fake.ghCalls('pr merge')).toHaveLength(1);
    expect(d.err.join('\n')).toContain('gh pr merge failed: HTTP 504');
    expect(readRecords(runDir, '3477').records.filter((r) => r.stage === 'merge').map((r) => r.note)).toEqual(['pr=#4242 gh-merge-failed']);
  });

  it('merge-pr: run rerun answered 504 but rerun: not sent again, the rerun is recorded once', () => {
    const fake = fakeGit({ prs: [openPr()], checks: [[{ name: 'Lint', bucket: 'fail', link: RUN_LINK }], GREEN_CHECKS] });
    const d = deps(timedOut(fake, 'run rerun', true));
    expect(mergeMain(argv(), d.deps)).toBe(0);
    expect(fake.ghCalls('run rerun')).toHaveLength(1);
    expect(fake.ghCalls('run view')).toHaveLength(1);
    expect(readRecords(runDir, '3477').records.filter((r) => r.stage === 'ci').map((r) => r.note)).toEqual([
      expect.stringContaining('rerun=555'),
      expect.stringContaining('checks='),
    ]);
  });

  it('merge-pr: run rerun answered 504 and not rerun: not sent again, fails as before', () => {
    const fake = fakeGit({ prs: [openPr()], checks: [[{ name: 'Lint', bucket: 'fail', link: RUN_LINK }]] });
    const d = deps(timedOut(fake, 'run rerun', false));
    expect(mergeMain(argv(), d.deps)).toBe(1);
    expect(fake.ghCalls('run rerun')).toHaveLength(1);
    expect(d.err.join('\n')).toContain('gh run rerun 555 failed: HTTP 504');
    expect(fake.ghCalls('pr merge')).toHaveLength(0);
  });

  it('merge-pr: a 504 on a read is still asked again (negative control)', () => {
    const fake = fakeGit({ prs: [openPr()], checks: [GREEN_CHECKS] });
    const d = deps(flaky(fake, 'pr checks', GATEWAY_TIMEOUT, 1));
    expect(mergeMain(argv(), d.deps)).toBe(0);
    expect(fake.ghCalls('pr checks')).toHaveLength(2);
    expect(d.err.filter((line) => line.includes('retrying'))).toHaveLength(1);
  });
});
