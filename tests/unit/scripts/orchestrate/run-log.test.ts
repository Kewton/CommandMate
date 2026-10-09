/**
 * scripts/orchestrate/run-log.mjs — the resumable /orchestrate run record (Issue #3477).
 *
 * Every file here is under os.tmpdir(); the script calls nothing external.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  STAGES,
  appendRecord,
  findLatest,
  makeRecord,
  readRecords,
  runLogPath,
  summarize,
} from '../../../../scripts/orchestrate/run-log.mjs';

const SCRIPT = path.resolve(__dirname, '../../../../scripts/orchestrate/run-log.mjs');
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

let runDir: string;
beforeEach(() => {
  runDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-orchestrate-runlog-')), '2026-10-09');
});
afterEach(() => {
  fs.rmSync(path.dirname(runDir), { recursive: true, force: true });
});

const at = (minute: number) => new Date(Date.UTC(2026, 9, 9, 0, minute));

describe('runLogPath', () => {
  it('names the file after the run’s Issue range', () => {
    expect(runLogPath('/r', '3477-3481')).toBe(path.join('/r', 'run-3477-3481.jsonl'));
    expect(runLogPath('/r', '3477,3480')).toBe(path.join('/r', 'run-3477,3480.jsonl'));
  });

  it.each(['', '../x', '3477/..', 'all'])('rejects %j', (issues) => {
    expect(() => runLogPath('/r', issues)).toThrow(/--issues/);
  });
});

describe('makeRecord', () => {
  it('gives every record the same keys', () => {
    const record = makeRecord({ issue: '3477', stage: 'send', result: 'ok' }, at(0));
    expect(record).toEqual({
      issue: 3477,
      stage: 'send',
      result: 'ok',
      head: null,
      taskId: null,
      contract: null,
      agent: null,
      model: null,
      durationSec: null,
      note: null,
      at: '2026-10-09T00:00:00.000Z',
    });
  });

  it.each([
    [{ issue: 1, stage: 'deploy', result: 'ok' }, /stage/],
    [{ issue: 1, stage: 'send', result: 'done' }, /result/],
    [{ issue: 0, stage: 'send', result: 'ok' }, /issue/],
    [{ issue: 1, stage: 'send', result: 'ok', head: 'HEAD' }, /head/],
    [{ issue: 1, stage: 'send', result: 'ok', durationSec: '-1' }, /duration/],
  ])('rejects %j', (input, message) => {
    expect(() => makeRecord(input)).toThrow(message);
  });
});

describe('append and read back', () => {
  it('appends one JSON line per call and reads them back in order', () => {
    appendRecord(runDir, '3477', { issue: 3477, stage: 'send', result: 'ok', head: HEAD_A, taskId: 't-1' }, at(0));
    appendRecord(runDir, '3477', { issue: 3477, stage: 'verify', result: 'ok', head: HEAD_B, durationSec: '600' }, at(10));
    const text = fs.readFileSync(path.join(runDir, 'run-3477.jsonl'), 'utf8');
    expect(text.split('\n')).toHaveLength(3); // two lines + the trailing newline
    const { records, skipped } = readRecords(runDir, '3477');
    expect(skipped).toEqual([]);
    expect(records.map((r: { stage: string }) => r.stage)).toEqual(['send', 'verify']);
    expect(records[1]).toMatchObject({ head: HEAD_B, durationSec: 600 });
  });

  it('does not touch another run’s file in the same directory', () => {
    fs.mkdirSync(runDir, { recursive: true });
    const other = path.join(runDir, 'run-3400-3405.jsonl');
    fs.writeFileSync(other, 'other run\n');
    appendRecord(runDir, '3477', { issue: 3477, stage: 'send', result: 'ok' });
    expect(fs.readFileSync(other, 'utf8')).toBe('other run\n');
  });

  it('survives a line torn by a crash: the next append starts on a new line', () => {
    appendRecord(runDir, '3477', { issue: 3477, stage: 'send', result: 'ok' }, at(0));
    fs.appendFileSync(path.join(runDir, 'run-3477.jsonl'), '{"issue":3477,"stage":"ver');
    appendRecord(runDir, '3477', { issue: 3477, stage: 'verify', result: 'ok' }, at(5));
    const { records, skipped } = readRecords(runDir, '3477');
    expect(records.map((r: { stage: string }) => r.stage)).toEqual(['send', 'verify']);
    expect(skipped).toEqual([2]);
  });

  it('reads a run that has not started as empty', () => {
    expect(readRecords(runDir, '3477')).toMatchObject({ records: [], skipped: [] });
  });
});

describe('summarize: where to resume', () => {
  function record(issue: number, stage: string, result: string, minute: number, head?: string) {
    return makeRecord({ issue, stage, result, head }, at(minute));
  }

  it('reports the furthest passed stage and the next one, per Issue', () => {
    const summary = summarize([
      record(3477, 'send', 'ok', 0, HEAD_A),
      record(3480, 'send', 'ok', 1),
      record(3477, 'verify', 'ok', 20, HEAD_B),
      record(3480, 'verify', 'fail', 25),
    ]);
    expect(summary.map((s) => [s.issue, s.reached, s.next, s.head])).toEqual([
      [3477, 'verify', 'precheck', HEAD_B],
      [3480, 'send', 'verify', null],
    ]);
  });

  it('counts skip as passed and a later fail as not passed', () => {
    const [item] = summarize([
      record(1, 'send', 'ok', 0),
      record(1, 'verify', 'ok', 1),
      record(1, 'precheck', 'skip', 2),
      record(1, 'verify', 'fail', 3),
    ]);
    expect(item.stages.verify.result).toBe('fail');
    expect(item.reached).toBe('precheck');
  });

  it('says done after merge', () => {
    const [item] = summarize(STAGES.map((stage: string, i: number) => record(1, stage, 'ok', i)));
    expect(item.reached).toBe('merge');
    expect(item.next).toBeNull();
  });

  it('findLatest matches on issue, stage, head and result', () => {
    const records = [record(1, 'verify', 'ok', 0, HEAD_A), record(1, 'verify', 'fail', 1, HEAD_B)];
    expect(findLatest(records, { issue: 1, stage: 'verify', result: 'ok' })?.head).toBe(HEAD_A);
    expect(findLatest(records, { issue: 1, stage: 'verify', head: HEAD_B })?.result).toBe('fail');
    expect(findLatest(records, { issue: 1, stage: 'verify', head: HEAD_B, result: 'ok' })).toBeNull();
  });
});

describe('CLI: stop half-way, re-run, continue', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  const common = () => ['--run-dir', runDir, '--issues', '3477'];

  it('records stages and status tells where to pick up', () => {
    expect(run('append', ...common(), '--issue', '3477', '--stage', 'send', '--result', 'ok', '--head', HEAD_A, '--task', 't-1', '--agent', 'claude', '--model', 'opus', '--contract', '.commandmate/tasks/issue-3477.yaml').status).toBe(0);

    // "the session died here" — a fresh process reads the record back.
    const first = run('status', ...common(), '--json');
    expect(first.status).toBe(0);
    const [item] = JSON.parse(first.stdout).summary;
    expect(item).toMatchObject({ issue: 3477, reached: 'send', next: 'verify', head: HEAD_A });
    expect(item.stages.send).toMatchObject({ taskId: 't-1', agent: 'claude', model: 'opus' });

    expect(run('append', ...common(), '--issue', '3477', '--stage', 'verify', '--result', 'ok', '--head', HEAD_B, '--duration-sec', '900').status).toBe(0);
    const second = run('status', ...common());
    expect(second.stdout).toContain(`#3477\treached=verify\tnext=precheck\thead=${HEAD_B}\tsend=ok verify=ok`);
  });

  it('says so when nothing is recorded yet', () => {
    expect(run('status', ...common()).stdout).toContain('no records in');
  });

  it('exits 1 on an invalid record and writes nothing', () => {
    const result = run('append', ...common(), '--issue', '3477', '--stage', 'deploy', '--result', 'ok');
    expect(result.status).toBe(1);
    expect(fs.existsSync(path.join(runDir, 'run-3477.jsonl'))).toBe(false);
  });

  it('exits 2 without --run-dir or --issues', () => {
    expect(run('status', '--issues', '3477').status).toBe(2);
    expect(run('append', '--run-dir', runDir).status).toBe(2);
  });
});
