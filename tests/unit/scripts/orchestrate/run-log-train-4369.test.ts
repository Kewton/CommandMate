/**
 * run-log.mjs: merge-train.mjs's `train` lines are a log, not progress (Issue #4369, design §10 E10).
 *
 * Like merge-pr's `queue` (run-log-queue-4277.test.ts), a `train` line holds no HEAD, readRecords
 * returns it in `logRecords`, and no progress reader sees it. The run directory is under os.tmpdir().
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ANY_LOG_STAGES,
  LOG_STAGES,
  STAGES,
  TRAIN_LOG_STAGES,
  appendRecord,
  headsOf,
  makeRecord,
  readRecords,
  summarize,
  trainSummary,
} from '../../../../scripts/orchestrate/run-log.mjs';

const SCRIPT = path.resolve(__dirname, '../../../../scripts/orchestrate/run-log.mjs');
const A = 'a'.repeat(40);
let runDir: string;
beforeEach(() => {
  runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-run-log-train-4369-'));
});
afterEach(() => {
  fs.rmSync(runDir, { recursive: true, force: true });
});

function progress() {
  appendRecord(runDir, '4369', { issue: 4369, stage: 'verify', result: 'ok', head: A, note: 'exit=0(passed)' });
  appendRecord(runDir, '4369', { issue: 4369, stage: 'precheck', result: 'ok', head: A });
}

describe('train records are not progress (E10, R24)', () => {
  it('train is a log stage beside queue, never one of STAGES', () => {
    expect(TRAIN_LOG_STAGES).toEqual(['train']);
    expect(ANY_LOG_STAGES).toEqual([...LOG_STAGES, 'train']);
    expect(STAGES).not.toContain('train');
  });

  it('makeRecord takes a train line without a HEAD and refuses one with a HEAD', () => {
    expect(() => makeRecord({ issue: 4369, stage: 'train', result: 'ok', note: 'state=green' })).not.toThrow();
    expect(() => makeRecord({ issue: 4369, stage: 'train', result: 'ok', head: A, note: 'state=green' })).toThrow(/holds no HEAD/);
  });

  it('positive control: train lines leave headsOf / summarize as they were and come back in logRecords', () => {
    progress();
    const before = readRecords(runDir, '4369');
    appendRecord(runDir, '4369', { issue: 4369, stage: 'train', result: 'skip', note: 'state=pushed train=20261114T000000000Z-1-000001 base=develop' });
    appendRecord(runDir, '4369', { issue: 4370, stage: 'train', result: 'ok', note: 'state=green train=20261114T000000000Z-1-000001 base=develop' });
    const after = readRecords(runDir, '4369');
    expect(after.records).toEqual(before.records);
    expect(summarize(after.records)).toEqual(summarize(before.records));
    expect(headsOf(after.records, 4369, null)).toEqual(headsOf(before.records, 4369, null));
    expect(after.logRecords.map((r: { stage: string }) => r.stage)).toEqual(['train', 'train']);
    expect(trainSummary(after.logRecords)).toMatchObject({ issue: 4370, state: 'green', train: '20261114T000000000Z-1-000001', base: 'develop', result: 'ok' });
  });

  it('negative control: without train lines, status --json has the keys it had; with one, `train` is added and the text has a train: line', () => {
    progress();
    const plain = spawnSync(process.execPath, [SCRIPT, 'status', '--run-dir', runDir, '--issues', '4369', '--json'], { encoding: 'utf8' });
    expect(Object.keys(JSON.parse(plain.stdout))).toEqual(['file', 'summary', 'skipped', 'envCleanShared', 'queue']);
    appendRecord(runDir, '4369', { issue: 4369, stage: 'train', result: 'fail', note: 'state=red train=20261114T000000000Z-1-000002 base=develop' });
    const json = JSON.parse(spawnSync(process.execPath, [SCRIPT, 'status', '--run-dir', runDir, '--issues', '4369', '--json'], { encoding: 'utf8' }).stdout);
    expect(json.train).toMatchObject({ state: 'red', train: '20261114T000000000Z-1-000002' });
    const text = spawnSync(process.execPath, [SCRIPT, 'status', '--run-dir', runDir, '--issues', '4369'], { encoding: 'utf8' }).stdout;
    expect(text).toContain('train: red\ttrain=20261114T000000000Z-1-000002\tbase=develop');
  });
});
