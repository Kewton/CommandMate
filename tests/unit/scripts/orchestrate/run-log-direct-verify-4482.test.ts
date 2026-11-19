/**
 * scripts/orchestrate/run-log.mjs `record-verify` — a verify the leader ran directly, recorded from
 * its run id with the environment (Issue #4482).
 *
 * The verify CLI and git are faked (`run`); the worktree, HOME and run directory are under
 * os.tmpdir() and removed after each test. Nothing external is called.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RECORD_VERIFY_EXIT,
  appendRecord,
  main,
  readRecords,
  recordVerifyRun,
} from '../../../../scripts/orchestrate/run-log.mjs';
import { keptManifest, manifestHash, takeManifest, verifyEnvState } from '../../../../scripts/orchestrate/env-manifest.mjs';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const WT = 'commandmate-issue-4482';
const STARTED = '2026-11-19T01:00:00.000Z';
const FINISHED = '2026-11-19T01:10:00.000Z';
const COMMITTED_BEFORE = '2026-11-19T00:50:00+00:00';
const COMMITTED_AFTER = '2026-11-19T01:05:00+00:00';

let base: string;
let runDir: string;
let worktree: string;
let home: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-runlog-direct-verify-'));
  runDir = path.join(base, 'runs', '2026-11-19');
  worktree = path.join(base, 'wt');
  home = path.join(base, 'home');
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'package-lock.json'), '{"lockfileVersion":3}\n');
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{"model":"opus"}\n');
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

type Gate = { gateId: string; status: string; durationMs?: number; logTail?: string | null };
const gate = (gateId: string, status: string): Gate => ({ gateId, status, durationMs: 1000, logTail: '' });

function view(overrides: Record<string, unknown> = {}) {
  return {
    id: 812,
    worktreeId: WT,
    instanceId: 'claude',
    taskId: 'task-1',
    trigger: 'cli',
    status: 'passed',
    baseRef: 'origin/develop',
    startedAt: STARTED,
    finishedAt: FINISHED,
    gates: [gate('lint', 'passed'), gate('typecheck', 'passed'), gate('unit', 'passed')],
    ...overrides,
  };
}

/** A fake `run`: `verify show <id> --json` prints `shown`; git answers with `head` and `committedAt`. */
function fakeRun({
  shown = view() as unknown,
  head = HEAD_A,
  committedAt = COMMITTED_BEFORE,
  showStatus = 0,
}: { shown?: unknown; head?: string; committedAt?: string; showStatus?: number } = {}) {
  const calls: string[][] = [];
  const run = (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (command === 'git' && args.includes('rev-parse')) return { status: 0, stdout: `${head}\n`, stderr: '' };
    if (command === 'git' && args.includes('log')) return { status: 0, stdout: `${committedAt}\n`, stderr: '' };
    if (args[0] === 'verify' && args[1] === 'show') {
      return showStatus === 0
        ? { status: 0, stdout: JSON.stringify(shown), stderr: '' }
        : { status: showStatus, stdout: '', stderr: 'Verification run not found.' };
    }
    return { status: 1, stdout: '', stderr: `unexpected ${command} ${args.join(' ')}` };
  };
  return { run, calls };
}

const NOW = new Date('2026-11-19T01:20:00.000Z');

function record(options: Record<string, unknown> = {}, runOptions: Parameters<typeof fakeRun>[0] = {}) {
  const { run } = fakeRun(runOptions);
  return recordVerifyRun(
    { runDir, issues: '4482', issue: '4482', wt: WT, worktree, runId: '812', cli: 'commandmatedev', ...options },
    { run, home, now: NOW }
  );
}

