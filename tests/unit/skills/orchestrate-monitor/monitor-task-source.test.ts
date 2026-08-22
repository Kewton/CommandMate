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

const SCRIPTS = path.join(process.cwd(), '.claude/skills/orchestrate-monitor/scripts');
const MONITOR = path.join(SCRIPTS, 'monitor.sh');
const HOOKS_TASK = path.join(SCRIPTS, 'hooks-task.sh');
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));

// Same loop parameters as the other monitor tests: polls drive every decision,
// --interval 0 removes the wall clock, --max-polls ends the run from the inside.
const INTERVAL_SEC = 0;
const IDLE_THRESHOLD = 1;
// Issue #1950: the guard is shared, and the vitest budget that tests/setup.ts
// gives this family is deliberately larger than it, so a run that overruns is
// reported by the guard (naming itself) rather than by a 5000ms wall clock that
// names nothing. The per-file values this replaced (15s / 20s / 25s) were all
// UNDER the 5s default budget's reach, so none of them could ever fire.
const HARD_TIMEOUT_MS = REAL_SHELL_SUBPROCESS_TIMEOUT_MS;

/** GENERATING latches started=1, then IDLE crosses the threshold. */
const STARTED_THEN_IDLE = ['live-generating-token.json', 'live-idle.json'];

/**
 * One row of `commandmate task list`, whose real output is tab-separated:
 * id, status, agent, gates, title. Copied from a live run against the Epic #1539
 * certification worktree.
 */
function taskListRow(status: string): string {
  return ['307cff97-f3b8-4bae-8704-12460591099c', status, 'claude', 'lint', 'Run B'].join('\t');
}

interface RunResult {
  stdout: string;
  stderr: string;
  status: number | null;
  captureCalls: string[];
  taskCalls: string[];
}

/**
 * Run the loop with a launcher shim that answers both subcommands the loop uses:
 * `capture` serves the next frame, `task list` serves a fixed status row. Both
 * are logged so a test can prove the loop really consulted the ledger rather
 * than reaching its verdict some other way.
 */
function runLoop(opts: {
  fixtures: string[];
  polls: number;
  taskStatus: string;
  /** Exit code of the `task` subcommand; non-zero is the unreachable ledger. */
  taskExit?: number;
  args?: string[];
}): RunResult {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'monitor-task-'));
  const captureLog = path.join(dir, 'capture.log');
  const taskLog = path.join(dir, 'task.log');
  const counter = path.join(dir, 'poll-count');
  const cmShim = path.join(dir, 'fake-cm');
  const tmuxShim = path.join(dir, 'tmux');

  const arms = opts.fixtures
    .map((f, index) => {
      const pattern = index === opts.fixtures.length - 1 ? '*' : String(index + 1);
      return `    ${pattern}) cat "${path.join(FIXTURES, f)}" ;;`;
    })
    .join('\n');

  writeFileSync(
    cmShim,
    [
      '#!/bin/sh',
      'case "$1" in',
      '  capture)',
      `    printf '%s\\n' "$*" >> "${captureLog}"`,
      `    n=$(cat "${counter}" 2>/dev/null || echo 0)`,
      '    n=$((n + 1))',
      `    echo "$n" > "${counter}"`,
      '    case "$n" in',
      arms,
      '    esac',
      '    ;;',
      '  task)',
      `    printf '%s\\n' "$*" >> "${taskLog}"`,
      // printf, not echo: the row carries literal tabs and must reach cut intact.
      `    printf '%s\\n' '${opts.taskStatus}'`,
      // The row is still written on the failing arms on purpose: a hook that read
      // stdout without checking `$?` would then answer with a status, which is the
      // defect these tests exist to catch.
      `    exit ${opts.taskExit ?? 0}`,
      '    ;;',
      'esac',
      '',
    ].join('\n'),
  );
  writeFileSync(tmuxShim, '#!/bin/sh\nexit 0\n');
  chmodSync(cmShim, 0o755);
  chmodSync(tmuxShim, 0o755);
  writeFileSync(captureLog, '');
  writeFileSync(taskLog, '');

  const proc = spawnSync(
    'bash',
    [
      MONITOR,
      '--interval', String(INTERVAL_SEC),
      '--idle-threshold', String(IDLE_THRESHOLD),
      '--max-polls', String(opts.polls),
      '--verbose',
      '--hooks', HOOKS_TASK,
      ...(opts.args ?? []),
      'w1',
    ],
    {
      encoding: 'utf8',
      timeout: HARD_TIMEOUT_MS,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, CM: cmShim },
    },
  );

  assertSubprocessCompleted(proc, 'monitor-task-source.test.ts');

  return {
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
    status: proc.status,
    captureCalls: readFileSync(captureLog, 'utf8').split('\n').filter(Boolean),
    taskCalls: readFileSync(taskLog, 'utf8').split('\n').filter(Boolean),
  };
}

