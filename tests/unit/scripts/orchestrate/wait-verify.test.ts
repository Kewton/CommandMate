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
const HEAD_B = 'b'.repeat(40);

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

/** Fakes for commandmatedev (wait / verify / auto-yes) and git. */
function harness({ waitExit = 0, waitLog = PASS_LOG, verifyExit = 0, verifyLog = PASS_LOG, autoYesExit = 0, head = HEAD_A } = {}) {
  const spawned: Call[] = [];
  const ran: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  let clock = Date.UTC(2026, 9, 9, 1, 0);
  const deps = {
    spawnToLog: (command: string, args: string[], { logFile }: { logFile: string }) => {
      spawned.push({ command, args });
      const isVerify = args[0] === 'verify';
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(logFile, isVerify ? verifyLog : waitLog);
      clock += 600_000; // the wait takes ten minutes
      return isVerify ? verifyExit : waitExit;
    },
    run: (command: string, args: string[]) => {
      ran.push({ command, args });
      if (command === 'git') return { status: 0, stdout: `${head}\n`, stderr: '' };
      return { status: autoYesExit, stdout: '', stderr: autoYesExit === 0 ? '' : 'server down' };
    },
    now: () => new Date(clock),
    log: (line: string) => out.push(line),
    error: (line: string) => err.push(line),
  };
  return { deps, spawned, ran, out, err };
}

const ARGS = ['--issues', '3477', '--issue', '3477', '--wt', 'wt-1', '--worktree', '/wt', '--instance', 'claude', '--model', 'opus', '--task', 't-1'];
const argv = (...extra: string[]) => ['--run-dir', runDir, ...ARGS, ...extra];

describe('summarizeVerdict', () => {
  it('folds the gate lines, RESULT and the completion basis into one line', () => {
    const v = summarizeVerdict(PASS_LOG, 0);
    expect(v.passed).toEqual(['work-evidence', 'scope', 'lint', 'typecheck', 'unit-related']);
    expect(v.failed).toEqual([]);
    expect(v.line).toBe('exit=0(passed) result=passed basis=hook_stop passed=work-evidence,scope,lint,typecheck,unit-related failed=-');
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
    expect(h.ran.filter((c) => c.command === 'commandmatedev').map((c) => c.args)).toEqual([
      ['auto-yes', 'wt-1', '--disable', '--instance', 'claude'],
    ]);
    expect(readRecords(runDir, '3477').records[0].note).toContain('auto-yes=off');
  });

  it.each([124, 10, 99])('exit %i (no verdict) leaves it on: the worker may still be working', (exit) => {
    const h = harness({ waitExit: exit, waitLog: '' });
    expect(main(argv(), h.deps)).toBe(exit);
    expect(h.ran.filter((c) => c.command === 'commandmatedev')).toEqual([]);
    expect(readRecords(runDir, '3477').records[0].note).toContain('auto-yes=kept');
  });

  it('warns and records it when the disable fails, and keeps the wait’s exit code', () => {
    const h = harness({ autoYesExit: 1 });
    expect(main(argv(), h.deps)).toBe(0);
    expect(h.err.join('\n')).toMatch(/auto-yes --disable failed for wt-1 \(claude\): server down/);
    expect(readRecords(runDir, '3477').records[0].note).toContain('auto-yes=NOT-disabled');
  });
});

describe('the run record', () => {
  it('writes the verify stage with the HEAD, task, agent, model and duration', () => {
    const h = harness();
    main(argv(), h.deps);
    const { records } = readRecords(runDir, '3477');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      issue: 3477,
      stage: 'verify',
      result: 'ok',
      head: HEAD_A,
      taskId: 't-1',
      agent: 'claude',
      model: 'opus',
      durationSec: 600,
    });
    expect(records[0].note).toContain('passed=work-evidence,scope,lint,typecheck,unit-related');
  });

  it('records a non-zero exit as fail, so status sends the run back to verify', () => {
    const h = harness({ waitExit: 20, waitLog: FAIL_LOG });
    main(argv(), h.deps);
    appendRecord(runDir, '3477', { issue: 3477, stage: 'send', result: 'ok', head: HEAD_A });
    const [item] = summarize(readRecords(runDir, '3477').records);
    expect(item.next).toBe('verify');
  });

  it('exits 1 when the HEAD cannot be read', () => {
    const h = harness();
    h.deps.run = () => ({ status: 128, stdout: '', stderr: 'not a git repository' });
    expect(main(argv(), h.deps)).toBe(1);
    expect(h.err.join('\n')).toMatch(/not a git repository/);
  });
});

describe('resuming: an ok verdict for the same HEAD is not waited for again', () => {
  it('reuses it without calling commandmatedev', () => {
    appendRecord(runDir, '3477', { issue: 3477, stage: 'verify', result: 'ok', head: HEAD_A });
    const h = harness();
    expect(main(argv(), h.deps)).toBe(0);
    expect(h.spawned).toEqual([]);
    expect(h.out.join('\n')).toMatch(/reused: ok at aaaaaaa/);
    expect(readRecords(runDir, '3477').records).toHaveLength(1);
  });

  it('waits again when the HEAD moved', () => {
    appendRecord(runDir, '3477', { issue: 3477, stage: 'verify', result: 'ok', head: HEAD_B });
    const h = harness();
    main(argv(), h.deps);
    expect(h.spawned).toHaveLength(1);
  });

  it('waits again after a fail on the same HEAD', () => {
    appendRecord(runDir, '3477', { issue: 3477, stage: 'verify', result: 'fail', head: HEAD_A });
    const h = harness();
    main(argv(), h.deps);
    expect(h.spawned).toHaveLength(1);
  });

  it('waits again with --force', () => {
    appendRecord(runDir, '3477', { issue: 3477, stage: 'verify', result: 'ok', head: HEAD_A });
    const h = harness();
    main(argv('--force'), h.deps);
    expect(h.spawned).toHaveLength(1);
  });
});
