#!/usr/bin/env node
/**
 * `/orchestrate` 6-2 / 6-3: refresh the PR on develop, wait for the CI it
 * needs, squash-merge it and close the Issue (Issue #3477, PR 3).
 *
 * In order, stopping at the first that does not hold:
 *   1. the PR is not merged yet — a merged PR is not merged again; the run only
 *      records the merge (if missing) and closes the Issue (if still open), so a
 *      rerun after a crash ends where the first run would have;
 *   2. the tree is clean (exit 2);
 *   3. the run record has verify / review / findings for the work HEAD
 *      (pr-common.mjs REQUIRED_RECORDS, judged by run-log.mjs `unmetStage` like
 *      `status`) and the fragments are there (6-4);
 *   4. 6-2's refresh, when develop has moved: `git merge origin/develop` (a
 *      conflict is aborted and left to the orchestrator — 6-2 resolves it by
 *      meaning). Then, on whatever HEAD is to be merged — refreshed here, pushed
 *      by publish-pr.mjs after a refresh, or not pushed yet — the conflict-marker
 *      sweep over every tracked file, and precheck.mjs (tsc, `vitest related`
 *      over the imports, the tests naming a changed path, the guards …) unless
 *      the run record already has `precheck=ok` for that very HEAD. On the HEAD
 *      this run's own refresh made, precheck gets `--heavy-to-ci` (#4265): the
 *      steps that would take `cpu.heavy` are recorded `=ci` and left to the PR's
 *      CI on that HEAD (step 5), so a worker's `wait --verify` holding the lock
 *      does not hold the merge; the light steps run and stop the push as before.
 *      Without a refresh in this run the precheck takes the lock as before. Only then
 *      `git push`;
 *   5. the PR's checks (6-3): no `fail` / `cancel` in `bucket` — a failed job is
 *      re-run once per HEAD (`gh run rerun --failed`, recorded in the `ci` stage
 *      so a rerun after a crash does not re-run it again), once its run has finished:
 *      GitHub refuses a run still going, and an early failure is always inside one (#4162).
 *      That wait is under --ci-timeout, and a base or PR head that moves during it stops
 *      the run; `Build` is `pass`
 *      unless the precheck of this HEAD built what the CI `Build` builds
 *      (`build`, `build-cli`, `build-server` all `ok`); `Unit Tests` is `pass`
 *      unless the verification passed verify.yaml's full `unit` gate — a
 *      `unit-related` or a refactor contract (lint / typecheck only) waits for
 *      it (2-4-3, 6-2), and `--unit-related` forces the wait; with `--last`
 *      every check is `pass` or `skipping` and LAST_REQUIRED_CHECKS have registered
 *      (6-2: the last PR, and every PR of a run whose permission says "if CI passes",
 *      waits for the full CI; `gh pr checks` lists only what has registered).
 *      Anything else `pending` is not waited for. --register-timeout bounds the time until this
 *      HEAD has any check at all, and --ci-timeout runs from then (#4148). Every look fetches
 *      the base after reading the checks: a base that moved during the wait, that read included, stops
 *      the run with exit 4, because this HEAD no longer is the combination that would land (a rerun
 *      refreshes it, step 4). A fetch that fails is asked again at the next look and never merges on
 *      an unread base;
 *   6. `gh pr merge --squash --match-head-commit <HEAD>`, recorded in the
 *      `merge` stage, then `gh issue close` unless `--close -`.
 *
 * `--item <work item>` (#3883): one PR of an Issue that has several. Every
 * record it reads is that work item's, every record it writes (and the
 * precheck it runs) carries it, so the other PRs of the Issue neither stop
 * nor pass it — another PR's full `unit` gate does not spare this one's wait
 * for `Unit Tests`. An Issue with several PRs is not closed by the merge of
 * one: with `--item` the Issue stays open unless `--close <N>` is given (the
 * last PR's call).
 *
 * `git push` here and in publish-pr.mjs goes through pr-common.mjs pushHead (#4162), which sends the
 * checked SHA by itself, so a local HEAD that moved since does not go out.
 *
 * `--queue <entry,...>` (#4277): the entries `<issue>[/<item>][@<pr>]` one after another in this one
 * process, each through the same steps 1-6. Every entry is resolved (PR → branch → worktree) before
 * anything is written; exit 3 and 4 are retried (3: twice, 60 s apart; 4: five times, at once), any
 * other non-zero stops the queue. The queue's state is the run record's `queue` lines (run-log.mjs
 * LOG_STAGES: no HEAD, not progress). docs/orchestrate/ci-merge.md#6-2-マージの列--queue
 *
 * One merge at a time per base: every merge-pr — one PR or a queue — holds the merge lock
 * `merge.<owner>.<repo>.<base>` (machine-lock-sync.mjs: tickets, first come first served) for its
 * whole run. The process that holds it is a process group of its own (the command re-starts itself
 * detached, `CM_MERGE_PR_INNER`), and the lock is recovered only when no process of the group is
 * left, so a push or merge its dead parent left running is never overlapped. A holder that died
 * while writing (`phase` push / merge / close) leaves an unresolved record beside the lock: every
 * later merge-pr on that base stops until a run that names that PR has finished it.
 *
 * Exit code: 0 merged (or already merged), 1 a condition or a command failed,
 * 2 usage error or a dirty tree, 3 the precheck is on hold, 4 the base moved during the CI wait,
 * 124 no CI registered within --register-timeout, or it did not settle within --ci-timeout.
 *
 * Usage:
 *   node scripts/orchestrate/merge-pr.mjs --run-dir <dir> --issues <range> --issue <N> --worktree <path>
 *        [--pr <number>] [--branch <name>] [--base develop] [--repo Kewton/CommandMate]
 *        [--close <N|->] [--last] [--unit-related] [--ci-timeout <sec>] [--register-timeout <sec>] [--poll <sec>] [--item <work item>]
 *        [--merge-lock-timeout <sec>]
 *   node scripts/orchestrate/merge-pr.mjs --run-dir <dir> --issues <range> --queue <issue[/item][@pr],...>
 *        [--close -] [--last] [--unit-related] [--base …] [--repo …] [--ci-timeout …] [--register-timeout …] [--poll …] [--merge-lock-timeout <sec>]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendRecord, findLatest, inItem, latestByStage, readRecords, unmetStage } from './run-log.mjs';
import { verifyEnvState } from './env-manifest.mjs';
import { itemProblem } from './execution-key.mjs';
import { acquireMachineLockSync, describeOwner, lockPathOf, readOwner } from './machine-lock-sync.mjs';
import {
  BUILD_STEPS,
  TO_CI,
  findTestsNaming,
  machineLockRoot,
  main as runPrecheck,
  optionsFromNote,
  parseNote,
  passedGates,
} from './precheck.mjs';
import {
  DEFAULT_BASE_BRANCH,
  DEFAULT_REPO,
  defaultRun,
  defaultSleep,
  dirtyPaths,
  fragmentProblems,
  ghJson,
  ghWrite,
  git,
  itemOption,
  lines,
  markerFiles,
  missingRecords,
  prsOfBranch,
  pushHead,
  withGhRetry,
  workHeadOf,
} from './pr-common.mjs';

export const DEFAULT_CI_TIMEOUT_SEC = 3600;
/** Until a pushed HEAD has any check: GitHub creating the run is not the CI being slow (#4148). */
export const DEFAULT_REGISTER_TIMEOUT_SEC = 600;
export const DEFAULT_POLL_SEC = 30;
export const BASE_MOVED_EXIT = 4;
export const HELD_EXIT = 3;
/** The merge lock's wait (#4277): the default, and the cap a ticket's deadline may be given. */
export const DEFAULT_MERGE_LOCK_TIMEOUT_SEC = 14400;
export const MAX_MERGE_LOCK_TIMEOUT_SEC = 86400;
/** `--queue`'s retries of one entry (#4277): exit 3 twice, 60 s apart; exit 4 five times, at once. */
export const QUEUE_RETRIES = { [HELD_EXIT]: { max: 2, waitSec: 60 }, [BASE_MOVED_EXIT]: { max: 5, waitSec: 0 } };
/** The phases in which the merge lock's holder writes outside: a holder that died in one leaves the write unconfirmed. */
export const WRITE_PHASES = ['push', 'merge', 'close'];
/** Set in the inner process (its own process group) the command re-starts itself as (#4277). */
export const INNER_ENV = 'CM_MERGE_PR_INNER';
export const BUILD_CHECK = 'Build';
export const UNIT_CHECK = 'Unit Tests';
/**
 * What `--last` waits to see registered: every job of .github/workflows/ci-pr.yml, a matrix
 * expanded, because `gh pr checks` lists only what has registered and a job registered late
 * would otherwise be merged past (#4135). merge-pr.test.ts fails when this and the workflow differ.
 */
