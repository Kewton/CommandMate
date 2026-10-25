/**
 * scripts/orchestrate/wait-verify.mjs — /orchestrate 3-3 as a script (Issue #3477).
 *
 * `commandmatedev` and `git` are replaced by fakes; the run record is written
 * under os.tmpdir().
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendRecord, readRecords, summarize } from '../../../../scripts/orchestrate/run-log.mjs';
import {
  baselineTask,
  defaultResolveTarget,
  defaultRun,
  defaultSpawnToLog,
  main,
  newerTask,
  parseArgs,
  summarizeVerdict,
  timingRunIdOf,
  verifyTiming,
} from '../../../../scripts/orchestrate/wait-verify.mjs';

const HEAD_A = 'a'.repeat(40);

const PASS_LOG = [
  'Waiting: wt-1 (status=running, running=true, prompt=false)',
  'Completed: wt-1 (basis=hook_stop)',
  'Verifying: wt-1 (run 12)',
  'GATE work-evidence PASS (commits=1, uncommitted=0)',
  'GATE scope PASS (exit=0, 0.1s)',
  'GATE lint PASS (exit=0, 30.2s)',
  'GATE typecheck PASS (exit=0, 40.0s)',
  'GATE unit-related PASS (exit=0, 600.0s) [contract]',
  'RESULT passed',
  '',
].join('\n');

const FAIL_LOG = [
  'Completed: wt-1 (basis=scraper_ready)',
  'GATE work-evidence PASS (commits=1, uncommitted=0)',
  'GATE scope FAIL (exit=1, 0.1s)',
  'outside scope: src/x.ts',
  'GATE lint PASS (exit=0, 30.2s)',
  'RESULT failed',
  '',
].join('\n');

let tmp: string;
let runDir: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-orchestrate-waitverify-'));
  runDir = path.join(tmp, 'runs', '2026-10-09');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Call = { command: string; args: string[]; opts?: { timeoutMs?: number } };
type TaskRow = { id: string; cliToolId: string; instanceId: string | null; createdAt: string; status: string };

const T0 = Date.UTC(2026, 9, 9, 1, 0);
const iso = (minute: number) => new Date(T0 + minute * 60_000).toISOString();

const task = (id: string, minute: number, instanceId: string | null = 'claude'): TaskRow => ({
  id,
  cliToolId: 'claude',
  instanceId,
  createdAt: iso(minute),
  status: 'running',
});

/**
 * Fakes for commandmatedev (wait / verify / capture / verify history / auto-yes / task list) and git.
 * Timeline by default: last commit 01:03, last turn end 01:04, verification started 01:05,
 * the wait returns at 01:10 — the verification saw the final state.
 */
function harness({
  waitExit = 0,
  waitLog = PASS_LOG,
  verifyExit = 0,
  verifyLog = PASS_LOG,
  autoYesExit = 0,
  autoYesStuck = false,
  head = HEAD_A,
  status = '',
  commitMinute = 3,
  lastStopMinute = 4 as number | null,
  runStartMinute = 5 as number | null,
  pane = [] as string[],
  commitDuringReverify = false,
  tasks = [] as TaskRow[],
  tasksDuringWait = null as TaskRow[] | null,
  tasksAfterWait = null as TaskRow[] | null,
  tasksDuringVerify = null as TaskRow[] | null,
  verifyCallForTasks = 1,
  resolved = {} as Record<string, string>,
  resolveError = null as string | null,
  shown = {} as Record<string, TaskRow>,
  historyStartMinute = undefined as number | undefined,
  runs = {} as Record<string, { startedAt?: string; status?: string; worktreeId?: string; gates?: unknown[] }[]>,
  replies = [] as (string | null)[],
  captureJsonFails = 0,
  verifySequence = [] as { exit: number; log: string }[],
  resolvedTools = {} as Record<string, string>,
  replyFails = false,
} = {}) {
  const spawned: Call[] = [];
  const ran: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const sleeps: number[] = [];
  let clock = T0;
  let commitAt = commitMinute;
  let paneIndex = 0;
  let taskList = tasks;
  let verifyCalls = 0;
  let replyIndex = 0;
  let captureJsonCalls = 0;
  const showCalls: Record<string, number> = {};
  const deps = {
    spawnToLog: (
      command: string,
      args: string[],
      { logFile, watch }: { logFile: string; watch?: () => boolean }
    ) => {
      spawned.push({ command, args });
      const isVerify = args[0] === 'verify';
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      if (!isVerify && tasksDuringWait) {
        // A second contract arrives while the wait runs, and the watch looks.
        fs.writeFileSync(logFile, 'Waiting: wt-1 (status=running)\n');
        taskList = tasksDuringWait;
        if (watch?.()) {
          clock += 60_000;
          return 143;
        }
      }
      if (isVerify && tasksDuringVerify && ++verifyCalls === verifyCallForTasks) taskList = tasksDuringVerify;
      // Between the watch's last look and the turn end.
      if (!isVerify && tasksAfterWait) taskList = tasksAfterWait;
      // #3883: verifications that answer in turn (a 409 first, then the run of this call).
      const next = isVerify ? verifySequence.shift() : undefined;
      fs.writeFileSync(logFile, next ? next.log : isVerify ? verifyLog : waitLog);
      clock += 600_000; // each run takes ten minutes
      if (isVerify && commitDuringReverify) commitAt = (clock - T0) / 60_000 + 1;
      return next ? next.exit : isVerify ? verifyExit : waitExit;
    },
    run: (command: string, args: string[], opts?: { timeoutMs?: number }) => {
      ran.push({ command, args, opts });
      const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });
      if (command === 'git') {
        const sub = args.slice(2);
        if (sub[0] === 'rev-parse') return ok(`${head}\n`);
        if (sub[0] === 'status') return ok(status);
        if (sub[0] === 'log') return ok(`${iso(commitAt)}\n`);
        throw new Error(`unexpected git ${sub.join(' ')}`);
      }
      if (args[0] === 'auto-yes') {
        return { status: autoYesExit, stdout: '', stderr: autoYesExit === 0 ? '' : 'server down' };
      }
      if (args[0] === 'capture' && args.includes('--pane')) {
        const screen = pane[Math.min(paneIndex, pane.length - 1)] ?? '';
        paneIndex += 1;
        return ok(screen);
      }
      if (args[0] === 'capture' && args.includes('--json')) {
        // #3883 H-7: a read-back that fails (server busy) is not a state.
        if (++captureJsonCalls <= captureJsonFails) return { status: 1, stdout: '', stderr: 'HTTP 503' };
        return ok(
          JSON.stringify({
            lastStopEventAt: lastStopMinute === null ? null : T0 + lastStopMinute * 60_000,
            autoYes: { enabled: autoYesStuck },
          })
        );
      }
      if (args[0] === 'task' && args[1] === 'list') {
        return ok(JSON.stringify(taskList));
      }
      if (args[0] === 'task' && args[1] === 'show') {
        const one = shown[args[2]];
        return one ? ok(JSON.stringify({ task: one, lastVerificationRun: null })) : { status: 1, stdout: '', stderr: 'Error: task not found' };
      }
      if (args[0] === 'reply' && args.includes('--since') && !args[args.indexOf('--since') + 1].startsWith('9999')) {
        // #3883 H-6: this task's reply (`reply --since <task start>`); none by default, as for a tool without a transcript reader.
        if (replyFails) return { status: 1, stdout: '', stderr: 'HTTP 503' };
        const reply = replies.length === 0 ? null : replies[Math.min(replyIndex, replies.length - 1)];
        replyIndex += 1;
        return ok(JSON.stringify({ worktreeId: args[1], instanceId: args[args.indexOf('--instance') + 1], reply }));
      }
      if (args[0] === 'reply') {
        // `reply --json` resolves --instance through the server, as defaultResolveTarget asks it (#3633 A).
        if (resolveError) return { status: 2, stdout: '', stderr: `Error: ${resolveError}` };
        const selector = args[args.indexOf('--instance') + 1];
        const tool = resolvedTools[selector];
        return ok(JSON.stringify({ worktreeId: args[1], instanceId: resolved[selector] ?? selector, ...(tool ? { cliToolId: tool } : {}), reply: null }));
      }
      if (args[0] === 'verify' && args[1] === 'history') {
        if (historyStartMinute !== undefined) return ok(JSON.stringify([{ id: 99, startedAt: iso(historyStartMinute) }]));
        return ok(JSON.stringify(runStartMinute === null ? [] : [{ id: 1, startedAt: iso(runStartMinute) }]));
      }
      if (args[0] === 'verify' && args[1] === 'show') {
        // The run a log printed (`Verifying: wt-1 (run <id>)`), read by its id (#3883 H-5).
        const id = args[2];
        const states = runs[id];
        if (states) {
          const n = showCalls[id] = (showCalls[id] ?? 0) + 1;
          const view = states[Math.min(n - 1, states.length - 1)];
          return ok(JSON.stringify({ run: { id: Number(id), worktreeId: 'wt-1', status: 'passed', startedAt: iso(runStartMinute ?? 0), ...view } }));
        }
        if (runStartMinute === null) return { status: 4, stdout: '', stderr: `Verification run ${id} not found.` };
        return ok(JSON.stringify({ run: { id: Number(id), worktreeId: 'wt-1', status: 'passed', startedAt: iso(runStartMinute) } }));
      }
      throw new Error(`unexpected ${command} ${args.join(' ')}`);
    },
    // The server's resolve-target: an alias maps through `resolved`, anything else names itself.
    resolveTarget: (wt: string, selector: string) =>
      resolveError
        ? { error: resolveError }
        : { instanceId: resolved[selector] ?? selector, ...(resolvedTools[selector] ? { cliToolId: resolvedTools[selector] } : {}) },
    sleep: (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => new Date(clock),
    log: (line: string) => out.push(line),
    error: (line: string) => err.push(line),
  };
  const autoYesCalls = () => ran.filter((c) => c.args[0] === 'auto-yes').map((c) => c.args);
  return { deps, spawned, ran, out, err, sleeps, autoYesCalls };
}

const ARGS = ['--issues', '3477', '--issue', '3477', '--wt', 'wt-1', '--worktree', '/wt', '--instance', 'claude', '--model', 'opus', '--task', 't-1'];
const argv = (...extra: string[]) => ['--run-dir', runDir, ...ARGS, ...extra];
const records = () => readRecords(runDir, '3477').records;

