#!/usr/bin/env node
/**
 * merge train, PR1 (Issue #4369, docs/design/merge-train-4369.md §11.1): a diagnosis without the
 * right to publish. It builds one train from the queued PRs — GitHub's squash replayed locally as a
 * single-parent chain on the base `B0` — checks the combination locally (conflict markers, the
 * precheck under the union of every candidate's conditions), pushes the train to its own throwaway
 * ref `train/<base>/<train ID>`, waits for that ref's one CI run, and reports.
 *
 * It never writes to the base, a PR head, a PR or an Issue (U2, I1, I12):
 *   - the only pushes are the creation of `refs/heads/train/<base>/<own ID>` and lease-guarded
 *     deletions of that ref and of the old IDs pruneOwnRefs picked from their own reports
 *     (assertTrainRef is checked right before every push);
 *   - the only other writes outside are `gh run rerun --failed` / `gh run cancel` of the manifest's run;
 *   - every report (the human text, `--json`, the saved `<run-dir>/train/<ID>.json`) carries
 *     `publishable: false` and NOTICE, whatever the verdict. A green train is the result of one CI
 *     on `T_N` over `B0`, not a permission to merge and not a reason to call merge-pr differently.
 *
 * The train's working tree is a `git clone --shared` under os.tmpdir() (#4369 pre-review 3, K1):
 * a `git worktree add` would be listed by the repository's `git worktree list`, which CommandMate's
 * worktree sync reads wherever the tree lives. The clone is removed at the end.
 *
 * Records: the `train` line of the run record (run-log.mjs LOG_STAGES: no HEAD, not progress) and the
 * report. The precheck of the train writes to `<run-dir>/train/`, never to the run record merge-pr reads.
 *
 * Exit code: 0 green (or no candidate left), 1 red / a condition or a command failed / green only after
 * a re-run (`green-after-rerun-unverified`, design I5 and V9), 2 usage / not eligible, 3 the precheck is
 * on hold, 4 the base moved (rebuild limit reached), 124 lock / registration / CI timeout.
 *
 * Usage:
 *   node scripts/orchestrate/merge-train.mjs --run-dir <dir> --issues <range> --queue <issue[/item][@pr],...>
 *        [--base develop] [--repo Kewton/CommandMate] [--required-checks <name,...>] [--workflow ci-pr.yml]
 *        [--source <worktree>] [--max-prs 5] [--ci-timeout 3600] [--register-timeout 600] [--poll 30]
 *        [--lock-timeout 14400] [--rebuild-max 0|1] [--keep-refs 3] [--json]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendRecord, findLatest, inItem, readRecords } from './run-log.mjs';
import { acquireMachineLockSync, describeOwner, lockPathOf, readOwner } from './machine-lock-sync.mjs';
import { machineLockRoot, main as runPrecheckMain, optionsFromNote } from './precheck.mjs';
import {
  DEFAULT_CI_TIMEOUT_SEC,
  DEFAULT_POLL_SEC,
  DEFAULT_REGISTER_TIMEOUT_SEC,
  LAST_REQUIRED_CHECKS,
  judgeChecks,
  mergeLockName,
  mergeLockRoot,
  parseQueue,
  parseWorktreeList,
  readUnresolved,
} from './merge-pr.mjs';
import {
  DEFAULT_BASE_BRANCH,
  DEFAULT_REPO,
  defaultRun,
  defaultSleep,
  dirtyPaths,
  fragmentProblems,
  ghWrite,
  git,
  lines,
  markerFiles,
  missingRecords,
  pushHead,
  withGhRetry,
  workHeadOf,
} from './pr-common.mjs';

/** I12: what every report says, in every verdict. */
export const NOTICE =
  'この結果は、B0 の上の T_N の tree の 1 回の CI の結果だけを意味する。マージの根拠にも、merge-pr の確認（取り込み・precheck・必須の CI・--last）を省いたり引数を変えたりする根拠にもならない。train の ref を base へ入れたり、その ref から PR を作ったりしない。';
/** P3-3: a green after a re-run exits 1 like a red; the human text says first that it is not one. */
export const NOT_RED_LINE = '赤ではない（再実行の後の緑。未確認）';
export const VERDICTS = ['green', 'red', 'empty', 'stale', 'stopped', 'timeout', 'green-after-rerun-unverified'];
/** Arguments that ask PR1 to publish or write (design §4, T-A): refused with exit 2. */
export const REFUSED_SWITCHES = ['--merge', '--push-base', '--fast-forward', '--create-pr', '--publishable'];
export const REFUSED_WITH_VALUE = ['--close'];
export const REFUSED_MESSAGE = 'not supported: PR1 is a diagnosis (publishable: false)';
export const INNER_ENV = 'CM_MERGE_TRAIN_INNER';
export const DEFAULT_WORKFLOW = 'ci-pr.yml';
export const DEFAULT_MAX_PRS = 5;
export const MAX_MAX_PRS = 20;
export const DEFAULT_LOCK_TIMEOUT_SEC = 14400;
export const DEFAULT_KEEP_REFS = 3;
export const MIN_GIT = [2, 40];
export const TRAIN_LOCK_DIR_NAME = 'train';
/** C9 / F05: a candidate that changes these is left to merge-pr. */
export const DEPS_FILES = ['package.json', 'package-lock.json'];
export const TRAIN_ID_PATTERN = /^\d{8}T\d{9}Z-\d+-[0-9a-f]{6}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
/** The identity of the train's own commits (throwaway; never published by PR1). */
const TRAIN_IDENTITY = {
  GIT_AUTHOR_NAME: 'merge-train',
  GIT_AUTHOR_EMAIL: 'merge-train@localhost',
  GIT_COMMITTER_NAME: 'merge-train',
  GIT_COMMITTER_EMAIL: 'merge-train@localhost',
};

/** A stop with its exit code and the train state it is recorded as. */
export class TrainStop extends Error {
  constructor(exit, message, state = 'stopped', extra = {}) {
    super(message);
    this.exit = exit;
    this.state = state;
    Object.assign(this, extra);
  }
}

const USAGE = `Usage:
  node scripts/orchestrate/merge-train.mjs --run-dir <dir> --issues <range> --queue <issue[/item][@pr],...>
       [--base ${DEFAULT_BASE_BRANCH}] [--repo ${DEFAULT_REPO}] [--required-checks <name,...>] [--workflow ${DEFAULT_WORKFLOW}]
       [--source <worktree>] [--max-prs ${DEFAULT_MAX_PRS}] [--ci-timeout ${DEFAULT_CI_TIMEOUT_SEC}] [--register-timeout ${DEFAULT_REGISTER_TIMEOUT_SEC}] [--poll ${DEFAULT_POLL_SEC}]
       [--lock-timeout ${DEFAULT_LOCK_TIMEOUT_SEC}] [--rebuild-max 0|1] [--keep-refs ${DEFAULT_KEEP_REFS}] [--json]`;

const FLAGS = {
  '--run-dir': 'runDir',
  '--issues': 'issues',
  '--queue': 'queue',
  '--base': 'base',
  '--repo': 'repo',
  '--required-checks': 'requiredChecks',
  '--workflow': 'workflow',
  '--source': 'source',
  '--max-prs': 'maxPrs',
  '--ci-timeout': 'ciTimeout',
  '--register-timeout': 'registerTimeout',
  '--poll': 'poll',
  '--lock-timeout': 'lockTimeout',
  '--rebuild-max': 'rebuildMax',
  '--keep-refs': 'keepRefs',
};
const NUMERIC = ['--max-prs', '--ci-timeout', '--register-timeout', '--poll', '--lock-timeout', '--rebuild-max', '--keep-refs'];

