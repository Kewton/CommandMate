import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPTS = path.join(process.cwd(), '.claude/skills/orchestrate-monitor/scripts');
const MONITOR = path.join(SCRIPTS, 'monitor.sh');
const HOOKS_TASK = path.join(SCRIPTS, 'hooks-task.sh');
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));

// Same loop parameters as the other monitor tests: polls drive every decision,
// --interval 0 removes the wall clock, --max-polls ends the run from the inside.
const INTERVAL_SEC = 0;
const IDLE_THRESHOLD = 1;
const HARD_TIMEOUT_MS = 15_000;

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
    // The CLI writes "No tasks recorded..." to stderr and leaves stdout empty
    // (measured). Empty must mean "no answer", so the loop falls back rather than
    // treating a contract-less worktree as adjudicated.
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

  it('answers empty when the CLI exits non-zero', () => {
    expect(probeHook('boom', 1).out).toBe('');
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
    expect(run.stdout).toMatch(/task=succeeded verdict=COMPLETE$/m);
  }, 20_000);

  it('reports VERIFY_FAILED and stops, instead of COMPLETE, for a failed task', () => {
    const run = runLoop({ fixtures: STARTED_THEN_IDLE, polls: 5, taskStatus: taskListRow('failed') });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('monitor[w1]: VERIFY_FAILED');
    expect(run.stdout).toContain('do not merge');
    expect(run.stdout).not.toContain('COMPLETE (approvals=');
    // Terminal: the loop ends on the verdict rather than running out of polls.
    expect(run.stdout).not.toContain('reached --max-polls');
    expect(run.stdout).toMatch(/task=failed verdict=VERIFY_FAILED$/m);
  }, 20_000);

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
    expect(run.stdout).toMatch(/task=succeeded verdict=WORKING$/m);
  }, 20_000);

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

    expect(run.stdout).toMatch(/commits=7 uncommitted=0 task=succeeded verdict=COMPLETE$/m);
  }, 20_000);

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
  }, 20_000);
});
