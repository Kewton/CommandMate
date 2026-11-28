/**
 * scripts/orchestrate/run-log.mjs — a precheck line added by hand is never the gate's record (Issue #4589).
 *
 * Range: what this guards against is a line written by `run-log.mjs append` by mistake (a leader's
 * note left as `--stage precheck --result ok`). Rewriting the jsonl by hand on purpose is outside it.
 *
 * H1 the command line marks its precheck; H2 appendRecord (precheck.mjs's own writer) does not;
 * H3 / H4 gatePrecheck passes the hand line over; H5 an unmarked old-form record is read as before;
 * H6 the other stages written by hand are not marked and are read as before.
 *
 * The run record is under os.tmpdir() and removed after each test.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HAND_WRITER,
  appendRecord,
  gatePrecheck,
  isHandPrecheck,
  latestByStage,
  main,
  readRecords,
  summarize,
} from '../../../../scripts/orchestrate/run-log.mjs';
import { missingRecords } from '../../../../scripts/orchestrate/pr-common.mjs';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const TOOL_NOTE = 'tsc=ok tests=ok env=0123456789ab opts=base:origin/develop,kind:refactor,metrics:false,allow-removed:true,build:false';

let tmp: string;
let runDir: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-run-log-hand-4589-'));
  runDir = path.join(tmp, 'runs');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const at = new Date('2026-11-26T00:00:00.000Z');
const later = new Date('2026-11-26T00:05:00.000Z');

/** A line as a leader adds it: through the command line. */
function appendByHand(stage: string, head: string, note = 'leader note: same as the tool') {
  const code = main(['append', '--run-dir', runDir, '--issues', '4589', '--issue', '4589', '--stage', stage, '--result', 'ok', '--head', head, '--note', note], later);
  expect(code).toBe(0);
}

/** precheck.mjs's own record: appendRecord called directly. */
const appendTool = (head = HEAD_A, note = TOOL_NOTE) =>
  appendRecord(runDir, '4589', { issue: 4589, stage: 'precheck', result: 'ok', head, key: 'k-tool', note }, at);

const records = () => readRecords(runDir, '4589').records;

describe('the mark (#4589)', () => {
  it('H1: a precheck written by `append` carries the hand mark', () => {
    appendByHand('precheck', HEAD_A);
    const [record] = records();
    expect(record).toMatchObject({ stage: 'precheck', result: 'ok', head: HEAD_A, writer: HAND_WRITER });
    expect(isHandPrecheck(record)).toBe(true);
    expect(isHandPrecheck({ ...record, writer: undefined })).toBe(false);
  });

  it('H2: a precheck written by appendRecord itself (precheck.mjs) carries no mark', () => {
    appendTool();
    const [record] = records();
    expect(record).not.toHaveProperty('writer');
    expect(record).toMatchObject({ stage: 'precheck', key: 'k-tool', note: TOOL_NOTE });
  });
});

describe('gatePrecheck (#4589)', () => {
  it('H3: the tool record and a later hand line on the same HEAD — the tool record', () => {
    appendTool();
    appendByHand('precheck', HEAD_A);
    expect(latestByStage(records(), 4589).precheck.writer).toBe(HAND_WRITER);
    const gate = gatePrecheck(records(), { issue: 4589, item: undefined });
    expect(gate).toMatchObject({ head: HEAD_A, key: 'k-tool', note: TOOL_NOTE });
    expect(gate).not.toHaveProperty('writer');
    expect(gatePrecheck(records(), { issue: 4589, head: HEAD_A, result: 'ok' })).toMatchObject({ key: 'k-tool' });
  });

  it('H4: only a hand line — none', () => {
    appendByHand('precheck', HEAD_A, `reason ${TOOL_NOTE}`);
    expect(gatePrecheck(records(), { issue: 4589 })).toBeNull();
    expect(gatePrecheck(records(), { issue: 4589, head: HEAD_A, result: 'ok' })).toBeNull();
  });

  it('H5 (positive control): an unmarked old-form record (no env=) is read as before', () => {
    fs.mkdirSync(runDir, { recursive: true });
    const old = { issue: 4589, stage: 'precheck', result: 'ok', head: HEAD_A, taskId: null, contract: null, agent: null, model: null, durationSec: null, note: 'tsc=ok', at: at.toISOString() };
    const work = ['verify', 'review', 'findings'].map((stage) => ({ ...old, stage, note: null }));
    fs.writeFileSync(path.join(runDir, 'run-4589.jsonl'), [...work, old].map((record) => `${JSON.stringify(record)}\n`).join(''));
    // The publish gate takes it as the precheck of the HEAD, with the warning of a record without env=.
    const warn = vi.fn();
    const where = { runDir, worktree: tmp, home: tmp, warn };
    expect(missingRecords(records(), 4589, { head: HEAD_A, workHead: HEAD_A }, undefined, where)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('warning: precheck at aaaaaaa: no env= in the record'));
    // A record of a later HEAD does not hide this HEAD's own (#4617): the gate reads the line of the HEAD it judges.
    appendTool(HEAD_B, 'tsc=ok');
    expect(missingRecords(records(), 4589, { head: HEAD_A, workHead: HEAD_A }, undefined)).toEqual([]);
  });

  it('H6 (positive control): contract / send / verify / review / findings written by `append` carry no mark and are read as before', () => {
    appendByHand('contract', HEAD_A);
    appendByHand('send', HEAD_A);
    // orchestrate.md / uat-fix-loop.md: a verify recorded by hand without a contract.
    appendByHand('verify', HEAD_A, 'exit=0(passed) passed=lint,typecheck failed=- contract=none');
    appendByHand('review', HEAD_A);
    appendByHand('findings', HEAD_A);
    appendTool();
    const all = records();
    expect(all.slice(0, 5).every((record) => !('writer' in record))).toBe(true);
    const stages = latestByStage(all, 4589);
    expect(stages.verify).toMatchObject({ head: HEAD_A, note: expect.stringContaining('contract=none') });
    expect(stages.review).toMatchObject({ head: HEAD_A });
    expect(stages.findings).toMatchObject({ head: HEAD_A });
    // The publish gate reads them as passed; only the stages after precheck are left.
    expect(missingRecords(all, 4589, { head: HEAD_A, workHead: HEAD_A }, undefined)).toEqual([]);
    expect(summarize(all)[0]).toMatchObject({ reached: 'precheck', next: 'pr' });
  });

  it('status still reads the hand line (status is not a gate)', () => {
    appendTool();
    appendByHand('precheck', HEAD_A);
    expect(summarize(records())[0].stages.precheck.writer).toBe(HAND_WRITER);
  });
});