/**
 * @returns {{ options: any } | { error: string, refused?: boolean }}
 */
export function parseArgs(argv) {
  const options = {
    base: DEFAULT_BASE_BRANCH,
    repo: DEFAULT_REPO,
    workflow: DEFAULT_WORKFLOW,
    maxPrs: String(DEFAULT_MAX_PRS),
    ciTimeout: String(DEFAULT_CI_TIMEOUT_SEC),
    registerTimeout: String(DEFAULT_REGISTER_TIMEOUT_SEC),
    poll: String(DEFAULT_POLL_SEC),
    lockTimeout: String(DEFAULT_LOCK_TIMEOUT_SEC),
    rebuildMax: '0',
    keepRefs: String(DEFAULT_KEEP_REFS),
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const flag = arg.split('=')[0];
    if (REFUSED_SWITCHES.includes(flag) || REFUSED_WITH_VALUE.includes(flag)) return { error: `${flag}: ${REFUSED_MESSAGE}`, refused: true };
    if (arg === '--json') options.json = true;
    else if (FLAGS[arg] && i + 1 < argv.length) options[FLAGS[arg]] = argv[++i];
    else return { error: `unknown or incomplete argument: ${arg}` };
  }
  for (const flag of ['--run-dir', '--issues', '--queue']) {
    if (!options[FLAGS[flag]]) return { error: `${flag} is required` };
  }
  for (const flag of NUMERIC) {
    if (!/^\d+$/.test(options[FLAGS[flag]])) return { error: `${flag} must be a non-negative integer (got ${options[FLAGS[flag]]})` };
  }
  if (Number(options.rebuildMax) > 1) return { error: `--rebuild-max must be 0 or 1 (got ${options.rebuildMax})` };
  const maxPrs = Number(options.maxPrs);
  if (maxPrs < 1 || maxPrs > MAX_MAX_PRS) return { error: `--max-prs must be 1-${MAX_MAX_PRS} (got ${options.maxPrs})` };
  if (Number(options.poll) < 1) return { error: '--poll must be at least 1' };
  if (options.base.startsWith('train/')) return { error: `--base must not be a train ref (got ${options.base})` };
  if (!/^[A-Za-z0-9._/-]+$/.test(options.base) || options.base.includes('..')) return { error: `--base is not a branch name (got ${options.base})` };
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(options.repo)) return { error: `--repo must be <owner>/<name> (got ${options.repo})` };
  // I10: the required checks are this repository's only by default.
  if (options.requiredChecks !== undefined) {
    options.required = options.requiredChecks.split(',').map((name) => name.trim()).filter(Boolean);
    if (options.required.length === 0) return { error: '--required-checks is empty' };
  } else if (options.repo === DEFAULT_REPO) {
    options.required = [...LAST_REQUIRED_CHECKS];
  } else {
    return { error: `--required-checks is required for --repo ${options.repo} (the default list is ${DEFAULT_REPO}'s)` };
  }
  const queue = parseQueue(options.queue);
  if ('error' in queue) return { error: queue.error };
  options.entries = queue.entries;
  return { options };
}

/** `<UTC YYYYMMDDTHHMMSSmmmZ>-<pid>-<6 hex>`: never reused (R11). */
export function trainId(now = new Date(), pid = process.pid, random = () => crypto.randomBytes(3).toString('hex')) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('.', '');
  return `${stamp}-${pid}-${random()}`;
}

export const trainRef = (base, id) => `train/${base}/${id}`;
export const trainTarget = (base, id) => `refs/heads/${trainRef(base, id)}`;

/** The train lock of a base (I8): `train.<owner>.<repo>.<base>`, apart from the merge lock. */
export function trainLockName(repo, base) {
  return mergeLockName(repo, base).replace(/^merge\./, 'train.');
}
export function trainLockRoot(machineRoot) {
  return path.join(machineRoot, TRAIN_LOCK_DIR_NAME);
}

/**
 * The push destination check (I1, T-R X3): `target` must be `refs/heads/train/<base>/<id>` for one of
 * the allowed IDs — the own ID, or, for a lease-guarded deletion, an old ID pruneOwnRefs selected.
 * Throws before anything is pushed.
 */
export function assertTrainRef(target, { base, ids }) {
  const ok = (ids ?? []).some((id) => TRAIN_ID_PATTERN.test(String(id)) && target === trainTarget(base, id));
  if (!ok || String(base).startsWith('train/')) {
    throw new TrainStop(1, `refusing to push to ${target}: merge-train writes only refs/heads/train/${base}/<its own train ID> (I1)`);
  }
}

/**
 * Create the own train ref at `sha` (pr-common.mjs pushHead, after the destination check).
 *
 * @param {typeof defaultRun} run
 * @param {string} repoDir
 * @param {{ target: string, sha: string, base: string, ownId: string, sleep?: (ms: number) => void, notice?: (line: string) => void }} options
 */
export function createTrainRef(run, repoDir, { target, sha, base, ownId, sleep = defaultSleep, notice = (line) => console.error(line) }) {
  assertTrainRef(target, { base, ids: [ownId] });
  if (!FULL_SHA.test(sha)) throw new TrainStop(1, `refusing to push ${sha}: not a full SHA`);
  return pushHead(run, repoDir, { branch: target.slice('refs/heads/'.length), head: sha, sleep, notice });
}

/** Delete a train ref only when the remote still has `expect` there (I7, I13): never without a lease. */
export function deleteTrainRef(run, repoDir, { target, expect, base, ids }) {
  assertTrainRef(target, { base, ids });
  if (!FULL_SHA.test(String(expect))) throw new TrainStop(1, `refusing to delete ${target} without a lease`);
  const out = run('git', ['-C', repoDir, 'push', `--force-with-lease=${target}:${expect}`, 'origin', `:${target}`]);
  return { deleted: out.status === 0, detail: `${out.stderr || out.stdout}`.trim().split('\n')[0] ?? '' };
}

// ---------------------------------------------------------------------------
// Checks (T-B: gh 2.86.0 pkg/cmd/pr/checks/aggregate.go)
// ---------------------------------------------------------------------------

/** A job, check-run or status context → the bucket `gh pr checks` gives it. Unknown values are pending. */
export function bucketOf(item) {
  const isStatus = item && 'state' in item && !('conclusion' in item) && !('status' in item);
  if (isStatus) {
    const state = String(item.state ?? '').toLowerCase();
    if (state === 'success') return 'pass';
    if (state === 'error' || state === 'failure') return 'fail';
    return 'pending';
  }
  if (String(item?.status ?? '').toLowerCase() !== 'completed') return 'pending';
  const conclusion = String(item?.conclusion ?? '').toLowerCase();
  if (conclusion === 'success') return 'pass';
  if (conclusion === 'skipped' || conclusion === 'neutral') return 'skipping';
  if (['failure', 'timed_out', 'action_required', 'error'].includes(conclusion)) return 'fail';
  if (conclusion === 'cancelled') return 'cancel';
  return 'pending';
}

/** `gh api --paginate --slurp <path>`: every page, or a throw (a failed page is never a partial answer). */
function ghPages(run, apiPath, key) {
  const out = run('gh', ['api', '--paginate', '--slurp', apiPath]);
  if (out.status !== 0) throw new Error(`gh api ${apiPath} failed: ${(out.stderr || out.stdout).trim()}`);
  const pages = JSON.parse(out.stdout);
  if (!Array.isArray(pages)) throw new Error(`gh api ${apiPath}: not a list of pages`);
  return pages.flatMap((page) => (Array.isArray(page) ? page : page?.[key] ?? []));
}

