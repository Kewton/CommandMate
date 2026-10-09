#!/usr/bin/env node
/**
 * The `/orchestrate` run record: one JSON line per stage per Issue (Issue #3477).
 *
 * After the session died on 2026-10-06 the orchestrator rebuilt "how far did
 * each Issue get" from the conversation transcript; nothing in the run
 * directory said it. This file is that record. It is append-only, so a crash
 * loses at most the line being written, and `status` reads it back.
 *
 *   <run-dir>/run-<issues>.jsonl
 *
 * `<run-dir>` is an argument (a run that crosses midnight keeps its start date),
 * and `<issues>` is the run's Issue range (`3477-3481`, `3477,3480`) so two runs
 * on the same day never write to the same file.
 *
 * Usage:
 *   node scripts/orchestrate/run-log.mjs append --run-dir <dir> --issues <range> --issue <N>
 *        --stage <stage> --result <ok|fail|skip> [--head <sha>] [--task <id>] [--contract <path>]
 *        [--agent <claude|antigravity>] [--model <opus|sonnet|->] [--duration-sec <n>] [--note <text>]
 *   node scripts/orchestrate/run-log.mjs status --run-dir <dir> --issues <range> [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * In run order: the consistency review (5-2b) and the out-of-body findings
 * (5-3) come before the PR, the fast local check (precheck) right before it,
 * and the PR's CI runs alongside the remaining gates (6-1-1) before the merge.
 */
export const STAGES = ['contract', 'send', 'verify', 'review', 'findings', 'precheck', 'pr', 'ci', 'merge'];
/** Stages whose result holds only for the HEAD it was taken on; a new HEAD needs them again. */
export const HEAD_BOUND_STAGES = ['verify', 'review', 'findings', 'precheck', 'ci', 'merge'];
export const RESULTS = ['ok', 'fail', 'skip'];
const PASSED = new Set(['ok', 'skip']);
const ISSUES_PATTERN = /^\d+(?:[-,]\d+)*$/;

export function runLogPath(runDir, issues) {
  if (!ISSUES_PATTERN.test(String(issues))) {
    throw new Error(`--issues must look like 3477, 3477-3481 or 3477,3480 (got ${issues})`);
  }
  return path.join(runDir, `run-${issues}.jsonl`);
}

function optionalString(value) {
  return value === undefined || value === null || value === '' ? null : String(value);
}

/** Validate one record and give it a fixed shape (absent fields are null, not missing). */
export function makeRecord(input, now = new Date()) {
  const problems = [];
  const issue = Number(input.issue);
  if (!Number.isInteger(issue) || issue <= 0) problems.push(`issue: must be a positive integer (got ${input.issue})`);
  if (!STAGES.includes(input.stage)) problems.push(`stage: must be one of ${STAGES.join(' / ')} (got ${input.stage})`);
  if (!RESULTS.includes(input.result)) problems.push(`result: must be one of ${RESULTS.join(' / ')} (got ${input.result})`);
  const head = optionalString(input.head);
  if (head !== null && !/^[0-9a-f]{7,40}$/.test(head)) problems.push(`head: must be a commit sha (got ${head})`);
  if (head === null && HEAD_BOUND_STAGES.includes(input.stage)) {
    problems.push(`head: required for ${input.stage} (its result holds only for the HEAD it ran on)`);
  }
  let durationSec = null;
  if (input.durationSec !== undefined && input.durationSec !== null && input.durationSec !== '') {
    durationSec = Number(input.durationSec);
    if (!Number.isFinite(durationSec) || durationSec < 0) problems.push(`duration-sec: must be a number >= 0 (got ${input.durationSec})`);
  }
  if (problems.length > 0) throw new Error(problems.join('\n'));
  return {
    issue,
    stage: input.stage,
    result: input.result,
    head,
    taskId: optionalString(input.taskId),
    contract: optionalString(input.contract),
    agent: optionalString(input.agent),
    model: optionalString(input.model),
    durationSec,
    note: optionalString(input.note),
    at: now.toISOString(),
  };
}

/**
 * Append one record. If the previous writer died mid-line (no trailing newline),
 * the torn line is closed first so it cannot swallow this one.
 */
export function appendRecord(runDir, issues, input, now = new Date()) {
  const file = runLogPath(runDir, issues);
  const record = makeRecord(input, now);
  fs.mkdirSync(runDir, { recursive: true });
  let prefix = '';
  if (fs.existsSync(file)) {
    const size = fs.statSync(file).size;
    if (size > 0) {
      const fd = fs.openSync(file, 'r');
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      fs.closeSync(fd);
      if (last.toString() !== '\n') prefix = '\n';
    }
  }
  fs.appendFileSync(file, `${prefix}${JSON.stringify(record)}\n`);
  return { file, record };
}