describe('summarizeVerdict', () => {
  it('folds the gate lines, RESULT and the completion basis into one line', () => {
    const v = summarizeVerdict(PASS_LOG, 0);
    // unit-related is defined by the contract ([contract]), so it is named as such (#3477 review 1).
    expect(v.passed).toEqual(['work-evidence', 'scope', 'lint', 'typecheck', 'unit-related@contract']);
    expect(v.failed).toEqual([]);
    expect(v.line).toBe('exit=0(passed) result=passed basis=hook_stop passed=work-evidence,scope,lint,typecheck,unit-related@contract failed=-');
  });

  it('names the failed gates with their label', () => {
    const v = summarizeVerdict(FAIL_LOG, 20);
    expect(v.failed).toEqual(['scope:FAIL']);
    expect(v.line).toContain('exit=20(failed) result=failed basis=scraper_ready');
  });

  it('says what a verdict-less exit was', () => {
    expect(summarizeVerdict('Timeout: wt-1 exceeded 10800s\n', 124).line).toBe(
      'exit=124(timeout) result=- basis=- passed=- failed=-'
    );
    expect(summarizeVerdict('', 21).meaning).toBe('no-work');
  });

  it('counts a FLAKY gate as passed only on a passed run', () => {
    expect(summarizeVerdict('GATE unit FLAKY (exit=0, 9.0s)\nRESULT passed\n', 0).passed).toEqual(['unit']);
    expect(summarizeVerdict('GATE unit FLAKY (exit=1, 9.0s)\nRESULT failed\n', 20).failed).toEqual(['unit:FLAKY']);
  });
});

describe('the wait command (3-3)', () => {
  it('always passes --instance, --on-prompt human and --verify', () => {
    const h = harness();
    expect(main(argv(), h.deps)).toBe(0);
    // #3883 N8: the verification is never started inside `wait` (`wait --verify`): the manifest is taken
    // before it, so `verify` is its own call, with the same instance, right after the wait.
    expect(h.spawned).toEqual([
      { command: 'commandmatedev', args: ['wait', 'wt-1', '--instance', 'claude', '--on-prompt', 'human', '--timeout', '10800'] },
      { command: 'commandmatedev', args: ['verify', 'wt-1', '--task', 't-1', '--instance', 'claude'] },
    ]);
  });

  it('writes the wait log into the run directory', () => {
    const h = harness();
    main(argv(), h.deps);
    expect(fs.readFileSync(path.join(runDir, 'wait-3477.log'), 'utf8')).toBe(PASS_LOG);
  });

  it('after a re-instruction: wait without --verify, then verify --task (3-4, #3118)', () => {
    const h = harness({ verifyLog: FAIL_LOG, verifyExit: 20 });
    expect(main(argv('--after-reinstruct'), h.deps)).toBe(20);
    expect(h.spawned.map((c) => c.args)).toEqual([
      ['wait', 'wt-1', '--instance', 'claude', '--on-prompt', 'human', '--timeout', '10800'],
      ['verify', 'wt-1', '--task', 't-1', '--instance', 'claude'],
    ]);
    const [record] = readRecords(runDir, '3477').records;
    expect(record.note).toContain('failed=scope:FAIL');
  });

  it('refuses --after-reinstruct without --task', () => {
    expect(parseArgs(['--run-dir', 'r', '--issues', '1', '--issue', '1', '--wt', 'w', '--worktree', '/w', '--instance', 'claude', '--after-reinstruct']).error).toMatch(/--task/);
  });

  it.each(['--run-dir', '--issues', '--issue', '--wt', '--worktree', '--instance'])('exits 2 without %s', (flag) => {
    const all = argv();
    const i = all.indexOf(flag);
    const h = harness();
    expect(main([...all.slice(0, i), ...all.slice(i + 2)], h.deps)).toBe(2);
    expect(h.spawned).toEqual([]);
  });
});

describe('Auto-Yes is turned off after a verdict', () => {
  it.each([
    [0, PASS_LOG],
    [20, FAIL_LOG],
    [21, 'GATE work-evidence FAIL (commits=0, uncommitted=0)\nRESULT not_started\n'],
  ])('exit %i disables it for the same instance', (exit, log) => {
    const h = harness({ waitExit: exit, waitLog: log });
    expect(main(argv(), h.deps)).toBe(exit);
    expect(h.autoYesCalls()).toEqual([['auto-yes', 'wt-1', '--disable', '--instance', 'claude']]);
    expect(records()[0].note).toContain('auto-yes=off');
  });

  it.each([124, 10, 99])('exit %i (no verdict) leaves it on: the worker may still be working', (exit) => {
    const h = harness({ waitExit: exit, waitLog: '' });
    expect(main(argv(), h.deps)).toBe(exit);
    expect(h.autoYesCalls()).toEqual([]);
    expect(records()[0].note).toContain('auto-yes=kept');
  });

  it('warns and records it when the disable fails, and keeps the wait’s exit code', () => {
    const h = harness({ autoYesExit: 1 });
    expect(main(argv(), h.deps)).toBe(0);
    expect(h.err.join('\n')).toMatch(/auto-yes --disable failed for wt-1 \(claude\): server down/);
    expect(records()[0].note).toContain('auto-yes=NOT-disabled');
  });

  it('retries the disable, and reads it back: still enabled is not off', () => {
    const h = harness({ autoYesStuck: true });
    main(argv(), h.deps);
    expect(h.autoYesCalls()).toHaveLength(3);
    expect(records()[0].note).toContain('auto-yes=NOT-disabled');
  });

  it('asks again on every call — a failed disable is not remembered as done (#3477 review 4)', () => {
    main(argv(), harness({ autoYesExit: 1 }).deps);
    const again = harness();
    expect(main(argv(), again.deps)).toBe(0);
    expect(again.autoYesCalls()).toHaveLength(1);
    expect(records().map((r: { note: string }) => r.note.match(/auto-yes=\S+/)?.[0])).toEqual([
      'auto-yes=NOT-disabled',
      'auto-yes=off',
    ]);
  });

  it('--auto-yes-off only turns it off (recovery), and exits 1 when it stays on', () => {
    const h = harness();
    expect(main(['--auto-yes-off', '--wt', 'wt-1', '--instance', 'claude'], h.deps)).toBe(0);
    expect(h.spawned).toEqual([]);
    expect(h.autoYesCalls()).toHaveLength(1);
    expect(main(['--auto-yes-off', '--wt', 'wt-1', '--instance', 'claude'], harness({ autoYesStuck: true }).deps)).toBe(1);
  });
});

describe('the run record', () => {
  it('writes the verify stage with the HEAD, task, agent, model and duration', () => {
    const h = harness();
    main(argv(), h.deps);
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({
      issue: 3477,
      stage: 'verify',
      result: 'ok',
      head: HEAD_A,
      taskId: 't-1',
      agent: 'claude',
      model: 'opus',
      durationSec: 1200, // the wait and the verification (#3883 N8), ten minutes each in the fake
    });
    expect(records()[0].note).toContain('passed=work-evidence,scope,lint,typecheck,unit-related@contract');
  });

  it('records a non-zero exit as fail, so status sends the run back to verify', () => {
    const h = harness({ waitExit: 20, waitLog: FAIL_LOG });
    main(argv(), h.deps);
    appendRecord(runDir, '3477', { issue: 3477, stage: 'send', result: 'ok', head: HEAD_A });
    const [item] = summarize(records());
    expect(item.next).toBe('verify');
  });

  it('exits 1 when the HEAD cannot be read', () => {
    const h = harness();
    h.deps.run = () => ({ status: 128, stdout: '', stderr: 'not a git repository' });
    expect(main(argv(), h.deps)).toBe(1);
    expect(h.err.join('\n')).toMatch(/not a git repository/);
  });
});

/** A verification whose heavy gate queued for a slot and for cpu.heavy (Issue #3909). */
const TIMED_LOG = [
  'Verifying: wt-1 (run 12)',
  'GATE work-evidence PASS (commits=1, uncommitted=0)',
  'GATE lint PASS (exit=0, 30.2s)',
  'GATE typecheck PASS (exit=0, 40.0s, queue=4.6s, mutex=0.0s, run=40.0s)',
  'GATE unit-related PASS (exit=0, 600.0s, queue=30.0s, mutex=120.4s, run=600.0s) [contract]',
  'GATE unit FLAKY (exit=1,0, 45.0s,44.0s)',
  'RESULT passed',
  '',
].join('\n');

describe('the waits and the execution of the verification (Issue #3909)', () => {
  it('sums the GATE lines of the last verification in the log', () => {
    // 30.2 + 40.0 + 600.0 + 45.0 + 44.0 = 759.2 executed; 34.6 and 120.4 waited.
    expect(verifyTiming(TIMED_LOG)).toEqual({ queueSec: 35, mutexSec: 120, runSec: 759 });
    // A refused start followed by the run: only the run that judged counts.
    const refusedFirst = `${TIMED_LOG.replace('Verifying: wt-1 (run 12)', 'Verifying: wt-1 (run 11)')}` +
      'Verifying: wt-1 (run 13)\nGATE lint PASS (exit=0, 1.0s, queue=2.0s, mutex=0.0s, run=1.0s)\nRESULT passed\n';
    expect(verifyTiming(refusedFirst)).toEqual({ queueSec: 2, mutexSec: 0, runSec: 1 });
  });

  it('gives nothing to record when no gate printed the split (negative control)', () => {
    // An older CLI, or a run in which nothing waited: the record reads as before #3909.
    expect(verifyTiming(PASS_LOG)).toEqual({});
    expect(verifyTiming('GATE e2e PASS (exit=0, 190.0s, waited=42.3s)\nRESULT passed\n')).toEqual({});
    expect(verifyTiming('')).toEqual({});
  });

  it('passes the split to the verify record, where run-log.mjs summarize reads it', () => {
    const h = harness({ verifyLog: TIMED_LOG });
    appendRecord(runDir, '3477', { issue: 3477, stage: 'send', result: 'ok', head: HEAD_A });
    expect(main(argv(), h.deps)).toBe(0);
    expect(records()).toHaveLength(2);
    expect(records()[1]).toMatchObject({ stage: 'verify', result: 'ok', durationSec: 1200, queueSec: 35, mutexSec: 120, runSec: 759 });
    const [item] = summarize(records());
    expect(item.stages.verify).toMatchObject({ queueSec: 35, mutexSec: 120, runSec: 759 });
    expect(item.next).toBe('review');
  });

  it('writes a record without the split for a verification that printed none (negative control)', () => {
    const h = harness();
    main(argv(), h.deps);
    for (const field of ['queueSec', 'mutexSec', 'runSec']) expect(records()[0]).not.toHaveProperty(field);
    const [item] = summarize(records());
    expect(item.stages.verify.result).toBe('ok');
  });
});

