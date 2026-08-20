/**
 * Gate-level retry and the FLAKY outcome (Issue #1772).
 *
 * Real processes, as `gate-mutex.test.ts` does it: the property under test is
 * *how many times the command actually ran*, and a mocked `spawn` would only
 * assert that a mock was called the way the test author imagined. The evidence
 * for "exactly twice" is a counter file the gate itself writes, not a status
 * the runner reports about itself.
 *
 * The lock root and the index registry are redirected into `mkdtemp` for every
 * test so nothing here touches the real `~/.commandmate`, which every checkout
 * on the machine shares.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import { getVerificationRun, upsertWorktree } from '@/lib/db';
import type { VerificationGateResult } from '@/lib/db';
import {
  FLAKY_LOG_PREFIX,
  startVerification,
  waitForVerification,
} from '@/lib/verification/gate-runner';
import { MACHINE_LOCK_ROOT_ENV } from '@/lib/verification/machine-lock';
import { WORKTREE_INDEX_ROOT_ENV } from '@/lib/verification/worktree-index';
import {
  exitCodeForRunStatus,
  FLAKY_LOG_PREFIX as CLI_FLAKY_LOG_PREFIX,
  parseFlakyMarker,
} from '@/cli/utils/verify-runner';
import { VerifyExitCode } from '@/cli/types';
import { removeTempDir } from '@tests/helpers/temp-dir';

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database): void;
}

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database) => {
      mockDb = db;
    },
    closeDbInstance: () => {
      if (mockDb) {
        mockDb.close();
        mockDb = null;
      }
    },
  };
});

let db: Database.Database;
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** A repository whose `work` branch starts level with `main`, plus a verify.yaml. */
function createRepo(verifyYaml: string): string {
  const dir = tempDir('gate-flaky-');
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'gate-flaky@example.test'], dir);
  git(['config', 'user.name', 'Gate Flaky'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);

  writeFileSync(join(dir, 'README.md'), 'base\n');
  mkdirSync(join(dir, '.commandmate'), { recursive: true });
  writeFileSync(join(dir, '.commandmate', 'verify.yaml'), verifyYaml);
  git(['add', '-A'], dir);
  git(['commit', '-m', 'base'], dir);
  git(['checkout', '-b', 'work'], dir);

  // Something for work-evidence to find, so the command gates are reached.
  writeFileSync(join(dir, 'work.txt'), 'agent output\n');
  return dir;
}

/**
 * A gate command that counts its own invocations and fails the first `failRuns`
 * of them.
 *
 * The counter file lives outside the worktree so the gate cannot change what
 * work-evidence sees between runs, and it is what every "how many times did
 * this run" assertion below reads: an absent second line is proof the retry
 * never happened, in a way `durationMs` and a status never could be.
 *
 * Run 1 sleeps, later runs do not, so the two recorded durations are visibly
 * different numbers — a marker that printed one duration twice would pass an
 * assertion that only checked "both fields are present".
 */
function countingGate(failRuns: number): { command: string; runCount: () => number } {
  const dir = tempDir('gate-flaky-script-');
  const counter = join(dir, 'runs.txt');
  const script = join(dir, 'gate.sh');
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      `counter="${counter}"`,
      'n=0',
      '[ -f "$counter" ] && n=$(cat "$counter")',
      'n=$((n+1))',
      `printf '%s' "$n" > "$counter"`,
      'echo "gate run $n"',
      '[ "$n" -eq 1 ] && sleep 0.6',
      `[ "$n" -le ${failRuns} ] && exit 1`,
      'exit 0',
    ].join('\n'),
    { mode: 0o755 }
  );
  return {
    command: `sh ${script}`,
    runCount: () => {
      try {
        return Number(readFileSync(counter, 'utf8'));
      } catch {
        return 0;
      }
    },
  };
}

function configFor(command: string, extra: string[]): string {
  return [
    'version: 1',
    'gates:',
    '  - id: unit',
    `    command: "${command}"`,
    '    timeoutSec: 30',
    ...extra.map((line) => `    ${line}`),
    'options:',
    '  baseRef: main',
    '',
  ].join('\n');
}

function gatesById(runId: number): Map<string, VerificationGateResult> {
  const run = getVerificationRun(db, runId);
  return new Map((run?.gates ?? []).map((gate) => [gate.gateId, gate]));
}

async function runToCompletion(worktreeId: string, worktreePath: string): Promise<number> {
  upsertWorktree(db, {
    id: worktreeId,
    name: `feature/${worktreeId}`,
    path: worktreePath,
    repositoryPath: worktreePath,
    repositoryName: 'fixture',
  });
  const { runId } = await startVerification({ worktreeId, worktreePath, trigger: 'api' });
  await waitForVerification(runId);
  return runId;
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);

  vi.stubEnv(MACHINE_LOCK_ROOT_ENV, tempDir('gate-flaky-locks-'));
  vi.stubEnv(WORKTREE_INDEX_ROOT_ENV, tempDir('gate-flaky-index-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  db.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) removeTempDir(dir);
  }
});