/** Probe the hook in isolation with a launcher shim that prints `stdout`. */
function probeHook(stdout: string, exitCode = 0): { out: string; status: number | null } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hooks-task-'));
  const cmShim = path.join(dir, 'fake-cm');
  writeFileSync(
    cmShim,
    `#!/bin/sh\nprintf '%s' '${stdout}'\nexit ${exitCode}\n`,
  );
  chmodSync(cmShim, 0o755);

  const proc = spawnSync('bash', ['-c', `. "${HOOKS_TASK}"; read_task_status w1`], {
    encoding: 'utf8',
    env: { ...process.env, CM: cmShim },
  });
  return { out: (proc.stdout ?? '').trim(), status: proc.status };
}

describe('hooks-task.sh reads the contract status from the task ledger (Issue #1581)', () => {
  it.each(['succeeded', 'failed', 'not_started', 'running'])(
    'extracts %s from the tab-separated task list row',
    (status) => {
      expect(probeHook(`${taskListRow(status)}\n`)).toEqual({ out: status, status: 0 });
    },
  );

  it('takes the newest row when the CLI lists more than one', () => {
    // `task list` sorts newest first, which is what makes a worktree id enough:
    // the monitor never has to be told the task id that `send --contract` printed.
    const rows = `${taskListRow('succeeded')}\n${taskListRow('failed')}\n`;
    expect(probeHook(rows).out).toBe('succeeded');
  });

  it('answers empty when the worktree has no tasks', () => {
    // The CLI writes "No tasks recorded..." to stderr, leaves stdout empty and
    // still exits 0 (measured against develop @a46845c7: src/cli/commands/task.ts).
    // Empty must stay a *normal* answer — it is the contract-less delegation — so
    // "empty stdout" can never be the signal that the ledger failed.
    expect(probeHook('')).toEqual({ out: '', status: 0 });
  });

  it.each([
    ['an error message', "error: unknown command 'task'"],
    ['a reordered row', '307cff97\tSome task title\tclaude\n'],
    ['an unknown status word', `${taskListRow('almost-succeeded')}\n`],
  ])('answers empty for %s rather than inventing a verdict', (_label, stdout) => {
    // `cut -f2` echoes the whole line when there is no tab and happily returns
    // whatever sits in column 2, so without the allow-list an older CLI's error
    // text or a reordered output format would arrive as a status.
    expect(probeHook(stdout).out).toBe('');
  });

  it.each([
    { label: 'the server is not running', exitCode: 1 },
    { label: 'the server does not know the worktree', exitCode: 99 },
  ])('answers unavailable, not empty, when $label', ({ exitCode }) => {
    // Both exit codes measured against develop @a46845c7 by calling the read-only
    // route: `Server is not running.` -> 1 (DEPENDENCY_ERROR) and `Resource not
    // found.` -> 99 (UNEXPECTED_ERROR, the 404 mapping in api-client.ts). Both used
    // to collapse into '' — the same value a healthy ledger returns for a
    // contract-less worktree — so the loop lost its adjudicated source and said
    // nothing about it. This case is pinned separately from the empty one on
    // purpose: they must never be able to satisfy each other's assertion.
    expect(probeHook('', exitCode)).toEqual({ out: 'unavailable', status: 0 });
  });

  it('answers unavailable even when the failing CLI printed a valid-looking row', () => {
    // The discriminator between "checked the exit code" and "read stdout and hoped".
    // An older CommandMate has no `task` subcommand at all and a proxy or a broken
    // pipe can put anything on stdout; a hook that trusts the bytes would report an
    // adjudicated `succeeded` for a call that never reached the ledger.
    expect(probeHook(`${taskListRow('succeeded')}`, 99).out).toBe('unavailable');
  });
});