/** A gate's stored row, as `verify show --json` returns it. */
const gateRow = (gateId: string, status: string, durationMs: number | null, logTail: string | null, exitCode: number | null = 0) =>
  ({ gateId, status, exitCode, durationMs, logTail });
const MUTEX_SKIP_TAIL = [
  'reason=mutex-wait waited=600.0s',
  '[mutex] name=cpu.heavy lock=/tmp/x.lock (held by run 3)',
  "Gate 'unit' declares mutex 'cpu.heavy' and the machine-wide lock stayed held for its whole 600s budget",
].join('\n');

describe('the split counts every gate the run recorded, and only the run’s own (#3909 review)', () => {
  // Review 1: the GATE line of a mutex-wait SKIP is its reason; the wait is in the stored marker.
  it('a mutex-wait SKIP adds its wait — alone, or beside a gate that ran', () => {
    const skipped = gateRow('unit', 'skipped', null, `${MUTEX_SKIP_TAIL}\n[timing] queue=5.0s mutex=600.0s run=0.0s`, null);
    expect(verifyTiming('', { gates: [skipped] })).toEqual({ queueSec: 5, mutexSec: 600, runSec: 0 });
    expect(verifyTiming('', { gates: [gateRow('lint', 'passed', 30_200, null), skipped] })).toEqual({ queueSec: 5, mutexSec: 600, runSec: 30 });
    // The CLI's lines when the run cannot be read: the marker ends the log printed under the SKIP.
    const text = ['Verifying: wt-1 (run 12)', 'GATE lint PASS (exit=0, 30.2s)', 'GATE unit SKIP (reason=mutex-wait waited=600.0s)', skipped.logTail, 'RESULT error', ''].join('\n');
    expect(verifyTiming(text)).toEqual({ queueSec: 5, mutexSec: 600, runSec: 30 });
  });

  it('a SKIP of a server older than the marker (waited= only) reads as before (negative control)', () => {
    const old = gateRow('unit', 'skipped', null, MUTEX_SKIP_TAIL, null);
    expect(verifyTiming('', { gates: [gateRow('lint', 'passed', 30_200, null), old] })).toEqual({});
    const text = ['Verifying: wt-1 (run 12)', 'GATE lint PASS (exit=0, 30.2s)', 'GATE unit SKIP (reason=mutex-wait waited=600.0s)', MUTEX_SKIP_TAIL, 'RESULT error', ''].join('\n');
    expect(verifyTiming(text)).toEqual({});
  });

  // Review 2: the CLI leaves the exit field out when there is none (a TIMEOUT).
  it('a TIMEOUT without an exit code adds its duration to run', () => {
    const timed = gateRow('unit', 'passed', 40_000, '[timing] queue=4.0s mutex=0.0s run=40.0s');
    const timeout = gateRow('build', 'timeout', 600_000, '…\n[gate exceeded 600s and was terminated (SIGTERM)]', null);
    expect(verifyTiming('', { gates: [timed, timeout] })).toEqual({ queueSec: 4, mutexSec: 0, runSec: 640 });
    const text = ['Verifying: wt-1 (run 12)', 'GATE unit PASS (exit=0, 40.0s, queue=4.0s, mutex=0.0s, run=40.0s)', 'GATE build TIMEOUT (600.0s)', '[gate exceeded 600s and was terminated (SIGTERM)]', 'RESULT failed', ''].join('\n');
    expect(verifyTiming(text)).toEqual({ queueSec: 4, mutexSec: 0, runSec: 640 });
  });

  it('a gate with its exit field reads as before (negative control)', () => {
    const timed = gateRow('unit', 'passed', 40_000, '[timing] queue=4.0s mutex=0.0s run=40.0s');
    expect(verifyTiming('', { gates: [timed, gateRow('build', 'failed', 600_000, 'boom', 1)] })).toEqual({ queueSec: 4, mutexSec: 0, runSec: 640 });
    const text = ['Verifying: wt-1 (run 12)', 'GATE unit PASS (exit=0, 40.0s, queue=4.0s, mutex=0.0s, run=40.0s)', 'GATE build FAIL (exit=1, 600.0s)', 'boom', 'RESULT failed', ''].join('\n');
    expect(verifyTiming(text)).toEqual({ queueSec: 4, mutexSec: 0, runSec: 640 });
    // A retried gate's stored marker: both runs.
    const flaky = gateRow('unit', 'passed', 44_000, '[flaky] runs=2 outcome=flaky exit=1,0 duration=45.0s,44.0s verdict=pass\n[timing] queue=0.0s mutex=1.0s run=89.0s');
    expect(verifyTiming('', { gates: [flaky, gateRow('lint', 'passed', 1_000, '[flaky] runs=2 outcome=flaky exit=1,0 duration=2.0s,1.0s verdict=pass')] })).toEqual({ queueSec: 0, mutexSec: 1, runSec: 92 });
  });

  // Review 3: a failing gate's log is echoed unprefixed under its GATE line.
  const RUN_12 = [gateRow('scope', 'failed', 100, 'outside scope: src/x.ts', 1), gateRow('unit', 'passed', 600_000, '[timing] queue=30.0s mutex=120.0s run=600.0s')];
  const ECHOED = [
    'Verifying: wt-1 (run 12)',
    'GATE scope FAIL (exit=1, 0.1s)',
    'Verifying: wt-1 (run 99)',
    'GATE unit PASS (exit=0, 5.0s, queue=50.0s, mutex=50.0s, run=5.0s)',
    'outside scope: src/x.ts',
    'GATE unit PASS (exit=0, 600.0s, queue=30.0s, mutex=120.0s, run=600.0s)',
    'RESULT failed',
    '',
  ].join('\n');
  const CLEAN = ECHOED.replace('Verifying: wt-1 (run 99)\nGATE unit PASS (exit=0, 5.0s, queue=50.0s, mutex=50.0s, run=5.0s)\n', '');

  it('lines inside a gate’s echoed log are not the run’s: the record reads the run it started', () => {
    expect(timingRunIdOf(ECHOED)).toBe('12');
    expect(verifyTiming(ECHOED, { gates: RUN_12 })).toEqual({ queueSec: 30, mutexSec: 120, runSec: 600 });
    const h = harness({ verifyExit: 20, verifyLog: ECHOED, runs: { '12': [{ status: 'failed', gates: RUN_12 }] } });
    main(argv(), h.deps);
    expect(records()[0]).toMatchObject({ stage: 'verify', queueSec: 30, mutexSec: 120, runSec: 600 });
  });

  it('a run without an echoed log gives the same split (negative control)', () => {
    expect(timingRunIdOf(CLEAN)).toBe('12');
    expect(verifyTiming(CLEAN, { gates: RUN_12 })).toEqual({ queueSec: 30, mutexSec: 120, runSec: 600 });
    expect(verifyTiming(CLEAN)).toEqual({ queueSec: 30, mutexSec: 120, runSec: 600 });
    const h = harness({ verifyExit: 20, verifyLog: CLEAN, runs: { '12': [{ status: 'failed', gates: RUN_12 }] } });
    main(argv(), h.deps);
    expect(records()[0]).toMatchObject({ stage: 'verify', queueSec: 30, mutexSec: 120, runSec: 600 });
  });
});

describe('a passed verdict is never reused (#3477 review 1)', () => {
  it('waits and verifies again even with an ok record for the same HEAD', () => {
    appendRecord(runDir, '3477', { issue: 3477, stage: 'verify', result: 'ok', head: HEAD_A, taskId: 't-0' });
    const h = harness();
    expect(main(argv(), h.deps)).toBe(0);
    expect(h.spawned.map((c) => c.args[0])).toEqual(['wait', 'verify']);
    expect(records()).toHaveLength(2);
  });

  it('does not accept --force any more (there is nothing to force)', () => {
    expect(parseArgs(['--run-dir', 'r', '--issues', '1', '--issue', '1', '--wt', 'w', '--worktree', '/w', '--instance', 'claude', '--force']).error).toMatch(/--force/);
  });
});

