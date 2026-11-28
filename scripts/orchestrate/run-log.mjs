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
 * merge-pr.mjs `--queue` (Issue #4277) writes the state of its queue as `queue`
 * records (LOG_STAGES). They are not progress: they carry no HEAD, readRecords
 * returns them apart (`logRecords`), and `records` — what headsOf, summarize,
 * latestByStage and envCleanShared read — never holds one. `status` shows them
 * after the summary (`queue` in `--json`). merge-train.mjs (Issue #4369) writes its `train` lines the
 * same way (TRAIN_LOG_STAGES, read with LOG_STAGES): no HEAD, never progress; `status` shows the latest one (`train` in `--json`, only when there is one).
 *
 * Usage:
 *   node scripts/orchestrate/run-log.mjs append --run-dir <dir> --issues <range> --issue <N>
 *        --stage <stage> --result <ok|fail|skip> [--head <sha>] [--work-head <sha>] [--task <id>] [--contract <path>]
 *        [--agent <claude|command-code>] [--model <opus|sonnet|->] [--duration-sec <n>] [--note <text>]
 *        [--item <work item>] [--key <execution key>] [--queue-sec <n>] [--mutex-sec <n>] [--run-sec <n>]
 *   node scripts/orchestrate/run-log.mjs status --run-dir <dir> --issues <range> [--json]
 *   node scripts/orchestrate/run-log.mjs record-verify --run-dir <dir> --issues <range> --issue <N>
 *        --run <verification run id> --wt <worktree id> --worktree <path> [--head <sha>] [--task <id>]
 *        [--item <work item>] [--cli <commandmatedev>]
 *
 * `record-verify` (Issue #4482) writes the `verify` line of a verification the leader ran directly
 * (`commandmatedev verify <wt>`, no wait-verify and so no worker signal): see recordVerifyRun.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirtyPaths } from './dirty-tree.mjs';
import { itemProblem, workItemName } from './execution-key.mjs';

/**
 * In run order: the consistency review (5-2b) and the out-of-body findings
 * (5-3) come before the PR, the fast local check (precheck) right before it,
 * and the PR's CI runs alongside the remaining gates (6-1-1) before the merge.
 */
export const STAGES = ['contract', 'send', 'verify', 'review', 'findings', 'precheck', 'pr', 'ci', 'merge'];
/**
 * Stages that log what a tool did, not how far an Issue got (Issue #4277): merge-pr.mjs `--queue`'s
 * `queue`. They hold no HEAD and are read apart from STAGES (readRecords `logRecords`), so no progress
 * reader — headsOf, latestByStage, summarize, envCleanShared — sees them.
 */
export const LOG_STAGES = ['queue'];
/**
 * merge-train.mjs's `train` (Issue #4369): a log stage like LOG_STAGES, kept in a list of its own so
 * LOG_STAGES stays the merge-pr queue's (run-log-queue-4277.test.ts fixes it). Every reader below
 * takes ANY_LOG_STAGES, so a `train` line is never progress either.
 */
export const TRAIN_LOG_STAGES = ['train'];
export const ANY_LOG_STAGES = [...LOG_STAGES, ...TRAIN_LOG_STAGES];
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

/**
 * The mark of a precheck record written by the `append` command line, not by
 * precheck.mjs (#4589). Only the command line sets it, and only on a precheck:
 * a gate reads precheck.mjs's own record (its env= and options), never a line
 * added by hand. Every other stage written by hand is read as before.
 */
export const HAND_WRITER = 'hand';

/** Whether `record` is a precheck written by hand (HAND_WRITER). A record without the mark is the tool's. */
export const isHandPrecheck = (record) => record?.stage === 'precheck' && record.writer === HAND_WRITER;

/** Validate one record and give it a fixed shape (absent fields are null, not missing). */
export function makeRecord(input, now = new Date()) {
  const problems = [];
  const issue = Number(input.issue);
  if (!Number.isInteger(issue) || issue <= 0) problems.push(`issue: must be a positive integer (got ${input.issue})`);
  if (!STAGES.includes(input.stage) && !ANY_LOG_STAGES.includes(input.stage)) {
    problems.push(`stage: must be one of ${[...STAGES, ...ANY_LOG_STAGES].join(' / ')} (got ${input.stage})`);
  }
  if (!RESULTS.includes(input.result)) problems.push(`result: must be one of ${RESULTS.join(' / ')} (got ${input.result})`);
  const head = optionalString(input.head);
  if (head !== null && !/^[0-9a-f]{7,40}$/.test(head)) problems.push(`head: must be a commit sha (got ${head})`);
  const workHead = optionalString(input.workHead);
  if (workHead !== null && !/^[0-9a-f]{7,40}$/.test(workHead)) problems.push(`work-head: must be a commit sha (got ${workHead})`);
  if (workHead !== null && head === null) problems.push('work-head: needs --head (the published HEAD built on it)');
  if (ANY_LOG_STAGES.includes(input.stage) && (head !== null || workHead !== null)) {
    // headsOf reads `head` from every record it is given; a log line must never name one (#4277).
    problems.push(`head: a ${input.stage} record holds no HEAD (it logs, it does not move progress)`);
  }
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
  const writer = input.writer === HAND_WRITER ? HAND_WRITER : null;
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
    // Only on a precheck written by the `append` command line (#4589); a record without it is the tool's.
    ...(writer !== null ? { writer } : {}),
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

/**
 * Every readable record, in file order. Lines that do not parse are reported, not fatal.
 * `records` are the progress stages (STAGES) only; `logRecords` the LOG_STAGES lines (#4277).
 */
export function readRecords(runDir, issues) {
  const file = runLogPath(runDir, issues);
  if (!fs.existsSync(file)) return { file, records: [], logRecords: [], skipped: [] };
  const records = [];
  const logRecords = [];
  const skipped = [];
  fs.readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      if (line.trim() === '') return;
      try {
        const parsed = JSON.parse(line);
        if (!Number.isInteger(parsed.issue)) throw new Error('not a record');
        if (ANY_LOG_STAGES.includes(parsed.stage) && !parsed.head && !parsed.workHead) logRecords.push(parsed);
        else if (STAGES.includes(parsed.stage)) records.push(parsed);
        else throw new Error('not a record');
      } catch {
        skipped.push(index + 1);
      }
    });
  return { file, records, logRecords, skipped };
}

/** `key=value` words of a note (the first `=` splits). */
function noteFields(note) {
  /** @type {Record<string, string>} */
  const fields = {};
  for (const word of String(note ?? '').split(/\s+/)) {
    const at = word.indexOf('=');
    if (at > 0) fields[word.slice(0, at)] = word.slice(at + 1);
  }
  return fields;
}

/**
 * The latest `queue` record of each (Issue, work item), in the order they first appear (#4277):
 * what `status` shows of a merge-pr.mjs `--queue` run. Read from `logRecords`, never `records`.
 *
 * @returns {{ issue: number, item?: string, state: string | null, pos: string | null, attempt: number | null, exit: number | null, pr: string | null, at: string | null }[]}
 */
export function queueSummary(logRecords) {
  /** @type {Map<string, any>} */
  const latest = new Map();
  for (const record of logRecords ?? []) {
    if (record.stage !== 'queue') continue;
    latest.set(`${record.issue}/${itemOf(record) ?? ''}`, record);
  }
  return [...latest.values()].map((record) => {
    const fields = noteFields(record.note);
    return {
      issue: record.issue,
      ...(itemOf(record) !== null ? { item: itemOf(record) } : {}),
      state: fields.state ?? null,
      pos: fields.pos ?? null,
      attempt: fields.attempt !== undefined && /^\d+$/.test(fields.attempt) ? Number(fields.attempt) : null,
      exit: fields.exit !== undefined && /^\d+$/.test(fields.exit) ? Number(fields.exit) : null,
      pr: fields.pr ?? null,
      at: record.at ?? null,
    };
  });
}

export const formatQueueLine = (entry) =>
  `queue #${entry.issue}${entry.item ? `/${entry.item}` : ''}\tstate=${entry.state ?? '-'}\tpos=${entry.pos ?? '-'}\tattempt=${entry.attempt ?? '-'}` +
  `${entry.exit !== null ? `\texit=${entry.exit}` : ''}\tpr=${entry.pr ?? '-'}`;

/**
 * The latest `train` record (merge-train.mjs, #4369), or null: what `status` shows of the trains.
 * Read from `logRecords`, never `records`.
 *
 * @returns {{ issue: number, state: string | null, train: string | null, base: string | null, at: string | null, result: string } | null}
 */
export function trainSummary(logRecords) {
  const latest = [...(logRecords ?? [])].reverse().find((record) => record.stage === 'train');
  if (!latest) return null;
  const fields = noteFields(latest.note);
  return { issue: latest.issue, state: fields.state ?? null, train: fields.train ?? null, base: fields.base ?? null, at: latest.at ?? null, result: latest.result };
}

export const formatTrainLine = (train) =>
  `train: ${train.state ?? '-'}\ttrain=${train.train ?? '-'}\tbase=${train.base ?? '-'}\tat=${train.at ?? '-'}`;

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

/**
 * The precheck record a gate reads (#4589): the latest precheck matching
 * `criteria` (as findLatest reads them, `stage` aside) that precheck.mjs wrote
 * itself — a line added by hand (isHandPrecheck) is passed over, so its missing
 * env= and options are never taken for the tool's. Only a hand line: null, as
 * when there is no record. merge-pr, publish (pr-common.mjs missingRecords) and
 * the train all read the precheck by this one rule.
 */
export function gatePrecheck(records, criteria) {
  return findLatest((records ?? []).filter((record) => !isHandPrecheck(record)), { ...criteria, stage: 'precheck' });
}

/**
 * The latest precheck precheck.mjs wrote itself on `head` (any result; a hand line,
 * isHandPrecheck, never counts), or null. Without a HEAD there is none: it never
 * falls back to another HEAD.
 */
export function toolPrecheck(records, { issue, item, head }) {
  if (!head) return null;
  return gatePrecheck(records, { issue, item, head });
}

/** The roles of the precheck record's readers and the HEAD each reads (#4614, #4617). */
export const PRECHECK_ROLES = ['gate', 'options'];

/**
 * The one precheck record a reader takes (#4614, #4617): the latest line
 * precheck.mjs wrote (toolPrecheck) on the HEAD of its role.
 *   - `gate`: the published HEAD `head` — a precheck stands for the HEAD that is
 *     published (WORK_STAGES leaves it out). precheck.mjs's reuse, merge-pr's
 *     env check and its CI wait, and missingRecords read this.
 *   - `options`: the work HEAD `workHead`, else `head` (a fold on top made the
 *     precheck run on the published HEAD only) — never any other HEAD. merge-pr's
 *     re-run and the train take the options from it.
 * When `head` is `workHead` both roles take the same line.
 */
export function precheckFor(records, { issue, item, role, head, workHead }) {
  if (role === 'gate') return toolPrecheck(records, { issue, item, head });
  if (role === 'options') return toolPrecheck(records, { issue, item, head: workHead }) ?? toolPrecheck(records, { issue, item, head });
  throw new Error(`precheckFor: role must be one of ${PRECHECK_ROLES.join(' / ')} (got ${role})`);
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

/**
 * What a `verify` record says env-clean listed (wait-verify.mjs): `<probe>:<sign><name>`, comma-separated.
 * A note is split on whitespace and read as key=value, so those characters and the comma are percent-encoded
 * in the name (#4162: a `$HOME` entry may hold any of them). A record from before that has no escapes to read,
 * and a `%` that does not decode stays as written.
 */
const ENV_CLEAN_ITEMS_NOTE = /(?:^|\s)env-clean-items=(\S+)/;
const encodeItem = (item) => item.replace(/[%,=\s]/g, encodeURIComponent);
const decodeItem = (item) => {
  try {
    return decodeURIComponent(item);
  } catch {
    return item;
  }
};
export const envCleanItemsNote = (items) => `env-clean-items=${items.map(encodeItem).join(',')}`;

/**
 * The env-clean items seen by more than one work item of a run (#4148): a candidate for an outside
 * cause, not a verdict. Two workers' tests can make the same name, so the attribution stays with 3-4.
 *
 * @returns {{ item: string, workItems: string[] }[]}
 */
export function envCleanShared(records) {
  /** @type {Map<string, Set<string>>} */
  const seen = new Map();
  for (const record of records) {
    if (record.stage !== 'verify') continue;
    const items = ENV_CLEAN_ITEMS_NOTE.exec(record.note ?? '')?.[1].split(',').map(decodeItem) ?? [];
    for (const item of items) {
      seen.set(item, (seen.get(item) ?? new Set()).add(`#${record.issue}${itemOf(record) ? `/${itemOf(record)}` : ''}`));
    }
  }
  return [...seen].filter(([, workItems]) => workItems.size > 1).map(([item, workItems]) => ({ item, workItems: [...workItems] }));
}

export const formatEnvCleanShared = ({ item, workItems }) =>
  `env-clean: ${item} in ${workItems.join(', ')} — candidate for an outside cause (attribute it: 3-4)`;

/**
 * Exit codes of `record-verify` (#4482). `notFinished` and `refused` write nothing: the run is not
 * over (its verdict is not taken early), or it is not the run of this worktree / HEAD / task.
 */
export const RECORD_VERIFY_EXIT = { recorded: 0, unreadable: 1, usage: 2, notFinished: 3, refused: 4 };
/** The run statuses that are an end (src/cli/types/api-responses.ts VerificationRunStatus); only `passed` is `ok`. */
const RUN_END_STATUSES = ['passed', 'failed', 'error', 'cancelled', 'not_started'];
/** A gate's stored status as a record result: only `passed` is `ok`, a SKIP is `skip`, anything else `fail`. */
const gateResult = (status) => (status === 'passed' ? 'ok' : status === 'skipped' ? 'skip' : 'fail');
const RUN_NOTE = (runId) => new RegExp(`(?:^|\\s)run=${runId}(?:\\s|$)`);

function defaultRun(command, args, { cwd, timeoutMs } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...(timeoutMs ? { timeout: timeoutMs, killSignal: 'SIGKILL' } : {}),
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function runSafely(run, command, args, cwd) {
  try {
    return run(command, args, { cwd, timeoutMs: 15_000 });
  } catch (error) {
    return { status: 1, stdout: '', stderr: String(error?.message ?? error) };
  }
}

/** The rows of `ls --json` (an array, or `{ worktrees }`), or null. */
function worktreeRows(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.worktrees)) return parsed.worktrees;
  return null;
}

function realpathOrNull(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

/**
 * Record a verification the leader ran directly (Issue #4482), from its run id: what
 * `verify show <id> --json` says of it, nothing more. The verdict stays the run's (team.md §10-4).
 *
 * - The run must be over (RUN_END_STATUSES): a `running` / `queued` (or unknown) run is refused
 *   (`notFinished`), its result is not decided here. Only `passed` is written as `ok`; `failed`,
 *   `error`, `cancelled`, `not_started` are `fail`. Each gate is `ok` / `skip` / `fail` (gateResult).
 *   An answer that is not a run (no `id`) is `unreadable`.
 * - The run must be this one (`refused` otherwise): its id is the one asked, its `worktreeId` is
 *   `--wt`, its task is `--task` when both say one, and `--worktree` is the path the CLI lists for
 *   `--wt` (realpath). A run already recorded for the work item (`run=<id>` in a verify line's note,
 *   by wait-verify or by this) is refused too. `--task` is never written for a run without a task.
 * - The HEAD is written only when it is the tree the run verified, fail-closed (#4482 review 1): the
 *   run does not store a HEAD, so the HEAD is the worktree's now, and it is refused unless the tree
 *   has no uncommitted change (dirty-tree.mjs dirtyPaths), HEAD was neither committed nor moved
 *   (HEAD's reflog entry, `git log -g -1 --date=unix --format=%gd HEAD`, whole seconds: a move in the second the run
 *   started counts as after it) after the run started, and `--head` (when given) is that HEAD. What
 *   cannot be read is refused, not assumed. A tree that was dirty during the run and cleaned before
 *   recording is not seen (a cleaning that does not move HEAD leaves no time to compare).
 * - env: none (`env=none`, the human decision (a) on #4482). A direct run has no manifest from its
 *   start, and one taken later can differ from the run's in ways no time stamp shows (a re-pointed
 *   `node_modules`, a deleted or restored settings file), so no env is claimed and no manifest file
 *   is written. env-manifest.mjs verifyEnvState never reads `env=none` as `same`.
 *
 * The note: `direct=verify run=<id> run-status=<status> gates=<id>:<ok|skip|fail>,… key=<key> env=none`.
 * `gates=` is for the reader: precheck / merge-pr read `passed=` (wait-verify's), so a direct record
 * is read as a `verify=ok` line and never lends its gates to a reuse.
 *
 * @returns {{ exit: number, reason?: string, file?: string, record?: any }}
 */
export function recordVerifyRun(options, { run = defaultRun, now = new Date() } = {}) {
  const runId = String(options.runId);
  const cli = options.cli || 'commandmatedev';
  const worktree = options.worktree;
  const refuse = (exit, reason) => ({ exit, reason });
  const refused = (reason) => refuse(RECORD_VERIFY_EXIT.refused, reason);
  const shown = runSafely(run, cli, ['verify', 'show', runId, '--json'], worktree);
  let parsed = null;
  try {
    parsed = shown.status === 0 ? JSON.parse(shown.stdout) : null;
  } catch {
    parsed = null;
  }
  const view = parsed && typeof parsed === 'object' ? (parsed.run ?? parsed) : null;
  if (!view || typeof view !== 'object' || view.id === undefined || view.id === null) {
    return refuse(RECORD_VERIFY_EXIT.unreadable, `run ${runId}: \`${cli} verify show ${runId} --json\` gave no run (exit ${shown.status}${shown.stderr ? `: ${String(shown.stderr).trim()}` : ''})`);
  }
  if (String(view.id) !== runId) return refused(`run ${runId}: the CLI answered with run ${view.id}`);
  if (view.worktreeId !== options.wt) return refused(`run ${runId} is of worktree ${view.worktreeId ?? '-'}, not ${options.wt}`);
  if (!RUN_END_STATUSES.includes(view.status)) {
    return refuse(RECORD_VERIFY_EXIT.notFinished, `run ${runId} is ${view.status ?? 'without a status'}: not over, nothing recorded (record it once it has ended)`);
  }
  const started = Date.parse(view.startedAt);
  if (!Number.isFinite(started)) return refused(`run ${runId}: no readable start (startedAt ${view.startedAt ?? '-'}), so no HEAD can be tied to it`);
  const taskId = optionalString(options.taskId);
  if (taskId !== null && view.taskId && view.taskId !== taskId) return refused(`run ${runId} is of task ${view.taskId}, not ${taskId}`);

  // (c) --worktree is --wt's worktree.
  const listed = runSafely(run, cli, ['ls', '--json'], worktree);
  let rows = null;
  try {
    rows = listed.status === 0 ? worktreeRows(JSON.parse(listed.stdout)) : null;
  } catch {
    rows = null;
  }
  if (!rows) return refused(`cannot read \`${cli} ls --json\` to tie --worktree to ${options.wt} (exit ${listed.status})`);
  const row = rows.find((r) => r && r.id === options.wt);
  if (!row || typeof row.path !== 'string') return refused(`worktree ${options.wt} is not listed by \`${cli} ls --json\``);
  const listedPath = realpathOrNull(row.path);
  const givenPath = realpathOrNull(worktree);
  if (listedPath === null || givenPath === null || listedPath !== givenPath) {
    return refused(`--worktree ${worktree} is not worktree ${options.wt} (${row.path})`);
  }

  const revParse = runSafely(run, 'git', ['-C', worktree, 'rev-parse', 'HEAD'], worktree);
  const head = revParse.status === 0 ? revParse.stdout.trim() : '';
  if (!FULL_SHA.test(head)) return refuse(RECORD_VERIFY_EXIT.unreadable, `${worktree}: cannot read HEAD (${String(revParse.stderr).trim()})`);
  const short = head.slice(0, 7);
  const wanted = optionalString(options.head);
  if (wanted !== null && wanted !== head) return refused(`--head ${wanted.slice(0, 7)} is not the worktree's HEAD ${short}`);
  // (a) No uncommitted change: the record says HEAD, and only the committed tree is HEAD.
  let dirty;
  try {
    dirty = dirtyPaths(run, worktree);
  } catch (error) {
    return refused(`cannot read the worktree's git status, so HEAD ${short} cannot be tied to run ${runId}: ${error.message}`);
  }
  if (dirty.length > 0) return refused(`uncommitted changes in ${worktree} (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''}): run ${runId} did not verify HEAD ${short} alone`);
  const logged = runSafely(run, 'git', ['-C', worktree, 'log', '-1', '--format=%cI'], worktree);
  const committedAt = logged.status === 0 ? Date.parse(logged.stdout.trim()) : NaN;
  if (!Number.isFinite(committedAt)) return refused(`cannot read when HEAD ${short} was committed (${String(logged.stderr).trim()})`);
  if (committedAt > started) return refused(`HEAD ${short} was committed after the run started (${view.startedAt}): run ${runId} verified an earlier state`);
  // (b) HEAD did not move after the run started (a reset / checkout to an older commit keeps an old commit date).
  // `%gd` with `--date=unix` is the reflog entry's own time (`HEAD@{<epoch>}`); `%ct` would be the commit's.
  const reflog = runSafely(run, 'git', ['-C', worktree, 'log', '-g', '-1', '--date=unix', '--format=%gd', 'HEAD'], worktree);
  const movedMatch = reflog.status === 0 ? /^HEAD@\{(\d+)\}$/.exec(reflog.stdout.trim()) : null;
  const movedSec = movedMatch ? Number(movedMatch[1]) : null;
  if (movedSec === null) return refused(`cannot read HEAD's reflog in ${worktree}, so it cannot be told that HEAD ${short} stayed since run ${runId} started`);
  if ((movedSec + 1) * 1000 > started) {
    return refused(`HEAD ${short} moved after the run started (${new Date(movedSec * 1000).toISOString()} >= ${view.startedAt}): run ${runId} verified another state`);
  }
  const item = optionalString(options.item);
  const issue = Number(options.issue);
  const { records } = readRecords(options.runDir, options.issues);
  const earlier = records.find(
    (r) => r.issue === issue && r.stage === 'verify' && itemOf(r) === item && RUN_NOTE(runId).test(String(r.note ?? ''))
  );
  if (earlier) return refused(`run ${runId} is already recorded for #${workItemName(issue, item)} (at ${earlier.at ?? '-'})`);

  // Only the run's own task (#4482 review 1 P3-1): `--task` checks it, it never stands in for it.
  const recordTask = optionalString(view.taskId);
  const key = `${options.issues}:${workItemName(issue, item)}:${recordTask ?? '-'}:run${runId}`;
  const gates = (Array.isArray(view.gates) ? view.gates : []).map((g) => `${g.gateId}:${gateResult(String(g.status ?? ''))}`);
  const note = [
    'direct=verify',
    `run=${runId}`,
    `run-status=${view.status}`,
    `gates=${gates.join(',') || '-'}`,
    `key=${key}`,
    // No env is claimed for a direct run: it has no manifest from its start (#4482 decision (a)).
    'env=none',
  ].join(' ');
  const finished = Date.parse(view.finishedAt);
  const input = {
    issue,
    stage: 'verify',
    result: view.status === 'passed' ? 'ok' : 'fail',
    head,
    taskId: recordTask,
    agent: optionalString(view.instanceId),
    durationSec: Number.isFinite(finished) && finished >= started ? Math.round((finished - started) / 1000) : null,
    note,
    item,
    key,
  };
  const { file, record } = appendRecord(options.runDir, options.issues, input, now);
  return { exit: RECORD_VERIFY_EXIT.recorded, file, record };
}

const RECORD_VERIFY_FLAGS = {
  '--run-dir': 'runDir',
  '--issues': 'issues',
  '--issue': 'issue',
  '--run': 'runId',
  '--wt': 'wt',
  '--worktree': 'worktree',
  '--head': 'head',
  '--task': 'taskId',
  '--item': 'item',
  '--cli': 'cli',
};

function recordVerifyMain(rest, now, deps) {
  const out = deps.out ?? ((line) => console.log(line));
  const error = deps.error ?? ((line) => console.error(line));
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = RECORD_VERIFY_FLAGS[rest[i]];
    if (!flag || i + 1 >= rest.length) {
      error(`unknown or incomplete argument: ${rest[i]}\n${USAGE}`);
      return RECORD_VERIFY_EXIT.usage;
    }
    options[flag] = rest[++i];
  }
  const missing = ['runDir', 'issues', 'issue', 'runId', 'wt', 'worktree'].filter((field) => !options[field]);
  if (missing.length > 0) {
    error(`missing ${missing.map((field) => Object.keys(RECORD_VERIFY_FLAGS).find((flag) => RECORD_VERIFY_FLAGS[flag] === field)).join(', ')}\n${USAGE}`);
    return RECORD_VERIFY_EXIT.usage;
  }
  if (!/^[1-9]\d*$/.test(options.runId)) {
    error(`--run: must be a verification run id (a positive integer) (got ${options.runId})`);
    return RECORD_VERIFY_EXIT.usage;
  }
  if (optionalString(options.head) !== null && !FULL_SHA.test(options.head)) {
    error(`--head: must be the full 40-digit commit sha (use \`git rev-parse HEAD\`, not a short sha) (got ${options.head})`);
    return RECORD_VERIFY_EXIT.usage;
  }
  const problem = itemProblem(options.item);
  if (problem) {
    error(problem);
    return RECORD_VERIFY_EXIT.usage;
  }
  try {
    runLogPath(options.runDir, options.issues);
  } catch (err) {
    error(err.message);
    return RECORD_VERIFY_EXIT.usage;
  }
  try {
    const result = recordVerifyRun(options, { run: deps.run, now });
    if (result.exit !== RECORD_VERIFY_EXIT.recorded) {
      error(`not recorded: ${result.reason}`);
      return result.exit;
    }
    const { record, file } = result;
    out(`recorded #${workItemName(record.issue, record.item)} verify=${record.result} ${record.head.slice(0, 7)}: ${record.note} -> ${file}`);
    return RECORD_VERIFY_EXIT.recorded;
  } catch (err) {
    error(err.message);
    return RECORD_VERIFY_EXIT.unreadable;
  }
}

function formatStatus(summary, skipped, shared = [], queue = [], train = null) {
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
  lines.push(...shared.map(formatEnvCleanShared));
  if (queue.length > 0) lines.push('queue:', ...queue.map(formatQueueLine));
  if (train) lines.push(formatTrainLine(train));
  if (skipped.length > 0) lines.push(`skipped unreadable line(s): ${skipped.join(', ')}`);
  return lines.join('\n');
}

const USAGE = `Usage:
  node scripts/orchestrate/run-log.mjs append --run-dir <dir> --issues <range> --issue <N> --stage <${[...STAGES, ...ANY_LOG_STAGES].join('|')}> --result <${RESULTS.join('|')}> [--head <sha>] [--work-head <sha>] [--task <id>] [--contract <path>] [--agent <name>] [--model <name>] [--duration-sec <n>] [--note <text>] [--item <work item>] [--key <execution key>] [--queue-sec <n>] [--mutex-sec <n>] [--run-sec <n>]
  node scripts/orchestrate/run-log.mjs status --run-dir <dir> --issues <range> [--json]
  node scripts/orchestrate/run-log.mjs record-verify --run-dir <dir> --issues <range> --issue <N> --run <verification run id> --wt <worktree id> --worktree <path> [--head <sha>] [--task <id>] [--item <work item>] [--cli <commandmatedev>]`;

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

export function main(argv, now = new Date(), deps = {}) {
  const [command, ...rest] = argv;
  if (command === 'record-verify') return recordVerifyMain(rest, now, deps);
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
      // A precheck written here is a hand line, never precheck.mjs's own record (#4589).
      const input = options.stage === 'precheck' ? { ...options, writer: HAND_WRITER } : options;
      const { file, record } = appendRecord(options.runDir, options.issues, input, now);
      console.log(`recorded #${record.issue}${record.item ? `/${record.item}` : ''} ${record.stage}=${record.result} -> ${file}`);
      return 0;
    }
    const { file, records, logRecords, skipped } = readRecords(options.runDir, options.issues);
    const summary = summarize(records);
    const shared = envCleanShared(records);
    const queue = queueSummary(logRecords);
    const train = trainSummary(logRecords);
    if (options.json) console.log(JSON.stringify({ file, summary, skipped, envCleanShared: shared, queue, ...(train ? { train } : {}) }, null, 2));
    else console.log(records.length === 0 && queue.length === 0 && !train ? `no records in ${file}` : formatStatus(summary, skipped, shared, queue, train));
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));
