/**
 * scripts/orchestrate/run-log.mjs `record-verify` — a verify the leader ran directly, recorded from
 * its run id: run, head and result, and `env=none` (Issue #4482; the human decision (a) of 11-20:
 * a direct run has no manifest from its start, so no env is claimed for it).
 *
 * The verify CLI and git are faked (`run`); the worktree, HOME and run directory are under
 * os.tmpdir() and removed after each test. Nothing external is called.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RECORD_VERIFY_EXIT,
  appendRecord,
  main,
  readRecords,
  recordVerifyRun,
} from '../../../../scripts/orchestrate/run-log.mjs';
import { manifestHash, takeManifest, verifyEnvState } from '../../../../scripts/orchestrate/env-manifest.mjs';
import { passedGates } from '../../../../scripts/orchestrate/precheck.mjs';
import { judgedByUnitRelated, ranFullUnit } from '../../../../scripts/orchestrate/merge-pr.mjs';
import { missingRecords } from '../../../../scripts/orchestrate/pr-common.mjs';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const WT = 'commandmate-issue-4482';
const STARTED = '2026-11-19T01:00:00.000Z';
const FINISHED = '2026-11-19T01:10:00.000Z';
const COMMITTED_BEFORE = '2026-11-19T00:50:00+00:00';
const COMMITTED_AFTER = '2026-11-19T01:05:00+00:00';
/** HEAD's last move (reflog, epoch seconds): before the run by default. */
const MOVED_BEFORE = String(Date.parse(COMMITTED_BEFORE) / 1000);
const MOVED_AFTER = String(Date.parse('2026-11-19T01:03:00Z') / 1000);
/** A time before the run, for the files the tests make. */
const OLD = new Date('2026-11-18T00:00:00Z');

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
  for (const file of [path.join(worktree, 'package-lock.json'), path.join(home, '.claude', 'settings.json')]) fs.utimesSync(file, OLD, OLD);
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

type FakeOptions = {
  shown?: unknown;
  head?: string;
  committedAt?: string;
  showStatus?: number;
  /** `git status --porcelain` output; null: git status fails. */
  porcelain?: string | null;
  /** HEAD's last reflog entry in epoch seconds (`git log -g -1 --date=unix --format=%gd HEAD` → `HEAD@{<n>}`); null: unreadable. */
  movedAt?: string | null;
  /** `ls --json` rows; null: ls fails. Default: `WT` at the test's worktree. */
  worktrees?: Array<{ id: string; path: string }> | null;
};

/**
 * A fake `run`: `verify show <id> --json` prints `shown`; `ls --json` lists `worktrees`; git answers
 * with `head`, `committedAt`, `porcelain` and `movedAt`.
 */