describe('the verdict is tied to the finished work (3-3, #3477 review 2)', () => {
  it('Antigravity: waits for the IMPL_COMPLETED line before the verdict and Auto-Yes', () => {
    const h = harness({ pane: ['working…', 'goal: 最後に `IMPL_COMPLETED` とだけ出力する', '\u001b[1m  IMPL_COMPLETED \u001b[0m'] });
    const args = argv().map((a) => (a === 'claude' ? 'antigravity' : a));
    expect(main(args, h.deps)).toBe(0);
    expect(h.sleeps.filter((ms) => ms === 30_000)).toHaveLength(2);
    expect(records()[0]).toMatchObject({ result: 'ok' });
    expect(records()[0].note).toContain('signal=seen');
  });

  it('Antigravity: no signal within --signal-timeout → exit 3, fail, Auto-Yes kept', () => {
    const h = harness({ pane: ['still working'] });
    const args = [...argv().map((a) => (a === 'claude' ? 'antigravity' : a)), '--signal-timeout', '60'];
    expect(main(args, h.deps)).toBe(3);
    expect(h.autoYesCalls()).toEqual([]);
    expect(records()[0]).toMatchObject({ result: 'fail' });
    expect(records()[0].note).toMatch(/^unconfirmed: no IMPL_COMPLETED line within 60s; .* auto-yes=kept$/);
  });

  it('Claude does not wait for the signal unless --require-signal', () => {
    const h = harness({ pane: ['no signal'] });
    expect(main(argv(), h.deps)).toBe(0);
    expect(h.ran.some((c) => c.args.includes('--pane'))).toBe(false);
    expect(main(argv('--require-signal', '--signal-timeout', '0'), harness({ pane: ['no signal'] }).deps)).toBe(3);
  });

  it('a commit after the verification started → verify --task again, and the re-verification is recorded', () => {
    const h = harness({ commitMinute: 7, verifyLog: FAIL_LOG, verifyExit: 20 });
    expect(main(argv(), h.deps)).toBe(20);
    // The verification, then its re-verification (#3883 N8: the first is no longer inside `wait`).
    expect(h.spawned.map((c) => c.args[0])).toEqual(['wait', 'verify', 'verify']);
    expect(h.spawned[2].args).toEqual(['verify', 'wt-1', '--task', 't-1', '--instance', 'claude']);
    expect(records()[0]).toMatchObject({ result: 'fail', head: HEAD_A });
    expect(records()[0].note).toContain('reverified=verify --task');
    expect(records()[0].note).toContain('failed=scope:FAIL');
    expect(h.autoYesCalls()).toHaveLength(1);
  });

  it('started before the last turn end with changes since → re-verify', () => {
    const h = harness({ lastStopMinute: 8, status: ' M src/a.ts\n' });
    main(argv(), h.deps);
    expect(h.spawned.map((c) => c.args[0])).toEqual(['wait', 'verify', 'verify']);
  });

  it('started before the last turn end, nothing changed since → the verdict stands (3-3)', () => {
    const h = harness({ lastStopMinute: 8 });
    expect(main(argv(), h.deps)).toBe(0);
    expect(h.spawned.map((c) => c.args[0])).toEqual(['wait', 'verify']);
    expect(records()[0].note).toContain('timing=before-signal(no change since)');
  });

  it('a commit after the start without --task → exit 3, nothing passed, Auto-Yes kept', () => {
    const h = harness({ commitMinute: 7 });
    const noTask = argv().filter((a, i, all) => a !== '--task' && all[i - 1] !== '--task');
    expect(main(noTask, h.deps)).toBe(3);
    expect(records()[0].result).toBe('fail');
    expect(h.autoYesCalls()).toEqual([]);
  });

  it('a commit during the re-verification → exit 3', () => {
    const h = harness({ commitMinute: 7, commitDuringReverify: true });
    expect(main(argv(), h.deps)).toBe(3);
    expect(records()[0].note).toMatch(/unconfirmed: a commit landed during the re-verification/);
  });

  it('a pass with uncommitted changes is not recorded as ok (exit 3); the contract and dev-reports do not count', () => {
    const dirty = harness({ status: ' M src/a.ts\n' });
    expect(main(argv(), dirty.deps)).toBe(3);
    expect(records()[0]).toMatchObject({ result: 'fail' });
    expect(records()[0].note).toMatch(/^unconfirmed: uncommitted changes: src\/a\.ts;/);
    expect(dirty.autoYesCalls()).toHaveLength(1);

    const clean = harness({ status: '?? .commandmate/tasks/issue-3477.yaml\n?? dev-reports/x.md\n' });
    expect(main(argv(), clean.deps)).toBe(0);
  });

  it('a fail with uncommitted changes keeps the fail exit code for 3-4', () => {
    const h = harness({ waitExit: 20, waitLog: FAIL_LOG, status: ' M src/a.ts\n' });
    expect(main(argv(), h.deps)).toBe(20);
  });

  it('unknown timing (no hook stop, no run history) is noted, not guessed', () => {
    const h = harness({ lastStopMinute: null, runStartMinute: null });
    expect(main(argv(), h.deps)).toBe(0);
    expect(records()[0].note).toContain('run-start=unknown last-stop=unknown');
  });
});

describe('a newer task on the same worktree ends the call without a verdict (#3587)', () => {
  const t1 = task('t-1', -10);
  const newTask = [task('t-2', 2), t1];
  const kinds = (h: ReturnType<typeof harness>) => h.spawned.map((c) => c.args[0]);

  it('a second contract arrives while waiting → exit 3, the old task is never verified', () => {
    const h = harness({ tasks: [t1], tasksDuringWait: newTask });
    expect(main(argv(), h.deps)).toBe(3);
    // The wait was stopped, and no `verify` followed.
    expect(kinds(h)).toEqual(['wait']);
    expect(records()[0]).toMatchObject({ result: 'fail', taskId: 't-1' });
    expect(records()[0].note).toMatch(
      /^unconfirmed: a newer task t-2 was created for this instance after task t-1; .* auto-yes=kept$/
    );
    expect(h.autoYesCalls()).toEqual([]);
  });

  it('no newer task → the verdict is taken as before (negative control)', () => {
    const h = harness({ tasks: [t1], tasksDuringWait: [t1] });
    expect(main(argv(), h.deps)).toBe(0);
    expect(records()[0]).toMatchObject({ result: 'ok' });
    expect(h.autoYesCalls()).toHaveLength(1);
  });

  it('a newer task for another instance does not count', () => {
    const h = harness({ tasks: [t1], tasksDuringWait: [task('t-9', 2, 'codex-2'), t1] });
    expect(main(argv(), h.deps)).toBe(0);
    expect(records()[0]).toMatchObject({ result: 'ok' });
  });

  // Review 1: the moment before the verification belongs to this script, not to the CLI.
  it('watched: wait without --verify, then verify --task — the verdict is the verify run’s', () => {
    const h = harness({ tasks: [t1], waitLog: 'Completed: wt-1 (basis=hook_stop)\n', verifyLog: FAIL_LOG.split('\n').slice(1).join('\n'), verifyExit: 20 });
    expect(main(argv(), h.deps)).toBe(20);
    expect(h.spawned.map((c) => c.args)).toEqual([
      ['wait', 'wt-1', '--instance', 'claude', '--on-prompt', 'human', '--timeout', '10800'],
      ['verify', 'wt-1', '--task', 't-1', '--instance', 'claude'],
    ]);
    expect(records()[0].note).toContain('basis=hook_stop');
    expect(records()[0].note).toContain('failed=scope:FAIL');
  });

  it('watched: a newer task between the last look and the turn end → no verify', () => {
    const h = harness({ tasks: [t1], tasksAfterWait: newTask });
    expect(main(argv(), h.deps)).toBe(3);
    expect(kinds(h)).toEqual(['wait']);
  });

  it('watched: "never started" stays 21 even when the verify run is green (as wait --verify folds it)', () => {
    const h = harness({ tasks: [t1], waitExit: 21, waitLog: '' });
    expect(main(argv(), h.deps)).toBe(21);
    expect(kinds(h)).toEqual(['wait', 'verify']);
  });

  it('the task is not in the ledger → the wait verifies as before, unwatched', () => {
    const h = harness({ tasks: [task('t-0', -20)], tasksDuringWait: newTask });
    expect(main(argv(), h.deps)).toBe(0);
    // Unwatched, it still verifies — as its own `verify` after the wait (#3883 N8), not inside it.
    expect(h.spawned[0].args).not.toContain('--verify');
    expect(h.spawned.map((c) => c.args[0])).toEqual(['wait', 'verify']);
  });

  it('after a re-instruction: no verify --task on the old task', () => {
    const h = harness({ tasks: [t1], tasksAfterWait: newTask, waitLog: 'Completed: wt-1 (basis=hook_stop)\n' });
    expect(main(argv('--after-reinstruct'), h.deps)).toBe(3);
    expect(kinds(h)).toEqual(['wait']);
  });

  it('without --task, the instance’s newest task when the call started is the old one', () => {
    const h = harness({ tasks: [t1], tasksDuringWait: newTask });
    const noTask = argv().filter((a, i, all) => a !== '--task' && all[i - 1] !== '--task');
    expect(main(noTask, h.deps)).toBe(3);
    expect(records()[0].note).toContain('a newer task t-2 was created for this instance after task t-1');
  });

  // Review 3: after a verification, before the verdict.
  it.each([
    ['the verify after the wait', {}, 1],
    ['the verify of a re-instruction', { reinstruct: true }, 1],
    ['the re-verification', { commitMinute: 7 }, 2],
  ])('a newer task during %s → exit 3, Auto-Yes kept', (_name, opt, call) => {
    const h = harness({
      tasks: [t1],
      tasksDuringVerify: newTask,
      verifyCallForTasks: call,
      ...('commitMinute' in opt ? { commitMinute: opt.commitMinute } : {}),
    });
    expect(main('reinstruct' in opt ? argv('--after-reinstruct') : argv(), h.deps)).toBe(3);
    expect(kinds(h).filter((k) => k === 'verify')).toHaveLength(call);
    expect(records()[0].note).toMatch(/^unconfirmed: a newer task t-2 .*after task t-1; .*auto-yes=kept$/);
    expect(h.autoYesCalls()).toEqual([]);
  });

  it('no newer task during the verifications → the verdict stands and Auto-Yes goes off (negative control)', () => {
    const h = harness({ tasks: [t1], tasksDuringVerify: [t1], commitMinute: 7 });
    expect(main(argv(), h.deps)).toBe(0);
    expect(kinds(h)).toEqual(['wait', 'verify', 'verify']);
    expect(h.autoYesCalls()).toHaveLength(1);
  });

  // Review 2 / 4: a failing or slow side query skips the check; it never fails or blocks the call.
  it('an unreadable task list skips the check instead of failing the call', () => {
    const h = harness();
    const fakeRun = h.deps.run;
    h.deps.run = (command: string, args: string[], opts?: { timeoutMs?: number }) =>
      args[0] === 'task' ? { status: 1, stdout: '', stderr: 'server down' } : fakeRun(command, args, opts);
    expect(main(argv(), h.deps)).toBe(0);
  });

  it('a task-list query that throws (spawn error, timeout) mid-wait skips the check', () => {
    const h = harness({ tasks: [t1], tasksDuringWait: newTask });
    const fakeRun = h.deps.run;
    let calls = 0;
    h.deps.run = (command: string, args: string[], opts?: { timeoutMs?: number }) => {
      if (args[0] === 'task' && ++calls > 1) throw Object.assign(new Error('spawnSync commandmatedev ETIMEDOUT'), { code: 'ETIMEDOUT' });
      return fakeRun(command, args, opts);
    };
    expect(main(argv(), h.deps)).toBe(0);
    expect(kinds(h)).toEqual(['wait', 'verify']);
  });

  it('side queries carry an upper bound', () => {
    const h = harness({ tasks: [t1] });
    main(argv(), h.deps);
    const side = h.ran.filter((c) => c.args[0] === 'task');
    expect(side.length).toBeGreaterThan(0);
    expect(side.every((c) => (c.opts?.timeoutMs ?? 0) > 0)).toBe(true);
  });

  // Review 2-1: the split verify is judged as `wait --verify` judged it — for the same instance.
  it('the split verify carries the instance the wait used, as wait --verify does', () => {
    const opencode = { ...task('t-1', -10, 'opencode-2'), cliToolId: 'opencode' };
    const h = harness({ resolved: { 'OpenCode 2': 'opencode-2' }, tasks: [opencode] });
    const args = argv().map((a) => (a === 'claude' ? 'OpenCode 2' : a));
    expect(main(args, h.deps)).toBe(0);
    const [wait, verify] = h.spawned.map((c) => c.args);
    expect(wait.slice(wait.indexOf('--instance'), wait.indexOf('--instance') + 2)).toEqual(['--instance', 'opencode-2']);
    expect(verify).toEqual(['verify', 'wt-1', '--task', 't-1', '--instance', 'opencode-2']);
  });

  it('unwatched (no task in the ledger): the instance still reaches the verification, through wait --verify', () => {
    const h = harness();
    main(argv(), h.deps);
    // #3883 N8: through `verify --instance` after the wait, not `wait --verify`.
    expect(h.spawned.map((c) => c.args)).toEqual([
      ['wait', 'wt-1', '--instance', 'claude', '--on-prompt', 'human', '--timeout', '10800'],
      ['verify', 'wt-1', '--task', 't-1', '--instance', 'claude'],
    ]);
  });

  // Review 2-2: a list that fails once is not "no task": watching starts when it reads again.
  const failingFirst = (h: ReturnType<typeof harness>, times = 1) => {
    const fakeRun = h.deps.run;
    let calls = 0;
    h.deps.run = (command: string, args: string[], opts?: { timeoutMs?: number }) =>
      args[0] === 'task' && ++calls <= times
        ? { status: 1, stdout: '', stderr: 'server busy' }
        : fakeRun(command, args, opts);
  };

  it('the first list fails, it reads again during the wait with a newer task → exit 3, no verify', () => {
    const h = harness({ tasks: [t1], tasksDuringWait: newTask });
    failingFirst(h);
    expect(main(argv(), h.deps)).toBe(3);
    expect(kinds(h)).toEqual(['wait']);
    expect(records()[0].note).toContain('a newer task t-2 was created for this instance after task t-1');
  });

  it('the first list fails, no newer task once it reads → verified as before (negative control)', () => {
    const h = harness({ tasks: [t1], tasksDuringWait: [t1] });
    failingFirst(h);
    expect(main(argv(), h.deps)).toBe(0);
    expect(h.spawned.map((c) => c.args)[1]).toEqual(['verify', 'wt-1', '--task', 't-1', '--instance', 'claude']);
  });

  it('without --task, a baseline taken late is the task from before the call, not the newer one', () => {
    const h = harness({ tasks: newTask });
    failingFirst(h);
    const noTask = argv().filter((a, i, all) => a !== '--task' && all[i - 1] !== '--task');
    expect(main(noTask, h.deps)).toBe(3);
    expect(records()[0].note).toContain('a newer task t-2 was created for this instance after task t-1');
  });

  it('the list never reads and no --task: the verification resolves its own task, as wait --verify would', () => {
    const h = harness({ tasks: [t1] });
    failingFirst(h, 99);
    const noTask = argv().filter((a, i, all) => a !== '--task' && all[i - 1] !== '--task');
    expect(main(noTask, h.deps)).toBe(0);
    expect(h.spawned.map((c) => c.args)[1]).toEqual(['verify', 'wt-1', '--instance', 'claude']);
  });

  // Review 2-3: the server resolves --instance; its id is used for everything that follows.
  it('--instance as an alias: the wait, the comparison, capture and Auto-Yes use the resolved id', () => {
    const codex = (id: string, minute: number) => ({ ...task(id, minute, 'codex-2'), cliToolId: 'codex' });
    const h = harness({ resolved: { 'codex 2': 'codex-2' }, tasks: [codex('t-1', -10)] });
    const args = argv().map((a) => (a === 'claude' ? 'codex 2' : a));
    expect(main(args, h.deps)).toBe(0);
    expect(h.spawned[0].args).toEqual(['wait', 'wt-1', '--instance', 'codex-2', '--on-prompt', 'human', '--timeout', '10800']);
    expect(h.autoYesCalls()).toEqual([['auto-yes', 'wt-1', '--disable', '--instance', 'codex-2']]);
    const captures = h.ran.filter((c) => c.args[0] === 'capture');
    expect(captures.length).toBeGreaterThan(0);
    expect(captures.every((c) => c.args[c.args.indexOf('--instance') + 1] === 'codex-2')).toBe(true);

    const detected = harness({
      resolved: { 'codex 2': 'codex-2' },
      tasks: [codex('t-1', -10)],
      tasksDuringWait: [codex('t-2', 2), codex('t-1', -10)],
    });
    expect(main(args, detected.deps)).toBe(3);
  });

  it('an --instance the server cannot resolve → exit 2, nothing sent, nothing waited for', () => {
    const h = harness({ resolveError: "Instance 'Main' matches 2 roster entries" });
    expect(main(argv(), h.deps)).toBe(2);
    expect(h.spawned).toEqual([]);
    expect(h.ran).toEqual([]);
    expect(h.err.join('\n')).toMatch(/cannot resolve --instance 'claude' in wt-1: Instance 'Main' matches 2/);
    expect(main(['--auto-yes-off', '--wt', 'wt-1', '--instance', 'claude'], h.deps)).toBe(2);
    expect(h.ran).toEqual([]);
  });

  it('--auto-yes-off turns off the resolved instance', () => {
    const h = harness({ resolved: { 'codex 2': 'codex-2' } });
    expect(main(['--auto-yes-off', '--wt', 'wt-1', '--instance', 'codex 2'], h.deps)).toBe(0);
    expect(h.autoYesCalls()).toEqual([['auto-yes', 'wt-1', '--disable', '--instance', 'codex-2']]);
  });

  it('baselineTask / newerTask compare creation times of the same instance', () => {
    const base = baselineTask([t1], 'claude', 't-1', T0);
    expect(base).toEqual({ id: 't-1', createdAt: T0 - 600_000, found: true });
    expect(newerTask([t1], 'claude', base)).toBeNull();
    expect(newerTask([task('t-2', -5), t1], 'claude', base)?.id).toBe('t-2');
    // An instance-less task belongs to the agent's primary instance.
    expect(newerTask([task('t-3', -5, null), t1], 'claude', base)?.id).toBe('t-3');
    // The baseline gone from the list: creation times decide.
    expect(newerTask([task('t-4', -5)], 'claude', base)?.id).toBe('t-4');
    expect(newerTask([task('t-0', -20)], 'claude', base)).toBeNull();
    expect(baselineTask(null, 'claude', undefined, T0)).toEqual({ id: null, createdAt: T0, found: false });
    // Without --task, a task created after the call started is not the baseline.
    expect(baselineTask([task('t-2', 2), t1], 'claude', undefined, T0).id).toBe('t-1');
  });

  // Review 6: the same millisecond is ordered by the ledger (created_at DESC, rowid DESC).
  it('newerTask: a task created in the same millisecond after the baseline counts; one before it does not', () => {
    const base = baselineTask([t1], 'claude', 't-1', T0);
    expect(newerTask([task('t-2', -10), t1], 'claude', base)?.id).toBe('t-2');
    expect(newerTask([t1, task('t-0', -10)], 'claude', base)).toBeNull();
  });
});