/**
 * The CI evidence of the manifest's run (I5): the one `push` run of `workflow` on `ref` at `sha`, its
 * latest attempt's jobs (every page), and the other checks of `sha` — check-runs of another check
 * suite (`filter=latest`, told apart by `check_suite.id`, never by name) and status contexts.
 *
 * @returns {{ state: 'unregistered' } | { state: 'ambiguous', runs: number[] } | { state: 'unread', reason: string }
 *   | { state: 'read', run: { id: number, attempt: number, checkSuiteId: number, status: string }, jobs: any[], others: any[], statuses: any[] }}
 */
export function collectCiEvidence(run, { repo, sha, ref, workflow, minAttempt = 1 }) {
  const runsPath = `repos/${repo}/actions/runs?head_sha=${sha}&event=push&branch=${encodeURIComponent(ref)}&per_page=100`;
  let runs;
  try {
    runs = ghPages(run, runsPath, 'workflow_runs');
  } catch (err) {
    throw new TrainStop(1, `could not read the runs of ${sha.slice(0, 7)}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const mine = runs.filter(
    (r) => String(r.path ?? '').split('@')[0] === `.github/workflows/${workflow}` && r.event === 'push' && r.head_sha === sha && r.head_branch === ref
  );
  if (mine.length === 0) return { state: 'unregistered' };
  if (mine.length > 1) return { state: 'ambiguous', runs: mine.map((r) => r.id) };
  const r = mine[0];
  const ciRun = { id: r.id, attempt: Number(r.run_attempt ?? 1), checkSuiteId: r.check_suite_id, status: String(r.status ?? '') };
  if (ciRun.attempt < minAttempt) return { state: 'unread', reason: `run ${r.id} attempt ${ciRun.attempt} (waiting for attempt ${minAttempt})`, run: ciRun };
  try {
    const jobs = ghPages(run, `repos/${repo}/actions/runs/${r.id}/attempts/${ciRun.attempt}/jobs?per_page=100`, 'jobs').map((job) => ({
      name: job.name, bucket: bucketOf(job), link: job.html_url ?? '',
    }));
    const others = ghPages(run, `repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100`, 'check_runs')
      .filter((check) => check?.check_suite?.id !== r.check_suite_id)
      .map((check) => ({ name: check.name, bucket: bucketOf(check), link: check.html_url ?? '' }));
    const status = run('gh', ['api', `repos/${repo}/commits/${sha}/status`]);
    if (status.status !== 0) throw new Error(`gh api status failed: ${(status.stderr || status.stdout).trim()}`);
    const statuses = (JSON.parse(status.stdout).statuses ?? []).map((s) => ({ name: s.context, bucket: bucketOf({ state: s.state }) }));
    return { state: 'read', run: ciRun, jobs, others, statuses };
  } catch (err) {
    return { state: 'unread', reason: err instanceof Error ? err.message : String(err), run: ciRun };
  }
}

/**
 * The verdict on read evidence: the run's jobs under `judgeChecks(…, { last: true, required })` (the
 * required names must be the run's own jobs), and every other check / status settled and not failed.
 * A run not `completed` is not green.
 *
 * @returns {{ state: 'ok' | 'pending' | 'fail', failed: any[], ownFailed: any[], waiting: string[], summary: string }}
 */
export function judgeTrain(evidence, { required }) {
  const own = judgeChecks(evidence.jobs, { needBuild: true, needUnit: true, last: true, required });
  const rest = [...evidence.others, ...evidence.statuses];
  const restVerdict = rest.length > 0 ? judgeChecks(rest, { needBuild: true, needUnit: true, last: true, required: [] }) : { state: 'ok', failed: [], waiting: [], summary: 'none' };
  const failed = [...own.failed, ...restVerdict.failed];
  const summary = `run:${own.summary} other:${restVerdict.summary}`;
  if (failed.length > 0) return { state: 'fail', failed, ownFailed: own.failed, waiting: [], summary };
  const waiting = [...own.waiting, ...restVerdict.waiting];
  if (evidence.run.status !== 'completed') waiting.push(`(run ${evidence.run.id} ${evidence.run.status || 'not completed'})`);
  return { state: waiting.length > 0 ? 'pending' : 'ok', failed, ownFailed: [], waiting, summary };
}

// ---------------------------------------------------------------------------
// Eligibility (F08), git config, git version
// ---------------------------------------------------------------------------

const notFound = (out) => /HTTP 404|Not Found|not protected/i.test(`${out.stderr}\n${out.stdout}`);

/** protection / rules / merge queue of the base: present, absent (404 / [] / null) or unknown (anything else). */
export function readEligibility(run, { repo, base }) {
  const result = { protection: 'unknown', rules: 'unknown', strict: 'unknown', queue: 'unknown' };
  let strictProtection = null;
  let strictRules = null;
  try {
    const out = run('gh', ['api', `repos/${repo}/branches/${base}/protection`]);
    if (out.status === 0) {
      result.protection = 'present';
      strictProtection = Boolean(JSON.parse(out.stdout)?.required_status_checks?.strict);
    } else if (notFound(out)) {
      result.protection = 'absent';
      strictProtection = false;
    }
  } catch {
    // unknown
  }
  try {
    const out = run('gh', ['api', `repos/${repo}/rules/branches/${base}`]);
    if (out.status === 0) {
      const rules = JSON.parse(out.stdout);
      if (Array.isArray(rules)) {
        result.rules = rules.length === 0 ? 'absent' : 'present';
        strictRules = rules.some((rule) => rule?.type === 'required_status_checks' && rule?.parameters?.strict_required_status_checks_policy === true);
      }
    }
  } catch {
    // unknown
  }
  if (strictProtection !== null && strictRules !== null) result.strict = strictProtection || strictRules ? 'present' : 'absent';
  else if (strictProtection === true || strictRules === true) result.strict = 'present';
  try {
    const [owner, name] = repo.split('/');
    const out = run('gh', [
      'api', 'graphql',
      '-f', 'query=query($o:String!,$n:String!,$b:String!){repository(owner:$o,name:$n){mergeQueue(branch:$b){id}}}',
      '-f', `o=${owner}`, '-f', `n=${name}`, '-f', `b=${base}`,
    ]);
    if (out.status === 0) {
      const repository = JSON.parse(out.stdout)?.data?.repository;
      if (repository && 'mergeQueue' in repository) result.queue = repository.mergeQueue === null ? 'absent' : 'present';
    }
  } catch {
    // unknown
  }
  return result;
}

function gitConfigOf(run, repoDir) {
  const get = (key) => {
    const out = run('git', ['-C', repoDir, 'config', '--get', key]);
    return out.status === 0 ? out.stdout.trim() : null;
  };
  return { mergeRenormalize: get('merge.renormalize'), attributesFile: get('core.attributesFile') };
}

export function gitVersionOk(text) {
  const m = /git version (\d+)\.(\d+)/.exec(String(text));
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > MIN_GIT[0] || (major === MIN_GIT[0] && minor >= MIN_GIT[1]);
}

/** `owner/name` of a GitHub remote URL (https or ssh), or null. */
export function repoOfUrl(url) {
  const m = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(String(url).trim());
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// The candidates (§2.3)
// ---------------------------------------------------------------------------

const describeError = (err) => (err instanceof Error ? err.message : String(err));

/**
 * Resolve every entry and sort it into a candidate or a dropped one (C1-C7). Usage errors (no PR
 * record, an unknown PR, an OPEN PR with 0 / 2+ worktrees, the same PR twice) and read failures stop
 * the whole train before anything is created; an ineligible PR is dropped with its reason.
 *
 * @returns {{ candidates: any[], dropped: { entry: string, pr: number | null, reason: string }[], unresolved: any[] }}
 */
export function classifyEntries(o, deps) {
  const { run } = deps;
  const repoDir = deps.repoDir ?? process.cwd();
  const home = deps.home ?? os.homedir();
  const { records } = readRecords(o.runDir, o.issues);
  const usage = [];
  const dropped = [];
  const resolved = [];
  let worktrees = null;
  const listWorktrees = () => {
    if (worktrees === null) {
      const out = run('git', ['-C', repoDir, 'worktree', 'list', '--porcelain']);
      if (out.status !== 0) throw new TrainStop(1, `git worktree list failed: ${out.stderr.trim()}`);
      worktrees = parseWorktreeList(out.stdout);
    }
    return worktrees;
  };
  for (const entry of o.entries) {
    let prNumber = entry.pr;
    if (prNumber === null) {
      const named = new Set(
        records
          .filter((r) => r.issue === entry.issue && r.stage === 'pr' && inItem(r, entry.item))
          .map((r) => /(?:^|\s)pr=#(\d+)\b/.exec(r.note ?? '')?.[1])
          .filter(Boolean)
      );
      if (named.size !== 1) {
        usage.push(`${entry.text}: the run record names ${named.size === 0 ? 'no pr=#N' : [...named].map((n) => `#${n}`).join(' and ')} — name it ${entry.text.split('@')[0]}@<pr>`);
        continue;
      }
      prNumber = Number([...named][0]);
    }
    const out = run('gh', [
      'pr', 'view', String(prNumber), '--repo', o.repo, '--json',
      'number,state,headRefOid,headRefName,baseRefName,headRepository,headRepositoryOwner,isCrossRepository',
    ]);
    if (out.status !== 0) {
      const text = `${out.stderr}\n${out.stdout}`;
      if (/no pull requests found|could not resolve to a pullrequest|not found/i.test(text) && !/HTTP 5\d\d/.test(text)) {
        usage.push(`${entry.text}: gh pr view ${prNumber}: ${text.trim().split('\n')[0]}`);
        continue;
      }
      throw new TrainStop(1, `${entry.text}: gh pr view ${prNumber} failed: ${text.trim().split('\n')[0]}`);
    }
    const pr = JSON.parse(out.stdout);
    if (pr.state !== 'OPEN') {
      resolved.push({ entry, pr, worktree: null, reason: `state=${pr.state}` });
      continue;
    }
    const matches = listWorktrees().filter((wt) => wt.branch === pr.headRefName);
    if (matches.length !== 1) {
      usage.push(`${entry.text}: ${matches.length === 0 ? 'no worktree' : `${matches.length} worktrees`} on ${pr.headRefName} (#${prNumber})`);
      continue;
    }
    resolved.push({ entry, pr, worktree: matches[0].path, reason: null });
  }
  const numbers = resolved.map((r) => r.pr.number);
  for (const [i, n] of numbers.entries()) {
    if (numbers.indexOf(n) !== i) usage.push(`#${n} is named by two entries`);
  }
  if (usage.length > 0) throw new TrainStop(2, `not started, nothing was created:\n  ${usage.join('\n  ')}`);

  const unresolvedRoot = deps.mergeLockRoot ?? mergeLockRoot(machineLockRoot(home));
  const unresolvedAll = readUnresolved(unresolvedRoot, mergeLockName(o.repo, o.base));
  const candidates = [];
  for (const { entry, pr, worktree, reason } of resolved) {
    const drop = (why) => dropped.push({ entry: entry.text, pr: pr.number, reason: why });
    if (reason) {
      drop(reason);
      continue;
    }
    // C1
    if (pr.baseRefName !== o.base) {
      drop(`base=${pr.baseRefName}`);
      continue;
    }
    const headRepo = pr.headRepositoryOwner?.login && pr.headRepository?.name ? `${pr.headRepositoryOwner.login}/${pr.headRepository.name}` : null;
    if (pr.isCrossRepository === true || (headRepo !== null && headRepo.toLowerCase() !== o.repo.toLowerCase())) {
      drop(`fork=${headRepo ?? '?'}`);
      continue;
    }
    // C2
    if (dirtyPaths(run, worktree).length > 0) {
      drop('dirty');
      continue;
    }
    const head = git(run, worktree, ['rev-parse', 'HEAD']).trim();
    if (head !== pr.headRefOid) {
      drop(`head-mismatch worktree=${head.slice(0, 7)} pr=${String(pr.headRefOid).slice(0, 7)}`);
      continue;
    }
    // C3
    const issue = entry.issue;
    const item = entry.item;
    const workHead = workHeadOf(run, worktree, head, { records, issue, item });
    const missing = missingRecords(records, issue, { head, workHead }, item, {
      runDir: o.runDir, worktree, home, warn: () => {},
    }).filter((why) => !why.startsWith('precheck:'));
    if (missing.length > 0) {
      drop(`records-missing=${missing.map((why) => why.split(':')[0]).join(',')}`);
      continue;
    }
    if (fragmentProblems(run, { worktree, runDir: o.runDir, issue, baseRef: `origin/${o.base}`, item }).length > 0) {
      drop('fragments-missing');
      continue;
    }
    // C4, C5
    const precheck =
      findLatest(records, { issue, item, stage: 'precheck', head: workHead, result: 'ok' }) ??
      findLatest(records, { issue, item, stage: 'precheck', head, result: 'ok' });
    const optsToken = String(precheck?.note ?? '').split(/\s+/).find((word) => word.startsWith('opts='));
    if (!precheck || !optsToken) {
      drop('precheck-options-unknown');
      continue;
    }
    const opts = optionsFromNote(precheck.note);
    if (opts.includes('--allow-removed-tests')) {
      drop('removed-tests-allowed');
      continue;
    }
    // C6
    const checksOut = run('gh', ['pr', 'checks', String(pr.number), '--repo', o.repo, '--json', 'name,bucket,link']);
    let checks = null;
    try {
      checks = JSON.parse(checksOut.stdout);
    } catch {
      checks = /no checks/i.test(checksOut.stderr) ? [] : null;
    }
    if (checks === null) throw new TrainStop(1, `gh pr checks ${pr.number} failed: ${(checksOut.stderr || checksOut.stdout).trim()}`);
    const ci = judgeChecks(checks, { needBuild: true, needUnit: true, last: true, required: o.required });
    if (ci.state !== 'ok') {
      drop(`pr-ci=${ci.state}`);
      continue;
    }
    // C7
    if (unresolvedAll.some((u) => u.owner?.pr === pr.number)) {
      drop('unresolved');
      continue;
    }
    candidates.push({
      text: entry.text, issue, item, pr: pr.number, h: head, workHead, worktree, headRepo: headRepo ?? o.repo,
      baseRef: pr.baseRefName,
      kind: opts.includes('--kind') ? opts[opts.indexOf('--kind') + 1] : null,
      metrics: opts.includes('--metrics'),
      build: opts.includes('--build'),
    });
  }
  const named = new Set([...candidates.map((c) => c.pr), ...dropped.map((d) => d.pr)]);
  const unresolved = unresolvedAll
    .filter((u) => !named.has(u.owner?.pr))
    .map((u) => ({ pr: u.owner?.pr ?? null, issue: u.owner?.issue ?? null, phase: u.owner?.phase ?? null, file: u.file }));
  const max = Number(o.maxPrs);
  for (const over of candidates.splice(max)) dropped.push({ entry: over.text, pr: over.pr, reason: 'over-limit' });
  return { candidates, dropped, unresolved };
}

// ---------------------------------------------------------------------------
// The train (§2.2)
// ---------------------------------------------------------------------------

/** `merge=` in any `.gitattributes` of `sha` (G2). */
function hasMergeAttribute(run, repoDir, sha) {
  const files = lines(git(run, repoDir, ['ls-tree', '-r', '--name-only', sha])).filter((file) => path.posix.basename(file) === '.gitattributes');
  return files.some((file) => /(?:^|\s)merge=/m.test(git(run, repoDir, ['show', `${sha}:${file}`])));
}

/**
 * The single-parent chain `T_k = commit-tree(merge-tree --merge-base=mb(B0, h_k) T_{k-1} h_k, -p T_{k-1})`.
 * G1 (exactly one merge-base), C9 (dependencies), G2 (gitlink: drop; `merge=` attribute: the whole
 * train stops with exit 2), G3 (a conflict drops the candidate).
 *
 * @returns {{ chain: { pr: number, T: string, tree: string }[], adopted: any[], dropped: { entry: string, pr: number, reason: string }[], T: string }}
 */
export function buildTrain(run, repoDir, { B0, candidates, id }) {
  if (hasMergeAttribute(run, repoDir, B0)) throw new TrainStop(2, `unsupported=merge-attribute in ${B0.slice(0, 7)}`, 'stopped', { unsupported: 'merge-attribute' });
  const chain = [];
  const adopted = [];
  const dropped = [];
  let tip = B0;
  for (const c of candidates) {
    const drop = (reason) => dropped.push({ entry: c.text, pr: c.pr, reason });
    const mbOut = run('git', ['-C', repoDir, 'merge-base', '--all', B0, c.h]);
    if (mbOut.status !== 0 && !(mbOut.status === 1 && mbOut.stdout.trim() === '')) {
      throw new TrainStop(1, `git merge-base --all ${B0.slice(0, 7)} ${c.h.slice(0, 7)} failed: ${mbOut.stderr.trim()}`);
    }
    const bases = lines(mbOut.stdout);
    if (bases.length !== 1) {
      drop(`merge-base-count=${bases.length}`);
      continue;
    }
    const mb = bases[0];
    const names = lines(git(run, repoDir, ['diff', '--name-only', '--no-renames', mb, c.h]));
    if (names.some((file) => DEPS_FILES.includes(file))) {
      drop('deps-changed');
      continue;
    }
    const raw = lines(git(run, repoDir, ['diff', '--raw', '--no-renames', '--no-abbrev', mb, c.h]));
    if (raw.some((line) => /^:(?:160000 \d{6}|\d{6} 160000) /.test(line))) {
      drop('gitlink');
      continue;
    }
    if (hasMergeAttribute(run, repoDir, c.h)) {
      throw new TrainStop(2, `unsupported=merge-attribute in #${c.pr} ${c.h.slice(0, 7)}`, 'stopped', { unsupported: 'merge-attribute' });
    }
    const mt = run('git', ['-C', repoDir, 'merge-tree', '--write-tree', '--name-only', '--no-messages', `--merge-base=${mb}`, tip, c.h]);
    if (mt.status === 1) {
      drop(`conflict files=${lines(mt.stdout).slice(1).join(',') || '-'}`);
      continue;
    }
    if (mt.status !== 0) throw new TrainStop(1, `git merge-tree for #${c.pr} failed: ${mt.stderr.trim()}`);
    const tree = lines(mt.stdout)[0];
    const commit = run('git', ['-C', repoDir, 'commit-tree', tree, '-p', tip, '-m', `merge-train ${id}: #${c.pr} (issue #${c.issue}) on ${B0.slice(0, 12)}`], { env: TRAIN_IDENTITY });
    if (commit.status !== 0) throw new TrainStop(1, `git commit-tree for #${c.pr} failed: ${commit.stderr.trim()}`);
    tip = commit.stdout.trim();
    chain.push({ pr: c.pr, T: tip, tree });
    adopted.push({ issue: c.issue, item: c.item, pr: c.pr, h: c.h, T: tip, tree, ciVerified: false });
  }
  return { chain, adopted, dropped, T: tip };
}

/** The blob of `package-lock.json` at `ref` in `dir`, or null when absent / unreadable. */
function lockBlob(run, dir, ref) {
  const out = run('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', `${ref}:package-lock.json`]);
  return out.status === 0 ? out.stdout.trim() : null;
}