function fakeRun({
  shown = view() as unknown,
  head = HEAD_A,
  committedAt = COMMITTED_BEFORE,
  showStatus = 0,
  porcelain = '',
  movedAt = MOVED_BEFORE,
  worktrees,
}: FakeOptions = {}) {
  const calls: string[][] = [];
  const run = (command: string, args: string[]) => {
    calls.push([command, ...args]);
    const fail = { status: 128, stdout: '', stderr: 'fatal: nope' };
    if (command === 'git' && args.includes('rev-parse')) return { status: 0, stdout: `${head}\n`, stderr: '' };
    if (command === 'git' && args.includes('status')) return porcelain === null ? fail : { status: 0, stdout: porcelain, stderr: '' };
    if (command === 'git' && args.includes('-g')) return movedAt === null ? fail : { status: 0, stdout: movedAt === '' ? '' : `HEAD@{${movedAt}}\n`, stderr: '' };
    if (command === 'git' && args.includes('log')) return { status: 0, stdout: `${committedAt}\n`, stderr: '' };
    if (args[0] === 'ls' && args.includes('--json')) {
      const rows = worktrees === undefined ? [{ id: WT, path: worktree }] : worktrees;
      return rows === null ? { status: 1, stdout: '', stderr: 'server down' } : { status: 0, stdout: JSON.stringify(rows), stderr: '' };
    }
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

function record(options: Record<string, unknown> = {}, runOptions: FakeOptions = {}) {
  const { run } = fakeRun(runOptions);
  return recordVerifyRun(
    { runDir, issues: '4482', issue: '4482', wt: WT, worktree, runId: '812', cli: 'commandmatedev', ...options },
    { run, now: NOW }
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
  ])('$name → verify=$result with run, status, gates, key and env=none', ({ shown, result, gates }) => {
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
    expect(line.note).toMatch(/(?:^|\s)env=none(?:\s|$)/);
    expect(line.note).not.toContain('env-at=');
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

  it('writes env=none and no manifest file, with the environment unchanged since the run', () => {
    const out = record();
    expect(out.exit).toBe(RECORD_VERIFY_EXIT.recorded);
    const line = readRecords(runDir, '4482').records[0];
    expect(line.note).not.toContain(`env=${manifestHash(takeManifest({ worktree, home }))}`);
    expect((out as { envFile?: string }).envFile).toBeUndefined();
    expect(fs.readdirSync(runDir).filter((name) => name.endsWith('.env.json'))).toEqual([]);
  });

  it('writes env=none even when the run itself says nothing (no instance, no task, no finish)', () => {
    const out = record({}, { shown: view({ instanceId: null, taskId: null, finishedAt: null }) });
    expect(out.exit).toBe(RECORD_VERIFY_EXIT.recorded);
    const line = readRecords(runDir, '4482').records[0];
    expect(line).toMatchObject({ taskId: null, agent: null, durationSec: null, key: '4482:4482:-:run812' });
    expect(line.note).toMatch(/(?:^|\s)env=none(?:\s|$)/);
  });

  it('passes --item into the record and the key', () => {
    record({ item: 'd1' });
    const line = readRecords(runDir, '4482').records[0];
    expect(line).toMatchObject({ item: 'd1', key: '4482:4482-d1:task-1:run812' });
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
    // #4482 review 1 (P1-1, P2-1, P2-3, P3-2, P3-3): the HEAD is written only when it is the tree the run verified.
    { name: 'an answer that is not a run ({ error })', runOptions: { shown: { error: 'boom' } }, options: {}, exit: 'unreadable', reason: /812/ },
    { name: 'an answer that is not a run ({})', runOptions: { shown: {} }, options: {}, exit: 'unreadable', reason: /812/ },
    { name: 'a run without startedAt', runOptions: { shown: view({ startedAt: undefined }) }, options: {}, exit: 'refused', reason: /start/ },
    { name: 'a run whose startedAt does not parse', runOptions: { shown: view({ startedAt: 'yesterday' }) }, options: {}, exit: 'refused', reason: /start/ },
    { name: 'uncommitted changes in the worktree', runOptions: { porcelain: ' M src/a.ts\n?? new.txt\n' }, options: {}, exit: 'refused', reason: /uncommitted.*src\/a\.ts/ },
    { name: 'a worktree whose status cannot be read', runOptions: { porcelain: null }, options: {}, exit: 'refused', reason: /status/ },
    { name: 'HEAD moved (reset / checkout to an older commit) after the run started', runOptions: { movedAt: MOVED_AFTER }, options: {}, exit: 'refused', reason: /moved after the run started/ },
    { name: 'HEAD moved within the second the run started', runOptions: { movedAt: String(Date.parse(STARTED) / 1000) }, options: {}, exit: 'refused', reason: /moved after the run started/ },
    { name: 'a HEAD reflog that cannot be read', runOptions: { movedAt: null }, options: {}, exit: 'refused', reason: /reflog/ },
    { name: 'a HEAD reflog that is empty', runOptions: { movedAt: '' }, options: {}, exit: 'refused', reason: /reflog/ },
    { name: '--worktree that is not --wt’s path', runOptions: { worktrees: [{ id: WT, path: '/elsewhere/commandmate-issue-4463' }] }, options: {}, exit: 'refused', reason: /elsewhere/ },
    { name: '--wt that the CLI does not list', runOptions: { worktrees: [{ id: 'other', path: '/x' }] }, options: {}, exit: 'refused', reason: /not listed/ },
    { name: 'a worktree list that cannot be read', runOptions: { worktrees: null }, options: {}, exit: 'refused', reason: /ls --json/ },
  ])('$name', ({ runOptions, options, exit, reason }) => {
    const out = record(options, runOptions as FakeOptions);
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

describe('record-verify: env=none is never read as the run’s environment (#4482 decision (a))', () => {
  const where = () => ({ runDir, worktree, home });
  const direct = () => {
    expect(record().exit).toBe(RECORD_VERIFY_EXIT.recorded);
    return readRecords(runDir, '4482').records[0];
  };

  it('does not date the env inputs: a change after the run is not a refusal (no env is claimed)', () => {
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{"model":"sonnet"}\n');
    expect(direct().note).toMatch(/(?:^|\s)env=none(?:\s|$)/);
  });

  it('verifyEnvState does not read env=none as `same` (nor as `changed` / `missing` against a manifest)', () => {
    const state = verifyEnvState(direct(), where());
    expect(state.state).not.toBe('same');
    expect(state.state).toBe('unrecorded');
    expect(state.detail).toMatch(/env=none/);
  });

  it('precheck reuses none of its gates, and merge-pr waits for CI’s Unit Tests', () => {
    const line = direct();
    expect(line.result).toBe('ok');
    expect(passedGates(line)).toEqual([]);
    expect(ranFullUnit(line)).toBe(false);
    expect(judgedByUnitRelated(line)).toBe(false);
  });

  it('publish / merge take it as the verify of the HEAD, with a warning that names env=none', () => {
    const records = [direct()];
    const warnings: string[] = [];
    const missing = missingRecords(records, 4482, { head: HEAD_A, workHead: HEAD_A }, null, { ...where(), warn: (line: string) => warnings.push(line) });
    expect(missing.filter((reason: string | null) => String(reason).startsWith('verify'))).toEqual([]);
    expect(warnings.join('\n')).toMatch(/env=none/);
  });

  it('a wait-verify line (env=<hash> with its manifest) is still read as `same` (I1)', () => {
    const hash = manifestHash(takeManifest({ worktree, home }));
    const key = '4482:4482:task-1:a1';
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'wait-4482.log.env.json'), JSON.stringify({ key, end: takeManifest({ worktree, home }) }));
    const line = { note: `exit=0(passed) passed=lint run=1 key=${key} env=${hash}`, key };
    expect(verifyEnvState(line, where()).state).toBe('same');
  });
});

describe('record-verify: --task is not a fact of the run (#4482 review 1 P3-1)', () => {
  it('does not write --task when the run has no task', () => {
    const out = record({ taskId: 'task-9' }, { shown: view({ taskId: null }) });
    expect(out.exit).toBe(RECORD_VERIFY_EXIT.recorded);
    expect(out.record).toMatchObject({ taskId: null, key: '4482:4482:-:run812' });
    expect(out.record?.note).not.toContain('task-9');
  });

  it('writes the run’s task when --task agrees', () => {
    expect(record({ taskId: 'task-1' }).record).toMatchObject({ taskId: 'task-1' });
  });
});

describe('record-verify writes no env file (#4482 decision (a))', () => {
  it('leaves no .env.json when the record cannot be appended either', () => {
    fs.mkdirSync(runDir, { recursive: true });
    const file = path.join(runDir, 'run-4482.jsonl');
    fs.writeFileSync(file, '');
    fs.chmodSync(file, 0o444);
    expect(() => record()).toThrow();
    fs.chmodSync(file, 0o644);
    expect(fs.readdirSync(runDir).filter((name) => name.endsWith('.env.json'))).toEqual([]);
  });
});

describe('record-verify against a real git worktree (#4482 review 1 P1-1)', () => {
  const OLD_DATE = '2020-01-01T00:00:00+00:00';
  const RUN_START = '2026-11-18T12:00:00.000Z'; // after the commits, before now
  const git = (args: string[], env: Record<string, string> = {}) => {
    const out = spawnSync('git', ['-C', worktree, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    if (out.status !== 0) throw new Error(out.stderr);
    return out.stdout.trim();
  };
  /** Real git; `verify show` and `ls` faked. */
  const hybrid = (shown: unknown) => (command: string, args: string[], opts?: { cwd?: string }) => {
    if (command === 'git') {
      const out = spawnSync('git', args, { cwd: opts?.cwd, encoding: 'utf8' });
      return { status: out.status ?? 1, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
    }
    if (args[0] === 'ls') return { status: 0, stdout: JSON.stringify([{ id: WT, path: worktree }]), stderr: '' };
    return { status: 0, stdout: JSON.stringify(shown), stderr: '' };
  };
  let older: string;
  let newer: string;
  beforeEach(() => {
    const dated = { GIT_AUTHOR_DATE: OLD_DATE, GIT_COMMITTER_DATE: OLD_DATE };
    git(['init', '-q']);
    fs.writeFileSync(path.join(worktree, '.gitignore'), 'package-lock.json\n');
    fs.writeFileSync(path.join(worktree, 'f'), '1\n');
    git(['add', '.'], dated);
    git(['commit', '-q', '-m', 'a'], dated);
    older = git(['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(worktree, 'f'), '2\n');
    git(['commit', '-q', '-am', 'b'], dated);
    newer = git(['rev-parse', 'HEAD']);
  });
  const recordReal = () =>
    recordVerifyRun(
      { runDir, issues: '4482', issue: '4482', wt: WT, worktree, runId: '812' },
      { run: hybrid(view({ startedAt: RUN_START })), now: NOW }
    );

  it('records the HEAD the run saw (committed and moved to before the run, clean tree)', () => {
    const out = recordReal();
    expect(out.exit).toBe(RECORD_VERIFY_EXIT.recorded);
    expect(out.record?.head).toBe(newer);
  });

  it('refuses after HEAD was reset to an older commit (committed before the run, moved after it)', () => {
    git(['reset', '-q', '--hard', older]);
    const out = recordReal();
    expect(out.exit).toBe(RECORD_VERIFY_EXIT.refused);
    expect(out.reason).toMatch(/moved after the run started/);
    expect(readRecords(runDir, '4482').records).toHaveLength(0);
  });

  it('refuses with uncommitted changes', () => {
    fs.writeFileSync(path.join(worktree, 'f'), '3\n');
    const out = recordReal();
    expect(out.exit).toBe(RECORD_VERIFY_EXIT.refused);
    expect(out.reason).toMatch(/uncommitted/);
  });

  it('refuses when the reflog is gone', () => {
    fs.rmSync(path.join(worktree, '.git', 'logs'), { recursive: true, force: true });
    const out = recordReal();
    expect(out.exit).toBe(RECORD_VERIFY_EXIT.refused);
    expect(out.reason).toMatch(/reflog/);
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