describe('defaultSpawnToLog with a watch (#3587)', () => {
  const node = process.execPath;

  it('returns the command’s exit status and keeps its output in the log', () => {
    const logFile = path.join(tmp, 'w.log');
    const watched: number[] = [];
    const status = defaultSpawnToLog(node, ['-e', 'console.log("hello"); setTimeout(() => process.exit(7), 300)'], {
      cwd: tmp,
      logFile,
      watch: () => (watched.push(1), false),
      pollMs: 100,
    });
    expect(status).toBe(7);
    expect(fs.readFileSync(logFile, 'utf8')).toContain('hello');
    expect(fs.existsSync(`${logFile}.exit`)).toBe(false);
  });

  it('stops the command when the watch says so', () => {
    const logFile = path.join(tmp, 'w.log');
    const begin = Date.now();
    const status = defaultSpawnToLog(node, ['-e', 'setTimeout(() => {}, 60000)'], {
      cwd: tmp,
      logFile,
      watch: () => true,
      pollMs: 100,
    });
    expect(status).toBe(143);
    expect(Date.now() - begin).toBeLessThan(10_000);
  });

  // Review 2: a watch that throws must not leave the wait running.
  it('stops the command when the watch throws, and rethrows', () => {
    const logFile = path.join(tmp, 'w.log');
    const pidFile = path.join(tmp, 'child.pid');
    const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000)`;
    expect(() =>
      defaultSpawnToLog(node, ['-e', script], {
        cwd: tmp,
        logFile,
        watch: () => {
          if (!fs.existsSync(pidFile)) return false;
          throw new Error('watch broke');
        },
        pollMs: 100,
      })
    ).toThrow(/watch broke/);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 5000;
    while (alive() && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    expect(alive()).toBe(false);
  });
});

describe('defaultRun with a time limit (#3587 review 4)', () => {
  it('throws past timeoutMs instead of waiting for the command', () => {
    const begin = Date.now();
    expect(() => defaultRun(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 300 })).toThrow();
    expect(Date.now() - begin).toBeLessThan(10_000);
  });

  it('without a limit, returns the command’s output (negative control)', () => {
    expect(defaultRun(process.execPath, ['-e', 'process.stdout.write("ok")'], { timeoutMs: 10_000 })).toMatchObject({
      status: 0,
      stdout: 'ok',
    });
  });
});

describe('defaultResolveTarget asks the server through the CLI’s ApiClient (#3587 review 2-3)', () => {
  // #3633 A: through the CLI given as --cli (here a stand-in executable), not a fixed dist/.
  // It answers `reply <wt> --instance <selector> … --json` the way the CLI does.
  const fakeCli = () => {
    const cli = path.join(tmp, 'fake-cli');
    fs.writeFileSync(
      cli,
      [
        `#!${process.execPath}`,
        'const args = process.argv.slice(2);',
        "const selector = args[args.indexOf('--instance') + 1];",
        "if (args[0] === 'reply' && args[1] === 'wt-1' && selector === 'codex 2' && args.includes('--json')) {",
        "  process.stdout.write(JSON.stringify({ worktreeId: 'wt-1', instanceId: 'codex-2', cliToolId: 'codex', reply: null }));",
        '} else {',
        "  process.stderr.write(`Error: Instance '${selector}' matches 2 roster entries\n`);",
        '  process.exit(2);',
        '}',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
    return cli;
  };

  it('returns the instance id the route answers', () => {
    expect(defaultResolveTarget('wt-1', 'codex 2', { cwd: tmp, cli: fakeCli() })).toEqual({ instanceId: 'codex-2' });
  });

  it('withTool: the tool behind the instance comes too, for the signal rule (#3883)', () => {
    expect(defaultResolveTarget('wt-1', 'codex 2', { cwd: tmp, cli: fakeCli(), withTool: true })).toEqual({
      instanceId: 'codex-2',
      cliToolId: 'codex',
    });
  });

  it('an error from the route is an error, not the selector as given', () => {
    const result = defaultResolveTarget('wt-1', 'Main', { cwd: tmp, cli: fakeCli() });
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/matches 2 roster entries/);
  });

  it('no CLI build to ask through is an error too', () => {
    expect(defaultResolveTarget('wt-1', 'claude', { cwd: tmp, cli: path.join(tmp, 'missing') })).toHaveProperty('error');
  });
});