export const LAST_REQUIRED_CHECKS = [
  'CLAUDE.md size check',
  'orchestrate.md size check',
  'Control character check',
  'Token discipline (raw palette guard + token existence)',
  'Route export guard',
  'Legacy tmux (<3.2) reading-mode no-op',
  'Lint',
  'Type Check',
  'Unit Tests (shard 1/4)',
  'Unit Tests (shard 2/4)',
  'Unit Tests (shard 3/4)',
  'Unit Tests (shard 4/4)',
  UNIT_CHECK,
  'Integration Tests',
  'E2E Tests',
  BUILD_CHECK,
  'Security Audit',
];
/** `bucket` values that settle a check without failing it. */
const SETTLED_OK = ['pass', 'skipping'];

/** The squash commit's subject: the PR title ending in `(#<PR>)`, once. */
export function squashSubject(title, number) {
  const t = String(title ?? '').trim();
  if (!t) return '';
  return t.endsWith(`(#${number})`) ? t : `${t} (#${number})`;
}

/**
 * 6-3 over `gh pr checks --json name,bucket,link`.
 *
 * @param {{ name: string, bucket: string, link?: string }[]} checks
 * @param {{ needBuild: boolean, needUnit: boolean, last: boolean, required?: string[] }} need
 * @returns {{ state: 'fail' | 'pending' | 'ok', failed: typeof checks, waiting: string[], summary: string }}
 */
export function judgeChecks(checks, { needBuild, needUnit, last, required = [] }) {
  const counts = {};
  for (const check of checks) counts[check.bucket] = (counts[check.bucket] ?? 0) + 1;
  const summary = Object.entries(counts).map(([bucket, n]) => `${bucket}:${n}`).join(',') || 'none';
  const failed = checks.filter((check) => check.bucket === 'fail' || check.bucket === 'cancel');
  if (failed.length > 0) return { state: 'fail', failed, waiting: [], summary };
  if (checks.length === 0) return { state: 'pending', failed, waiting: ['(no checks yet)'], summary };
  const waiting = [];
  const passed = (name) => checks.some((check) => check.name === name && check.bucket === 'pass');
  if (last) {
    waiting.push(...checks.filter((check) => !SETTLED_OK.includes(check.bucket)).map((check) => check.name));
    waiting.push(...required.filter((name) => !checks.some((check) => check.name === name)).map((name) => `${name} (not registered)`));
  } else {
    if (needBuild && !passed(BUILD_CHECK)) waiting.push(BUILD_CHECK);
    if (needUnit && !passed(UNIT_CHECK)) waiting.push(UNIT_CHECK);
  }
  return { state: waiting.length > 0 ? 'pending' : 'ok', failed, waiting, summary };
}

/** Workflow run ids in the checks' links (`…/actions/runs/<id>/job/<id>`). */
export function runIdsOf(checks) {
  return [...new Set(checks.map((check) => /\/actions\/runs\/(\d+)/.exec(check.link ?? '')?.[1]).filter(Boolean))];
}

/** GitHub's answer to a re-run of a run still going: not sent, so it is asked again once the run ends (#4162). */
const RUN_STILL_GOING = /already running/i;

/** Of the run ids, those a check still pending belongs to: GitHub would refuse their re-run (#4162). */
export function runsStillGoing(checks, ids) {
  const going = runIdsOf(checks.filter((check) => check.bucket === 'pending'));
  return ids.filter((id) => going.includes(id));
}

/** Whether the contract's test gate was `unit-related` (verify.yaml's or the contract's, wait-verify.mjs's note). */
export function judgedByUnitRelated(verifyRecord) {
  return passedGates(verifyRecord).some((gate) => gate === 'unit-related' || gate === 'unit-related@contract');
}

/**
 * Whether the verification ran the whole unit suite: verify.yaml's `unit`
 * gate passed. A contract-defined `unit@contract` runs the contract's command,
 * not verify.yaml's, so it does not count; `unit-related` and a refactor's
 * lint / typecheck do not either. Anything short of it waits for CI's `Unit Tests`.
 */
export function ranFullUnit(verifyRecord) {
  return passedGates(verifyRecord).includes('unit');
}

/**
 * Whether a precheck record left a heavy step to the PR's CI (`<step>=ci`, `--heavy-to-ci`, #4265).
 * Such a HEAD waits for CI's `Unit Tests` with or without `--last`: no local run tested its tree.
 */
export function leftHeavyToCi(precheckRecord) {
  if (!precheckRecord) return false;
  return Object.values(parseNote(precheckRecord.note)).includes(TO_CI);
}

/** Whether a precheck record built everything CI's `Build` builds (`build`, `build:cli`, `build:server`). */
export function builtLikeCi(precheckRecord) {
  if (!precheckRecord || precheckRecord.result !== 'ok') return false;
  const steps = parseNote(precheckRecord.note);
  return BUILD_STEPS.every((step) => steps[step] === 'ok');
}

const USAGE = `Usage:
  node scripts/orchestrate/merge-pr.mjs --run-dir <dir> --issues <range> --issue <N> --worktree <path>
       [--pr <number>] [--branch <name>] [--base ${DEFAULT_BASE_BRANCH}] [--repo ${DEFAULT_REPO}]
       [--close <N|->] [--last] [--unit-related] [--ci-timeout <sec>] [--register-timeout <sec>] [--poll <sec>] [--item <work item>]
       [--merge-lock-timeout <sec>]
  node scripts/orchestrate/merge-pr.mjs --run-dir <dir> --issues <range> --queue <issue[/item][@pr],...>
       [--close -] [--last] [--unit-related] [--base …] [--repo …] [--ci-timeout …] [--register-timeout …] [--poll …] [--merge-lock-timeout <sec>]`;

