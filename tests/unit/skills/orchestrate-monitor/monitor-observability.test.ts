import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
  assertSubprocessCompleted,
} from '@tests/helpers/real-shell-budget';

const SCRIPTS = path.join(
  process.cwd(),
  '.claude/skills/orchestrate-monitor/scripts',
);
const MONITOR = path.join(SCRIPTS, 'monitor.sh');
const HOOKS_GIT = path.join(SCRIPTS, 'hooks-git.sh');
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));

// Same loop parameters as monitor-resend.test.ts (Issue #1527): polls, not
// seconds, drive every decision, so --interval 0 removes the wall clock and
// --max-polls ends the run from the inside.
const INTERVAL_SEC = 0;
const IDLE_THRESHOLD = 1;
// Issue #1950: the guard is shared, and the vitest budget that tests/setup.ts
// gives this family is deliberately larger than it, so a run that overruns is
// reported by the guard (naming itself) rather than by a 5000ms wall clock that
// names nothing. The per-file values this replaced (15s / 20s / 25s) were all
// UNDER the 5s default budget's reach, so none of them could ever fire.
const HARD_TIMEOUT_MS = REAL_SHELL_SUBPROCESS_TIMEOUT_MS;

/**
 * GENERATING on the first poll latches `started=1`; every later poll is IDLE, so
 * the streak crosses IDLE_THRESHOLD and the run reaches the completion decision
 * with the STARTED guard satisfied. That is the only place `commits` /
 * `uncommitted` are read, which makes this the sequence that tells a wired
 * counter apart from the stub.
 */
const STARTED_THEN_IDLE = ['live-generating-token.json', 'live-idle.json'];

interface RunResult {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  captureCalls: string[];
}

interface RunOptions {
  fixtures: string[];
  polls: number;
  args?: string[];
  env?: Record<string, string>;
  id?: string;
}

/**
 * Run the loop against a fixed sequence of capture frames. The launcher shim
 * serves `fixtures[n-1]` on poll n and repeats the last entry afterwards, and
 * logs every invocation so the test can count the polls that really happened
 * rather than trusting the loop's own stdout.
 */