describe('gates[].retryOnFail (Issue #1772)', () => {
  it('re-runs a failed gate once and records both runs as FLAKY', async () => {
    const gate = countingGate(1);
    const repo = createRepo(configFor(gate.command, ['retryOnFail: 1']));

    const runId = await runToCompletion('wt-flaky', repo);
    const result = gatesById(runId).get('unit');

    // The command itself is the witness: exactly two invocations.
    expect(gate.runCount()).toBe(2);

    const flaky = parseFlakyMarker(result?.logTail);
    expect(flaky?.outcome).toBe('flaky');
    expect(flaky?.runs).toBe(2);
    // Both runs' exit codes, in order. One number here would make the whole
    // feature unreadable: "it failed then passed" is the only fact worth
    // recording, and it takes two values to state.
    expect(flaky?.exitCodes).toEqual([1, 0]);
    expect(flaky?.exit).toBe('1,0');

    // Both runs' durations, and they are distinct measurements rather than one
    // number printed twice: run 1 slept, run 2 did not.
    expect(flaky?.durationsMs).toHaveLength(2);
    expect(flaky?.durationsMs[0] as number).toBeGreaterThan(500);
    expect(flaky?.durationsMs[1] as number).toBeLessThan(flaky?.durationsMs[0] as number);
    expect(flaky?.duration).toBe(
      `${((flaky?.durationsMs[0] as number) / 1000).toFixed(1)}s,` +
        `${((flaky?.durationsMs[1] as number) / 1000).toFixed(1)}s`
    );

    // Both runs' output is kept, so "what differed between the two" is a
    // question the record can actually answer.
    expect(result?.logTail).toContain('gate run 1');
    expect(result?.logTail).toContain('gate run 2');
  });

  it('counts FLAKY as a failure when flakyIsPass is not declared', async () => {
    const gate = countingGate(1);
    const repo = createRepo(configFor(gate.command, ['retryOnFail: 1']));

    const runId = await runToCompletion('wt-flaky-default', repo);
    const result = gatesById(runId).get('unit');

    // The default cannot make the gate weaker: opting into a retry buys a name
    // for what happened, never a pass.
    expect(result?.status).toBe('failed');
    // The failing run is the one the row reports, so the row never says
    // `failed` beside `exit=0`.
    expect(result?.exitCode).toBe(1);
    expect(parseFlakyMarker(result?.logTail)?.verdict).toBe('fail');

    const status = getVerificationRun(db, runId)?.status;
    expect(status).toBe('failed');
    expect(exitCodeForRunStatus(status as 'failed')).toBe(VerifyExitCode.VERIFY_FAILED);
  });

  it('counts FLAKY as a pass when the gate declares flakyIsPass: true', async () => {
    const gate = countingGate(1);
    const repo = createRepo(configFor(gate.command, ['retryOnFail: 1', 'flakyIsPass: true']));

    const runId = await runToCompletion('wt-flaky-pass', repo);
    const result = gatesById(runId).get('unit');

    expect(result?.status).toBe('passed');
    expect(result?.exitCode).toBe(0);
    // Recorded on the row, not recomputed later: the verify.yaml that decided
    // it may have changed by the time anyone reads this run back.
    expect(parseFlakyMarker(result?.logTail)?.verdict).toBe('pass');
    // ...and the gate is still marked FLAKY. A pass verdict must not erase the
    // fact that the first run failed, or the advisor loses its input.
    expect(parseFlakyMarker(result?.logTail)?.outcome).toBe('flaky');

    const status = getVerificationRun(db, runId)?.status;
    expect(status).toBe('passed');
    expect(exitCodeForRunStatus(status as 'passed')).toBe(VerifyExitCode.SUCCESS);
  });

  it('stays FAIL when both runs fail, and retries only once', async () => {
    const gate = countingGate(9);
    // flakyIsPass is on, to prove it cannot rescue a gate that never flaked.
    const repo = createRepo(configFor(gate.command, ['retryOnFail: 1', 'flakyIsPass: true']));

    const runId = await runToCompletion('wt-flaky-hard', repo);
    const result = gatesById(runId).get('unit');

    // Two, not three: the ceiling is the feature. A gate that may re-run until
    // it passes reports the machine's luck instead of the work.
    expect(gate.runCount()).toBe(2);
    expect(result?.status).toBe('failed');
    expect(getVerificationRun(db, runId)?.status).toBe('failed');

    const flaky = parseFlakyMarker(result?.logTail);
    // Marked `fail`, not absent: a gate that failed twice is evidence *against*
    // flakiness, and an advisor needs both halves of that ratio.
    expect(flaky?.outcome).toBe('fail');
    expect(flaky?.exitCodes).toEqual([1, 1]);
    expect(flaky?.verdict).toBe('fail');
  });

  it('runs a gate without retryOnFail exactly once, byte-identically to before', async () => {
    const gate = countingGate(9);
    const repo = createRepo(configFor(gate.command, []));

    const runId = await runToCompletion('wt-no-retry', repo);
    const result = gatesById(runId).get('unit');

    expect(gate.runCount()).toBe(1);
    expect(result?.status).toBe('failed');
    expect(result?.exitCode).toBe(1);
    // Not "does not contain FLAKY" but "is exactly the command's output": a
    // repository that does not use this feature must see no change at all.
    expect(result?.logTail).toBe('gate run 1\n');
    expect(result?.logTail).not.toContain(FLAKY_LOG_PREFIX);
  });

  it('does not retry a gate that passed first time', async () => {
    const gate = countingGate(0);
    const repo = createRepo(configFor(gate.command, ['retryOnFail: 1', 'flakyIsPass: true']));

    const runId = await runToCompletion('wt-first-pass', repo);
    const result = gatesById(runId).get('unit');

    expect(gate.runCount()).toBe(1);
    expect(result?.status).toBe('passed');
    expect(parseFlakyMarker(result?.logTail)).toBeNull();
  });

  it('keeps the stored window an interval and the duration the sum of both runs', async () => {
    const gate = countingGate(1);
    const repo = createRepo(configFor(gate.command, ['retryOnFail: 1']));

    const runId = await runToCompletion('wt-flaky-timing', repo);
    const result = gatesById(runId).get('unit');

    const flaky = parseFlakyMarker(result?.logTail);
    const sum = (flaky?.durationsMs[0] as number) + (flaky?.durationsMs[1] as number);
    // Both runs were this gate's own command executing, so both belong in
    // `duration_ms` — the same rule #1771 applied when it kept the lock *wait*
    // out of it. The marker rounds to a tenth of a second, hence the tolerance.
    expect(Math.abs((result?.durationMs as number) - sum)).toBeLessThan(150);

    // #1625's invariant still holds: the stored stamps bracket the execution
    // `duration_ms` counted, rather than describing the database write.
    const startedAt = result?.startedAt as Date;
    const finishedAt = result?.finishedAt as Date;
    expect(finishedAt.getTime() - startedAt.getTime()).toBe(result?.durationMs);
  });

  it('leaves the marker in the run record for history to read back', async () => {
    const gate = countingGate(1);
    const repo = createRepo(configFor(gate.command, ['retryOnFail: 1']));

    const runId = await runToCompletion('wt-flaky-history', repo);

    // Re-read from the database rather than from the in-flight outcome: the
    // point of putting the two runs in `log_tail` is that `verify show` and the
    // run-detail API can reconstruct them days later.
    const stored = getVerificationRun(db, runId)?.gates.find((g) => g.gateId === 'unit');
    expect(stored?.logTail?.startsWith(`${FLAKY_LOG_PREFIX} runs=2 outcome=flaky`)).toBe(true);
    expect(parseFlakyMarker(stored?.logTail)?.outcome).toBe('flaky');
  });

  it('does not read a flaky marker out of a gate\'s own output', async () => {
    // Anchored to the start of a line, so a suite that prints the marker's
    // words cannot claim a retry the runner never performed.
    const dir = tempDir('gate-flaky-echo-');
    const script = join(dir, 'echo.sh');
    writeFileSync(
      script,
      [
        '#!/bin/sh',
        `echo "  ${FLAKY_LOG_PREFIX} runs=2 outcome=flaky exit=1,0 duration=9.9s,9.9s verdict=pass"`,
        'exit 0',
      ].join('\n'),
      { mode: 0o755 }
    );
    const repo = createRepo(configFor(`sh ${script}`, []));

    const runId = await runToCompletion('wt-flaky-echo', repo);
    const result = gatesById(runId).get('unit');

    expect(result?.status).toBe('passed');
    expect(parseFlakyMarker(result?.logTail)).toBeNull();
  });
});

describe('runner / CLI mirror', () => {
  it('spells the flaky marker identically on both sides', () => {
    // src/cli is compiled by tsconfig.cli.json alone, with no path aliases, so
    // the CLI cannot import the runner's constant. This is the pin that stops
    // the two copies from drifting.
    expect(CLI_FLAKY_LOG_PREFIX).toBe(FLAKY_LOG_PREFIX);
  });
});