const FLAGS = {
  '--run-dir': 'runDir',
  '--issues': 'issues',
  '--issue': 'issue',
  '--worktree': 'worktree',
  '--pr': 'pr',
  '--branch': 'branch',
  '--base': 'base',
  '--repo': 'repo',
  '--close': 'close',
  '--ci-timeout': 'ciTimeout',
  '--register-timeout': 'registerTimeout',
  '--poll': 'poll',
  '--item': 'item',
  '--queue': 'queue',
  '--merge-lock-timeout': 'mergeLockTimeout',
};
/** The single-PR flags `--queue` replaces (each entry names its own). */
const SINGLE_ONLY = ['--issue', '--worktree', '--pr', '--branch', '--item'];
const ENTRY_PATTERN = /^(\d+)(?:\/([^@/,\s]+))?(?:@(\d+))?$/;

/**
 * `--queue`'s entries: `<issue>[/<item>][@<pr>]`, comma-separated (#4277).
 *
 * @returns {{ entries: { text: string, issue: number, item: string | null, pr: number | null }[] } | { error: string }}
 */
export function parseQueue(text) {
  const entries = [];
  for (const raw of String(text ?? '').split(',')) {
    const part = raw.trim();
    const m = ENTRY_PATTERN.exec(part);
    if (!m) return { error: `--queue: ${part || '(empty)'} is not <issue>[/<item>][@<pr>]` };
    const problem = itemProblem(m[2]);
    if (problem) return { error: `--queue: ${part}: ${problem}` };
    entries.push({ text: part, issue: Number(m[1]), item: m[2] ?? null, pr: m[3] ? Number(m[3]) : null });
  }
  // Two entries are one unit when nothing tells their PRs apart; two named PRs of one Issue are two (#4277, review 2 finding 4).
  const seen = new Set();
  for (const entry of entries) {
    const key = `${entry.issue}/${entry.item ?? ''}@${entry.pr ?? '?'}`;
    if (seen.has(key)) return { error: `--queue: ${entry.text} is given twice` };
    seen.add(key);
  }
  for (const entry of entries.filter((e) => e.pr === null)) {
    if (entries.some((other) => other !== entry && other.issue === entry.issue && other.item === entry.item)) {
      return { error: `--queue: ${entry.text} and another entry are the same unit — name each PR (${entry.issue}${entry.item ? `/${entry.item}` : ''}@<pr>)` };
    }
  }
  return { entries };
}
const SWITCHES = { '--last': 'last', '--unit-related': 'unitRelated' };