describe('record-verify: what the record says (#4482)', () => {
  it.each([
    {
      name: 'passed',
      shown: view(),
      result: 'ok',
      gates: 'lint:ok,typecheck:ok,unit:ok',
    },
    {
      name: 'failed',
      shown: view({ status: 'failed', gates: [gate('lint', 'passed'), gate('unit', 'failed')] }),
      result: 'fail',
      gates: 'lint:ok,unit:fail',
    },
    {
      name: 'error',
      shown: view({ status: 'error', gates: [gate('lint', 'error')] }),
      result: 'fail',
      gates: 'lint:fail',
    },
    {
      name: 'cancelled with a SKIP',
      shown: view({ status: 'cancelled', gates: [gate('lint', 'passed'), gate('unit', 'skipped')] }),
      result: 'fail',
      gates: 'lint:ok,unit:skip',
    },
    {
      name: 'a timeout gate',
      shown: view({ status: 'failed', gates: [gate('unit', 'timeout')] }),
      result: 'fail',
      gates: 'unit:fail',
    },
    {
      // `verify show --json` of an older CLI wrapped the run as `{ run }` (wait-verify reads both).
      name: 'passed, wrapped in { run }',
      shown: { run: view() },
      result: 'ok',
      gates: 'lint:ok,typecheck:ok,unit:ok',
    },
  ])('$name → verify=$result with run, status, gates, key and env', ({ shown, result, gates }) => {
    const out = record({}, { shown });
    expect(out.exit).toBe(RECORD_VERIFY_EXIT.recorded);
    const { records } = readRecords(runDir, '4482');
    expect(records).toHaveLength(1);
    const line = records[0];
    expect(line).toMatchObject({ issue: 4482, stage: 'verify', result, head: HEAD_A, taskId: 'task-1', agent: 'claude', durationSec: 600 });
    const status = (shown as { status?: string; run?: { status: string } }).status ?? (shown as { run: { status: string } }).run.status;
    expect(line.note).toContain('direct=verify');
    expect(line.note).toContain('run=812');
    expect(line.note).toContain(`run-status=${status}`);
    expect(line.note).toContain(`gates=${gates}`);
    expect(line.note).toContain('env-at=record');
    expect(line.note).toMatch(/(?:^|\s)env=[0-9a-f]{12}(?:\s|$)/);
    expect(line.note).toContain(`key=${line.key}`);
    expect(line.key).toBe('4482:4482:task-1:run812');
  });

  it('never writes ok for a run that did not pass (failed / error / cancelled / not_started)', () => {
    for (const status of ['failed', 'error', 'cancelled', 'not_started']) {
      const out = record({ runId: '812' }, { shown: view({ status, id: 812 }) });
      expect(out.exit).toBe(RECORD_VERIFY_EXIT.recorded);
      expect(out.record?.result).toBe('fail');
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('keeps the env manifest so precheck / publish compare it the same way (verifyEnvState is `same`)', () => {
    const out = record();
    const line = readRecords(runDir, '4482').records[0];
    const hash = manifestHash(takeManifest({ worktree, home }));
    expect(line.note).toContain(`env=${hash}`);
    expect(out.envFile && fs.existsSync(out.envFile)).toBe(true);
    expect(keptManifest(runDir, line.key, hash)).not.toBeNull();
    expect(verifyEnvState(line, { runDir, worktree, home }).state).toBe('same');
    // The environment as it is when recorded: a change after it reads as `changed`, not as the run's.
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{"model":"sonnet"}\n');
    expect(verifyEnvState(line, { runDir, worktree, home }).state).toBe('changed');
  });

  it('records the env even when the run itself says nothing of it (no instance, no task, no finish)', () => {
    const out = record({}, { shown: view({ instanceId: null, taskId: null, finishedAt: null }) });
    expect(out.exit).toBe(RECORD_VERIFY_EXIT.recorded);
    const line = readRecords(runDir, '4482').records[0];
    expect(line).toMatchObject({ taskId: null, agent: null, durationSec: null, key: '4482:4482:-:run812' });
    expect(line.note).toMatch(/(?:^|\s)env=[0-9a-f]{12}(?:\s|$)/);
  });

  it('passes --item into the record, the key and the env file name', () => {
    const out = record({ item: 'd1' });
    const line = readRecords(runDir, '4482').records[0];
    expect(line).toMatchObject({ item: 'd1', key: '4482:4482-d1:task-1:run812' });
    expect(path.basename(out.envFile ?? '')).toBe('verify-4482-d1.run812.env.json');
  });
});

describe('record-verify: what it refuses, writing nothing (#4482 I2 / I3)', () => {
  it.each([
    { name: 'a running run', runOptions: { shown: view({ status: 'running', finishedAt: null }) }, options: {}, exit: 'notFinished', reason: /running/ },
    { name: 'a queued run', runOptions: { shown: view({ status: 'queued', finishedAt: null }) }, options: {}, exit: 'notFinished', reason: /queued/ },
    { name: 'a run without a status', runOptions: { shown: view({ status: undefined }) }, options: {}, exit: 'notFinished', reason: /status/ },
    { name: 'a run of another worktree', runOptions: { shown: view({ worktreeId: 'commandmate-issue-4463' }) }, options: {}, exit: 'refused', reason: /commandmate-issue-4463/ },
    { name: 'a run without a worktree', runOptions: { shown: view({ worktreeId: undefined }) }, options: {}, exit: 'refused', reason: /worktree/ },
    { name: 'a run whose id is not the one asked', runOptions: { shown: view({ id: 813 }) }, options: {}, exit: 'refused', reason: /813/ },
    { name: 'a HEAD committed after the run started', runOptions: { committedAt: COMMITTED_AFTER }, options: {}, exit: 'refused', reason: /after the run started/ },
    { name: '--head that is not the worktree HEAD', runOptions: {}, options: { head: HEAD_B }, exit: 'refused', reason: /bbbbbbb/ },
    { name: '--task that is not the run’s task', runOptions: {}, options: { taskId: 'task-2' }, exit: 'refused', reason: /task-2/ },
    { name: 'a run that cannot be read', runOptions: { showStatus: 4 }, options: {}, exit: 'unreadable', reason: /812/ },
    { name: 'a run that is not JSON', runOptions: { shown: 'not json' }, options: {}, exit: 'unreadable', reason: /812/ },
  ])('$name', ({ runOptions, options, exit, reason }) => {
    const out = record(options, runOptions as Parameters<typeof fakeRun>[0]);
    expect(out.exit).toBe(RECORD_VERIFY_EXIT[exit as keyof typeof RECORD_VERIFY_EXIT]);
    expect(out.reason).toMatch(reason);
    expect(readRecords(runDir, '4482').records).toHaveLength(0);
    // No env file is left behind for a record that was not written.
    expect(fs.existsSync(runDir) ? fs.readdirSync(runDir).filter((name) => name.endsWith('.env.json')) : []).toEqual([]);
  });

  it('refuses a run already recorded for the work item (by wait-verify or by an earlier record-verify)', () => {
    appendRecord(runDir, '4482', { issue: 4482, stage: 'verify', result: 'ok', head: HEAD_A, note: 'exit=0(passed) run=812 key=4482:4482:task-1:a1 env=0123456789ab' });
    const out = record();
    expect(out.exit).toBe(RECORD_VERIFY_EXIT.refused);
    expect(out.reason).toMatch(/already recorded/);
    expect(readRecords(runDir, '4482').records).toHaveLength(1);
  });

  it('records the same run id for another work item (the run ids are the worktree’s, the record is per item)', () => {
    appendRecord(runDir, '4482', { issue: 4482, stage: 'verify', result: 'ok', head: HEAD_A, item: 'd1', note: 'run=812' });
    expect(record().exit).toBe(RECORD_VERIFY_EXIT.recorded);
  });
});

describe('record-verify on the command line (#4482)', () => {
  const argv = (extra: string[] = []) => [
    'record-verify', '--run-dir', runDir, '--issues', '4482', '--issue', '4482', '--run', '812', '--wt', WT, '--worktree', worktree, ...extra,
  ];

  it('exits 0 and prints the record', () => {
    const { run, calls } = fakeRun();
    const lines: string[] = [];
    expect(main(argv(), NOW, { run, home, out: (line: string) => lines.push(line), error: (line: string) => lines.push(line) })).toBe(0);
    expect(lines.join('\n')).toMatch(/recorded #4482 verify=ok .*run=812/);
    expect(calls).toContainEqual(['commandmatedev', 'verify', 'show', '812', '--json']);
  });

  it('asks the CLI given by --cli', () => {
    const { run, calls } = fakeRun();
    expect(main(argv(['--cli', 'commandmate']), NOW, { run, home, out: () => {}, error: () => {} })).toBe(0);
    expect(calls).toContainEqual(['commandmate', 'verify', 'show', '812', '--json']);
  });

  it('exits 3 for a running run and 4 for another worktree’s run, saying why on stderr', () => {
    const errors: string[] = [];
    const running = fakeRun({ shown: view({ status: 'running' }) }).run;
    expect(main(argv(), NOW, { run: running, home, out: () => {}, error: (line: string) => errors.push(line) })).toBe(3);
    const other = fakeRun({ shown: view({ worktreeId: 'x' }) }).run;
    expect(main(argv(), NOW, { run: other, home, out: () => {}, error: (line: string) => errors.push(line) })).toBe(4);
    expect(errors.join('\n')).toMatch(/running/);
    expect(errors.join('\n')).toMatch(/worktree x/);
    expect(readRecords(runDir, '4482').records).toHaveLength(0);
  });

  it.each([
    ['--run missing', ['record-verify', '--run-dir', 'R', '--issues', '4482', '--issue', '4482', '--wt', WT, '--worktree', 'W']],
    ['--run not a number', ['record-verify', '--run-dir', 'R', '--issues', '4482', '--issue', '4482', '--run', 'x', '--wt', WT, '--worktree', 'W']],
    ['--wt missing', ['record-verify', '--run-dir', 'R', '--issues', '4482', '--issue', '4482', '--run', '1', '--worktree', 'W']],
    ['--worktree missing', ['record-verify', '--run-dir', 'R', '--issues', '4482', '--issue', '4482', '--run', '1', '--wt', WT]],
    ['--head short', ['record-verify', '--run-dir', 'R', '--issues', '4482', '--issue', '4482', '--run', '1', '--wt', WT, '--worktree', 'W', '--head', 'abc1234']],
  ])('exits 2 on %s', (_name, args) => {
    const { run, calls } = fakeRun();
    expect(main(args, NOW, { run, home, out: () => {}, error: () => {} })).toBe(2);
    expect(calls).toEqual([]);
  });
});

describe('record-verify leaves append / status as they were (#4482 I1)', () => {
  it('append still takes the same flags and writes the same shape', () => {
    expect(main(['append', '--run-dir', runDir, '--issues', '4482', '--issue', '4482', '--stage', 'verify', '--result', 'ok', '--head', HEAD_A, '--note', 'run=1'], NOW)).toBe(0);
    const line = readRecords(runDir, '4482').records[0];
    expect(Object.keys(line)).toEqual(['issue', 'stage', 'result', 'head', 'taskId', 'contract', 'agent', 'model', 'durationSec', 'note', 'at']);
  });

  it('append does not take record-verify’s flags', () => {
    expect(main(['append', '--run-dir', runDir, '--issues', '4482', '--issue', '4482', '--stage', 'send', '--result', 'ok', '--run', '1'], NOW)).toBe(2);
  });
});