function runLoop({ fixtures, polls, args = [], env = {}, id = 'w1' }: RunOptions): RunResult {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'monitor-obs-'));
  const captureLog = path.join(dir, 'capture.log');
  const counter = path.join(dir, 'poll-count');
  const cmShim = path.join(dir, 'fake-cm');
  const tmuxShim = path.join(dir, 'tmux');

  const arms = fixtures
    .map((f, index) => {
      const pattern = index === fixtures.length - 1 ? '*' : String(index + 1);
      return `  ${pattern}) cat "${path.join(FIXTURES, f)}" ;;`;
    })
    .join('\n');

  writeFileSync(
    cmShim,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> "${captureLog}"`,
      `n=$(cat "${counter}" 2>/dev/null || echo 0)`,
      'n=$((n + 1))',
      `echo "$n" > "${counter}"`,
      'case "$n" in',
      arms,
      'esac',
      '',
    ].join('\n'),
  );
  writeFileSync(tmuxShim, '#!/bin/sh\nexit 0\n');
  chmodSync(cmShim, 0o755);
  chmodSync(tmuxShim, 0o755);
  writeFileSync(captureLog, '');

  const proc = spawnSync(
    'bash',
    [
      MONITOR,
      '--interval',
      String(INTERVAL_SEC),
      '--idle-threshold',
      String(IDLE_THRESHOLD),
      '--max-polls',
      String(polls),
      ...args,
      id,
    ],
    {
      encoding: 'utf8',
      timeout: HARD_TIMEOUT_MS,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, CM: cmShim, ...env },
    },
  );

  assertSubprocessCompleted(proc, 'monitor-observability.test.ts');

  return {
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
    status: proc.status,
    signal: proc.signal,
    captureCalls: readFileSync(captureLog, 'utf8').split('\n').filter(Boolean),
  };
}

/** Every assertion below is gated on the loop having actually polled. */
function expectPolls(run: RunResult, polls: number, id = 'w1'): void {
  expect({ status: run.status, signal: run.signal }).toEqual({ status: 0, signal: null });
  expect(run.captureCalls).toEqual(
    Array.from({ length: polls }, () => `capture ${id} --json`),
  );
  expect(run.stdout).not.toContain('capture failed');
}

// `task=` carries the contract status verify-completion.sh was given, and is
// appended after `verdict=` only when the task ledger actually answered (Issue
// #1581, #1613). It is optional rather than a `-` placeholder so a contract-less
// run — and a run whose ledger could not be reached — keeps the pre-ledger line
// byte for byte: an evidence stream must not carry a value that looks like a
// reading when nothing was read. Its presence is therefore itself the signal that
// the verdict was adjudicated rather than inferred.
const POLL_LINE =
  /^monitor\[([^\]]+)\]: poll (\d+) -> ([A-Z_]+) started=(\d+) streak=(\d+) commits=(\d+) uncommitted=(\d+) verdict=([A-Z_]+)(?: task=(\S+))?$/;

interface PollRecord {
  id: string;
  poll: number;
  state: string;
  started: number;
  streak: number;
  commits: number;
  uncommitted: number;
  task: string | null;
  verdict: string;
}

/** Machine-parse the per-poll lines, i.e. what an evidence run has to be able to do. */
function parsePolls(stdout: string): PollRecord[] {
  return stdout
    .split('\n')
    .map((line) => POLL_LINE.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({
      id: m[1],
      poll: Number(m[2]),
      state: m[3],
      started: Number(m[4]),
      streak: Number(m[5]),
      commits: Number(m[6]),
      uncommitted: Number(m[7]),
      verdict: m[8],
      task: m[9] ?? null,
    }));
}

function stateDistribution(records: PollRecord[]): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const r of records) dist[r.state] = (dist[r.state] ?? 0) + 1;
  return dist;
}

describe('monitor.sh --verbose per-poll state log (Issue #1533, scope A)', () => {
  it('stays silent by default: the stock stream is interventions and verdicts only', () => {
    const POLLS = 3;
    const run = runLoop({ fixtures: STARTED_THEN_IDLE, polls: POLLS });
    expectPolls(run, POLLS);

    // Pinned byte-for-byte, not just "no poll lines": this is the operator-facing
    // stream and Issue #1533 is only allowed to add opt-in output to it. Verified
    // once against the pre-change monitor.sh by diffing stdout across five
    // fixtures; this assertion is what keeps it that way.
    //
    // Issue #1601 added exactly one line to it: the resolved intervention target,
    // once per worker on its first successful poll. It is NOT opt-in because the
    // defect it closes is invisibility — the loop typed into a session that did
    // not exist and said nothing, so an operator had no way to notice before a
    // missed approval had already stalled the worker.
    expect(run.stdout).toBe(
      [
        'monitor: watching 1 worker(s), interval=0s, idle-threshold=1, max-resends=2',
        'monitor[w1]: intervention target = mcbd-claude-w1',
        'monitor[w1]: NOT_STARTED — idle with no work; check the composer / Enter',
        'monitor[w1]: NOT_STARTED — idle with no work; check the composer / Enter',
        'monitor: reached --max-polls (3) after 3 poll round(s); stopping',
        '',
      ].join('\n'),
    );
    expect(parsePolls(run.stdout)).toEqual([]);
  });

  it('emits exactly one parseable line per poll under --verbose', () => {
    const POLLS = 3;
    const run = runLoop({ fixtures: STARTED_THEN_IDLE, polls: POLLS, args: ['--verbose'] });
    expectPolls(run, POLLS);

    const records = parsePolls(run.stdout);
    // One line per poll and nothing skipped: a format change that broke the regex
    // would leave this short rather than silently degrade the evidence.
    expect(records.map((r) => r.poll)).toEqual([1, 2, 3]);
    expect(records).toEqual([
      { id: 'w1', poll: 1, state: 'GENERATING', started: 1, streak: 0, commits: 0, uncommitted: 0, task: null, verdict: 'WORKING' },
      { id: 'w1', poll: 2, state: 'IDLE', started: 1, streak: 1, commits: 0, uncommitted: 0, task: null, verdict: 'NOT_STARTED' },
      { id: 'w1', poll: 3, state: 'IDLE', started: 1, streak: 2, commits: 0, uncommitted: 0, task: null, verdict: 'NOT_STARTED' },
    ]);
    // The #1513 G2 question "what was the state distribution over the run".
    expect(stateDistribution(records)).toEqual({ GENERATING: 1, IDLE: 2 });
    // Nothing was wired to the ledger here, so the field is absent rather than
    // present-and-empty. Asserted on the raw text as well as through the optional
    // capture group: `task=-` would satisfy neither, and a `task=` with nothing
    // after it would still parse.
    expect(run.stdout).not.toContain('task=');
  });

  it('adds only the poll lines: --verbose stdout minus them equals the default stdout', () => {
    const POLLS = 3;
    const plain = runLoop({ fixtures: STARTED_THEN_IDLE, polls: POLLS });
    const verbose = runLoop({ fixtures: STARTED_THEN_IDLE, polls: POLLS, args: ['--verbose'] });
    expectPolls(plain, POLLS);
    expectPolls(verbose, POLLS);

    const stripped = verbose.stdout
      .split('\n')
      .filter((line) => !POLL_LINE.test(line))
      .join('\n');
    expect(stripped).toBe(plain.stdout);
  });

  it('records interventions in the same run, so poll count and interventions line up', () => {
    // RATE_LIMIT on every poll: the intervention line the operator already got and
    // the new poll line coexist, one of each per round.
    const POLLS = 2;
    const run = runLoop({ fixtures: ['rate-limit.json'], polls: POLLS, args: ['--verbose'] });
    expectPolls(run, POLLS);

    expect(stateDistribution(parsePolls(run.stdout))).toEqual({ RATE_LIMIT: 2 });
    expect(
      run.stdout.split('\n').filter((l) => l.includes("rate limit -> sent 'a' to mcbd-claude-w1")),
    ).toHaveLength(2);
  });
});

describe('monitor.sh completion hooks (Issue #1533, scope B)', () => {
  function writeHooks(body: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'monitor-hooks-'));
    const file = path.join(dir, 'hooks.sh');
    writeFileSync(file, body);
    return file;
  }

  it('never reaches COMPLETE with the stub counters', () => {
    // The control arm. Without it, "COMPLETE fired" below is equally satisfied by
    // a loop that reports COMPLETE for any started+idle worker — which is exactly
    // the false-complete the STARTED guard exists to prevent.
    const POLLS = 3;
    const run = runLoop({ fixtures: STARTED_THEN_IDLE, polls: POLLS, args: ['--verbose'] });
    expectPolls(run, POLLS);

    expect(run.stdout).not.toContain('COMPLETE');
    expect(run.stdout).toContain('NOT_STARTED — idle with no work');
    expect(parsePolls(run.stdout).every((r) => r.commits === 0 && r.uncommitted === 0)).toBe(true);
  });

  it('reaches COMPLETE once --hooks supplies real counters', () => {
    const hooks = writeHooks('count_commits() { echo 2; }\ncount_uncommitted() { echo 5; }\n');
    // Poll 1 GENERATING (latches started), poll 2 IDLE at the threshold -> COMPLETE
    // ends the run before --max-polls can, which is itself the signal.
    const run = runLoop({
      fixtures: STARTED_THEN_IDLE,
      polls: 5,
      args: ['--verbose', '--hooks', hooks],
    });
    expectPolls(run, 2);

    expect(run.stdout).toContain('monitor[w1]: COMPLETE (approvals=0)');
    expect(run.stdout).toContain('monitor: all 1 worker(s) complete');
    expect(run.stdout).not.toContain('reached --max-polls');
    expect(parsePolls(run.stdout)).toEqual([
      { id: 'w1', poll: 1, state: 'GENERATING', started: 1, streak: 0, commits: 2, uncommitted: 5, task: null, verdict: 'WORKING' },
      { id: 'w1', poll: 2, state: 'IDLE', started: 1, streak: 1, commits: 2, uncommitted: 5, task: null, verdict: 'COMPLETE' },
    ]);
  });

  it('accepts MONITOR_HOOKS from the environment', () => {
    const hooks = writeHooks('count_uncommitted() { echo 3; }\n');
    const run = runLoop({
      fixtures: STARTED_THEN_IDLE,
      polls: 5,
      args: ['--verbose'],
      env: { MONITOR_HOOKS: hooks },
    });
    expectPolls(run, 2);

    // Only count_uncommitted was defined, so count_commits must still be the stub:
    // a hooks file is allowed to supply one counter without breaking the other.
    const last = parsePolls(run.stdout).at(-1);
    expect(last).toMatchObject({ commits: 0, uncommitted: 3, verdict: 'COMPLETE' });
  });

  it('fails loudly instead of silently stubbing when the hooks file is missing', () => {
    const run = runLoop({
      fixtures: STARTED_THEN_IDLE,
      polls: 1,
      args: ['--hooks', '/nonexistent/hooks.sh'],
    });

    expect(run.status).toBe(2);
    expect(run.stderr).toContain('hooks file not found');
    expect(run.captureCalls).toEqual([]);
  });
});

describe('hooks-git.sh reference implementation (Issue #1533, scope B)', () => {
  /** A repo with a `feature/x` worktree holding one commit and one untracked file. */
  function makeRepo(): { repo: string; base: string; id: string } {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'monitor-hooks-git-'));
    const repo = path.join(dir, 'myrepo');
    const git = (cwd: string, ...args: string[]): void => {
      const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
        cwd,
        encoding: 'utf8',
      });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    };

    spawnSync('git', ['-c', 'init.defaultBranch=main', 'init', repo], { encoding: 'utf8' });
    writeFileSync(path.join(repo, 'README.md'), 'base\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'base');

    const wt = path.join(dir, 'myrepo-x');
    git(repo, 'worktree', 'add', '-b', 'feature/x', wt);
    writeFileSync(path.join(wt, 'README.md'), 'work\n');
    git(wt, 'commit', '-am', 'work');
    writeFileSync(path.join(wt, 'scratch.txt'), 'wip\n');

    // generateWorktreeId('feature/x', 'myrepo') in src/lib/git/worktrees.ts.
    return { repo, base: 'main', id: 'myrepo-feature-x' };
  }

  it('counts real commits and uncommitted changes for a worktree-id', () => {
    const { repo, base, id } = makeRepo();
    const probe = spawnSync(
      'bash',
      ['-c', `. "${HOOKS_GIT}"; printf '%s %s\\n' "$(count_commits "${id}")" "$(count_uncommitted "${id}")"`],
      {
        encoding: 'utf8',
        env: { ...process.env, MONITOR_HOOKS_REPO: repo, MONITOR_HOOKS_BASE: base },
      },
    );

    expect({ status: probe.status, stderr: probe.stderr }).toEqual({ status: 0, stderr: '' });
    // 1 commit ahead of main, 1 untracked file.
    expect(probe.stdout.trim()).toBe('1 1');
  });

  it('returns 0 rather than erroring for an id that resolves to no worktree', () => {
    const { repo, base } = makeRepo();
    const probe = spawnSync(
      'bash',
      ['-c', `. "${HOOKS_GIT}"; printf '%s %s\\n' "$(count_commits nope-nope)" "$(count_uncommitted nope-nope)"`],
      {
        encoding: 'utf8',
        env: { ...process.env, MONITOR_HOOKS_REPO: repo, MONITOR_HOOKS_BASE: base },
      },
    );

    expect(probe.status).toBe(0);
    expect(probe.stdout.trim()).toBe('0 0');
  });

  it('drives monitor.sh to COMPLETE end to end', () => {
    // The whole point of scope B: the shipped reference — not just a test double —
    // makes the COMPLETE branch reachable.
    const { repo, base, id } = makeRepo();
    const run = runLoop({
      fixtures: STARTED_THEN_IDLE,
      polls: 5,
      args: ['--verbose', '--hooks', HOOKS_GIT],
      env: { MONITOR_HOOKS_REPO: repo, MONITOR_HOOKS_BASE: base },
      id,
    });
    expectPolls(run, 2, id);

    expect(run.stdout).toContain(`monitor[${id}]: COMPLETE (approvals=0)`);
    expect(parsePolls(run.stdout).at(-1)).toMatchObject({
      state: 'IDLE',
      commits: 1,
      uncommitted: 1,
      verdict: 'COMPLETE',
    });
  });

  it('warns on an unresolvable base ref instead of silently counting zero commits', () => {
    const { repo } = makeRepo();
    const probe = spawnSync('bash', ['-c', `. "${HOOKS_GIT}"`], {
      encoding: 'utf8',
      env: { ...process.env, MONITOR_HOOKS_REPO: repo, MONITOR_HOOKS_BASE: 'origin/nope' },
    });

    expect(probe.stderr).toContain("base ref 'origin/nope' does not resolve");
  });
});