/**
 * F05 (I4): whether the train may borrow `<source>/node_modules`: the lockfile blob is the same at
 * `T_N`, `B0` and the source's HEAD, the source is clean and has node_modules.
 *
 * @returns {{ state: 'same' | 'changed' | 'unknown', detail: string }}
 */
export function depsState(run, { repoDir, B0, T, source }) {
  const atB0 = lockBlob(run, repoDir, B0);
  const atT = lockBlob(run, repoDir, T);
  if (atT !== atB0) return { state: 'changed', detail: `package-lock.json differs between B0 and T_N` };
  if (!source || !fs.existsSync(source)) return { state: 'unknown', detail: `no source worktree (${source ?? '-'})` };
  let dirty;
  try {
    dirty = dirtyPaths(run, source);
  } catch (err) {
    return { state: 'unknown', detail: describeError(err) };
  }
  if (dirty.length > 0) return { state: 'unknown', detail: `the source ${source} is dirty` };
  const atSource = lockBlob(run, source, 'HEAD');
  if (atSource === null && atB0 !== null) return { state: 'unknown', detail: `cannot read package-lock.json in ${source}` };
  if (atSource !== atB0) return { state: 'changed', detail: `package-lock.json of ${source} differs from B0` };
  if (!fs.existsSync(path.join(source, 'node_modules'))) return { state: 'unknown', detail: `${source}/node_modules is missing` };
  return { state: 'same', detail: `node_modules of ${source}` };
}

