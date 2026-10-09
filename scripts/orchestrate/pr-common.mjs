/**
 * What `publish-pr.mjs` and `merge-pr.mjs` share (Issue #3477, PR 3): the
 * commands they run, the PR of a branch, and the conditions read from the run
 * record before anything is published or merged.
 *
 * Both scripts take every external call (`git`, `gh`, `npx`) through one `run`
 * function, so the tests replace it and nothing is pushed, opened or merged.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

export const DEFAULT_REPO = 'Kewton/CommandMate';
/** The branch PRs go to (6-x: feature → develop). The remote ref is `origin/<base>`. */
export const DEFAULT_BASE_BRANCH = 'develop';
/** Files the orchestrator leaves in a worktree that are not the worker's work. */
export const IGNORED_DIRTY = ['.commandmate/tasks/', 'dev-reports/'];
/** Files the orchestrator may commit on the PR branch after the checks (6-4: the module-reference fold). */
export const ORCHESTRATOR_FILES = ['docs/module-reference.md'];
/**
 * What the run record must hold for the work HEAD before it is published or
 * merged. `review` takes `skip` for an Issue 5-2b does not cover (docs only,
 * tests only): the orchestrator records that decision instead of leaving the
 * stage empty, so a forgotten review and a review that does not apply differ.
 */
export const REQUIRED_RECORDS = [
  { stage: 'verify', accept: ['ok'], why: '3-3 / 5-1' },
  { stage: 'review', accept: ['ok', 'skip'], why: '5-2b' },
  { stage: 'findings', accept: ['ok'], why: '5-3' },
  { stage: 'precheck', accept: ['ok'], why: '6-1-1' },
];

export function defaultRun(command, args, { cwd, env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export const lines = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean);

export function git(run, worktree, args) {
  const { status, stdout, stderr } = run('git', ['-C', worktree, ...args]);
  if (status !== 0) throw new Error(`git ${args.join(' ')} failed in ${worktree}: ${stderr.trim()}`);
  return stdout;
}

/** `gh …` parsed as JSON; throws with gh's own message when it fails. */
export function ghJson(run, args) {
  const { status, stdout, stderr } = run('gh', args);
  if (status !== 0) throw new Error(`gh ${args.join(' ')} failed: ${(stderr || stdout).trim()}`);
  return JSON.parse(stdout);
}

/** Changed paths other than the contract and dev-reports (`git status --porcelain`). */
export function dirtyPaths(run, worktree) {
  return lines(git(run, worktree, ['status', '--porcelain']))
    .map((line) => line.replace(/^\S+\s+/, ''))
    .filter((file) => !IGNORED_DIRTY.some((prefix) => file.startsWith(prefix)));
}

/**
 * The branch's PRs, newest first: `{ open, merged }` (either may be null).
 * The branch is the Issue's (`feature/<N>-worktree`), so this is "the PR of
 * this Issue" for both scripts.
 */
export function prsOfBranch(run, repo, branch) {
  const prs = ghJson(run, [
    'pr', 'list', '--repo', repo, '--head', branch, '--state', 'all',
    '--json', 'number,state,headRefOid,url,title,baseRefName',
  ]);
  const sorted = [...prs].sort((a, b) => b.number - a.number);
  return {
    open: sorted.find((pr) => pr.state === 'OPEN') ?? null,
    merged: sorted.find((pr) => pr.state === 'MERGED') ?? null,
  };
}

/**
 * The commits whose records still describe HEAD: HEAD itself, then down the
 * first parent while the commit is a merge (6-2's refresh) or touches only
 * ORCHESTRATOR_FILES (6-4's fold), and the first commit that is neither — the
 * worker's last commit, which verify / review / findings / precheck saw.
 */
export function workHeads(run, worktree, head) {
  const heads = [];
  const log = lines(git(run, worktree, ['log', '--first-parent', '--format=%H %P', '-n', '50', head]));
  for (const line of log) {
    const [sha, ...parents] = line.split(' ');
    heads.push(sha);
    if (parents.length > 1) continue;
    const files = lines(git(run, worktree, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha]));
    if (files.length > 0 && files.every((file) => ORCHESTRATOR_FILES.includes(file))) continue;
    break;
  }
  return heads;
}

/**
 * What the run record lacks for `heads` (workHeads): for each required stage,
 * the latest record of this Issue taken on one of those commits must be an
 * accepted result. A later fail on the same work replaces an earlier ok.
 */
export function missingRecords(records, issue, heads) {
  const short = heads[0] ? heads[0].slice(0, 7) : '-';
  const missing = [];
  for (const { stage, accept, why } of REQUIRED_RECORDS) {
    let latest = null;
    for (let i = records.length - 1; i >= 0; i--) {
      const record = records[i];
      if (record.issue === issue && record.stage === stage && heads.includes(record.head)) {
        latest = record;
        break;
      }
    }
    if (!latest) missing.push(`${stage}: no record for ${short} (${why})`);
    else if (!accept.includes(latest.result)) missing.push(`${stage}: ${latest.result} at ${latest.head.slice(0, 7)} (${why})`);
  }
  return missing;
}

export function moduleReferenceFragment(worktree, issue) {
  return path.join(worktree, 'dev-reports', 'module-reference', `issue-${issue}.md`);
}

export function moduleReferenceBackup(runDir, issue) {
  return path.join(runDir, `module-reference-${issue}.md`);
}

/**
 * 6-4: a PR without its fragments is not published or merged. The CHANGELOG
 * fragment must be in the branch's commits; the module-reference one is in
 * dev-reports/ (never committed), or in the run directory's copy of it.
 */
export function fragmentProblems(run, { worktree, runDir, issue, baseRef }) {
  const problems = [];
  const fragment = `changelog.d/${issue}.md`;
  const status = lines(git(run, worktree, ['diff', '--name-status', '--no-renames', `${baseRef}...HEAD`, '--', 'changelog.d/']));
  if (!status.some((line) => /^[AM]\s/.test(line) && line.replace(/^[AM]\s+/, '') === fragment)) {
    problems.push(`${fragment} is not in the branch's commits (6-4)`);
  }
  if (!fs.existsSync(moduleReferenceFragment(worktree, issue)) && !fs.existsSync(moduleReferenceBackup(runDir, issue))) {
    problems.push(`dev-reports/module-reference/issue-${issue}.md is missing (6-4)`);
  }
  return problems;
}
