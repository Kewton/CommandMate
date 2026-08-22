import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
  assertSubprocessCompleted,
} from '@tests/helpers/real-shell-budget';

/**
 * Issue #1728 (secondary) — telling "the monitor is quiet" apart from "the
 * monitor is dead".
 *
 * A supervision run once ended at exit 144 about 25 minutes in, having printed
 * exactly one line — its own startup banner — while both workers it was watching
 * carried on unsupervised. Nothing said a signal had arrived, nothing said the
 * loop had stopped, and the operator had no way to notice, because a healthy
 * monitor between verdicts produces the same output as a dead one: none.
 *
 * Three things are pinned here, and each is a statement the stream could not
 * make before:
 *
 *   - a caught signal names itself before the loop gives up (proposal E);
 *   - any exit that is not one of the two documented termini says so, with the
 *     round it happened on and how many workers were left unwatched;
 *   - `--heartbeat` puts a periodic line in the stream, so the *absence* of one
 *     is evidence rather than ambiguity (proposal F).
 *
 * All three go to stderr or carry the word `alive`, i.e. they survive the
 * `grep -Ei "…|ERROR|FAIL"` an operator pipes the monitor through — the same
 * filter that hid the hooks diagnostics in the primary half of this Issue.
 */
const SCRIPTS = path.join(process.cwd(), '.claude/skills/orchestrate-monitor/scripts');
const MONITOR = path.join(SCRIPTS, 'monitor.sh');
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));

// Issue #1950: the guard is shared, and the vitest budget that tests/setup.ts
// gives this family is deliberately larger than it, so a run that overruns is
// reported by the guard (naming itself) rather than by a 5000ms wall clock that
// names nothing. The per-file values this replaced (15s / 20s / 25s) were all
// UNDER the 5s default budget's reach, so none of them could ever fire.
const HARD_TIMEOUT_MS = REAL_SHELL_SUBPROCESS_TIMEOUT_MS;

/**
 * A fake `commandmate` that answers every poll with the same fixture, and a
 * `tmux` that accepts everything. Same construction as the other loop tests; it
 * is duplicated rather than shared because these runs are unbounded on purpose
 * and the shared helper is built around `--max-polls`.
 */
function makeShims(fixtures: string | string[]): { dir: string; cm: string } {
  const list = Array.isArray(fixtures) ? fixtures : [fixtures];
  const dir = mkdtempSync(path.join(os.tmpdir(), 'monitor-live-'));
  const cm = path.join(dir, 'fake-cm');
  const tmux = path.join(dir, 'tmux');
  const counter = path.join(dir, 'poll-count');
  const arms = list
    .map((f, index) => {
      const pattern = index === list.length - 1 ? '*' : String(index + 1);
      return `  ${pattern}) cat "${path.join(FIXTURES, f)}" ;;`;
    })
    .join('\n');
  writeFileSync(
    cm,
    [
      '#!/bin/sh',
      `n=$(cat "${counter}" 2>/dev/null || echo 0)`,
      'n=$((n + 1))',
      `echo "$n" > "${counter}"`,
      'case "$n" in',
      arms,
      'esac',
      '',
    ].join('\n'),
  );
  writeFileSync(tmux, '#!/bin/sh\nexit 0\n');
  chmodSync(cm, 0o755);
  chmodSync(tmux, 0o755);
  return { dir, cm };
}

interface RunResult {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
}

function runBounded(args: string[], fixture: string | string[] = 'live-idle.json'): RunResult {
  const { dir, cm } = makeShims(fixture);
  const proc = spawnSync('bash', [MONITOR, '--interval', '0', '--idle-threshold', '1', ...args, 'w1'], {
    encoding: 'utf8',
    timeout: HARD_TIMEOUT_MS,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, CM: cm },
  });
  assertSubprocessCompleted(proc, 'monitor-liveness.test.ts');
  return {
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
    status: proc.status,
    signal: proc.signal,
  };
}