/** Every readable record, in file order. Lines that do not parse are reported, not fatal. */
export function readRecords(runDir, issues) {
  const file = runLogPath(runDir, issues);
  if (!fs.existsSync(file)) return { file, records: [], skipped: [] };
  const records = [];
  const skipped = [];
  fs.readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      if (line.trim() === '') return;
      try {
        const parsed = JSON.parse(line);
        if (!STAGES.includes(parsed.stage) || !Number.isInteger(parsed.issue)) throw new Error('not a record');
        records.push(parsed);
      } catch {
        skipped.push(index + 1);
      }
    });
  return { file, records, skipped };
}

/** The latest record matching every given field (`issue`, `stage`, `head`, `result`), or null. */
export function findLatest(records, criteria) {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (Object.entries(criteria).every(([key, value]) => value === undefined || record[key] === value)) return record;
  }
  return null;
}

/**
 * Per Issue: where to resume. The HEAD is the latest one recorded; each stage
 * is satisfied by its latest record when that passed (`ok` / `skip`) and, for a
 * HEAD-bound stage, was taken on that HEAD. `next` is the first stage that is
 * not satisfied — so a stage that failed after later ones passed is where the
 * run goes back to, and a moved HEAD re-opens every check. A merged Issue is done.
 */
export function summarize(records) {
  const byIssue = new Map();
  for (const record of records) {
    if (!byIssue.has(record.issue)) byIssue.set(record.issue, { stages: {}, head: null });
    const item = byIssue.get(record.issue);
    item.stages[record.stage] = record;
    if (record.head) item.head = record.head;
  }
  return [...byIssue.entries()]
    .sort(([a], [b]) => a - b)
    .map(([issue, { stages, head }]) => {
      const short = head ? head.slice(0, 7) : '-';
      const unmet = (stage) => {
        const record = stages[stage];
        if (stage === 'contract' && !record && stages.send && PASSED.has(stages.send.result)) return null;
        if (!record) return HEAD_BOUND_STAGES.includes(stage) ? `${stage}: no result for ${short}` : `${stage}: no result`;
        if (HEAD_BOUND_STAGES.includes(stage) && record.head !== head) return `${stage}: no result for ${short}`;
        if (!PASSED.has(record.result)) return `${stage}: ${record.result} at ${record.head ? record.head.slice(0, 7) : '-'}`;
        return null;
      };
      if (stages.merge && PASSED.has(stages.merge.result)) {
        return { issue, reached: 'merge', next: null, reason: null, head, stages };
      }
      let reached = null;
      for (const stage of STAGES) {
        const reason = unmet(stage);
        if (reason) return { issue, reached, next: stage, reason, head, stages };
        reached = stage;
      }
      return { issue, reached, next: null, reason: null, head, stages };
    });
}

function formatStatus(summary, skipped) {
  const lines = [];
  for (const item of summary) {
    const stageText = STAGES.filter((stage) => item.stages[stage])
      .map((stage) => `${stage}=${item.stages[stage].result}`)
      .join(' ');
    lines.push(
      `#${item.issue}\treached=${item.reached ?? '-'}\tnext=${item.next ?? 'done'}\thead=${item.head ?? '-'}\t${stageText}` +
        (item.reason ? `\t(${item.reason})` : '')
    );
  }
  if (skipped.length > 0) lines.push(`skipped unreadable line(s): ${skipped.join(', ')}`);
  return lines.join('\n');
}

const USAGE = `Usage:
  node scripts/orchestrate/run-log.mjs append --run-dir <dir> --issues <range> --issue <N> --stage <${STAGES.join('|')}> --result <${RESULTS.join('|')}> [--head <sha>] [--task <id>] [--contract <path>] [--agent <name>] [--model <name>] [--duration-sec <n>] [--note <text>]
  node scripts/orchestrate/run-log.mjs status --run-dir <dir> --issues <range> [--json]`;

const FLAGS = {
  '--run-dir': 'runDir',
  '--issues': 'issues',
  '--issue': 'issue',
  '--stage': 'stage',
  '--result': 'result',
  '--head': 'head',
  '--task': 'taskId',
  '--contract': 'contract',
  '--agent': 'agent',
  '--model': 'model',
  '--duration-sec': 'durationSec',
  '--note': 'note',
};

export function main(argv, now = new Date()) {
  const [command, ...rest] = argv;
  const options = { json: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--json') options.json = true;
    else if (FLAGS[arg] && i + 1 < rest.length) options[FLAGS[arg]] = rest[++i];
    else {
      console.error(`unknown or incomplete argument: ${arg}\n${USAGE}`);
      return 2;
    }
  }
  if (!['append', 'status'].includes(command) || !options.runDir || !options.issues) {
    console.error(USAGE);
    return 2;
  }
  try {
    if (command === 'append') {
      const { file, record } = appendRecord(options.runDir, options.issues, options, now);
      console.log(`recorded #${record.issue} ${record.stage}=${record.result} -> ${file}`);
      return 0;
    }
    const { file, records, skipped } = readRecords(options.runDir, options.issues);
    const summary = summarize(records);
    if (options.json) console.log(JSON.stringify({ file, summary, skipped }, null, 2));
    else console.log(records.length === 0 ? `no records in ${file}` : formatStatus(summary, skipped));
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));