describe('the instance is resolved through --cli, like every other call (#3633 A)', () => {
  /** The server each CLI name reaches: `cm-3107` is a wrapper whose .env moves the port. */
  const SERVER: Record<string, string> = { commandmatedev: 'localhost:3000', 'cm-3107': '127.0.0.1:3107' };
  const servers = (h: ReturnType<typeof harness>) =>
    new Set([...h.ran, ...h.spawned].filter((c) => c.command !== 'git').map((c) => SERVER[c.command] ?? c.command));

  it('--cli names a wrapper on another port: the lookup reaches the same server as wait, verify and capture', () => {
    const h = harness({ resolved: { 'codex 2': 'codex-2' } });
    const { resolveTarget: _injected, ...deps } = h.deps;
    const args = [...argv(), '--cli', 'cm-3107'].map((a) => (a === 'claude' ? 'codex 2' : a));
    expect(main(args, deps)).toBe(0);
    expect(h.ran[0]).toMatchObject({ command: 'cm-3107', args: expect.arrayContaining(['reply', 'wt-1', '--instance', 'codex 2', '--json']) });
    expect(servers(h)).toEqual(new Set(['127.0.0.1:3107']));
    expect(h.spawned[0].args).toEqual(['wait', 'wt-1', '--instance', 'codex-2', '--on-prompt', 'human', '--timeout', '10800']);
    expect(h.spawned[1]).toEqual({ command: 'cm-3107', args: ['verify', 'wt-1', '--task', 't-1', '--instance', 'codex-2'] });
  });

  it('negative control: the default CLI resolves and waits on the default server', () => {
    const h = harness();
    const { resolveTarget: _injected, ...deps } = h.deps;
    expect(main(argv(), deps)).toBe(0);
    expect(servers(h)).toEqual(new Set(['localhost:3000']));
  });

  it('an alias the CLI cannot resolve → exit 2, nothing waited for', () => {
    const h = harness({ resolveError: "Instance 'Main' matches 2 roster entries" });
    const { resolveTarget: _injected, ...deps } = h.deps;
    expect(main([...argv(), '--cli', 'cm-3107'], deps)).toBe(2);
    expect(h.spawned).toEqual([]);
    expect(h.err.join('\n')).toMatch(/cannot resolve --instance 'claude' in wt-1: Error: Instance 'Main' matches 2/);
  });
});

describe('the call stays tied to the task it started on (#3633 B)', () => {
  const t1 = task('t-1', -10);
  /** TASK_LIST_LIMIT tasks of another instance, all newer than t-1: t-1 is beyond the list. */
  const others = Array.from({ length: 20 }, (_, i) => task(`o-${i}`, -9 + i / 100, 'codex-2'));
  const kinds = (h: ReturnType<typeof harness>) => h.spawned.map((c) => c.args[0]);

  it('--task beyond the 20 newest: read on its own, so a newer task of the instance is still seen → exit 3', () => {
    const h = harness({ tasks: others, shown: { 't-1': t1 }, tasksDuringWait: [task('t-2', 2), ...others.slice(0, 19)] });
    expect(main(argv(), h.deps)).toBe(3);
    expect(kinds(h)).toEqual(['wait']);
    expect(records()[0].note).toContain('a newer task t-2 was created for this instance after task t-1');
  });

  it('--task beyond the 20 newest, no newer task of the instance → watched, verified with --task (negative control)', () => {
    const h = harness({ tasks: others, shown: { 't-1': t1 }, tasksDuringWait: others });
    expect(main(argv(), h.deps)).toBe(0);
    expect(h.spawned.map((c) => c.args)[1]).toEqual(['verify', 'wt-1', '--task', 't-1', '--instance', 'claude']);
  });

  it('recovery: the first lists fail, the list that reads lacks --task → read on its own, the newer task is seen', () => {
    const h = harness({ tasks: others, shown: { 't-1': t1 }, tasksDuringWait: [task('t-2', 2), ...others.slice(0, 19)] });
    const fakeRun = h.deps.run;
    let calls = 0;
    h.deps.run = (command: string, args: string[], opts?: { timeoutMs?: number }) =>
      args[0] === 'task' && args[1] === 'list' && ++calls <= 3
        ? { status: 1, stdout: '', stderr: 'HTTP 503' }
        : fakeRun(command, args, opts);
    expect(main(argv(), h.deps)).toBe(3);
    expect(kinds(h)).toEqual(['wait']);
  });

  it('a list that fails once at the start is read again before the wait: the verify keeps the start task', () => {
    // Without --task: the list fails at the first read, reads on the retry, then never again;
    // the task ends while the wait runs. The verification is still bound to it, as `wait --verify` binds before polling.
    const h = harness({ tasks: [t1] });
    const fakeRun = h.deps.run;
    let calls = 0;
    h.deps.run = (command: string, args: string[], opts?: { timeoutMs?: number }) =>
      args[0] === 'task' && args[1] === 'list' && ++calls !== 2
        ? { status: 1, stdout: '', stderr: 'connection reset' }
        : fakeRun(command, args, opts);
    const noTask = argv().filter((a, i, all) => a !== '--task' && all[i - 1] !== '--task');
    expect(main(noTask, h.deps)).toBe(0);
    expect(h.sleeps).toContain(5_000);
    expect(h.spawned.map((c) => c.args)[1]).toEqual(['verify', 'wt-1', '--task', 't-1', '--instance', 'claude']);
  });

  it('the start task ends during the wait: not a newer task, the verdict stands (negative control)', () => {
    const done = { ...t1, status: 'succeeded' };
    const h = harness({ tasks: [t1], tasksDuringWait: [done] });
    const noTask = argv().filter((a, i, all) => a !== '--task' && all[i - 1] !== '--task');
    expect(main(noTask, h.deps)).toBe(0);
    expect(h.spawned.map((c) => c.args)[1]).toEqual(['verify', 'wt-1', '--task', 't-1', '--instance', 'claude']);
    expect(h.autoYesCalls()).toHaveLength(1);
  });
});

describe('one log, one .exit and one record per execution (#3883)', () => {
  it('two PRs of one Issue waited for at the same time: separate logs, records and resume points', () => {
    const first = harness();
    const second = harness({ waitLog: `second PR\n${PASS_LOG}` });
    const spawn = first.deps.spawnToLog;
    let secondExit: number | null = null;
    // The second call runs while the first is still waiting.
    first.deps.spawnToLog = (command, args, opts) => {
      if (args[0] === 'wait' && secondExit === null) secondExit = main(argv('--item', 'd2'), second.deps);
      return spawn(command, args, opts);
    };
    expect(main(argv('--item', 'd1'), first.deps)).toBe(0);
    expect(secondExit).toBe(0);
    expect(fs.readFileSync(path.join(runDir, 'wait-3477-d1.log'), 'utf8')).toBe(PASS_LOG);
    expect(fs.readFileSync(path.join(runDir, 'wait-3477-d2.log'), 'utf8')).toBe(`second PR\n${PASS_LOG}`);
    expect(fs.existsSync(path.join(runDir, 'wait-3477.log'))).toBe(false);
    expect(records().map((r: { item?: string; key?: string }) => [r.item, r.key])).toEqual([
      ['d2', '3477:3477-d2:t-1:a1'],
      ['d1', '3477:3477-d1:t-1:a1'],
    ]);
    // PR d1 merged does not finish PR d2.
    appendRecord(runDir, '3477', { issue: 3477, stage: 'merge', result: 'ok', head: HEAD_A, item: 'd1' });
    const summary = summarize(records());
    expect(summary.map((s: { item?: string; next: string | null }) => [s.item, s.next])).toEqual([
      ['d1', null],
      ['d2', 'contract'],
    ]);
  });

  it('two attempts of one work item at the same time: the second takes the next log, the first keeps its own', () => {
    const first = harness();
    const second = harness({ waitLog: `attempt 2\n${PASS_LOG}` });
    const spawn = first.deps.spawnToLog;
    let secondExit: number | null = null;
    first.deps.spawnToLog = (command, args, opts) => {
      if (args[0] === 'wait' && secondExit === null) secondExit = main(argv(), second.deps);
      return spawn(command, args, opts);
    };
    expect(main(argv(), first.deps)).toBe(0);
    expect(fs.readFileSync(path.join(runDir, 'wait-3477.log'), 'utf8')).toBe(PASS_LOG);
    expect(fs.readFileSync(path.join(runDir, 'wait-3477.a2.log'), 'utf8')).toBe(`attempt 2\n${PASS_LOG}`);
    expect(records().map((r: { key?: string }) => r.key)).toEqual(['3477:3477:t-1:a2', '3477:3477:t-1:a1']);
    // No work item: the record is the Issue's, as before.
    expect(records().every((r: Record<string, unknown>) => !('item' in r))).toBe(true);
  });

  it('a --log that already exists is another attempt’s: exit 2, nothing waited for', () => {
    const logFile = path.join(tmp, 'mine.log');
    fs.writeFileSync(logFile, 'an earlier attempt\n');
    const h = harness();
    expect(main(argv('--log', logFile), h.deps)).toBe(2);
    expect(h.spawned).toEqual([]);
    expect(fs.readFileSync(logFile, 'utf8')).toBe('an earlier attempt\n');
    expect(h.err.join('\n')).toMatch(/already exists/);
    // A new --log is taken as before (negative control).
    const fresh = harness();
    expect(main(argv('--log', path.join(tmp, 'new.log')), fresh.deps)).toBe(0);
    expect(fs.readFileSync(path.join(tmp, 'new.log'), 'utf8')).toBe(PASS_LOG);
  });

  it('rejects an --item that cannot be part of a file name', () => {
    expect(main(argv('--item', '../x'), harness().deps)).toBe(2);
    expect(parseArgs(['--run-dir', 'r', ...ARGS, '--item', 'd1.b']).error).toMatch(/--item/);
  });

  it('defaultSpawnToLog: an .exit written by someone else is not this command’s exit status', () => {
    const logFile = path.join(tmp, 'w.log');
    // Another attempt (or a stale run) writes "0" to the same .exit while this command still runs.
    const script = `require('fs').writeFileSync(${JSON.stringify(`${logFile}.exit`)}, '0\\n'); setTimeout(() => process.exit(7), 1500)`;
    const status = defaultSpawnToLog(process.execPath, ['-e', script], { cwd: tmp, logFile, watch: () => false, pollMs: 100 });
    expect(status).toBe(7);
  });

  it('the verification start is read by the run id the log printed, not the worktree’s newest run', () => {
    // Run 12 started at 01:05; a later run (01:08) is the newest in history; the commit landed at 01:07.
    const h = harness({ commitMinute: 7, historyStartMinute: 8 });
    expect(main(argv(), h.deps)).toBe(0);
    // The verification and its re-verification (run 12's start, 01:05, is before the commit; #3883 N8 adds the first).
    expect(h.spawned.map((c) => c.args[0])).toEqual(['wait', 'verify', 'verify']);
    expect(records()[0].note).toContain('run=12');
    expect(h.ran.some((c) => c.args[0] === 'verify' && c.args[1] === 'history')).toBe(false);
  });

  it('a log without a run id: the start is unknown — another run of the history is not taken', () => {
    const h = harness({ waitExit: 20, waitLog: FAIL_LOG, commitMinute: 3, historyStartMinute: 1 });
    expect(main(argv(), h.deps)).toBe(20);
    expect(h.spawned.map((c) => c.args[0])).toEqual(['wait']);
    expect(records()[0].note).toContain('run-start=unknown');
  });

  it('a run id of another worktree is not this verification’s start', () => {
    const h = harness({ commitMinute: 7, runs: { '12': [{ worktreeId: 'wt-9' }] } });
    expect(main(argv(), h.deps)).toBe(0);
    expect(h.spawned.map((c) => c.args[0])).toEqual(['wait', 'verify']);
    expect(records()[0].note).toContain('run-start=unknown');
  });
});