/**
 * Start an **unbounded** run (no `--max-polls`, so it never stops on its own),
 * wait until it has polled at least once, then deliver `signal` to that process
 * and only that process.
 *
 * `child.kill()` targets the recorded pid. No pattern matching, no process
 * group: a `pkill -f monitor.sh` in a test suite would reach every monitor on
 * the machine, including an operator's live supervision run.
 */
function runAndSignal(signal: NodeJS.Signals, args: string[] = []): Promise<RunResult> {
  const { dir, cm } = makeShims('live-idle.json');
  const child = spawn(
    'bash',
    [MONITOR, '--interval', '1', '--idle-threshold', '99', ...args, 'w1'],
    { env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, CM: cm } },
  );

  let stdout = '';
  let stderr = '';
  let delivered = false;
  const deliver = (): void => {
    if (delivered) return;
    delivered = true;
    child.kill(signal);
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    // The loop has reached the body of a poll round, so `poll_round` /
    // `done_count` in the trap report are values the run actually produced.
    if (stdout.includes('intervention target')) deliver();
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    const bail = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`monitor.sh did not exit within ${HARD_TIMEOUT_MS}ms`));
    }, HARD_TIMEOUT_MS);
    child.on('error', reject);
    child.on('close', (status, sig) => {
      clearTimeout(bail);
      resolve({ stdout, stderr, status, signal: sig });
    });
  });
}

describe('monitor.sh names the signal that stopped it (Issue #1728, proposal E)', () => {
  it('reports SIGTERM on stderr and exits 143 instead of dying silently', async () => {
    const run = await runAndSignal('SIGTERM');

    // The line the 25-minute run did not have. `SIGTERM` is named, so the next
    // time this happens the log says what arrived rather than leaving 128+n to
    // be reverse-engineered from an exit code.
    expect(run.stderr).toContain('monitor: ERROR caught SIGTERM (signal 15)');
    expect(run.stderr).toMatch(/on poll round \d+/);
    expect({ status: run.status, signal: run.signal }).toEqual({ status: 143, signal: null });
  }, HARD_TIMEOUT_MS);

  it('reports SIGINT and exits 130', async () => {
    const run = await runAndSignal('SIGINT');

    expect(run.stderr).toContain('monitor: ERROR caught SIGINT (signal 2)');
    expect(run.status).toBe(130);
  }, HARD_TIMEOUT_MS);

  it('also reports that the workers are left unmonitored, on the same stream', async () => {
    const run = await runAndSignal('SIGTERM');

    // Two independent statements: what arrived (the signal handler) and what it
    // cost (the exit reporter). The second is the one that survives a death this
    // script never sees coming, because it hangs off the EXIT trap rather than
    // off any particular signal.
    expect(run.stderr).toContain('UNMONITORED');
    expect(run.stderr).toMatch(/monitor: ERROR exiting on poll round \d+ with 0\/1 worker\(s\) complete \(rc=143\)/);
  }, HARD_TIMEOUT_MS);

  it('keeps running through SIGURG, and says one arrived', async () => {
    // 144 = 128 + 16, and 16 is SIGURG on macOS — the signal the unexplained
    // exit pointed at. Its default disposition is *ignore*, so trapping it must
    // not turn a harmless delivery into a monitor death: the handler prints and
    // returns. Proving that is the point of this case — the run below is stopped
    // by the SIGTERM that follows, not by the SIGURG.
    const { dir, cm } = makeShims('live-idle.json');
    const child = spawn('bash', [MONITOR, '--interval', '1', '--idle-threshold', '99', 'w1'], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, CM: cm },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      stdout += c;
      if (stdout.includes('intervention target')) child.kill('SIGURG');
    });
    child.stderr.on('data', (c: string) => {
      stderr += c;
      if (stderr.includes('SIGURG')) child.kill('SIGTERM');
    });

    const run = await new Promise<RunResult>((resolve, reject) => {
      const bail = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('monitor.sh did not exit'));
      }, HARD_TIMEOUT_MS);
      child.on('error', reject);
      child.on('close', (status, signal) => {
        clearTimeout(bail);
        resolve({ stdout, stderr, status, signal });
      });
    });

    expect(run.stderr).toContain('monitor: WARN caught SIGURG');
    expect(run.stderr).toContain('monitoring continues');
    // It was SIGTERM that ended the run, i.e. SIGURG really was survivable.
    expect(run.stderr).toContain('caught SIGTERM');
    expect(run.status).toBe(143);
  }, HARD_TIMEOUT_MS);
});

