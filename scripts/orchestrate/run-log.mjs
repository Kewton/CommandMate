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
 * A record names the HEAD it holds for (`head`) and, when that HEAD only
 * merges develop or folds module-reference on top of the worker's commit, the
 * work HEAD under it (`workHead`). `unmetStage` judges the worker's checks on
 * the work HEAD and the rest on the published HEAD; `status` and the publishing
 * scripts (pr-common.mjs) both use it. Which commit is the work HEAD is
 * pr-common.mjs `workHeads` (#4076): a commit with a verify of its own is the
 * work HEAD; a merge is passed over only when it is known to have changed
 * nothing itself — a develop conflict the worker resolved makes that merge the
 * work HEAD, so its own verify / review / findings are what count. precheck
 * and publish-pr write that answer as `workHead`, and `status` reads it back
 * (headsOf, which applies the same verify mark, verifiedAt).
 *
 * One Issue can carry several PRs. A record names its work item with `item`
 * (`--item d1`, execution-key.mjs) and the attempt it came from with `key`;
 * `status` resumes each work item on its own (`#3883/d1`). A record without
 * `item` — every record written before #3883 — belongs to the Issue itself.
 *
 * A `verify` / `precheck` record may split its `durationSec` into the waits
 * and the execution (Issue #3884): `queueSec` (waiting for a verification
 * slot), `mutexSec` (waiting for a machine-wide lock such as `cpu.heavy`) and
 * `runSec` (the checks themselves). Each is written only when given, so a
 * record without them — every record before #3884 — reads as it always did.
 *
 * Usage:
 *   node scripts/orchestrate/run-log.mjs append --run-dir <dir> --issues <range> --issue <N>
 *        --stage <stage> --result <ok|fail|skip> [--head <sha>] [--work-head <sha>] [--task <id>] [--contract <path>]
 *        [--agent <claude|antigravity>] [--model <opus|sonnet|->] [--duration-sec <n>] [--note <text>]
 *        [--item <work item>] [--key <execution key>] [--queue-sec <n>] [--mutex-sec <n>] [--run-sec <n>]
 *   node scripts/orchestrate/run-log.mjs status --run-dir <dir> --issues <range> [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { itemProblem } from './execution-key.mjs';

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
/**
 * The checks of the worker's own work: judged on the work HEAD (`workHead`),
 * the worker's last commit — or a merge of develop it resolved and was
 * verified on (#4076, pr-common.mjs workHeads). Every other HEAD-bound stage is judged on the HEAD
 * that is published — the work HEAD, or a commit on top of it that only merges
 * develop (6-2) or folds module-reference (6-4). Such a commit needs its own
 * precheck; it does not need the worker's checks again.
 */
export const WORK_STAGES = ['verify', 'review', 'findings'];
/** Results that pass a stage. `skip` stands for "does not apply" only where that can be true (5-2b). */
export const ACCEPTED = {
  verify: ['ok'],
  findings: ['ok'],
  precheck: ['ok'],
};
const accepts = (stage, result) => (ACCEPTED[stage] ?? [...PASSED]).includes(result);
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

/** The fields a record splits its duration into (#3884), with the flag each is given by. */
export const TIMING_FIELDS = { queueSec: '--queue-sec', mutexSec: '--mutex-sec', runSec: '--run-sec' };

// publish-pr.mjs looks a record up by `git rev-parse HEAD` (40 digits), so a short sha
// recorded by hand would read as "no record" there. The `append` command line rejects
// it (#3664); makeRecord itself still takes 7-40 digits for other scripts' callers, and
// records already written with 7 digits are still read as they are.
const FULL_SHA = /^[0-9a-f]{40}$/;

/** Validate one record and give it a fixed shape (absent fields are null, not missing). */
export function makeRecord(input, now = new Date()) {
  const problems = [];
  const issue = Number(input.issue);
  if (!Number.isInteger(issue) || issue <= 0) problems.push(`issue: must be a positive integer (got ${input.issue})`);
  if (!STAGES.includes(input.stage)) problems.push(`stage: must be one of ${STAGES.join(' / ')} (got ${input.stage})`);
  if (!RESULTS.includes(input.result)) problems.push(`result: must be one of ${RESULTS.join(' / ')} (got ${input.result})`);
  const head = optionalString(input.head);
  if (head !== null && !/^[0-9a-f]{7,40}$/.test(head)) problems.push(`head: must be a commit sha (got ${head})`);
  const workHead = optionalString(input.workHead);
  if (workHead !== null && !/^[0-9a-f]{7,40}$/.test(workHead)) problems.push(`work-head: must be a commit sha (got ${workHead})`);
  if (workHead !== null && head === null) problems.push('work-head: needs --head (the published HEAD built on it)');
  if (head === null && HEAD_BOUND_STAGES.includes(input.stage)) {
    problems.push(`head: required for ${input.stage} (its result holds only for the HEAD it ran on)`);
  }
  let durationSec = null;
  if (input.durationSec !== undefined && input.durationSec !== null && input.durationSec !== '') {
    durationSec = Number(input.durationSec);
    if (!Number.isFinite(durationSec) || durationSec < 0) problems.push(`duration-sec: must be a number >= 0 (got ${input.durationSec})`);
  }
  /** @type {Record<string, number>} */
  const timing = {};
  for (const [field, flag] of Object.entries(TIMING_FIELDS)) {
    const value = input[field];
    if (value === undefined || value === null || value === '') continue;
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) problems.push(`${flag.slice(2)}: must be a number >= 0 (got ${value})`);
    else timing[field] = seconds;
  }
  const item = optionalString(input.item);
  const badItem = itemProblem(item);
  if (badItem) problems.push(badItem.replace('--item', 'item'));
  const key = optionalString(input.key);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  return {
    issue,
    stage: input.stage,
    result: input.result,
    head,
    // Only when the published HEAD is not the work itself (a refresh / fold on top).
    ...(workHead !== null && workHead !== head ? { workHead } : {}),
    // Only for a work item of its own (#3883); a record without one is the Issue's.
    ...(item !== null ? { item } : {}),
    ...(key !== null ? { key } : {}),
    taskId: optionalString(input.taskId),
    contract: optionalString(input.contract),
    agent: optionalString(input.agent),
    model: optionalString(input.model),
    durationSec,
    // Only when given (#3884); a record without them is read as before.
    ...timing,
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

/** The work item a record belongs to: its `item`, or null for the Issue itself (every record before #3883). */
export const itemOf = (record) => record.item ?? null;

/**
 * Whether `record` belongs to the work item `item`. `undefined` is "any work
 * item of the Issue" — what every caller got before #3883 — and `null` the
 * Issue's own records (no `item`).
 */
export function inItem(record, item) {
  return item === undefined || itemOf(record) === item;
}

/**
 * The latest record matching every given field (`issue`, `stage`, `head`,
 * `result`, and `item` as inItem reads it), or null.
 */
export function findLatest(records, criteria) {
  const { item, ...fields } = criteria;
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (!inItem(record, item)) continue;
    if (Object.entries(fields).every(([key, value]) => value === undefined || record[key] === value)) return record;
  }
  return null;
}

/** The latest record of each stage for one Issue (any HEAD), or for one of its work items (`item`, inItem). */
export function latestByStage(records, issue, item) {
  /** @type {Record<string, any>} */
  const stages = {};
  for (const record of records) if (record.issue === issue && inItem(record, item)) stages[record.stage] = record;
  return stages;
}

/**
 * Whether the run record has a verify of `sha` itself for the work item (any
 * result; `item` as inItem reads it): the mark that makes that commit its own
 * work HEAD (#4076). pr-common.mjs workHeads (git) and headsOf (`status`)
 * both read it, so a verify added after a record that named another work
 * HEAD moves both. A failed one counts too, so a later failure is never
 * covered by an earlier pass under it.
 */
export function verifiedAt(records, issue, item, sha) {
  return findLatest(records ?? [], { issue, item, stage: 'verify', head: sha }) !== null;
}

/**
 * Why `stage` is not satisfied at `{ head, workHead }`, or null. The one rule
 * both `status` and the publishing scripts (pr-common.mjs) judge by: the
 * latest record of the stage passes, and — for a HEAD-bound stage — was taken
 * on the work HEAD (WORK_STAGES) or on the published HEAD (the rest).
 */
export function unmetStage(stage, record, { head, workHead }) {
  const target = WORK_STAGES.includes(stage) ? workHead ?? head : head;
  const short = target ? target.slice(0, 7) : '-';
  if (!record) return HEAD_BOUND_STAGES.includes(stage) ? `${stage}: no result for ${short}` : `${stage}: no result`;
  if (HEAD_BOUND_STAGES.includes(stage) && record.head !== target) return `${stage}: no result for ${short}`;
  if (!accepts(stage, record.result)) return `${stage}: ${record.result} at ${record.head ? record.head.slice(0, 7) : '-'}`;
  return null;
}

/**
 * The HEADs an Issue is at, read from its records: the latest recorded HEAD,
 * and the work HEAD that HEAD was built on (its `workHead`, else itself).
 * It does not read git: the `workHead` it finds is the one precheck / publish-pr
 * wrote by pr-common.mjs workHeads, so a merge the worker was verified on reads
 * as its own work HEAD here too (#4076). A HEAD with a verify of its own
 * (verifiedAt) is its own work HEAD whatever an earlier record of it said —
 * a precheck of a clean merge writes `workHead=W`, and a verify of that merge
 * recorded after it makes the merge the work HEAD for workHeads as well (a
 * record never carries `workHead` equal to `head`, so the later records alone
 * could not say it). A precheck of the HEAD names its work HEAD afresh: a
 * precheck without `workHead` sets it back to the HEAD itself.
 */
export function headsOf(records, issue, item) {
  let head = null;
  let workHead = null;
  for (const record of records) {
    if (record.issue !== issue || !inItem(record, item) || !record.head) continue;
    if (record.head !== head) workHead = null;
    head = record.head;
    // A precheck always writes the work HEAD it found (none: the HEAD itself), so it replaces
    // what an earlier record of this HEAD said (precheck.mjs writes it again when it changed).
    if (record.stage === 'precheck') workHead = record.workHead ?? null;
    else if (record.workHead) workHead = record.workHead;
  }
  if (head !== null && verifiedAt(records, issue, item, head)) workHead = head;
  return { head, workHead: workHead ?? head };
}

/**
 * Per Issue: where to resume. Each stage is judged by unmetStage at the
 * Issue's HEADs (headsOf). `next` is the first stage that is not satisfied —
 * so a stage that failed after later ones passed is where the run goes back
 * to, and a moved HEAD re-opens every check. A merged Issue is done.
 *
 * Each work item of an Issue (`item`, #3883) is resumed on its own: PR 1a's
 * merge does not finish PR 2, and PR 2's HEAD does not re-open PR 1a's checks.
 * The Issue's own records (no `item`) come first, then its items by name.
 */
export function summarize(records) {
  const issues = [...new Set(records.map((record) => record.issue))].sort((a, b) => a - b);
  const units = issues.flatMap((issue) => {
    const items = [...new Set(records.filter((r) => r.issue === issue).map(itemOf))];
    return items.sort((a, b) => (a === null ? -1 : b === null ? 1 : a.localeCompare(b))).map((item) => ({ issue, item }));
  });
  return units.map(({ issue, item }) => {
    const stages = latestByStage(records, issue, item);
    const { head, workHead } = headsOf(records, issue, item);
    const unmet = (stage) => {
      if (stage === 'contract' && !stages.contract && stages.send && PASSED.has(stages.send.result)) return null;
      return unmetStage(stage, stages[stage], { head, workHead });
    };
    const of = { issue, ...(item !== null ? { item } : {}) };
    if (stages.merge && PASSED.has(stages.merge.result)) {
      return { ...of, reached: 'merge', next: null, reason: null, head, workHead, stages };
    }
    let reached = null;
    for (const stage of STAGES) {
      const reason = unmet(stage);
      if (reason) return { ...of, reached, next: stage, reason, head, workHead, stages };
      reached = stage;
    }
    return { ...of, reached, next: null, reason: null, head, workHead, stages };
  });
}

function formatStatus(summary, skipped) {
  const lines = [];
  for (const item of summary) {
    const stageText = STAGES.filter((stage) => item.stages[stage])
      .map((stage) => `${stage}=${item.stages[stage].result}`)
      .join(' ');
    lines.push(
      `#${item.issue}${item.item ? `/${item.item}` : ''}\treached=${item.reached ?? '-'}\tnext=${item.next ?? 'done'}\thead=${item.head ?? '-'}${item.workHead && item.workHead !== item.head ? `\twork=${item.workHead}` : ''}\t${stageText}` +
        (item.reason ? `\t(${item.reason})` : '')
    );
  }
  if (skipped.length > 0) lines.push(`skipped unreadable line(s): ${skipped.join(', ')}`);
  return lines.join('\n');
}

const USAGE = `Usage:
  node scripts/orchestrate/run-log.mjs append --run-dir <dir> --issues <range> --issue <N> --stage <${STAGES.join('|')}> --result <${RESULTS.join('|')}> [--head <sha>] [--work-head <sha>] [--task <id>] [--contract <path>] [--agent <name>] [--model <name>] [--duration-sec <n>] [--note <text>] [--item <work item>] [--key <execution key>] [--queue-sec <n>] [--mutex-sec <n>] [--run-sec <n>]
  node scripts/orchestrate/run-log.mjs status --run-dir <dir> --issues <range> [--json]`;

const FLAGS = {
  '--run-dir': 'runDir',
  '--issues': 'issues',
  '--issue': 'issue',
  '--stage': 'stage',
  '--result': 'result',
  '--head': 'head',
  '--work-head': 'workHead',
  '--task': 'taskId',
  '--contract': 'contract',
  '--agent': 'agent',
  '--model': 'model',
  '--duration-sec': 'durationSec',
  '--note': 'note',
  '--item': 'item',
  '--key': 'key',
  ...Object.fromEntries(Object.entries(TIMING_FIELDS).map(([field, flag]) => [flag, field])),
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
      const short = [['--head', options.head], ['--work-head', options.workHead]].filter(
        ([, value]) => optionalString(value) !== null && !FULL_SHA.test(String(value))
      );
      if (short.length > 0) {
        for (const [flag, value] of short) {
          console.error(`${flag}: must be the full 40-digit commit sha (use \`git rev-parse HEAD\`, not a short sha) (got ${value})`);
        }
        return 2;
      }
      const { file, record } = appendRecord(options.runDir, options.issues, options, now);
      console.log(`recorded #${record.issue}${record.item ? `/${record.item}` : ''} ${record.stage}=${record.result} -> ${file}`);
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
