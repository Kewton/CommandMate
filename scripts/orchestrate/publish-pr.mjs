#!/usr/bin/env node
/**
 * `/orchestrate` 6-1: push the Issue's branch and open its PR, once (Issue #3477, PR 3).
 *
 * In order, stopping at the first that does not hold:
 *   1. the tree is clean (exit 2) — what is pushed is the HEAD the records name;
 *   2. the run record has verify / review / findings for the work HEAD and a
 *      precheck for the HEAD that is pushed (pr-common.mjs REQUIRED_RECORDS,
 *      judged by run-log.mjs `unmetStage` like `status`; 6-1-1's order puts them
 *      all before the PR). A HEAD that merges develop or folds module-reference
 *      on top of the work therefore needs its own precheck. No tracked file has
 *      a conflict marker, and the fragments are there (6-4);
 *   3. the module-reference fragment is copied into the run directory, because
 *      dev-reports/ is never committed and goes with the worktree;
 *   4. `git push -u origin <branch>` (never forced);
 *   5. the PR is opened only when the branch has no open PR — a rerun after a
 *      crash finds the one it opened and records it instead. A merged PR on the
 *      branch means the Issue's work is in: nothing is pushed. An open PR of
 *      another branch that refers to the Issue (`(#<N>)` in the title, `Closes
 *      #<N>` and the like in the body as /create-pr writes it, or the number in
 *      the branch) stops the run (two PRs for one Issue), unless `--allow-other-pr`.
 * The result goes to the `pr` stage of `run-log.mjs` with the PR number, the
 * pushed HEAD and the work HEAD under it.
 *
 * Exit code: 0 published (or already open / merged), 1 a condition failed or a
 * command failed, 2 usage error or a dirty tree.
 *
 * Usage:
 *   node scripts/orchestrate/publish-pr.mjs --run-dir <dir> --issues <range> --issue <N> --worktree <path>
 *        [--branch <name>] [--base develop] [--repo Kewton/CommandMate] [--title <text>] [--body-file <file>]
 *        [--label <a,b>] [--allow-other-pr]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { appendRecord, readRecords } from './run-log.mjs';
import {
  DEFAULT_BASE_BRANCH,
  DEFAULT_REPO,
  defaultRun,
  dirtyPaths,
  fragmentProblems,
  ghJson,
  git,
  markerFiles,
  missingRecords,
  moduleReferenceBackup,
  moduleReferenceFragment,
  prsOfBranch,
  refersToIssue,
  workHeadOf,
} from './pr-common.mjs';

const USAGE = `Usage:
  node scripts/orchestrate/publish-pr.mjs --run-dir <dir> --issues <range> --issue <N> --worktree <path>
       [--branch <name>] [--base ${DEFAULT_BASE_BRANCH}] [--repo ${DEFAULT_REPO}] [--title <text>] [--body-file <file>] [--label <a,b>] [--allow-other-pr]`;

const FLAGS = {
  '--run-dir': 'runDir',
  '--issues': 'issues',
  '--issue': 'issue',
  '--worktree': 'worktree',
  '--branch': 'branch',
  '--base': 'base',
  '--repo': 'repo',
  '--title': 'title',
  '--body-file': 'bodyFile',
  '--label': 'label',
};
const SWITCHES = { '--allow-other-pr': 'allowOtherPr' };

export function parseArgs(argv) {
  const options = { base: DEFAULT_BASE_BRANCH, repo: DEFAULT_REPO, allowOtherPr: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (SWITCHES[arg]) options[SWITCHES[arg]] = true;
    else if (FLAGS[arg] && i + 1 < argv.length) options[FLAGS[arg]] = argv[++i];
    else return { error: `unknown or incomplete argument: ${arg}` };
  }
  for (const flag of ['--run-dir', '--issues', '--issue', '--worktree']) {
    if (!options[FLAGS[flag]]) return { error: `${flag} is required` };
  }
  return { options };
}

/** Values a shell would have expanded; parseArgs takes `$issue` as written so orchestrate.md's calls can be checked. */
export function validate(options) {
  if (!/^\d+$/.test(options.issue)) return `--issue must be an Issue number (got ${options.issue})`;
  return null;
}

/** The PR number at the end of `gh pr create`'s URL line. */
export function prNumberFromUrl(text) {
  const match = /\/pull\/(\d+)\s*$/.exec(text.trim());
  return match ? Number(match[1]) : null;
}

/** The default PR body: the HEAD commit's body, and the Issue (develop PRs do not close it; merge-pr.mjs does). */
export function defaultBody(commitBody, issue) {
  return `${commitBody.trim()}\n\nRefs #${issue}\n`.replace(/^\n+/, '');
}