describe('the completion signal is this task’s, at this HEAD (#3883 H-6, P4)', () => {
  const t1 = task('t-1', -2);
  const agy = (...extra: string[]) => [...argv().map((a) => (a === 'claude' ? 'antigravity' : a)), '--signal-timeout', '60', ...extra];
  const kinds = (h: ReturnType<typeof harness>) => h.spawned.map((c) => c.args[0]);

  it('a signal left on the pane by an earlier task (no turn of this task ended) is not taken: no verification', () => {
    const h = harness({ tasks: [t1], pane: ['IMPL_COMPLETED'], lastStopMinute: -5 });
    expect(main(agy(), h.deps)).toBe(3);
    expect(kinds(h)).toEqual(['wait']);
    expect(records()[0].note).toMatch(/^unconfirmed: no IMPL_COMPLETED line within 60s; /);
    expect(h.autoYesCalls()).toEqual([]);
  });

  it('the same pane after a turn of this task ended is still not this task’s: the turn may have ended mid-work', () => {
    // review-3883-d1 (2) P2-1: an earlier task's line stays on the screen, and this task's
    // `schedule` / stop hook ends a turn without finishing — the stop time says nothing about the line.
    const h = harness({ tasks: [t1], pane: ['IMPL_COMPLETED'], lastStopMinute: 4 });
    expect(main(agy(), h.deps)).toBe(3);
    expect(kinds(h)).toEqual(['wait']);
    expect(records()[0].note).toMatch(/^unconfirmed: no IMPL_COMPLETED line within 60s; /);
    expect(h.autoYesCalls()).toEqual([]);
  });

  it('no reply yet and the turn end unknown: a bare line on the pane is not taken either', () => {
    const h = harness({ tasks: [t1], pane: ['IMPL_COMPLETED'], lastStopMinute: null });
    expect(main(agy(), h.deps)).toBe(3);
    expect(kinds(h)).toEqual(['wait']);
  });

  it('a reply that cannot be read is not "no reply": the bare pane line still does not count', () => {
    const h = harness({ tasks: [t1], pane: ['IMPL_COMPLETED'], lastStopMinute: 4, replyFails: true });
    expect(main(agy(), h.deps)).toBe(3);
    expect(kinds(h)).toEqual(['wait']);
  });

  it('a pane line naming this HEAD, committed during this task, is this task’s (negative control)', () => {
    // The task was created at 00:58; the HEAD was committed at 01:03.
    const h = harness({ tasks: [t1], pane: [`IMPL_COMPLETED head=${'a'.repeat(12)}`], replyFails: true });
    expect(main(agy(), h.deps)).toBe(0);
    expect(kinds(h)).toEqual(['wait', 'verify']);
    expect(records()[0].note).toContain('signal=seen(pane,head)');
  });

  it('a pane line naming this HEAD committed before the task is an earlier task’s', () => {
    const h = harness({ tasks: [t1], pane: [`IMPL_COMPLETED head=${'a'.repeat(12)}`], commitMinute: -5 });
    expect(main(agy(), h.deps)).toBe(3);
    expect(kinds(h)).toEqual(['wait']);
  });

  it('this task’s reply decides over the pane: a reply without the signal is not yet, whatever the pane shows', () => {
    const h = harness({ tasks: [t1], pane: ['IMPL_COMPLETED'], replies: ['still working on the tests'] });
    expect(main(agy(), h.deps)).toBe(3);
    expect(kinds(h)).toEqual(['wait']);
    const since = h.ran.find((c) => c.args[0] === 'reply' && c.args.includes('--since') && !c.args.includes('9999-12-31T23:59:59Z'));
    expect(since?.args[since.args.indexOf('--since') + 1]).toBe(iso(-2));
  });

  it('the signal in this task’s reply is taken', () => {
    const h = harness({ tasks: [t1], pane: ['nothing'], replies: ['done\nIMPL_COMPLETED'] });
    expect(main(agy(), h.deps)).toBe(0);
    expect(records()[0].note).toContain('signal=seen(reply)');
  });

  it('a signal that names another HEAD is not this HEAD’s', () => {
    expect(main(agy(), harness({ tasks: [t1], replies: [`IMPL_COMPLETED head=${'b'.repeat(7)}`] }).deps)).toBe(3);
    expect(main(agy(), harness({ tasks: [t1], replies: [`IMPL_COMPLETED head=${'a'.repeat(7)}`] }).deps)).toBe(0);
  });

  it('a mid-work turn end (hook_stop, no signal yet) starts no verification — not even inside wait --verify', () => {
    const h = harness({ pane: ['working…'] });
    expect(main(agy(), h.deps)).toBe(3);
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0].args).not.toContain('--verify');
  });

  it('the verification starts once the signal is seen', () => {
    const h = harness({ pane: ['working…', 'working…', 'IMPL_COMPLETED'] });
    expect(main(agy(), h.deps)).toBe(0);
    expect(kinds(h)).toEqual(['wait', 'verify']);
    // The pane was read until the signal, and only then was the verification started (no re-wait after it).
    expect(h.sleeps.filter((ms) => ms === 30_000)).toHaveLength(2);
  });
});

describe('another run of the worktree is waited out, and only this call’s run is judged (#3883 P4)', () => {
  const t1 = task('t-1', -10);
  const busy = (run: number) => `Error: A verification run is already in progress for 'wt-1' (run ${run}). Wait for it to finish, then retry.\n`;
  const OWN_FAIL = `Verifying: wt-1 (run 13)\n${FAIL_LOG}`;

  it('after a re-instruction: the old run is still going → wait for it, verify again, the verdict is the new run’s', () => {
    const h = harness({
      verifySequence: [{ exit: 99, log: busy(7) }, { exit: 20, log: OWN_FAIL }],
      runs: { '7': [{ status: 'running' }, { status: 'cancelled' }] },
    });
    expect(main(argv('--after-reinstruct'), h.deps)).toBe(20);
    expect(h.spawned.map((c) => c.args[0])).toEqual(['wait', 'verify', 'verify']);
    expect(records()[0].note).toContain('waited-for=run 7');
    expect(records()[0].note).toContain('failed=scope:FAIL');
    expect(h.ran.filter((c) => c.args[0] === 'verify' && c.args[1] === 'show' && c.args[2] === '7')).toHaveLength(2);
  });

  it('wait --verify that hit another run: that run is waited out and this call verifies', () => {
    // #3883 N8: the wait no longer verifies; the verification it is followed by is the one that meets the other run.
    const h = harness({
      waitLog: 'Completed: wt-1 (basis=hook_stop)\n',
      verifySequence: [{ exit: 99, log: busy(7) }, { exit: 0, log: PASS_LOG }],
      runs: { '7': [{ status: 'passed' }] },
    });
    expect(main(argv(), h.deps)).toBe(0);
    expect(h.spawned.map((c) => c.args)).toEqual([
      ['wait', 'wt-1', '--instance', 'claude', '--on-prompt', 'human', '--timeout', '10800'],
      ['verify', 'wt-1', '--task', 't-1', '--instance', 'claude'],
      ['verify', 'wt-1', '--task', 't-1', '--instance', 'claude'],
    ]);
    expect(records()[0].note).toContain('waited-for=run 7');
    expect(h.autoYesCalls()).toHaveLength(1);
    // The turn end the wait saw is still named.
    expect(records()[0].note).toContain('basis=hook_stop');
  });

  it('a run that never ends: exit stays a non-verdict, recorded, Auto-Yes kept', () => {
    const h = harness({
      tasks: [t1],
      verifySequence: [{ exit: 99, log: busy(7) }],
      runs: { '7': [{ status: 'running' }] },
    });
    expect(main(argv(), h.deps)).toBe(99);
    expect(records()[0].note).toContain('waited-for=run 7(still running)');
    expect(h.autoYesCalls()).toEqual([]);
  });

  it('a newer task while waiting for the old run → exit 3, no second verification', () => {
    const h = harness({
      tasks: [t1],
      verifySequence: [{ exit: 99, log: busy(7) }],
      runs: { '7': [{ status: 'running' }] },
    });
    const fakeRun = h.deps.run;
    let shown = false;
    h.deps.run = (command: string, args: string[], opts?: { timeoutMs?: number }) => {
      if (args[0] === 'verify' && args[1] === 'show') shown = true;
      // Once the old run has been looked at, the task list shows a second contract.
      if (shown && args[0] === 'task' && args[1] === 'list') {
        return { status: 0, stdout: JSON.stringify([task('t-2', 30), t1]), stderr: '' };
      }
      return fakeRun(command, args, opts);
    };
    expect(main(argv(), h.deps)).toBe(3);
    expect(h.spawned.map((c) => c.args[0])).toEqual(['wait', 'verify']);
  });
});