/**
 * The top-level entries of `<source>/node_modules` that start with `.` and are still linked: npm's own
 * (the command shims and the hidden lockfile). Every other dot entry is a tool's cache or temp dir.
 */
export const LINKED_DOT_ENTRIES = ['.bin', '.package-lock.json'];

/**
 * Borrow `<source>/node_modules` without writing to it (#4369 review P2): `<dir>/node_modules` is a
 * real directory whose entries link one by one to the source's packages. The tools' caches that
 * resolve to `<root>/node_modules/.<name>` — vitest's `node_modules/.vite/vitest/<hash>/results.json`
 * (VitestCache.resolveCacheDir), vite's `.vite` / `.vite-temp`, `node_modules/.cache` — are then made
 * inside the clone and removed with it; the source's own dot entries are not linked. What this cannot
 * keep out is a write into a package's own directory (`node_modules/<pkg>/…`), which goes through the
 * link to the source (none of the precheck's steps is known to do it).
 *
 * @returns {string[]} the linked entry names
 */
export function linkNodeModules(source, dir) {
  const from = path.join(source, 'node_modules');
  const to = path.join(dir, 'node_modules');
  fs.mkdirSync(to);
  const linked = [];
  for (const name of fs.readdirSync(from).sort()) {
    if (name.startsWith('.') && !LINKED_DOT_ENTRIES.includes(name)) continue;
    fs.symlinkSync(path.join(from, name), path.join(to, name));
    linked.push(name);
  }
  return linked;
}

