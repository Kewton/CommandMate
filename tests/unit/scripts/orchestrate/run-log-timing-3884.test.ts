/**
 * scripts/orchestrate/run-log.mjs — a record may split its duration into the
 * waits and the execution (Issue #3884), and a record without them reads as
 * it always did.
 *
 * Every file here is under os.tmpdir().
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TIMING_FIELDS, appendRecord, main, makeRecord, readRecords, summarize } from '../../../../scripts/orchestrate/run-log.mjs';

const HEAD_A = 'a'.repeat(40);
const at = new Date(Date.UTC(2026, 9, 25, 0, 0));

let runDir: string;
beforeEach(() => {
  runDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-runlog-timing-3884-')), '2026-10-25');
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(path.dirname(runDir), { recursive: true, force: true });
});

describe('queueSec / mutexSec / runSec (Issue #3884)', () => {
  it('writes them only when given', () => {
    const plain = makeRecord({ issue: 3884, stage: 'verify', result: 'ok', head: HEAD_A, durationSec: 600 }, at);
    for (const field of Object.keys(TIMING_FIELDS)) expect(plain).not.toHaveProperty(field);

    const split = makeRecord(
      { issue: 3884, stage: 'verify', result: 'ok', head: HEAD_A, durationSec: 600, queueSec: '30', mutexSec: 120, runSec: '450' },
      at
    );
    expect(split).toMatchObject({ durationSec: 600, queueSec: 30, mutexSec: 120, runSec: 450 });
  });

  it.each([
    [{ queueSec: '-1' }, /queue-sec/],
    [{ mutexSec: 'soon' }, /mutex-sec/],
    [{ runSec: -5 }, /run-sec/],
  ])('rejects %j', (timing, message) => {
    expect(() => makeRecord({ issue: 3884, stage: 'precheck', result: 'ok', head: HEAD_A, ...timing }, at)).toThrow(message);
  });

  it('takes them from the command line', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = main(
      ['append', '--run-dir', runDir, '--issues', '3884', '--issue', '3884', '--stage', 'precheck', '--result', 'ok',
        '--head', HEAD_A, '--queue-sec', '0', '--mutex-sec', '42', '--run-sec', '95'],
      at
    );
    expect(code).toBe(0);
    expect(readRecords(runDir, '3884').records[0]).toMatchObject({ queueSec: 0, mutexSec: 42, runSec: 95 });
  });

  it('reads a record written before #3884 and one with the split the same way', () => {
    // An old line, written by hand exactly as the old makeRecord shaped it.
    appendRecord(runDir, '3884', { issue: 3884, stage: 'send', result: 'ok', head: HEAD_A }, at);
    fs.appendFileSync(
      path.join(runDir, 'run-3884.jsonl'),
      `${JSON.stringify({ issue: 3884, stage: 'verify', result: 'ok', head: HEAD_A, taskId: null, contract: null, agent: null, model: null, durationSec: 600, note: null, at: at.toISOString() })}\n`
    );
    appendRecord(runDir, '3884', { issue: 3884, stage: 'review', result: 'ok', head: HEAD_A }, at);
    appendRecord(runDir, '3884', { issue: 3884, stage: 'findings', result: 'ok', head: HEAD_A }, at);
    appendRecord(runDir, '3884', { issue: 3884, stage: 'precheck', result: 'ok', head: HEAD_A, mutexSec: 42, runSec: 95 }, at);
    const { records, skipped } = readRecords(runDir, '3884');
    expect(skipped).toEqual([]);
    expect(records).toHaveLength(5);
    const [summary] = summarize(records);
    expect(summary.reached).toBe('precheck');
    expect(summary.next).toBe('pr');
  });
});