describe('monitor.sh takes its completion verdict from the task ledger (Issue #1581)', () => {
  it('reaches COMPLETE from a succeeded task while the work counters are still stubs', () => {
    // The counters are the stubs (commits=0, uncommitted=0) — the configuration
    // that monitor-observability.test.ts pins as unable to reach COMPLETE. So a
    // COMPLETE here can only have come from the ledger.
    const run = runLoop({ fixtures: STARTED_THEN_IDLE, polls: 5, taskStatus: taskListRow('succeeded') });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('monitor[w1]: COMPLETE (approvals=0)');
    expect(run.stdout).toContain('monitor: all 1 worker(s) complete');
    expect(run.stdout).not.toContain('reached --max-polls');
    // Two polls, not one: poll 1 is GENERATING, where the live pane vetoes the
    // already-succeeded status. One ledger read per poll, addressed by worktree
    // id alone — the monitor never needs the task id `send --contract` printed.
    expect(run.taskCalls).toEqual(['task list w1 --limit 1', 'task list w1 --limit 1']);
    expect(run.captureCalls).toEqual(['capture w1 --json', 'capture w1 --json']);
    expect(run.stdout).toMatch(/verdict=COMPLETE task=succeeded$/m);
  });

  it('reports VERIFY_FAILED and stops, instead of COMPLETE, for a failed task', () => {
    const run = runLoop({ fixtures: STARTED_THEN_IDLE, polls: 5, taskStatus: taskListRow('failed') });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('monitor[w1]: VERIFY_FAILED');
    expect(run.stdout).toContain('do not merge');
    expect(run.stdout).not.toContain('COMPLETE (approvals=');
    // Terminal: the loop ends on the verdict rather than running out of polls.
    expect(run.stdout).not.toContain('reached --max-polls');
    expect(run.stdout).toMatch(/verdict=VERIFY_FAILED task=failed$/m);
  });

  it('keeps a live worker WORKING even when the newest task already succeeded', () => {
    // A stale terminal status plus a generating pane. Ending the watch here would
    // hand the orchestrator a half-written worktree to merge.
    const run = runLoop({
      fixtures: ['live-generating-token.json'],
      polls: 2,
      taskStatus: taskListRow('succeeded'),
    });

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain('COMPLETE (approvals=');
    expect(run.stdout).toContain('reached --max-polls');
    expect(run.stdout).toMatch(/verdict=WORKING task=succeeded$/m);
  });

  it('loads work counters and the task status from two --hooks files at once', () => {
    // The reason --hooks is repeatable: hooks-git.sh answers "what did the worker
    // change", hooks-task.sh answers "what did the gates say", and a contract-driven
    // run needs both. A single-file flag would force one to be dropped.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'monitor-task-extra-'));
    const counters = path.join(dir, 'counters.sh');
    writeFileSync(counters, 'count_commits() { echo 7; }\n');

    const run = runLoop({
      fixtures: STARTED_THEN_IDLE,
      polls: 5,
      taskStatus: taskListRow('succeeded'),
      args: ['--hooks', counters],
    });

    expect(run.stdout).toMatch(/commits=7 uncommitted=0 verdict=COMPLETE task=succeeded$/m);
  });

  it('fails loudly when any file in a repeated --hooks list is missing', () => {
    const run = runLoop({
      fixtures: STARTED_THEN_IDLE,
      polls: 1,
      taskStatus: taskListRow('succeeded'),
      args: ['--hooks', '/nonexistent/hooks.sh'],
    });

    expect(run.status).toBe(2);
    expect(run.stderr).toContain('hooks file not found');
    expect(run.captureCalls).toEqual([]);
  });
});

/** The one line the loop owes an operator when it stops adjudicating (Issue #1613). */
const FALLBACK_LINE =
  "monitor[w1]: task state unavailable (CommandMate without 'commandmate task', server down, " +
  'or unknown worktree) — FALLBACK MODE: completion is inferred from capture, not adjudicated. ' +
  'Diagnose with: commandmate task list w1 --limit 1';

function countLines(stdout: string, needle: string): number {
  return stdout.split('\n').filter((line) => line.includes(needle)).length;
}