/**
 * The precheck of the train (§2.4 3): the train's own run-dir, `--base <B0 SHA>`, `--heavy-to-ci`, and the
 * union of every candidate's conditions. `--allow-removed-tests` is never given (C5, I3).
 */
export function precheckArgs({ runDir, issues, worktree, B0, candidates }) {
  return [
    '--run-dir', path.join(runDir, 'train'),
    '--issues', issues,
    '--issue', String(candidates[0].issue),
    '--worktree', worktree,
    '--base', B0,
    '--heavy-to-ci',
    ...(candidates.some((c) => c.kind === 'refactor') ? ['--kind', 'refactor'] : []),
    ...(candidates.some((c) => c.metrics) ? ['--metrics'] : []),
    ...(candidates.some((c) => c.build) ? ['--build'] : []),
  ];
}

/** The train's working tree (K1): a shared clone under os.tmpdir(), not a worktree of the repository. */
export function trainDirOf(tmpdir, repo, id) {
  return path.join(tmpdir, `cm-train-${repo.replace(/[^A-Za-z0-9]+/g, '-')}-${id}`);
}

// ---------------------------------------------------------------------------
// Old refs (I13)
// ---------------------------------------------------------------------------

/**
 * Lease-delete the own namespace's refs beyond the newest `keep`, only those whose report in
 * `<run-dir>/train/` recorded the very SHA the remote has. Others are left and counted.
 *
 * @returns {{ pruned: { id: string, sha: string }[], skipped: { id: string, reason: string }[], remaining: number }}
 */
export function pruneOwnRefs(run, repoDir, { base, keep, reportsDir, ownId = null }) {
  const out = run('git', ['-C', repoDir, 'ls-remote', 'origin', `refs/heads/train/${base}/*`]);
  if (out.status !== 0) return { pruned: [], skipped: [{ id: '*', reason: `ls-remote failed: ${out.stderr.trim()}` }], remaining: -1 };
  const prefix = `refs/heads/train/${base}/`;
  const refs = lines(out.stdout)
    .map((line) => line.split(/\s+/))
    .filter(([, ref]) => ref?.startsWith(prefix))
    .map(([sha, ref]) => ({ sha, id: ref.slice(prefix.length) }))
    .filter((r) => r.id !== ownId)
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const pruned = [];
  const skipped = [];
  for (const r of refs.slice(keep)) {
    if (!TRAIN_ID_PATTERN.test(r.id)) {
      skipped.push({ id: r.id, reason: 'not a train ID' });
      continue;
    }
    let report = null;
    try {
      report = JSON.parse(fs.readFileSync(path.join(reportsDir, `${r.id}.json`), 'utf8'));
    } catch {
      skipped.push({ id: r.id, reason: 'no report in this run-dir' });
      continue;
    }
    if (report?.pushed !== r.sha || report?.base !== base) {
      skipped.push({ id: r.id, reason: `the remote is at ${r.sha.slice(0, 7)}, the report says ${String(report?.pushed ?? '-').slice(0, 7)}` });
      continue;
    }
    const del = deleteTrainRef(run, repoDir, { target: trainTarget(base, r.id), expect: r.sha, base, ids: [r.id] });
    if (del.deleted) pruned.push({ id: r.id, sha: r.sha });
    else skipped.push({ id: r.id, reason: `lease: ${del.detail}` });
  }
  return { pruned, skipped, remaining: refs.length - pruned.length };
}

// ---------------------------------------------------------------------------
// The report (I12)
// ---------------------------------------------------------------------------

/** Every report goes through here: `publishable` is false and NOTICE is there, whatever `fields` says. */
export function buildReport(fields) {
  const { publishable: _ignored, notice: _n, ...rest } = fields ?? {};
  return { publishable: false, notice: NOTICE, ...rest };
}

