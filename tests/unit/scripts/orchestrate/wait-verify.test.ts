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
import { main, parseArgs, summarizeVerdict } from '../../../../scripts/orchestrate/wait-verify.mjs';

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

type Call = { command: string; args: string[] };

const T0 = Date.UTC(2026, 9, 9, 1, 0);
const iso = (minute: number) => new Date(T0 + minute * 60_000).toISOString();

/**
 * Fakes for commandmatedev (wait / verify / capture / verify history / auto-yes) and git.
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
} = {}) {
  const spawned: Call[] = [];
  const ran: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const sleeps: number[] = [];
  let clock = T0;
  let commitAt = commitMinute;
  let paneIndex = 0;
  const deps = {
    spawnToLog: (command: string, args: string[], { logFile }: { logFile: string }) => {
      spawned.push({ command, args });
      const isVerify = args[0] === 'verify';
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(logFile, isVerify ? verifyLog : waitLog);
      clock += 600_000; // each run takes ten minutes
      if (isVerify && commitDuringReverify) commitAt = (clock - T0) / 60_000 + 1;
      return isVerify ? verifyExit : waitExit;
    },
    run: (command: string, args: string[]) => {
      ran.push({ command, args });
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
        return ok(
          JSON.stringify({
            lastStopEventAt: lastStopMinute === null ? null : T0 + lastStopMinute * 60_000,
            autoYes: { enabled: autoYesStuck },
          })
        );
      }
      if (args[0] === 'verify' && args[1] === 'history') {
        return ok(JSON.stringify(runStartMinute === null ? [] : [{ id: 1, startedAt: iso(runStartMinute) }]));
      }
      throw new Error(`unexpected ${command} ${args.join(' ')}`);
    },
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
    expect(h.spawned).toEqual([
      {
        command: 'commandmatedev',
        args: ['wait', 'wt-1', '--instance', 'claude', '--on-prompt', 'human', '--verify', '--timeout', '10800'],
      },
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
      ['verify', 'wt-1', '--task', 't-1'],
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
      durationSec: 600,
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

describe('a passed verdict is never reused (#3477 review 1)', () => {
  it('waits and verifies again even with an ok record for the same HEAD', () => {
    appendRecord(runDir, '3477', { issue: 3477, stage: 'verify', result: 'ok', head: HEAD_A, taskId: 't-0' });
    const h = harness();
    expect(main(argv(), h.deps)).toBe(0);
    expect(h.spawned).toHaveLength(1);
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
    expect(h.spawned.map((c) => c.args[0])).toEqual(['wait', 'verify']);
    expect(h.spawned[1].args).toEqual(['verify', 'wt-1', '--task', 't-1']);
    expect(records()[0]).toMatchObject({ result: 'fail', head: HEAD_A });
    expect(records()[0].note).toContain('reverified=verify --task');
    expect(records()[0].note).toContain('failed=scope:FAIL');
    expect(h.autoYesCalls()).toHaveLength(1);
  });

  it('started before the last turn end with changes since → re-verify', () => {
    const h = harness({ lastStopMinute: 8, status: ' M src/a.ts\n' });
    main(argv(), h.deps);
    expect(h.spawned.map((c) => c.args[0])).toEqual(['wait', 'verify']);
  });

  it('started before the last turn end, nothing changed since → the verdict stands (3-3)', () => {
    const h = harness({ lastStopMinute: 8 });
    expect(main(argv(), h.deps)).toBe(0);
    expect(h.spawned).toHaveLength(1);
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