describe('monitor.sh announces an unreachable task ledger instead of degrading quietly (Issue #1613)', () => {
  it.each([
    { label: 'the server is not running', exitCode: 1 },
    { label: 'the server does not know the worktree', exitCode: 99 },
  ])('reports FALLBACK MODE exactly once per worker when $label', ({ exitCode }) => {
    // The shim still prints a `succeeded` row, so this run separates "read the exit
    // code" from "read stdout": with the exit code honoured the status is discarded
    // and the stub counters keep the loop off COMPLETE; without it the run would end
    // early on an adjudicated COMPLETE that the ledger never gave.
    const run = runLoop({
      fixtures: STARTED_THEN_IDLE,
      polls: 3,
      taskStatus: taskListRow('succeeded'),
      taskExit: exitCode,
    });

    expect(run.status).toBe(0);
    expect(countLines(run.stdout, FALLBACK_LINE)).toBe(1);
    // Once per worker, not once per poll: three polls happened, and the notice is a
    // version gate, not a per-poll event. A repeated line would bury the stream it
    // is supposed to make readable.
    expect(run.taskCalls).toHaveLength(3);
    expect(run.stdout).not.toContain('COMPLETE (approvals=');
    expect(run.stdout).toContain('reached --max-polls');
  });

  it('keeps polling the ledger so a server that comes back is picked up', () => {
    // Downgrading to empty must not latch the hook off. The gate file only silences
    // the message; the read itself still happens on every poll.
    const run = runLoop({
      fixtures: STARTED_THEN_IDLE,
      polls: 4,
      taskStatus: taskListRow('succeeded'),
      taskExit: 99,
    });

    expect(run.taskCalls).toEqual(Array.from({ length: 4 }, () => 'task list w1 --limit 1'));
  });

  it('omits task= from the poll lines while the ledger is unreachable', () => {
    // `unavailable` is downgraded to empty before the poll line is built, so the
    // evidence stream never claims a status it did not get. Pinned as an absence
    // because the failure mode is a plausible-looking value, not a missing one.
    const run = runLoop({
      fixtures: STARTED_THEN_IDLE,
      polls: 3,
      taskStatus: taskListRow('succeeded'),
      taskExit: 1,
    });

    const pollLines = run.stdout.split('\n').filter((line) => / poll \d+ -> /.test(line));
    expect(pollLines).toHaveLength(3);
    expect(pollLines.some((line) => line.includes('task='))).toBe(false);
    expect(pollLines.every((line) => /verdict=[A-Z_]+$/.test(line))).toBe(true);
  });

  it('stays silent for a contract-less worktree, where nothing was promised', () => {
    // The control arm, and the reason the branch keys on the exit code rather than
    // on empty stdout: a known worktree with zero tasks exits 0 with an empty stdout
    // (measured), and that is a normal answer. Warning here would train the operator
    // to ignore the line that matters.
    const run = runLoop({
      fixtures: STARTED_THEN_IDLE,
      polls: 3,
      taskStatus: '',
    });

    expect(run.stdout).not.toContain('FALLBACK MODE');
    expect(run.stdout).not.toContain('task=');
    expect(run.taskCalls).toHaveLength(3);
  });

  it('stays silent when the hook was never wired, so the stub is not a failure', () => {
    // monitor.sh's own `read_task_status` stub returns empty, not `unavailable`:
    // a run that never asked for task state must not be told it lost it.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'monitor-task-nohook-'));
    const cmShim = path.join(dir, 'fake-cm');
    writeFileSync(
      cmShim,
      `#!/bin/sh\ncat "${path.join(FIXTURES, 'live-idle.json')}"\n`,
    );
    chmodSync(cmShim, 0o755);

    const proc = spawnSync(
      'bash',
      [MONITOR, '--interval', '0', '--idle-threshold', '1', '--max-polls', '2', '--verbose', 'w1'],
      {
        encoding: 'utf8',
        timeout: HARD_TIMEOUT_MS,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, CM: cmShim },
      },
    );

    assertSubprocessCompleted(proc, 'monitor-task-source.test.ts');

    expect(proc.status).toBe(0);
    expect(proc.stdout ?? '').not.toContain('FALLBACK MODE');
    expect(proc.stdout ?? '').not.toContain('task=');
  });
});