/** The human text: (for a green after a re-run, NOT_RED_LINE first), `publishable: false`, NOTICE, then the result. */
export function formatReport(report) {
  const out = [];
  if (report.verdict === 'green-after-rerun-unverified') out.push(NOT_RED_LINE);
  out.push('publishable: false', NOTICE);
  out.push(`merge-train ${report.id ?? '-'}: verdict=${report.verdict} exit=${report.exit}${report.reason ? ` — ${report.reason}` : ''}`);
  if (report.ref) out.push(`  ref ${report.ref}  B0 ${report.B0 ?? '-'}`);
  if (report.verified?.sha) {
    out.push(`  verified: ${report.verified.sha} (tree ${report.verified.tree}) run=${report.verified.runId ?? '-'} attempt=${report.verified.attempt ?? '-'} ${report.verified.workflow}/${report.verified.event}`);
  }
  for (const a of report.adopted ?? []) out.push(`  adopted #${a.pr} (issue #${a.issue}) T=${a.T.slice(0, 12)} tree=${a.tree.slice(0, 12)} — this T_k has not been through CI`);
  for (const d of report.dropped ?? []) out.push(`  dropped ${d.entry} (#${d.pr ?? '?'}): ${d.reason}`);
  for (const u of report.unresolved ?? []) out.push(`  unresolved merge-pr write: #${u.pr ?? '?'} phase=${u.phase ?? '?'} (${u.file})`);
  if (report.ci?.failed?.length) out.push(`  failed: ${report.ci.failed.join(', ')}`);
  if (report.eligibility) out.push(`  eligibility: ${Object.entries(report.eligibility).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (report.refs) out.push(`  train refs left on origin: ${report.refs.remaining} (pruned ${report.refs.pruned.length}; delete the rest by hand: docs/orchestrate/ci-merge.md)`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @param {{
 *   run?: typeof defaultRun, sleep?: (ms: number) => void, now?: () => Date, log?: (line: string) => void,
 *   error?: (line: string) => void, out?: (text: string) => void, home?: string, repoDir?: string, tmpdir?: string,
 *   lockRoot?: string, mergeLockRoot?: string, pgid?: number, lockSleep?: (ms: number) => void,
 *   acquireTrainLock?: typeof acquireMachineLockSync, runPrecheck?: typeof runPrecheckMain,
 *   pid?: number, random?: () => string,
 * }} [deps]
 * @returns {number} exit code
 */
export function main(argv, deps = {}) {
  const sleep = deps.sleep ?? defaultSleep;
  const error = deps.error ?? ((line) => console.error(line));
  const log = deps.log ?? ((line) => console.log(line));
  const out = deps.out ?? ((text) => process.stdout.write(`${text}\n`));
  const now = deps.now ?? (() => new Date());
  const run = withGhRetry(deps.run ?? defaultRun, { sleep, notice: error });
  const json = argv.includes('--json');

  const early = (exit, reason) => {
    const report = buildReport({ verdict: 'stopped', exit, reason });
    error(formatReport(report));
    if (json) out(JSON.stringify(report, null, 2));
    return exit;
  };
  const parsed = parseArgs(argv);
  if ('error' in parsed) return early(2, parsed.refused ? parsed.error : `${parsed.error}\n${USAGE}`);
  const o = parsed.options;
  const repoDir = deps.repoDir ?? process.cwd();
  const home = deps.home ?? os.homedir();

  // G4 and C17, before the lock: nothing is read from GitHub yet.
  const version = run('git', ['--version']);
  if (version.status !== 0 || !gitVersionOk(version.stdout)) return early(2, `git ${MIN_GIT.join('.')} or later is needed for merge-tree --merge-base (${version.stdout.trim() || version.stderr.trim()})`);
  const origin = run('git', ['-C', repoDir, 'config', '--get', 'remote.origin.url']);
  const originRepo = origin.status === 0 ? repoOfUrl(origin.stdout) : null;
  if (!originRepo || originRepo.toLowerCase() !== o.repo.toLowerCase()) {
    return early(2, `origin of ${repoDir} is ${origin.stdout.trim() || '(none)'}, not ${o.repo}`);
  }

  const firstIssue = o.entries[0].issue;
  const trainLine = (result, state, id, extra = '') => {
    const note = `state=${state} train=${id ?? '-'} base=${o.base} queue=${o.queue}${extra ? ` ${extra}` : ''}`;
    appendRecord(o.runDir, o.issues, { issue: firstIssue, stage: 'train', result, note }, now());
  };

  const root = deps.lockRoot ?? trainLockRoot(machineLockRoot(home));
  const lockName = trainLockName(o.repo, o.base);
  const lock = (deps.acquireTrainLock ?? acquireMachineLockSync)(lockName, {
    root,
    timeoutMs: Number(o.lockTimeout) * 1000,
    ...(deps.pgid ? { pgid: deps.pgid } : {}),
    ...(deps.lockSleep ? { sleep: deps.lockSleep } : {}),
    ownerFields: { phase: 'idle', repo: o.repo, base: o.base },
    warn: (line) => log(`train lock: ${line}`),
  });
  if (!lock.acquired) {
    const owner = readOwner(lockPathOf(root, lockName));
    trainLine('fail', 'lock-timeout', null, `waited=${Math.round((lock.waitedMs ?? 0) / 1000)}s`);
    return early(124, `train lock ${lockName} held by ${owner ? `${describeOwner(owner)}${owner.pgid ? ` (pgid ${owner.pgid})` : ''}` : lock.heldBy ?? 'nobody readable'} (--lock-timeout ${o.lockTimeout})`);
  }

  try {
    let rebuilds = 0;
    for (;;) {
      const result = oneTrain(o, { ...deps, run, sleep, now, log, error, repoDir, home, lock, trainLine, rebuilds });
      if (result.rebuild && rebuilds < Number(o.rebuildMax)) {
        rebuilds += 1;
        continue;
      }
      const report = buildReport({ ...result.report, rebuilds });
      let saved = null;
      if (report.id) {
        try {
          const dir = path.join(o.runDir, 'train');
          fs.mkdirSync(dir, { recursive: true });
          saved = path.join(dir, `${report.id}.json`);
          fs.writeFileSync(saved, `${JSON.stringify(report, null, 2)}\n`);
        } catch (err) {
          const failed = buildReport({ ...report, verdict: 'stopped', exit: 1, reason: `the report could not be written: ${describeError(err)}` });
          error(formatReport(failed));
          if (json) out(JSON.stringify(failed, null, 2));
          return 1;
        }
      }
      const text = formatReport(report) + (saved ? `\n  report: ${saved}` : '');
      if (report.exit === 0) log(text);
      else error(text);
      if (json) out(JSON.stringify(report, null, 2));
      return report.exit;
    }
  } finally {
    try {
      lock.setOwnerFields?.({ phase: 'idle' });
    } finally {
      lock.release();
    }
  }
}

/**
 * One train under the lock: select → build → check → push → CI → report. Always returns a report
 * (never throws); `rebuild: true` when the base moved after the verdict and the train was withdrawn.
 */
function oneTrain(o, deps) {
  const { run, sleep, now, log, error, repoDir, home, lock, trainLine } = deps;
  const id = trainId(now(), deps.pid ?? process.pid, deps.random);
  const ref = trainRef(o.base, id);
  const target = trainTarget(o.base, id);
  const reportsDir = path.join(o.runDir, 'train');
  const tmpdir = deps.tmpdir ?? os.tmpdir();
  const report = {
    id, repo: o.repo, base: o.base, B0: null, ref, verdict: 'stopped', exit: 1, reason: null,
    verified: null, adopted: [], dropped: [], unresolved: [], ci: null, eligibility: null,
    gitConfig: null, deps: null, precheck: null, pushed: null, refs: null, cancel: null,
  };
  let trainDir = null;
  let pushed = false;
  let runId = null;
  const phase = (p) => {
    if (lock.setOwnerFields && lock.setOwnerFields({ phase: p, train: id }) === false) {
      throw new TrainStop(1, `the train lock's record could not be updated (phase ${p}) — stopped before the next outside call`);
    }
  };
  const withdraw = () => {
    // I7: only the manifest's run and the own ref (lease = the pushed T_N).
    if (runId !== null) {
      const cancel = run('gh', ['run', 'cancel', String(runId), '--repo', o.repo]);
      if (cancel.status !== 0) {
        report.cancel = `failed run=${runId}`;
        error(`merge-train ${id}: gh run cancel ${runId}: ${(cancel.stderr || cancel.stdout).trim()} — left running`);
      } else report.cancel = `ok run=${runId}`;
    }
    if (pushed) {
      const del = deleteTrainRef(run, repoDir, { target, expect: report.pushed, base: o.base, ids: [id] });
      if (!del.deleted) error(`merge-train ${id}: ${target} not deleted: ${del.detail}`);
    }
  };
  const finish = (verdict, exit, reason, extra = {}) => {
    Object.assign(report, { verdict, exit, reason }, extra);
    return { report };
  };
  try {
    phase('select');
    report.refs = pruneOwnRefs(run, repoDir, { base: o.base, keep: Number(o.keepRefs), reportsDir, ownId: id });
    const { candidates, dropped, unresolved } = classifyEntries(o, { run, repoDir, home, mergeLockRoot: deps.mergeLockRoot });
    report.dropped.push(...dropped);
    report.unresolved = unresolved;
    report.eligibility = readEligibility(run, { repo: o.repo, base: o.base });
    report.gitConfig = gitConfigOf(run, repoDir);
    git(run, repoDir, ['fetch', 'origin', o.base]);
    const B0 = git(run, repoDir, ['rev-parse', '--verify', `refs/remotes/origin/${o.base}^{commit}`]).trim();
    report.B0 = B0;
    if (candidates.length === 0) {
      trainLine('skip', 'empty', id);
      return finish('empty', 0, 'no candidate left');
    }
    phase('build');
    const built = buildTrain(run, repoDir, { B0, candidates, id });
    report.dropped.push(...built.dropped);
    report.adopted = built.adopted;
    const kept = candidates.filter((c) => built.adopted.some((a) => a.pr === c.pr));
    if (kept.length === 0) {
      trainLine('skip', 'empty', id);
      return finish('empty', 0, 'every candidate was dropped');
    }
    const T = built.T;
    const tree = built.chain[built.chain.length - 1].tree;

    phase('check');
    const source = o.source ?? kept[0].worktree;
    const depState = depsState(run, { repoDir, B0, T, source });
    report.deps = { ...depState, source };
    if (depState.state !== 'same') {
      trainLine('fail', 'stopped', id, `deps=${depState.state}`);
      return finish('stopped', 2, `deps=${depState.state}: ${depState.detail}`);
    }
    trainDir = trainDirOf(tmpdir, o.repo, id);
    git(run, repoDir, ['clone', '--quiet', '--shared', '--no-checkout', repoDir, trainDir]);
    git(run, trainDir, ['checkout', '--quiet', '--detach', T]);
    try {
      linkNodeModules(source, trainDir);
    } catch (err) {
      throw new TrainStop(2, `node_modules link failed: ${describeError(err)}`);
    }
    const markers = markerFiles(run, trainDir);
    if (markers.length > 0) {
      trainLine('fail', 'stopped', id, `marker=fail`);
      return finish('stopped', 1, `conflict markers in ${markers.join(', ')}`);
    }
    const args = precheckArgs({ runDir: o.runDir, issues: o.issues, worktree: trainDir, B0, candidates: kept });
    const code = (deps.runPrecheck ?? runPrecheckMain)(args, { run, now, log, error, home });
    report.precheck = { args, exit: code };
    if (code !== 0) {
      trainLine('fail', 'stopped', id, `precheck=${code}`);
      return finish('stopped', code === 3 ? 3 : 1, `the precheck of ${T.slice(0, 7)} exited ${code} — not pushed`);
    }

    phase('push');
    const remote = run('git', ['-C', repoDir, 'ls-remote', 'origin', target]);
    if (remote.status !== 0 || remote.stdout.trim() !== '') {
      throw new TrainStop(1, `${target} ${remote.status !== 0 ? `could not be read: ${remote.stderr.trim()}` : 'already exists'} — not pushed`);
    }
    const push = createTrainRef(run, repoDir, { target, sha: T, base: o.base, ownId: id, sleep, notice: error });
    if (push.status !== 0) throw new TrainStop(1, `git push ${target} failed: ${(push.stderr || push.stdout).trim()}`);
    pushed = true;
    report.pushed = T;
    trainLine('skip', 'pushed', id, `T=${T}`);

    phase('ci-wait');
    const verified = { sha: T, tree, policy: o.required, workflow: o.workflow, event: 'push', ref, runId: null, checkSuiteId: null, attempt: null };
    const registerDeadline = now().getTime() + Number(o.registerTimeout) * 1000;
    let ciDeadline = null;
    let rerunFrom = null;
    let last = null;
    for (;;) {
      const ev = collectCiEvidence(run, { repo: o.repo, sha: T, ref, workflow: o.workflow, minAttempt: rerunFrom === null ? 1 : rerunFrom + 1 });
      if (ev.state === 'ambiguous') {
        trainLine('fail', 'stopped', id, `runs=${ev.runs.join(',')}`);
        return finish('stopped', 1, `${ev.runs.length} runs match the manifest (${ev.runs.join(', ')}) — not judged`, { verified });
      }
      if (ev.run) {
        runId = ev.run.id;
        if (ciDeadline === null) ciDeadline = now().getTime() + Number(o.ciTimeout) * 1000;
      }
      const verdict = ev.state === 'read' ? judgeTrain(ev, { required: o.required }) : null;
      if (verdict) last = verdict;
      // I6: read after the checks; an unread base is never green.
      const fetched = run('git', ['-C', repoDir, 'fetch', 'origin', o.base]).status === 0;
      if (fetched) {
        const current = run('git', ['-C', repoDir, 'rev-parse', '--verify', `refs/remotes/origin/${o.base}^{commit}`]);
        if (current.status === 0 && current.stdout.trim() !== B0) {
          trainLine('fail', 'base-moved', id, `B0=${B0} now=${current.stdout.trim()}`);
          withdraw();
          pushed = false;
          return { ...finish('stale', 4, `origin/${o.base} moved from ${B0.slice(0, 7)} to ${current.stdout.trim().slice(0, 7)} — this train is not the combination that would land`, { verified }), rebuild: true };
        }
      }
      if (verdict && ev.state === 'read') {
        Object.assign(verified, { runId: ev.run.id, checkSuiteId: ev.run.checkSuiteId, attempt: ev.run.attempt });
        report.ci = { summary: verdict.summary, failed: verdict.failed.map((c) => `${c.name}:${c.bucket}`), statuses: ev.statuses, others: ev.others };
        if (verdict.state === 'fail') {
          const onlyOthers = verdict.ownFailed.length === 0;
          if (rerunFrom !== null || onlyOthers) {
            trainLine('fail', 'red', id, `T=${T}`);
            return finish('red', 1, `CI failed on ${T.slice(0, 7)} (PRs ${built.adopted.map((a) => `#${a.pr}`).join(', ')})${rerunFrom !== null ? ' after the re-run' : ''}`, { verified });
          }
          if (ev.run.status === 'completed') {
            const before = ev.run.attempt;
            const again = ghWrite(run, ['run', 'rerun', String(ev.run.id), '--failed', '--repo', o.repo], {
              notice: error,
              confirm: () => {
                const after = Number(JSON.parse(run('gh', ['run', 'view', String(ev.run.id), '--repo', o.repo, '--json', 'attempt']).stdout).attempt);
                return after > before ? '' : null;
              },
            });
            if (again.status === 0) {
              rerunFrom = before;
              trainLine('fail', 'rerun', id, `run=${ev.run.id} attempt=${before}`);
              log(`merge-train ${id}: re-ran the failed jobs of run ${ev.run.id} (attempt ${before})`);
            } else if (!/already running/i.test(`${again.stderr}\n${again.stdout}`)) {
              throw new TrainStop(1, `gh run rerun ${ev.run.id} failed: ${(again.stderr || again.stdout).trim()}`);
            }
          }
        } else if (verdict.state === 'ok' && fetched) {
          if (rerunFrom !== null) {
            trainLine('fail', 'green-after-rerun-unverified', id, `T=${T}`);
            return finish('green-after-rerun-unverified', 1, `green after the re-run of run ${ev.run.id}; how the API lists the jobs of a re-run attempt is not confirmed yet (V9)`, { verified });
          }
          trainLine('ok', 'green', id, `T=${T}`);
          return finish('green', 0, `one CI of ${T.slice(0, 7)} over ${B0.slice(0, 7)} is green`, { verified });
        }
      }
      if (ciDeadline === null && now().getTime() >= registerDeadline) {
        trainLine('fail', 'timeout', id, 'register');
        return finish('timeout', 124, `no ${o.workflow} push run on ${ref} within ${o.registerTimeout}s — does the workflow run on train/** pushes (on.push.branches)?`, { verified });
      }
      if (ciDeadline !== null && now().getTime() >= ciDeadline) {
        trainLine('fail', 'timeout', id, 'ci');
        const waiting = last ? last.waiting.join(', ') : ev.reason ?? '-';
        return finish('timeout', 124, `CI did not settle within ${o.ciTimeout}s (waiting for ${waiting})`, { verified });
      }
      sleep(Number(o.poll) * 1000);
    }
  } catch (err) {
    const exit = err instanceof TrainStop ? err.exit : 1;
    try {
      trainLine('fail', 'stopped', id, `exit=${exit}`);
    } catch {
      // the report still says it
    }
    return finish('stopped', exit, describeError(err));
  } finally {
    if (trainDir) {
      try {
        fs.rmSync(trainDir, { recursive: true, force: true });
      } catch (err) {
        error(`merge-train ${id}: could not remove ${trainDir}: ${describeError(err)}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The command: an outer process that re-starts itself in its own process group (merge-pr.mjs runOuter)
// ---------------------------------------------------------------------------

/** @param {Record<string, string | undefined>} [env] */
export function innerSpawnOptions(env = process.env) {
  return { detached: true, stdio: 'inherit', env: { ...env, [INNER_ENV]: '1' } };
}

const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
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
      console.error(`merge-train: could not start the inner process: ${err.message}`);
      done(1);
    });
    child.on('exit', (code, signal) => done(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1)));
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.env[INNER_ENV] === '1') {
    delete process.env[INNER_ENV];
    process.exit(main(process.argv.slice(2), { pgid: process.pid }));
  } else {
    runOuter(process.argv.slice(2)).then((code) => process.exit(code));
  }
}
