/**
 * run-log.mjs: merge-pr `--queue`'s records are kept apart from progress (Issue #4277, R6).
 *
 * A `queue` line holds no HEAD and readRecords returns it as `logRecords`, so headsOf, summarize,
 * latestByStage and envCleanShared — which read `records` — never see one. The run directory is
 * under os.tmpdir().
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOG_STAGES, STAGES, appendRecord, envCleanShared, makeRecord, queueSummary, readRecords, summarize } from '../../../../scripts/orchestrate/run-log.mjs';

const SCRIPT = path.resolve(__dirname, '../../../../scripts/orchestrate/run-log.mjs');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
let runDir: string;
beforeEach(() => {
  runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-run-log-queue-4277-'));
});
afterEach(() => {
  fs.rmSync(runDir, { recursive: true, force: true });
});

function progress() {
  appendRecord(runDir, '4245', { issue: 4245, stage: 'verify', result: 'ok', head: A, note: 'exit=0(passed) env-clean-items=home-entries:+x' });
  appendRecord(runDir, '4245', { issue: 4245, stage: 'review', result: 'ok', head: A });
  appendRecord(runDir, '4245', { issue: 4245, stage: 'precheck', result: 'ok', head: A });
}

describe('queue records are not progress', () => {
  it('queue is a log stage, not one of STAGES', () => {
    expect(LOG_STAGES).toEqual(['queue']);
    expect(STAGES).not.toContain('queue');
  });

  it('makeRecord refuses a queue record that names a HEAD', () => {
    expect(() => makeRecord({ issue: 4245, stage: 'queue', result: 'skip', head: B, note: 'state=running' })).toThrow(/holds no HEAD/);
    expect(() => makeRecord({ issue: 4245, stage: 'queue', result: 'skip', note: 'state=running' })).not.toThrow();
  });

  it('positive control: queue lines — one for an item only the queue knows, one hand-written with a HEAD — leave every unit as it was', () => {
    progress();
    const before = summarize(readRecords(runDir, '4245').records);
    appendRecord(runDir, '4245', { issue: 4245, stage: 'queue', result: 'skip', note: 'state=running queue=4245,4257/d9 pos=1/2 attempt=1 pr=#4263' });
    appendRecord(runDir, '4245', { issue: 4257, item: 'd9', stage: 'queue', result: 'skip', note: 'state=waiting pos=2/2 pr=#4264' });
    // Written around makeRecord (an older tool, a hand edit): a queue line naming another HEAD.
    fs.appendFileSync(path.join(runDir, 'run-4245.jsonl'), `${JSON.stringify({ issue: 4245, stage: 'queue', result: 'skip', head: B, note: 'state=running' })}\n`);
    const read = readRecords(runDir, '4245');
    expect(summarize(read.records)).toEqual(before);
    expect(summarize(read.records)).toHaveLength(1);
    expect(read.records.every((r: { stage: string }) => r.stage !== 'queue')).toBe(true);
    expect(read.logRecords).toHaveLength(2);
    expect(read.skipped).toEqual([6]);
    expect(envCleanShared(read.records)).toEqual(envCleanShared(readRecords(runDir, '4245').records));
  });

  it('negative control: a real verify of a new HEAD still moves next', () => {
    progress();
    appendRecord(runDir, '4245', { issue: 4245, stage: 'queue', result: 'skip', note: 'state=waiting' });
    appendRecord(runDir, '4245', { issue: 4245, stage: 'verify', result: 'ok', head: B });
    const [unit] = summarize(readRecords(runDir, '4245').records);
    expect(unit).toMatchObject({ head: B, workHead: B });
    expect(unit.stages.verify.head).toBe(B);
    // The review of A no longer counts at B.
    expect(unit.stages.review.head).toBe(A);
  });

  it('queueSummary keeps the latest state of each unit', () => {
    appendRecord(runDir, '4245', { issue: 4245, stage: 'queue', result: 'skip', note: 'state=waiting pos=1/1 pr=#4263' });
    appendRecord(runDir, '4245', { issue: 4245, stage: 'queue', result: 'skip', note: 'state=retry pos=1/1 attempt=1 exit=3 pr=#4263' });
    expect(queueSummary(readRecords(runDir, '4245').logRecords)).toEqual([
      expect.objectContaining({ issue: 4245, state: 'retry', pos: '1/1', attempt: 1, exit: 3, pr: '#4263' }),
    ]);
  });

  it('status --json keeps its keys and adds queue; the text shows a queue: block', () => {
    progress();
    appendRecord(runDir, '4245', { issue: 4245, stage: 'queue', result: 'ok', note: 'state=merged pos=1/1 attempt=1 pr=#4263' });
    const json = spawnSync(process.execPath, [SCRIPT, 'status', '--run-dir', runDir, '--issues', '4245', '--json'], { encoding: 'utf8' });
    expect(json.status).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(Object.keys(parsed)).toEqual(['file', 'summary', 'skipped', 'envCleanShared', 'queue']);
    expect(parsed.queue[0]).toMatchObject({ issue: 4245, state: 'merged' });
    const text = spawnSync(process.execPath, [SCRIPT, 'status', '--run-dir', runDir, '--issues', '4245'], { encoding: 'utf8' });
    expect(text.stdout).toContain('queue:');
    expect(text.stdout).toContain('queue #4245\tstate=merged');
  });
});
