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
 *      the run record already has `precheck=ok` for that very HEAD. Only then
 *      `git push`;
 *   5. the PR's checks (6-3): no `fail` / `cancel` in `bucket` — a failed job is
 *      re-run once per HEAD (`gh run rerun --failed`, recorded in the `ci` stage
 *      so a rerun after a crash does not re-run it again); `Build` is `pass`
 *      unless the precheck of this HEAD built what the CI `Build` builds
 *      (`build`, `build-cli`, `build-server` all `ok`); `Unit Tests` is `pass`
 *      unless the verification passed verify.yaml's full `unit` gate — a
 *      `unit-related` or a refactor contract (lint / typecheck only) waits for
 *      it (2-4-3, 6-2), and `--unit-related` forces the wait; with `--last`
 *      every check is `pass` (6-2: only the last PR waits for the full CI).
 *      Anything else `pending` is not waited for;
 *   6. `gh pr merge --squash --match-head-commit <HEAD>`, recorded in the
 *      `merge` stage, then `gh issue close` unless `--close -`.
 *
 * Exit code: 0 merged (or already merged), 1 a condition or a command failed,
 * 2 usage error or a dirty tree, 124 the CI did not settle within --ci-timeout.
 *
 * Usage:
 *   node scripts/orchestrate/merge-pr.mjs --run-dir <dir> --issues <range> --issue <N> --worktree <path>
 *        [--pr <number>] [--branch <name>] [--base develop] [--repo Kewton/CommandMate]
 *        [--close <N|->] [--last] [--unit-related] [--ci-timeout <sec>] [--poll <sec>]
 */
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { appendRecord, findLatest, latestByStage, readRecords, unmetStage } from './run-log.mjs';
import { BUILD_STEPS, findTestsNaming, main as runPrecheck, optionsFromNote, parseNote, passedGates } from './precheck.mjs';
import {
  DEFAULT_BASE_BRANCH,
  DEFAULT_REPO,
  defaultRun,
  defaultSleep,
  dirtyPaths,
  fragmentProblems,
  ghJson,
  git,
  lines,
  markerFiles,
  missingRecords,
  prsOfBranch,
  workHeadOf,
} from './pr-common.mjs';

export const DEFAULT_CI_TIMEOUT_SEC = 3600;
export const DEFAULT_POLL_SEC = 30;
export const BUILD_CHECK = 'Build';
export const UNIT_CHECK = 'Unit Tests';
/** `bucket` values that settle a check without failing it. */
const SETTLED_OK = ['pass', 'skipping'];

/**
 * 6-3 over `gh pr checks --json name,bucket,link`.
 *
 * @param {{ name: string, bucket: string, link?: string }[]} checks
 * @param {{ needBuild: boolean, needUnit: boolean, last: boolean }} need
 * @returns {{ state: 'fail' | 'pending' | 'ok', failed: typeof checks, waiting: string[], summary: string }}
 */
export function judgeChecks(checks, { needBuild, needUnit, last }) {
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

/** Whether a precheck record built everything CI's `Build` builds (`build`, `build:cli`, `build:server`). */
export function builtLikeCi(precheckRecord) {
  if (!precheckRecord || precheckRecord.result !== 'ok') return false;
  const steps = parseNote(precheckRecord.note);
  return BUILD_STEPS.every((step) => steps[step] === 'ok');
}

const USAGE = `Usage:
  node scripts/orchestrate/merge-pr.mjs --run-dir <dir> --issues <range> --issue <N> --worktree <path>
       [--pr <number>] [--branch <name>] [--base ${DEFAULT_BASE_BRANCH}] [--repo ${DEFAULT_REPO}]
       [--close <N|->] [--last] [--unit-related] [--ci-timeout <sec>] [--poll <sec>]`;

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
  '--poll': 'poll',
};
const SWITCHES = { '--last': 'last', '--unit-related': 'unitRelated' };

export function parseArgs(argv) {
  const options = {
    base: DEFAULT_BASE_BRANCH,
    repo: DEFAULT_REPO,
    last: false,
    unitRelated: false,
    ciTimeout: String(DEFAULT_CI_TIMEOUT_SEC),
    poll: String(DEFAULT_POLL_SEC),
    close: /** @type {string | undefined} */ (undefined),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (SWITCHES[arg]) options[SWITCHES[arg]] = true;
    else if (FLAGS[arg] && i + 1 < argv.length) options[FLAGS[arg]] = argv[++i];
    else return { error: `unknown or incomplete argument: ${arg}` };
  }
  for (const flag of ['--run-dir', '--issues', '--issue', '--worktree']) {
    if (!options[FLAGS[flag]]) return { error: `${flag} is required` };
  }
  options.close = options.close ?? options.issue;
  return { options };
}