/**
 * @param {string[]} argv
 * @param {{ run?: typeof defaultRun, now?: () => Date, log?: (line: string) => void, error?: (line: string) => void }} [deps]
 * @returns {number} exit code
 */
export function main(argv, deps = {}) {
  const { run = defaultRun, now = () => new Date() } = deps;
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

  try {
    const head = git(run, o.worktree, ['rev-parse', 'HEAD']).trim();
    const short = head.slice(0, 7);
    const dirty = dirtyPaths(run, o.worktree);
    if (dirty.length > 0) {
      error(`publish #${issue}: uncommitted changes in ${o.worktree} — ${short} is not what would be pushed:\n  ${dirty.join('\n  ')}`);
      return 2;
    }
    const branch = o.branch ?? git(run, o.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    if (['HEAD', 'develop', 'main', o.base].includes(branch)) {
      error(`publish #${issue}: ${o.worktree} is on ${branch}, not an Issue branch — pass --branch`);
      return 2;
    }
    const workHead = workHeadOf(run, o.worktree, head);
    const record = (prNumber, note) => {
      const { file } = appendRecord(
        o.runDir,
        o.issues,
        { issue, stage: 'pr', result: 'ok', head, workHead, note: `pr=#${prNumber} ${note}` },
        now()
      );
      log(`recorded -> ${file}`);
    };

    const { open, merged } = prsOfBranch(run, o.repo, branch);
    if (!open && merged) {
      log(`publish #${issue}: ${branch} was merged in #${merged.number} — nothing to push (merge-pr.mjs closes the Issue)`);
      return 0;
    }

    const { records } = readRecords(o.runDir, o.issues);
    const markers = markerFiles(run, o.worktree);
    const problems = [
      ...missingRecords(records, issue, { head, workHead }),
      ...(markers.length > 0 ? [`conflict markers in ${markers.join(', ')} (6-2)`] : []),
      ...fragmentProblems(run, { worktree: o.worktree, runDir: o.runDir, issue, baseRef }),
    ];
    if (!open && !o.allowOtherPr) {
      // Every open PR, filtered here: a search would miss a body reference or a branch name.
      const others = ghJson(run, ['pr', 'list', '--repo', o.repo, '--state', 'open', '--limit', '500', '--json', 'number,title,body,headRefName']);
      for (const pr of others) {
        if (pr.headRefName !== branch && refersToIssue(pr, issue)) {
          problems.push(`#${pr.number} (${pr.headRefName}) is already open for #${issue} — pass --allow-other-pr if both are meant`);
        }
      }
    }
    if (problems.length > 0) {
      error(`publish #${issue} ${short}: not published:\n  ${problems.join('\n  ')}`);
      return 1;
    }

    // dev-reports/ goes with the worktree; 6-4 folds this copy into the body later.
    const fragment = moduleReferenceFragment(o.worktree, issue);
    if (fs.existsSync(fragment)) {
      fs.mkdirSync(o.runDir, { recursive: true });
      fs.copyFileSync(fragment, moduleReferenceBackup(o.runDir, issue));
    }

    const push = run('git', ['-C', o.worktree, 'push', '-u', 'origin', branch]);
    if (push.status !== 0) {
      error(`publish #${issue}: git push failed: ${(push.stderr || push.stdout).trim()}`);
      return 1;
    }
    log(`pushed ${branch} at ${short}`);

    if (open) {
      log(`publish #${issue}: #${open.number} is already open for ${branch} — not creating another`);
      record(open.number, `existing ${open.url}`);
      return 0;
    }

    const title = o.title ?? git(run, o.worktree, ['log', '-1', '--format=%s', head]).trim();
    let bodyFile = o.bodyFile;
    let tmpDir = null;
    if (!bodyFile) {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-publish-pr-'));
      bodyFile = path.join(tmpDir, 'body.md');
      fs.writeFileSync(bodyFile, defaultBody(git(run, o.worktree, ['log', '-1', '--format=%b', head]), issue));
    }
    try {
      const create = run('gh', [
        'pr', 'create', '--repo', o.repo, '--base', o.base, '--head', branch, '--title', title, '--body-file', bodyFile,
        ...(o.label ? ['--label', o.label] : []),
      ]);
      const number = create.status === 0 ? prNumberFromUrl(create.stdout) : null;
      if (number === null) {
        error(`publish #${issue}: gh pr create failed: ${(create.stderr || create.stdout).trim()}`);
        return 1;
      }
      log(`publish #${issue}: opened #${number} ${create.stdout.trim()}`);
      record(number, `created ${create.stdout.trim()}`);
      return 0;
    } finally {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));