/** The merge lock of a base (#4277): `merge.<owner>.<repo>.<base>` in the lock name's alphabet, 64 characters at most. */
export function mergeLockName(repo, base) {
  const name = `merge.${repo}.${base}`.replace(/\//g, '.').replace(/[^A-Za-z0-9_.-]/g, '_');
  if (name.length <= 64) return name;
  return `${name.slice(0, 51)}.${crypto.createHash('sha1').update(name).digest('hex').slice(0, 12)}`;
}

export function parseArgs(argv) {
  const options = {
    base: DEFAULT_BASE_BRANCH,
    repo: DEFAULT_REPO,
    last: false,
    unitRelated: false,
    ciTimeout: String(DEFAULT_CI_TIMEOUT_SEC),
    registerTimeout: String(DEFAULT_REGISTER_TIMEOUT_SEC),
    poll: String(DEFAULT_POLL_SEC),
    mergeLockTimeout: String(DEFAULT_MERGE_LOCK_TIMEOUT_SEC),
    close: /** @type {string | undefined} */ (undefined),
    queue: /** @type {string | undefined} */ (undefined),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (SWITCHES[arg]) options[SWITCHES[arg]] = true;
    else if (FLAGS[arg] && i + 1 < argv.length) options[FLAGS[arg]] = argv[++i];
    else return { error: `unknown or incomplete argument: ${arg}` };
  }
  if (options.queue !== undefined) {
    for (const flag of ['--run-dir', '--issues']) {
      if (!options[FLAGS[flag]]) return { error: `${flag} is required` };
    }
    const combined = SINGLE_ONLY.find((flag) => options[FLAGS[flag]] !== undefined);
    if (combined) return { error: `--queue cannot be combined with ${combined} (each entry names its own)` };
    if (options.close !== undefined && options.close !== '-') return { error: `--queue takes --close - or none (got --close ${options.close})` };
    // The entries are read by main (parseQueue), so orchestrate.md's `--queue "$MERGE_ISSUES"` can be checked as written.
    options.item = null;
    return { options };
  }
  for (const flag of ['--run-dir', '--issues', '--issue', '--worktree']) {
    if (!options[FLAGS[flag]]) return { error: `${flag} is required` };
  }
  const item = itemOption(options);
  if ('error' in item) return { error: item.error };
  options.item = item.item;
  // One PR of several does not close the Issue; the last one's call names it (#3883).
  options.close = options.close ?? (options.item ? '-' : options.issue);
  return { options };
}

/** Values a shell would have expanded; parseArgs takes `$issue` as written so orchestrate.md's calls can be checked. */
export function validate(options) {
  if (!/^\d+$/.test(options.issue)) return `--issue must be an Issue number (got ${options.issue})`;
  if (options.close !== '-' && !/^\d+$/.test(options.close)) return `--close must be an Issue number or - (got ${options.close})`;
  if (options.pr !== undefined && !/^\d+$/.test(options.pr)) return `--pr must be a PR number (got ${options.pr})`;
  return validateShared(options);
}

/** What one PR and a queue check alike. */
function validateShared(options) {
  for (const flag of ['--ci-timeout', '--register-timeout', '--poll', '--merge-lock-timeout']) {
    if (!/^\d+$/.test(options[FLAGS[flag]])) return `${flag} must be seconds (got ${options[FLAGS[flag]]})`;
  }
  if (Number(options.mergeLockTimeout) > MAX_MERGE_LOCK_TIMEOUT_SEC) {
    return `--merge-lock-timeout must be at most ${MAX_MERGE_LOCK_TIMEOUT_SEC} (got ${options.mergeLockTimeout})`;
  }
  return null;
}

/**
 * @param {string[]} argv
 * @param {{
 *   run?: typeof defaultRun,
 *   sleep?: (ms: number) => void,
 *   now?: () => Date,
 *   findTestsNaming?: typeof findTestsNaming,
 *   acquireHeavyLock?: (timeoutMs: number) => { acquired: boolean, waitedMs: number, heldBy: string | null, release: () => void },
 *   estimateRelatedTests?: (worktree: string, sources: string[]) => number,
 *   home?: string,
 *   log?: (line: string) => void,
 *   error?: (line: string) => void,
 *   runPrecheck?: typeof runPrecheck,
 *   lockRoot?: string,
 *   repoDir?: string,
 *   pgid?: number,
 *   lockSleep?: (ms: number) => void,
 *   acquireMergeLock?: typeof acquireMachineLockSync,
 *   mergeOne?: (options: any, deps: any) => number,
 * }} [deps]
 * @returns {number} exit code
 */
export function main(argv, deps = {}) {
  const { sleep = defaultSleep } = deps;
  const error = deps.error ?? ((line) => console.error(line));
  // GitHub's 5xx and dropped connections are asked again for reads, and said so; writes
  // are sent once and read back through ghWrite (#3633 D).
  const run = withGhRetry(deps.run ?? defaultRun, { sleep, notice: error });

  const parsed = parseArgs(argv);
  if (parsed.error) {
    error(`${parsed.error}\n${USAGE}`);
    return 2;
  }
  const o = parsed.options;
  if (o.queue !== undefined) {
    const queue = parseQueue(o.queue);
    if ('error' in queue) {
      error(`${queue.error}\n${USAGE}`);
      return 2;
    }
    o.entries = queue.entries;
  }
  const invalid = o.entries ? validateShared(o) : validate(o);
  if (invalid) {
    error(`${invalid}\n${USAGE}`);
    return 2;
  }
  const inner = { ...deps, run, error, log: deps.log ?? ((line) => console.log(line)), now: deps.now ?? (() => new Date()) };
  return o.entries ? runQueue(o, inner) : runOne(o, inner);
}

/**
 * Steps 1-6 for one PR (`o` is parseArgs' single-PR options). The caller holds the merge lock;
 * `deps.phase` is told before each write outside (push, merge, close) and `deps.beforeWrite`
 * may stop the PR before anything is written (an unresolved write of another PR, #4277).
 *
 * @returns {number} exit code
 */
export function mergeOne(o, deps) {
  const { sleep = defaultSleep, now = () => new Date(), run } = deps;
  const findNaming = deps.findTestsNaming ?? findTestsNaming;
  const log = deps.log ?? ((line) => console.log(line));
  const error = deps.error ?? ((line) => console.error(line));
  const phase = deps.phase ?? (() => {});
  const issue = Number(o.issue);
  const item = o.item;
  const baseRef = `origin/${o.base}`;
  const started = now();

  const record = (stage, result, head, note, workHead = null) => {
    const durationSec = Math.round((now().getTime() - started.getTime()) / 1000);
    const { file } = appendRecord(o.runDir, o.issues, { issue, item, stage, result, head, workHead, durationSec, note }, now());
    log(`${stage} #${issue} ${head.slice(0, 7)} ${result}: ${note} -> ${file}`);
  };

  /** Close the Issue unless `--close -`; a closed one is left as it is. */
  const closeIssue = (prNumber) => {
    if (o.close === '-') return 'kept-open';
    const state = ghJson(run, ['issue', 'view', o.close, '--repo', o.repo, '--json', 'state']).state;
    if (state !== 'OPEN') return 'already-closed';
    const closed = ghWrite(run, ['issue', 'close', o.close, '--repo', o.repo, '--comment', `#${prNumber} でマージした。`], {
      notice: error,
      confirm: () => (ghJson(run, ['issue', 'view', o.close, '--repo', o.repo, '--json', 'state']).state === 'CLOSED' ? '' : null),
    });
    if (closed.status !== 0) throw new Error(`gh issue close ${o.close} failed: ${(closed.stderr || closed.stdout).trim()}`);
    return 'closed';
  };

  try {
    const branch = o.branch ?? git(run, o.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const viewPr = (ref) =>
      ghJson(run, ['pr', 'view', String(ref), '--repo', o.repo, '--json', 'number,state,headRefOid,url,headRefName,title']);
    let pr;
    if (o.pr) pr = viewPr(o.pr);
    else {
      const { open, merged } = prsOfBranch(run, o.repo, branch);
      pr = open ?? merged;
      if (!pr) {
        error(`merge #${issue}: no PR for ${branch} — run publish-pr.mjs first`);
        return 1;
      }
    }

    const stop = deps.beforeWrite?.(pr.number);
    if (stop) {
      error(`merge #${issue}: ${stop}`);
      return 1;
    }
    phase('refresh', { pr: pr.number });

    // 1. Never merge twice: finish what a merged PR leaves (the record, the Issue).
    if (pr.state === 'MERGED') {
      phase('close');
      const { records } = readRecords(o.runDir, o.issues);
      if (!findLatest(records, { issue, item, stage: 'merge', head: pr.headRefOid, result: 'ok' })) {
        record('merge', 'ok', pr.headRefOid, `pr=#${pr.number} already-merged`);
      }
      log(`merge #${issue}: #${pr.number} is already merged — issue ${o.close}: ${closeIssue(pr.number)}`);
      return 0;
    }
    if (pr.state !== 'OPEN') {
      error(`merge #${issue}: #${pr.number} is ${pr.state}, not open`);
      return 1;
    }

    // 2. The tree is what the records and the PR describe.
    let head = git(run, o.worktree, ['rev-parse', 'HEAD']).trim();
    const dirty = dirtyPaths(run, o.worktree);
    if (dirty.length > 0) {
      error(`merge #${issue}: uncommitted changes in ${o.worktree}:\n  ${dirty.join('\n  ')}`);
      return 2;
    }

    // 3. The records of the work, and the fragments. The precheck of the HEAD
    //    to merge is step 4's: that HEAD may not exist yet.
    let { records } = readRecords(o.runDir, o.issues);
    // pr-common.mjs workHeadOf, the rule publish-pr and precheck use: a merge the worker was verified on is the work HEAD (#4076).
    let workHead = workHeadOf(run, o.worktree, head, { records, issue, item });
    const envWhere = { runDir: o.runDir, worktree: o.worktree, home: deps.home ?? os.homedir() };
    // A verify of an earlier HEAD that differs only in the dependencies waits for step 4's precheck (#3883 N10).
    const deferred = [];
    const problems = [
      ...missingRecords(records, issue, { head, workHead }, item, {
        ...envWhere, warn: log, defer: (reason) => deferred.push(reason),
      }).filter((reason) => !reason.startsWith('precheck:')),
      ...fragmentProblems(run, { worktree: o.worktree, runDir: o.runDir, issue, baseRef, item }),
    ];
    if (problems.length > 0) {
      error(`merge #${issue} ${head.slice(0, 7)}: not merged — the run record or the PR lacks:\n  ${problems.join('\n  ')}`);
      return 1;
    }

    // 4. 6-2's refresh, then the local gate on the HEAD to merge.
    git(run, o.worktree, ['fetch', 'origin', o.base]);
    let refreshed = false;
    const behind = run('git', ['-C', o.worktree, 'merge-base', '--is-ancestor', baseRef, 'HEAD']).status !== 0;
    if (behind) {
      const merge = run('git', ['-C', o.worktree, 'merge', '--no-edit', baseRef]);
      if (merge.status !== 0) {
        const conflicts = lines(run('git', ['-C', o.worktree, 'diff', '--name-only', '--diff-filter=U']).stdout);
        run('git', ['-C', o.worktree, 'merge', '--abort']);
        record('merge', 'fail', head, `refresh=conflict ${conflicts.join(',') || '-'}`, workHead);
        error(`merge #${issue}: ${baseRef} conflicts in ${conflicts.join(', ') || '(see git)'} — resolve by meaning (6-2), commit, and run again`);
        return 1;
      }
      refreshed = true;
      head = git(run, o.worktree, ['rev-parse', 'HEAD']).trim();
      // The work HEAD under the refresh, by the same rule: a refresh whose own change cannot be
      // judged (merge-tree failed) is its own work HEAD, not the one step 3 judged (#4076).
      workHead = workHeadOf(run, o.worktree, head, { records, issue, item });
      // So the worker's stages are judged again at the HEADs now in hand, as publish-pr and
      // `status` would judge them; the deferred verify is the one of this work HEAD.
      deferred.length = 0;
      const again = missingRecords(records, issue, { head, workHead }, item, {
        ...envWhere, warn: log, defer: (reason) => deferred.push(reason),
      }).filter((reason) => !reason.startsWith('precheck:'));
      if (again.length > 0) {
        // The stop is recorded at the HEADs computed here (#4085): without it `status` (headsOf,
        // which reads only the record) keeps W and points past M's own verify. The work HEAD is
        // workHeadOf's answer, never `head` by default — a clean refresh stays on W. The stage is
        // the existing merge failure, not a precheck that did not run.
        record('merge', 'fail', head, `refresh=merged record=missing ${again.map((reason) => reason.split(':')[0]).join(',')}`, workHead);
        error(
          `merge #${issue} ${head.slice(0, 7)}: not merged — the refresh is the work HEAD ${workHead.slice(0, 7)} and the run record lacks:\n  ${again.join('\n  ')}\n` +
            `  (not pushed; the refresh is left committed in ${o.worktree})`
        );
        return 1;
      }
    }
    const markers = markerFiles(run, o.worktree);
    if (markers.length > 0) {
      record('merge', 'fail', head, `refresh=${refreshed ? 'merged' : '-'} marker=fail ${markers.join(',')}`, workHead);
      error(`merge #${issue}: conflict markers in ${markers.join(', ')} at ${head.slice(0, 7)} — not pushed`);
      return 1;
    }
    // The precheck is recorded per HEAD, so a HEAD pushed earlier (publish-pr.mjs
    // after a refresh) is checked here too unless it already passed — in this
    // environment (#3883 N9: precheck.mjs runs it again when the inputs moved).
    const headPrecheck = latestByStage(records, issue, item).precheck;
    const precheckEnv = headPrecheck ? verifyEnvState(headPrecheck, { runDir: o.runDir, worktree: o.worktree, home: deps.home ?? os.homedir() }) : null;
    if (precheckEnv?.state === 'unrecorded') log(`merge #${issue}: warning: precheck at ${head.slice(0, 7)}: ${precheckEnv.detail}`);
    for (const reason of deferred) log(`merge #${issue}: ${reason}`);
    if (
      unmetStage('precheck', headPrecheck, { head, workHead }) ||
      precheckEnv?.state === 'changed' ||
      precheckEnv?.state === 'missing' ||
      deferred.length > 0
    ) {
      // The options come from the precheck of the work HEAD; when a fold commit on top made the
      // precheck run on the published HEAD only, from the Issue's latest precheck=ok (any HEAD).
      // Without either the options would be guessed (kind lost → suppressions=skip): stop (#3527).
      const workPrecheck =
        findLatest(records, { issue, item, stage: 'precheck', head: workHead, result: 'ok' }) ??
        findLatest(records, { issue, item, stage: 'precheck', result: 'ok' });
      if (!workPrecheck) {
        error(`merge #${issue}: no precheck=ok record to take the options from (kind etc.) — run precheck.mjs on the work HEAD first; not pushed`);
        return 1;
      }
      phase('precheck');
      const code = (deps.runPrecheck ?? runPrecheck)(
        [
          '--run-dir', o.runDir, '--issues', o.issues, '--issue', String(issue), '--worktree', o.worktree,
          ...optionsFromNote(workPrecheck.note, baseRef),
          // The HEAD this run's refresh made: the heavy steps are the PR's CI's on this very HEAD,
          // which step 5 waits for before the merge — not cpu.heavy's here (#4265).
          ...(refreshed ? ['--heavy-to-ci'] : []),
          ...(item ? ['--item', item] : []),
        ],
        {
          run, now, log, error, findTestsNaming: findNaming, home: deps.home,
          // Test seams of precheck.mjs main, passed through when given.
          ...(deps.acquireHeavyLock ? { acquireHeavyLock: deps.acquireHeavyLock } : {}),
          ...(deps.estimateRelatedTests ? { estimateRelatedTests: deps.estimateRelatedTests } : {}),
        }
      );
      if (code === 3) {
        // precheck exit 3: a heavy step could not take the machine lock — undecided, not failed.
        error(`merge #${issue}: the precheck of ${head.slice(0, 7)} is on hold (the heavy-step lock was not taken) — not pushed; run merge-pr again to continue`);
        return 3;
      }
      if (code !== 0) {
        error(`merge #${issue}: the precheck of ${head.slice(0, 7)} did not pass${refreshed ? ' after the refresh' : ''} — not pushed`);
        return 1;
      }
    }
    if (deferred.length > 0) {
      // The precheck of this HEAD passed in this environment: the verify's environment is judged again, now without deferring.
      records = readRecords(o.runDir, o.issues).records;
      const still = missingRecords(records, issue, { head, workHead }, item, { ...envWhere, warn: log }).filter((reason) => reason.startsWith('verify:'));
      if (still.length > 0) {
        error(`merge #${issue} ${head.slice(0, 7)}: not merged — after the precheck the run record still lacks:\n  ${still.join('\n  ')}`);
        return 1;
      }
    }
    if (head !== pr.headRefOid) {
      phase('push');
      const push = pushHead(run, o.worktree, { branch, head, sleep, notice: error });
      if (push.status !== 0) throw new Error(`git push failed: ${(push.stderr || push.stdout).trim()}`);
      log(`merge #${issue}: refresh=${refreshed ? 'merged' : 'unpushed'} marker=ok precheck=ok; pushed ${head.slice(0, 7)}`);
    }

    // 5. The checks of this HEAD.
    phase('ci-wait');
    records = readRecords(o.runDir, o.issues).records;
    const headPrecheckNow = findLatest(records, { issue, item, stage: 'precheck', head });
    const needBuild = !builtLikeCi(headPrecheckNow);
    // The verify judged at the work HEAD (step 3, or again after the refresh): whether it ran the
    // full unit suite. A latest verify of another HEAD is not that one, and does not spare the wait (#4076).
    const latestVerify = latestByStage(records, issue, item).verify ?? null;
    const verify = latestVerify && unmetStage('verify', latestVerify, { head, workHead }) === null ? latestVerify : null;
    // A HEAD whose precheck left the heavy steps to CI (the refresh's, #4265) is the combination no
    // local test has seen: the worker's full unit ran on the work HEAD, not on it — wait for `Unit Tests`.
    const heavyToCi = leftHeavyToCi(headPrecheckNow);
    const need = {
      needBuild,
      needUnit: o.unitRelated || heavyToCi || !ranFullUnit(verify),
      last: o.last,
      required: o.last ? LAST_REQUIRED_CHECKS : [],
    };
    const rerunDone = records.some(
      (r) => r.issue === issue && inItem(r, item) && r.stage === 'ci' && r.head === head && /(^| )rerun=/.test(r.note ?? '')
    );
    let rerun = rerunDone;
    // The runs whose end the re-run is waiting for; only ever set at a look where current.headRefOid === head.
    let rerunWait = [];
    const registerDeadline = now().getTime() + Number(o.registerTimeout) * 1000;
    // Starts when this HEAD has its first check: until then the wait is GitHub's, not the CI's.
    let ciDeadline = null;
    let baseUnread = false;
    let verdict;
    let title = pr.title;
    for (;;) {
      const current = viewPr(pr.number);
      title = current.title ?? title;
      if (current.state === 'MERGED') {
        phase('close');
        record('merge', 'ok', current.headRefOid, `pr=#${pr.number} merged-elsewhere`, current.headRefOid === head ? workHead : null);
        log(`merge #${issue}: #${pr.number} was merged meanwhile — issue ${o.close}: ${closeIssue(pr.number)}`);
        return 0;
      }
      if (current.headRefOid !== head && rerunWait.length > 0) {
        record('ci', 'fail', head, `pr=#${pr.number} head-moved ${current.headRefOid.slice(0, 7)}`, workHead);
        error(`merge #${issue}: the PR head moved to ${current.headRefOid.slice(0, 7)} while run ${rerunWait.join(',')} was finishing — not re-run, not merged; run again on the new HEAD`);
        return 1;
      }
      if (current.headRefOid === head) {
        // gh pr checks exits 8 while checks are pending; the JSON is still on stdout.
        const out = run('gh', ['pr', 'checks', String(pr.number), '--repo', o.repo, '--json', 'name,bucket,link']);
        let checks = null;
        try {
          checks = JSON.parse(out.stdout);
        } catch {
          checks = out.stderr.includes('no checks') ? [] : null;
        }
        if (checks === null) throw new Error(`gh pr checks ${pr.number} failed: ${(out.stderr || out.stdout).trim()}`);
        // The HEAD being waited for was refreshed on the base as it was then (step 4). Read after the
        // checks, so nothing of the base goes unread between the last green answer and the merge:
        // --match-head-commit pins the PR's head, not the base. A rerun is not sent for a stale HEAD either.
        // Asked of `head`, the SHA that merge names: the worktree's HEAD can move on its own during the wait.
        baseUnread = run('git', ['-C', o.worktree, 'fetch', 'origin', o.base]).status !== 0;
        if (!baseUnread && run('git', ['-C', o.worktree, 'merge-base', '--is-ancestor', baseRef, head]).status !== 0) {
          record('merge', 'fail', head, `pr=#${pr.number} base-moved`, workHead);
          error(`merge #${issue}: ${baseRef} moved during the CI wait — not merged; run again to refresh ${head.slice(0, 7)} on it (6-2)`);
          return BASE_MOVED_EXIT;
        }
        if (ciDeadline === null && checks.length > 0) ciDeadline = now().getTime() + Number(o.ciTimeout) * 1000;
        verdict = judgeChecks(checks, need);
        rerunWait = [];
        if (verdict.state === 'fail') {
          const names = verdict.failed.map((check) => `${check.name}:${check.bucket}`).join(',');
          const ids = runIdsOf(verdict.failed);
          if (rerun || ids.length === 0) {
            record('ci', 'fail', head, `checks=${verdict.summary} failed=${names}${rerun ? ' after-rerun' : ''}`, workHead);
            error(`merge #${issue}: not merged — ${names} (6-3)`);
            return 1;
          }
          rerunWait = runsStillGoing(checks, ids);
          if (rerunWait.length > 0) {
            log(`merge #${issue}: ${names} — waiting for run ${rerunWait.join(',')} to finish before re-running it (--ci-timeout ${o.ciTimeout}s)`);
          }
          const sent = [];
          for (const id of rerunWait.length > 0 ? [] : ids) {
            // A rerun that is accepted raises the run's attempt number, whatever
            // its status: `completed` is both "before the rerun" and "the rerun
            // already finished". The attempt is read before sending; when it
            // cannot be read, a failed answer is not taken as accepted.
            const attemptOf = () => {
              const n = Number(ghJson(run, ['run', 'view', id, '--repo', o.repo, '--json', 'attempt']).attempt);
              return Number.isInteger(n) && n > 0 ? n : null;
            };
            let before = null;
            try {
              before = attemptOf();
            } catch {
              // unreadable: a failed answer is then never taken as accepted
            }
            const again = ghWrite(run, ['run', 'rerun', id, '--failed', '--repo', o.repo], {
              notice: error,
              confirm: () => {
                if (before === null) return null;
                const after = attemptOf();
                return after !== null && after > before ? '' : null;
              },
            });
            if (again.status !== 0) {
              // Not sent. A run this look did not see as going: asked again at a later look, under the same deadline.
              if (RUN_STILL_GOING.test(`${again.stderr}\n${again.stdout}`)) {
                rerunWait = [id];
                break;
              }
              if (sent.length > 0) record('ci', 'fail', head, `checks=${verdict.summary} failed=${names} rerun=${sent.join(',')}`, workHead);
              throw new Error(`gh run rerun ${id} failed: ${(again.stderr || again.stdout).trim()}`);
            }
            sent.push(id);
          }
          // Once per HEAD, by what was sent: a run refused above does not count unless another was accepted.
          if (sent.length > 0) {
            rerun = true;
            rerunWait = [];
            record('ci', 'fail', head, `checks=${verdict.summary} failed=${names} rerun=${sent.join(',')}`, workHead);
          }
        } else if (verdict.state === 'ok' && !baseUnread) break;
      }
      if (ciDeadline === null && now().getTime() >= registerDeadline) {
        error(`merge #${issue}: no CI registered on ${head.slice(0, 7)} within ${o.registerTimeout}s (--register-timeout; the PR head is ${current.headRefOid.slice(0, 7)})`);
        return 124;
      }
      if (ciDeadline !== null && now().getTime() >= ciDeadline) {
        const waitingFor = rerunWait.length > 0
          ? `run ${rerunWait.join(',')} to finish before re-running it`
          : verdict.state === 'ok' ? `git fetch origin ${o.base}` : verdict.waiting.join(', ');
        error(`merge #${issue}: CI did not settle within ${o.ciTimeout}s (waiting for ${waitingFor})`);
        return 124;
      }
      sleep(Number(o.poll) * 1000);
    }
    record('ci', 'ok', head, `checks=${verdict.summary} build=${needBuild ? 'pass' : 'precheck'} unit=${need.needUnit ? 'pass' : '-'}${o.last ? ' last=all-pass' : ''}`, workHead);

    // 6. Merge exactly this HEAD, then the Issue.
    // The squash commit is named after the PR (publish-pr titles it), also over
    // a fold or a refresh: the subject is the PR's own title, as read on the last look at it.
    const subject = squashSubject(title, pr.number);
    phase('merge');
    const merged = ghWrite(run, [
      'pr', 'merge', String(pr.number), '--repo', o.repo, '--squash', '--match-head-commit', head,
      ...(subject ? ['--subject', subject] : []),
    ], {
      notice: error,
      confirm: () => {
        const after = viewPr(pr.number);
        return after.state === 'MERGED' && after.headRefOid === head ? '' : null;
      },
    });
    if (merged.status !== 0) {
      record('merge', 'fail', head, `pr=#${pr.number} gh-merge-failed`, workHead);
      error(`merge #${issue}: gh pr merge failed: ${(merged.stderr || merged.stdout).trim()}`);
      return 1;
    }
    record('merge', 'ok', head, `pr=#${pr.number} squash`, workHead);
    phase('close');
    log(`merge #${issue}: #${pr.number} merged — issue ${o.close}: ${closeIssue(pr.number)}`);
    return 0;
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

// ---------------------------------------------------------------------------
// The merge lock, and what a dead holder left unresolved (#4277)
// ---------------------------------------------------------------------------

const unresolvedDir = (root, name) => path.join(root, `${name}.unresolved`);

/**
 * The writes of dead merge lock holders that nobody has confirmed: one file per dead holder, kept
 * until a merge-pr that names that PR ends with 0. Read by every merge-pr on the base (Codex review 2
 * finding 2: the stop must not be lost to the one run that happened to recover the lock).
 *
 * @returns {{ file: string, owner: any }[]}
 */
export function readUnresolved(root, name) {
  const dir = unresolvedDir(root, name);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((entry) => entry.endsWith('.json')).sort();
  } catch {
    return [];
  }
  return names.flatMap((entry) => {
    const file = path.join(dir, entry);
    try {
      return [{ file, owner: JSON.parse(fs.readFileSync(file, 'utf8')) }];
    } catch {
      // Unreadable: still a stop, named by its file.
      return [{ file, owner: { phase: 'unknown', pr: null, issue: null } }];
    }
  });
}

/** Written before the dead holder's lock is removed, so a recoverer that dies here leaves the stop behind. */
function persistUnresolved(root, name, owner) {
  const dir = unresolvedDir(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${String(owner.token).replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify({ ...owner, recoveredAt: new Date().toISOString(), recoveredBy: process.pid }), { flag: 'wx' });
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }
  return file;
}

const describeUnresolved = (owner) =>
  `#${owner.issue ?? '?'}${owner.item ? `/${owner.item}` : ''} (pr=#${owner.pr ?? '?'}) phase=${owner.phase ?? '?'}`;

/**
 * Take the merge lock of `o.repo` / `o.base` (machine-lock-sync.mjs, ticket order). The owner names
 * this process group, so the lock outlives a dead parent while its git / gh children still run.
 */
function takeMergeLock(o, deps, recovered) {
  const root = deps.lockRoot ?? machineLockRoot(deps.home ?? os.homedir());
  const name = mergeLockName(o.repo, o.base);
  const acquire = deps.acquireMergeLock ?? acquireMachineLockSync;
  const lock = acquire(name, {
    root,
    timeoutMs: Number(o.mergeLockTimeout) * 1000,
    ...(deps.pgid ? { pgid: deps.pgid } : {}),
    ...(deps.lockSleep ? { sleep: deps.lockSleep } : {}),
    ownerFields: { phase: 'idle', repo: o.repo, base: o.base },
    warn: (line) => deps.log(`merge lock: ${line}`),
    onStaleHolder: (owner) => {
      const write = WRITE_PHASES.includes(owner.phase);
      recovered.push({ owner, write, file: write ? persistUnresolved(root, name, owner) : null });
    },
  });
  return { lock, root, name };
}

function heldByLine(root, name, lock) {
  const owner = readOwner(lockPathOf(root, name));
  if (!owner) return lock.heldBy ?? 'nobody readable';
  return `${describeOwner(owner)}${owner.pgid ? ` (pgid ${owner.pgid})` : ''}, phase ${owner.phase ?? '-'}${owner.pr ? ` pr=#${owner.pr}` : ''}`;
}

/** One PR under the merge lock: the call before #4277, with the lock and the unresolved check around it. */
function runOne(o, deps) {
  const recovered = [];
  const { lock, root, name } = takeMergeLock(o, deps, recovered);
  if (!lock.acquired) {
    deps.error(`merge #${o.issue}: merge lock ${name} held by ${heldByLine(root, name, lock)} for ${Math.round(lock.waitedMs / 1000)}s (--merge-lock-timeout ${o.mergeLockTimeout}) — not started`);
    return 124;
  }
  try {
    for (const r of recovered) deps.log(`merge #${o.issue}: recovered the merge lock of a dead holder ${describeUnresolved(r.owner)}${r.write ? ' — its write is unconfirmed' : ''}`);
    let mine = [];
    const code = mergeOne(o, {
      ...deps,
      phase: (p, fields = {}) => lock.setOwnerFields({ phase: p, entry: o.item ? `${o.issue}/${o.item}` : String(o.issue), issue: Number(o.issue), item: o.item, ...fields }),
      beforeWrite: (prNumber) => {
        const pending = readUnresolved(root, name);
        const others = pending.filter((u) => u.owner.pr !== prNumber);
        if (others.length > 0) {
          return `not started — a merge-pr died while writing ${others.map((u) => describeUnresolved(u.owner)).join(', ')}; run merge-pr on that PR first (${others.map((u) => u.file).join(', ')})`;
        }
        mine = pending;
        return null;
      },
    });
    if (code === 0) for (const u of mine) fs.rmSync(u.file, { force: true });
    return code;
  } finally {
    lock.setOwnerFields({ phase: 'idle' });
    lock.release();
  }
}

/** `git worktree list --porcelain` → { path, branch } (branch without refs/heads/). */
export function parseWorktreeList(text) {
  const out = [];
  for (const block of String(text ?? '').split(/\n\s*\n/)) {
    const wt = /^worktree (.+)$/m.exec(block)?.[1];
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (wt) out.push({ path: wt.trim(), branch: branch ? branch.trim() : null });
  }
  return out;
}

/**
 * Every entry's PR → branch → worktree, before anything is written (#4277, design §3.1). Reads only:
 * the run record's `pr` stage, `gh pr view` and `git worktree list`.
 *
 * @returns {{ resolved: any[] } | { problems: string[] }}
 */
export function resolveEntries(o, deps) {
  const { run } = deps;
  const { records } = readRecords(o.runDir, o.issues);
  const problems = [];
  let worktrees = null;
  const listWorktrees = () => {
    if (worktrees === null) {
      const out = run('git', ['-C', deps.repoDir ?? process.cwd(), 'worktree', 'list', '--porcelain']);
      if (out.status !== 0) throw new Error(`git worktree list failed: ${out.stderr.trim()}`);
      worktrees = parseWorktreeList(out.stdout);
    }
    return worktrees;
  };
  const resolved = [];
  for (const entry of o.entries) {
    let prNumber = entry.pr;
    if (prNumber === null) {
      const named = new Set(
        records
          .filter((r) => r.issue === entry.issue && r.stage === 'pr' && inItem(r, entry.item))
          .map((r) => /(?:^|\s)pr=#(\d+)\b/.exec(r.note ?? '')?.[1])
          .filter(Boolean)
      );
      if (named.size === 0) {
        problems.push(`${entry.text}: the run record has no pr=#N for it — run publish-pr.mjs first, or name it ${entry.text}@<pr>`);
        continue;
      }
      if (named.size > 1) {
        problems.push(`${entry.text}: the run record names ${[...named].map((n) => `#${n}`).join(' and ')} — name each as ${entry.text}@<pr>`);
        continue;
      }
      prNumber = Number([...named][0]);
    }
    let pr;
    try {
      pr = ghJson(run, ['pr', 'view', String(prNumber), '--repo', o.repo, '--json', 'number,state,headRefOid,headRefName']);
    } catch (err) {
      problems.push(`${entry.text}: gh pr view ${prNumber}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (pr.state === 'MERGED') {
      // Recorded and closed only (step 1): a worktree cleaned up after the merge does not stop a resumed queue.
      resolved.push({ ...entry, pr: prNumber, branch: pr.headRefName ?? null, worktree: null, merged: true });
      continue;
    }
    if (pr.state !== 'OPEN') {
      problems.push(`${entry.text}: #${prNumber} is ${pr.state}`);
      continue;
    }
    const matches = listWorktrees().filter((wt) => wt.branch === pr.headRefName);
    if (matches.length !== 1) {
      problems.push(`${entry.text}: ${matches.length === 0 ? 'no worktree' : `${matches.length} worktrees`} on ${pr.headRefName} (#${prNumber})`);
      continue;
    }
    resolved.push({ ...entry, pr: prNumber, branch: pr.headRefName, worktree: matches[0].path, merged: false });
  }
  const numbers = resolved.map((e) => e.pr);
  for (const [i, n] of numbers.entries()) {
    if (numbers.indexOf(n) !== i) problems.push(`#${n} is named by two entries (${resolved.filter((e) => e.pr === n).map((e) => e.text).join(', ')})`);
  }
  if (problems.length > 0) return { problems };
  // Only the last entry of an Issue closes it, and only an entry without a work item (the rule of a
  // single call, #3883): earlier PRs of the Issue leave it open (review 2 finding 4).
  return {
    resolved: resolved.map((entry, i) => ({
      ...entry,
      close:
        o.close === '-' || entry.item !== null || resolved.slice(i + 1).some((later) => later.issue === entry.issue) ? '-' : String(entry.issue),
    })),
  };
}

/**
 * `--queue`: the entries one after another under one merge lock (#4277, design §3).
 *
 * @returns {number} exit code
 */
export function runQueue(o, deps) {
  const { now, log, error } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  let resolution;
  try {
    resolution = resolveEntries(o, deps);
  } catch (err) {
    error(`merge --queue: ${err instanceof Error ? err.message : String(err)} — nothing was changed`);
    return 1;
  }
  if ('problems' in resolution) {
    error(`merge --queue ${o.queue}: not started, nothing was changed:\n  ${resolution.problems.join('\n  ')}`);
    return 2;
  }
  const entries = resolution.resolved;
  const total = entries.length;
  const record = (entry, result, state, extra = '') => {
    const pos = entries.indexOf(entry) + 1;
    const note = `state=${state} queue=${o.queue} pos=${pos}/${total} pr=#${entry.pr}${extra ? ` ${extra}` : ''}`;
    appendRecord(o.runDir, o.issues, { issue: entry.issue, item: entry.item, stage: 'queue', result, note }, now());
    log(`queue #${entry.issue}${entry.item ? `/${entry.item}` : ''} ${state}: ${note}`);
  };
  for (const entry of entries) {
    record(entry, 'skip', 'waiting', `branch=${entry.branch ?? '-'} worktree=${entry.worktree ?? '-'}${entry.merged ? ' merged=yes' : ''}`);
  }

  const recovered = [];
  const { lock, root, name } = takeMergeLock(o, deps, recovered);
  if (!lock.acquired) {
    const holder = heldByLine(root, name, lock);
    record(entries[0], 'fail', 'lock-timeout', `waited=${Math.round(lock.waitedMs / 1000)}s`);
    error(`merge --queue: merge lock ${name} held by ${holder} for ${Math.round(lock.waitedMs / 1000)}s (--merge-lock-timeout ${o.mergeLockTimeout}) — not started`);
    return 124;
  }
  try {
    for (const r of recovered) {
      record(entries[0], r.write ? 'fail' : 'skip', 'recovered', `from=${describeUnresolved(r.owner).replace(/ /g, '_')} phase=${r.owner.phase ?? '-'}`);
    }
    // Every unconfirmed write on this base must be one of this queue's PRs; those go first (design §3.2).
    const pending = readUnresolved(root, name);
    const order = [...entries];
    for (const u of [...pending].reverse()) {
      const at = order.findIndex((entry) => entry.pr === u.owner.pr);
      if (at < 0) {
        record(entries[0], 'fail', 'recovered-stop', `from=#${u.owner.issue ?? '?'} phase=${u.owner.phase ?? '?'} unresolved-pr=#${u.owner.pr ?? '?'}`);
        error(
          `merge --queue: an earlier merge-pr died while writing ${describeUnresolved(u.owner)} — nothing was changed; ` +
            `run that entry first (add it to the queue: ${u.owner.issue}${u.owner.item ? `/${u.owner.item}` : ''}@${u.owner.pr}). Record: ${u.file}`
        );
        return 1;
      }
      order.unshift(...order.splice(at, 1));
    }
    if (pending.length > 0) log(`merge --queue: finishing the unconfirmed write(s) first: ${pending.map((u) => describeUnresolved(u.owner)).join(', ')}`);

    const lastIndex = order.length - 1;
    for (const [index, entry] of order.entries()) {
      const tries = { [HELD_EXIT]: 0, [BASE_MOVED_EXIT]: 0 };
      for (let attempt = 1; ; attempt++) {
        record(entry, 'skip', 'running', `attempt=${attempt}`);
        const options = {
          ...o,
          issue: String(entry.issue),
          item: entry.item,
          worktree: entry.worktree ?? '-',
          pr: String(entry.pr),
          branch: entry.branch ?? undefined,
          close: entry.close,
          last: o.last || index === lastIndex,
        };
        const code = (deps.mergeOne ?? mergeOne)(options, {
          ...deps,
          phase: (p, fields = {}) => lock.setOwnerFields({ phase: p, entry: entry.text, issue: entry.issue, item: entry.item, pr: entry.pr, ...fields }),
        });
        lock.setOwnerFields({ phase: 'idle' });
        if (code === 0) {
          record(entry, 'ok', 'merged', `attempt=${attempt}`);
          for (const u of pending.filter((p) => p.owner.pr === entry.pr)) fs.rmSync(u.file, { force: true });
          break;
        }
        const retry = QUEUE_RETRIES[code];
        if (retry && tries[code] < retry.max) {
          tries[code] += 1;
          record(entry, 'skip', 'retry', `attempt=${attempt} exit=${code} next-in=${retry.waitSec}s`);
          if (retry.waitSec > 0) sleep(retry.waitSec * 1000);
          continue;
        }
        record(entry, 'fail', 'stopped', `attempt=${attempt} exit=${code}`);
        const rest = order.slice(index + 1).map((e) => e.text);
        error(`merge --queue: stopped at ${entry.text} (exit ${code}${retry ? `, after ${tries[code]} retr${tries[code] === 1 ? 'y' : 'ies'}` : ''})${rest.length > 0 ? ` — not started: ${rest.join(', ')}` : ''}`);
        return code;
      }
    }
    return 0;
  } finally {
    lock.setOwnerFields({ phase: 'idle' });
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// The command: an outer process that re-starts itself as the inner one (#4277)
// ---------------------------------------------------------------------------

/**
 * How the outer process starts the inner one: a new process group (detached) whose leader is the
 * inner process, with the parent's whole environment plus INNER_ENV — PATH, the gh login and
 * CM_VERIFY_LOCK_ROOT are inherited (Codex review 2 finding 3).
 */
/** @param {Record<string, string | undefined>} [env] */
export function innerSpawnOptions(env = process.env) {
  return { detached: true, stdio: 'inherit', env: { ...env, [INNER_ENV]: '1' } };
}

const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Start the inner process and wait for it; INT / TERM / HUP go to its whole group.
 *
 * @param {string[]} argv
 * @param {{ spawnImpl?: typeof spawn, script?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {Promise<number>}
 */
export function runOuter(argv, { spawnImpl = spawn, script = fileURLToPath(import.meta.url), env = process.env } = {}) {
  return new Promise((resolve) => {
    const child = spawnImpl(process.execPath, [script, ...argv], innerSpawnOptions(env));
    const handlers = FORWARDED_SIGNALS.map((signal) => {
      const handler = () => {
        try {
          process.kill(-child.pid, signal);
        } catch {
          // the group is gone already
        }
      };
      process.on(signal, handler);
      return [signal, handler];
    });
    const done = (code) => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      resolve(code);
    };
    child.on('error', (err) => {
      console.error(`merge-pr: could not start the inner process: ${err.message}`);
      done(1);
    });
    child.on('exit', (code, signal) => done(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1)));
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.env[INNER_ENV] === '1') {
    // Not inherited further: a merge-pr started by a child (a test) is an outer process of its own.
    delete process.env[INNER_ENV];
    process.exit(main(process.argv.slice(2), { pgid: process.pid }));
  } else {
    runOuter(process.argv.slice(2)).then((code) => process.exit(code));
  }
}