/** Values a shell would have expanded; parseArgs takes `$issue` as written so orchestrate.md's calls can be checked. */
export function validate(options) {
  if (!/^\d+$/.test(options.issue)) return `--issue must be an Issue number (got ${options.issue})`;
  if (options.close !== '-' && !/^\d+$/.test(options.close)) return `--close must be an Issue number or - (got ${options.close})`;
  if (options.pr !== undefined && !/^\d+$/.test(options.pr)) return `--pr must be a PR number (got ${options.pr})`;
  for (const flag of ['--ci-timeout', '--poll']) {
    if (!/^\d+$/.test(options[FLAGS[flag]])) return `${flag} must be seconds (got ${options[FLAGS[flag]]})`;
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
 *   log?: (line: string) => void,
 *   error?: (line: string) => void,
 * }} [deps]
 * @returns {number} exit code
 */
export function main(argv, deps = {}) {
  const { run = defaultRun, sleep = defaultSleep, now = () => new Date() } = deps;
  const findNaming = deps.findTestsNaming ?? findTestsNaming;
  const log = deps.log ?? ((line) => console.log(line));
  const error = deps.error ?? ((line) => console.error(line));

  const parsed = parseArgs(argv);
  if (parsed.error) {
    error(`${parsed.error}\n${USAGE}`);
    return 2;
  }
  const o = parsed.options;
  const invalid = validate(o);
  if (invalid) {
    error(`${invalid}\n${USAGE}`);
    return 2;
  }
  const issue = Number(o.issue);
  const baseRef = `origin/${o.base}`;
  const started = now();

  const record = (stage, result, head, note, workHead = null) => {
    const durationSec = Math.round((now().getTime() - started.getTime()) / 1000);
    const { file } = appendRecord(o.runDir, o.issues, { issue, stage, result, head, workHead, durationSec, note }, now());
    log(`${stage} #${issue} ${head.slice(0, 7)} ${result}: ${note} -> ${file}`);
  };

  /** Close the Issue unless `--close -`; a closed one is left as it is. */
  const closeIssue = (prNumber) => {
    if (o.close === '-') return 'kept-open';
    const state = ghJson(run, ['issue', 'view', o.close, '--repo', o.repo, '--json', 'state']).state;
    if (state !== 'OPEN') return 'already-closed';
    const closed = run('gh', ['issue', 'close', o.close, '--repo', o.repo, '--comment', `#${prNumber} でマージした。`]);
    if (closed.status !== 0) throw new Error(`gh issue close ${o.close} failed: ${(closed.stderr || closed.stdout).trim()}`);
    return 'closed';
  };

  try {
    const branch = o.branch ?? git(run, o.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const viewPr = (ref) =>
      ghJson(run, ['pr', 'view', String(ref), '--repo', o.repo, '--json', 'number,state,headRefOid,url,headRefName']);
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

    // 1. Never merge twice: finish what a merged PR leaves (the record, the Issue).
    if (pr.state === 'MERGED') {
      const { records } = readRecords(o.runDir, o.issues);
      if (!findLatest(records, { issue, stage: 'merge', head: pr.headRefOid, result: 'ok' })) {
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
    const workHead = workHeadOf(run, o.worktree, head);
    let { records } = readRecords(o.runDir, o.issues);
    const problems = [
      ...missingRecords(records, issue, { head, workHead }).filter((reason) => !reason.startsWith('precheck:')),
      ...fragmentProblems(run, { worktree: o.worktree, runDir: o.runDir, issue, baseRef }),
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
    }
    const markers = markerFiles(run, o.worktree);
    if (markers.length > 0) {
      record('merge', 'fail', head, `refresh=${refreshed ? 'merged' : '-'} marker=fail ${markers.join(',')}`, workHead);
      error(`merge #${issue}: conflict markers in ${markers.join(', ')} at ${head.slice(0, 7)} — not pushed`);
      return 1;
    }
    // The precheck is recorded per HEAD, so a HEAD pushed earlier (publish-pr.mjs
    // after a refresh) is checked here too unless it already passed.
    if (unmetStage('precheck', latestByStage(records, issue).precheck, { head, workHead })) {
      // The options come from the precheck of the work HEAD; when a fold commit on top made the
      // precheck run on the published HEAD only, from the Issue's latest precheck=ok (any HEAD).
      // Without either the options would be guessed (kind lost → suppressions=skip): stop (#3527).
      const workPrecheck =
        findLatest(records, { issue, stage: 'precheck', head: workHead, result: 'ok' }) ??
        findLatest(records, { issue, stage: 'precheck', result: 'ok' });
      if (!workPrecheck) {
        error(`merge #${issue}: no precheck=ok record to take the options from (kind etc.) — run precheck.mjs on the work HEAD first; not pushed`);
        return 1;
      }
      const code = runPrecheck(
        [
          '--run-dir', o.runDir, '--issues', o.issues, '--issue', String(issue), '--worktree', o.worktree,
          ...optionsFromNote(workPrecheck.note, baseRef),
        ],
        { run, now, log, error, findTestsNaming: findNaming }
      );
      if (code !== 0) {
        error(`merge #${issue}: the precheck of ${head.slice(0, 7)} did not pass${refreshed ? ' after the refresh' : ''} — not pushed`);
        return 1;
      }
    }
    if (head !== pr.headRefOid) {
      const push = run('git', ['-C', o.worktree, 'push', 'origin', `HEAD:${branch}`]);
      if (push.status !== 0) throw new Error(`git push failed: ${(push.stderr || push.stdout).trim()}`);
      log(`merge #${issue}: refresh=${refreshed ? 'merged' : 'unpushed'} marker=ok precheck=ok; pushed ${head.slice(0, 7)}`);
    }

    // 5. The checks of this HEAD.
    records = readRecords(o.runDir, o.issues).records;
    const needBuild = !builtLikeCi(findLatest(records, { issue, stage: 'precheck', head }));
    const verify = latestByStage(records, issue).verify ?? null;
    const need = { needBuild, needUnit: o.unitRelated || !ranFullUnit(verify), last: o.last };
    const rerunDone = records.some((r) => r.issue === issue && r.stage === 'ci' && r.head === head && /(^| )rerun=/.test(r.note ?? ''));
    let rerun = rerunDone;
    const deadline = now().getTime() + Number(o.ciTimeout) * 1000;
    let verdict;
    for (;;) {
      const current = viewPr(pr.number);
      if (current.state === 'MERGED') {
        record('merge', 'ok', current.headRefOid, `pr=#${pr.number} merged-elsewhere`, current.headRefOid === head ? workHead : null);
        log(`merge #${issue}: #${pr.number} was merged meanwhile — issue ${o.close}: ${closeIssue(pr.number)}`);
        return 0;
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
        verdict = judgeChecks(checks, need);
        if (verdict.state === 'fail') {
          const names = verdict.failed.map((check) => `${check.name}:${check.bucket}`).join(',');
          const ids = runIdsOf(verdict.failed);
          if (rerun || ids.length === 0) {
            record('ci', 'fail', head, `checks=${verdict.summary} failed=${names}${rerun ? ' after-rerun' : ''}`, workHead);
            error(`merge #${issue}: not merged — ${names} (6-3)`);
            return 1;
          }
          for (const id of ids) {
            const again = run('gh', ['run', 'rerun', id, '--failed', '--repo', o.repo]);
            if (again.status !== 0) throw new Error(`gh run rerun ${id} failed: ${(again.stderr || again.stdout).trim()}`);
          }
          rerun = true;
          record('ci', 'fail', head, `checks=${verdict.summary} failed=${names} rerun=${ids.join(',')}`, workHead);
        } else if (verdict.state === 'ok') break;
      }
      if (now().getTime() >= deadline) {
        error(`merge #${issue}: CI did not settle within ${o.ciTimeout}s (waiting for ${verdict?.waiting.join(', ') || `the PR head to reach ${head.slice(0, 7)}`})`);
        return 124;
      }
      sleep(Number(o.poll) * 1000);
    }
    record('ci', 'ok', head, `checks=${verdict.summary} build=${needBuild ? 'pass' : 'precheck'} unit=${need.needUnit ? 'pass' : '-'}${o.last ? ' last=all-pass' : ''}`, workHead);

    // 6. Merge exactly this HEAD, then the Issue.
    const merged = run('gh', ['pr', 'merge', String(pr.number), '--repo', o.repo, '--squash', '--match-head-commit', head]);
    if (merged.status !== 0) {
      record('merge', 'fail', head, `pr=#${pr.number} gh-merge-failed`, workHead);
      error(`merge #${issue}: gh pr merge failed: ${(merged.stderr || merged.stdout).trim()}`);
      return 1;
    }
    record('merge', 'ok', head, `pr=#${pr.number} squash`, workHead);
    log(`merge #${issue}: #${pr.number} merged — issue ${o.close}: ${closeIssue(pr.number)}`);
    return 0;
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));