describe('Auto-Yes that cannot be read back is unknown, not off (#3883 H-7)', () => {
  it('every read-back after --disable fails → auto-yes=unknown, asked again each time', () => {
    const h = harness({ captureJsonFails: 99 });
    expect(main(argv(), h.deps)).toBe(0);
    expect(h.autoYesCalls()).toHaveLength(3);
    expect(records()[0].note).toContain('auto-yes=unknown');
    expect(h.err.join('\n')).toMatch(/auto-yes for wt-1 \(claude\) is unknown/);
  });

  it('--auto-yes-off: a read-back that fails once is asked again, and off only once it reads', () => {
    const once = harness({ captureJsonFails: 1 });
    expect(main(['--auto-yes-off', '--wt', 'wt-1', '--instance', 'claude'], once.deps)).toBe(0);
    expect(once.autoYesCalls()).toHaveLength(2);
    const never = harness({ captureJsonFails: 99 });
    expect(main(['--auto-yes-off', '--wt', 'wt-1', '--instance', 'claude'], never.deps)).toBe(1);
    expect(never.out.join('\n')).toContain('auto-yes wt-1 (claude): unknown');
  });

  it('a capture that answers with something other than a state object is not off either', () => {
    const h = harness();
    const fakeRun = h.deps.run;
    h.deps.run = (command: string, args: string[], opts?: { timeoutMs?: number }) =>
      args[0] === 'capture' && args.includes('--json') ? { status: 0, stdout: 'null', stderr: '' } : fakeRun(command, args, opts);
    expect(main(['--auto-yes-off', '--wt', 'wt-1', '--instance', 'claude'], h.deps)).toBe(1);
  });
});

describe('a signal with no task to date it by (#3883, negative control)', () => {
  it('the ledger does not show the task: the pane line is taken as before, noted signal-task=unknown', () => {
    // The worker finished before this call started; nothing says which task the line is of.
    const h = harness({ pane: ['IMPL_COMPLETED'], lastStopMinute: -30 });
    const args = [...argv().map((a) => (a === 'claude' ? 'antigravity' : a)), '--signal-timeout', '60'];
    expect(main(args, h.deps)).toBe(0);
    expect(records()[0].note).toContain('signal=seen signal-task=unknown');
    expect(h.ran.some((c) => c.args[0] === 'reply' && !c.args.includes('9999-12-31T23:59:59Z'))).toBe(false);
  });
});

describe('every Antigravity instance waits for the signal, whatever its id (#3883, review-3883-d1 P2-2)', () => {
  const base = (instance: string, ...extra: string[]) =>
    [...argv().map((a) => (a === 'claude' ? instance : a)), '--signal-timeout', '60', ...extra];

  it('a second instance (antigravity-2): a mid-work turn end starts no verification', () => {
    const h = harness({ pane: ['working…'], resolvedTools: { 'antigravity-2': 'antigravity' } });
    expect(main(base('antigravity-2'), h.deps)).toBe(3);
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0].args).not.toContain('--verify');
    expect(h.autoYesCalls()).toEqual([]);
  });

  it('an alias of it: the tool the server resolved decides, not the name given', () => {
    const h = harness({ pane: ['working…'], resolved: { 'agy b': 'antigravity-2' }, resolvedTools: { 'agy b': 'antigravity' } });
    expect(main(base('agy b'), h.deps)).toBe(3);
    expect(h.spawned.map((c) => c.args)).toEqual([['wait', 'wt-1', '--instance', 'antigravity-2', '--on-prompt', 'human', '--timeout', '10800']]);
  });

  it('through the CLI (no injected resolver): the cliToolId of `reply --json` is read', () => {
    const h = harness({ pane: ['working…'], resolved: { 'agy b': 'antigravity-2' }, resolvedTools: { 'agy b': 'antigravity' } });
    const { resolveTarget: _injected, ...deps } = h.deps;
    expect(main(base('agy b'), deps)).toBe(3);
    expect(h.spawned.map((c) => c.args[0])).toEqual(['wait']);
  });

  it('a server that does not name the tool: an id of the form antigravity-<n> still needs the signal', () => {
    const h = harness({ pane: ['working…'] });
    expect(main(base('antigravity-2'), h.deps)).toBe(3);
    expect(h.spawned.map((c) => c.args[0])).toEqual(['wait']);
  });

  it('the signal seen: the second instance is verified (negative control)', () => {
    const h = harness({ pane: ['IMPL_COMPLETED'], resolvedTools: { 'antigravity-2': 'antigravity' } });
    expect(main(base('antigravity-2'), h.deps)).toBe(0);
    expect(h.spawned.map((c) => c.args[0])).toEqual(['wait', 'verify']);
  });

  it('another tool’s second instance (codex-2) does not wait for the signal (negative control)', () => {
    const h = harness({ pane: ['no signal'], resolvedTools: { 'codex-2': 'codex' } });
    expect(main(base('codex-2'), h.deps)).toBe(0);
    expect(h.spawned.map((c) => c.args[0])).toEqual(['wait', 'verify']);
    expect(h.ran.some((c) => c.args.includes('--pane'))).toBe(false);
  });
});

describe('the inputs of the execution are kept with the verdict (#3883 H-8)', () => {
  const t1 = task('t-1', -10);
  /** A worktree and a HOME of their own, with the files the manifest reads. */
  function env() {
    const wt = path.join(tmp, 'wt');
    const home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(wt, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.claude', 'settings.local.json'), '{"model":"opus[1m]"}');
    fs.writeFileSync(path.join(wt, 'package-lock.json'), '{"lockfileVersion":3}');
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{"model":"opus[1m]"}');
    return { wt, home };
  }
  /** Run main with `change` applied when the wait (`wait`) or the verification (`verify`) runs. */
  function go(h: ReturnType<typeof harness>, when: 'wait' | 'verify' | null, change: () => void) {
    const { wt, home } = env();
    const inner = h.deps.spawnToLog;
    h.deps.spawnToLog = (command: string, args: string[], opts: { logFile: string; watch?: () => boolean }) => {
      if (args[0] === when) change();
      return inner(command, args, opts);
    };
    return main(argv('--worktree', wt), { ...h.deps, home } as Parameters<typeof main>[1]);
  }
  const lockfile = () => fs.writeFileSync(path.join(tmp, 'wt', 'package-lock.json'), '{"lockfileVersion":3,"changed":true}');
  const globalModel = () => fs.writeFileSync(path.join(tmp, 'home', '.claude', 'settings.json'), '{"model":"fable"}');

  it('nothing changed: the verdict names its environment and the manifest is kept under the key (negative control)', () => {
    const h = harness({ tasks: [t1] });
    expect(go(h, null, () => {})).toBe(0);
    const note = records()[0].note as string;
    expect(note).toMatch(/ env=[0-9a-f]{12} auto-yes=off$/);
    expect(note).not.toContain('env-changed');
    const kept = JSON.parse(fs.readFileSync(path.join(runDir, 'wait-3477.env.json'), 'utf8'));
    expect(kept.key).toBe('3477:3477:t-1:a1');
    expect(kept.end.globalModel).toBe('opus[1m]');
    expect(kept.changed).toEqual({ duringTask: [], duringVerify: [] });
  });

  it('the lockfile changes during the verification → no verdict (exit 3), Auto-Yes kept', () => {
    const h = harness({ tasks: [t1] });
    expect(go(h, 'verify', lockfile)).toBe(3);
    expect(records()[0]).toMatchObject({ result: 'fail' });
    expect(records()[0].note).toMatch(/^unconfirmed: the inputs changed during the verification \(lockfile; see wait-3477\.env\.json\); exit=0\(passed\)/);
    expect(h.autoYesCalls()).toEqual([]);
  });

  it('the global default model changes during the verification → no verdict either', () => {
    const h = harness({ tasks: [t1] });
    expect(go(h, 'verify', globalModel)).toBe(3);
    expect(records()[0].note).toContain('(globalModel;');
  });

  it('a change while the worker worked is recorded with the verdict, which stands for the end environment', () => {
    const h = harness({ tasks: [t1] });
    expect(go(h, 'wait', lockfile)).toBe(0);
    expect(records()[0]).toMatchObject({ result: 'ok' });
    expect(records()[0].note).toMatch(/ env=[0-9a-f]{12} env-changed=lockfile auto-yes=off$/);
  });

  it('wait --verify (no split): a change is recorded, not judged — the moment of the verification is not known', () => {
    // #3883 N8: no call verifies inside `wait` any more, so the moment is known for every call: the manifest is
    // taken right before `verify` starts. A change while the worker worked is the work's (recorded, exit 0).
    const h = harness();
    expect(go(h, 'wait', globalModel)).toBe(0);
    expect(h.spawned[0].args).not.toContain('--verify');
    expect(records()[0].note).toContain('env-changed=globalModel');
    const kept = JSON.parse(fs.readFileSync(path.join(runDir, 'wait-3477.env.json'), 'utf8'));
    expect(kept.verify.globalModel).toBe('fable');
    expect(kept.changed).toEqual({ duringTask: ['globalModel'], duringVerify: [] });
  });

  it('a call that was not split before: a change as soon as the verification starts → no verdict (exit 3), Auto-Yes kept (#3883 N8)', () => {
    // The verification of `wait --verify` began right after its turn-end line; a manifest read off the log came
    // after that start. Now the manifest is taken before `verify` is started, so even a change at its first moment counts.
    const h = harness();
    expect(go(h, 'verify', globalModel)).toBe(3);
    expect(h.spawned.map((c) => c.args[0])).toEqual(['wait', 'verify']);
    expect(records()[0].note).toMatch(/^unconfirmed: the inputs changed during the verification \(globalModel; see wait-3477\.env\.json\)/);
    expect(h.autoYesCalls()).toEqual([]);
  });

  it('a call that was not split before, with a log that shows no turn end: a change during the work is the work’s (#3883 N8)', () => {
    const noTurnEnd = PASS_LOG.split('\n').filter((line) => !line.startsWith('Completed:')).join('\n');
    expect(go(harness({ waitLog: noTurnEnd }), 'wait', globalModel)).toBe(0);
    expect(records()[0].note).toContain('env-changed=globalModel');
    // The same change during the verification is still not a verdict (positive control).
    fs.rmSync(runDir, { recursive: true, force: true });
    expect(go(harness({ waitLog: noTurnEnd }), 'verify', globalModel)).toBe(3);
  });
});