describe('monitor.sh reports only unexpected exits (Issue #1728, proposal E)', () => {
  it('says nothing extra when the run ends on --max-polls', () => {
    const run = runBounded(['--max-polls', '3']);

    expect(run.stdout).toContain('monitor: reached --max-polls (3)');
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  }, HARD_TIMEOUT_MS);

  it('says nothing extra when every worker completes', () => {
    // GENERATING latches started=1, then IDLE climbs the streak past the
    // threshold: with a wired commit counter that is the only route to COMPLETE.
    const { dir, cm } = makeShims(['live-generating-token.json', 'live-idle.json']);
    const hooks = path.join(dir, 'hooks.sh');
    writeFileSync(hooks, 'count_commits() { echo 3; }\ncount_uncommitted() { echo 0; }\n');
    const proc = spawnSync(
      'bash',
      [MONITOR, '--interval', '0', '--idle-threshold', '1', '--hooks', hooks, 'w1'],
      {
        encoding: 'utf8',
        timeout: HARD_TIMEOUT_MS,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, CM: cm },
      },
    );
    assertSubprocessCompleted(proc, 'monitor-liveness.test.ts');

    expect(proc.stdout).toContain('monitor: all 1 worker(s) complete');
    expect(proc.stderr).toBe('');
    expect(proc.status).toBe(0);
  }, HARD_TIMEOUT_MS);

  it('says nothing extra when argument validation rejects the run', () => {
    // These exits predate the trap and their stream is pinned elsewhere; the
    // reporter must not start decorating them.
    const run = runBounded(['--max-polls', '1', '--hooks', '/nope/missing.sh']);

    expect(run.status).toBe(2);
    expect(run.stderr.trim()).toBe('monitor.sh: hooks file not found: /nope/missing.sh');
  }, HARD_TIMEOUT_MS);
});

describe('monitor.sh --heartbeat proves the loop is alive (Issue #1728, proposal F)', () => {
  it('emits one line every N poll rounds', () => {
    const run = runBounded(['--max-polls', '6', '--heartbeat', '2']);

    expect(run.stdout.split('\n').filter((l) => l.includes('monitor: alive'))).toEqual([
      'monitor: alive (poll=2, complete=0/1)',
      'monitor: alive (poll=4, complete=0/1)',
      'monitor: alive (poll=6, complete=0/1)',
    ]);
  }, HARD_TIMEOUT_MS);

  it('is off when set to 0', () => {
    const run = runBounded(['--max-polls', '6', '--heartbeat', '0']);
    expect(run.stdout).not.toContain('alive');
  }, HARD_TIMEOUT_MS);

  it('defaults to every 10 rounds, so short runs and pinned streams are untouched', () => {
    // The default has to be quiet enough that the operator-facing stream stays
    // what it was — interventions and verdicts — while still bounding how long a
    // dead monitor can look like a healthy one (~3 minutes at the documented 20s
    // interval).
    const short = runBounded(['--max-polls', '9']);
    expect(short.stdout).not.toContain('alive');

    const long = runBounded(['--max-polls', '10']);
    expect(long.stdout).toContain('monitor: alive (poll=10, complete=0/1)');
  }, HARD_TIMEOUT_MS);
});
