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
 *      A new PR is titled `--title`, else the Issue's title with ` (#<N>)`
 *      (prTitle, read before the push; unreadable → exit 1, nothing pushed).
 *   The work HEAD is pr-common.mjs workHeadOf: a merge the worker was verified
 *   on (a develop conflict it resolved) is the work HEAD itself (#4076).
 * The result goes to the `pr` stage of `run-log.mjs` with the PR number, the
 * pushed HEAD and the work HEAD under it.
 *
 * `--item <work item>` (#3883): one PR of an Issue that has several. Only that
 * work item's records are read and the `pr` record carries it, so another PR
 * of the Issue — its records at its own HEAD — neither stops this one nor
 * stands for it. The PRs the run record has for the Issue's other work items
 * are not taken for "two PRs for one Issue".
 *
 * Exit code: 0 published (or already open / merged), 1 a condition failed or a
 * command failed, 2 usage error or a dirty tree.
 *
 * Usage:
 *   node scripts/orchestrate/publish-pr.mjs --run-dir <dir> --issues <range> --issue <N> --worktree <path>
 *        [--branch <name>] [--base develop] [--repo Kewton/CommandMate] [--title <text>] [--body-file <file>]
 *        [--label <a,b>] [--allow-other-pr] [--item <work item>]
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
  defaultSleep,
  dirtyPaths,
  fragmentProblems,
  ghJson,
  ghWrite,
  git,
  markerFiles,
  missingRecords,
  moduleReferenceBackup,
  moduleReferenceFragment,
  prsOfBranch,
  itemOption,
  refersToIssue,
  siblingPrNumbers,
  withGhRetry,
  workHeadOf,
} from './pr-common.mjs';

const USAGE = `Usage:
  node scripts/orchestrate/publish-pr.mjs --run-dir <dir> --issues <range> --issue <N> --worktree <path>
       [--branch <name>] [--base ${DEFAULT_BASE_BRANCH}] [--repo ${DEFAULT_REPO}] [--title <text>] [--body-file <file>] [--label <a,b>] [--allow-other-pr] [--item <work item>]`;

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
  '--item': 'item',
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
  const item = itemOption(options);
  if ('error' in item) return { error: item.error };
  options.item = item.item;
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

/** `title` with ` (#<issue>)` at the end, unless it already names the Issue that way (#4076 B). */
export function withIssueNumber(title, issue) {
  const text = String(title).trim();
  return text.includes(`(#${issue})`) ? text : `${text} (#${issue})`;
}

/**
 * The title of a new PR (#4076 B): `--title` as given, else the Issue's own
 * title (`gh api repos/<repo>/issues/<N> --jq .title`) with ` (#<N>)` — for a work item's PR
 * (`--item`) too. The last commit's subject is not used: after a reinstruction
 * it names the last partial fix, not the work. When the title cannot be read,
 * `{ error }`: the caller stops before the push instead of guessing one.
 *
 * @returns {{ title: string } | { error: string }}
 */
export function prTitle(run, o, issue) {
  if (o.title) return { title: o.title };
  // `gh api` (a read, asked again on a 5xx) rather than `gh issue view`: the same title, and the
  // `gh issue` calls stay merge-pr's own (whether the Issue is closed).
  const read = run('gh', ['api', `repos/${o.repo}/issues/${issue}`, '--jq', '.title']);
  if (read.status !== 0) return { error: `could not read the title of #${issue}: ${(read.stderr || read.stdout).trim()}` };
  const title = String(read.stdout ?? '').trim();
  if (!title) return { error: `#${issue} has no title to name the PR by` };
  return { title: withIssueNumber(title, issue) };
}

/**
 * @param {string[]} argv
 * @param {{ run?: typeof defaultRun, sleep?: (ms: number) => void, now?: () => Date, log?: (line: string) => void, error?: (line: string) => void }} [deps]
 * @returns {number} exit code
 */
export function main(argv, deps = {}) {
  const { sleep = defaultSleep, now = () => new Date() } = deps;
  const log = deps.log ?? ((line) => console.log(line));
  const error = deps.error ?? ((line) => console.error(line));
  // GitHub's 5xx and dropped connections are asked again for reads, and said so (#3633 D).
  const run = withGhRetry(deps.run ?? defaultRun, { sleep, notice: error });

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
  const item = o.item;
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
    const { records } = readRecords(o.runDir, o.issues);
    // A merge verified on its own (a develop conflict the worker resolved) is the work HEAD (#4076).
    const workHead = workHeadOf(run, o.worktree, head, { records, issue, item });
    const record = (prNumber, note) => {
      const { file } = appendRecord(
        o.runDir,
        o.issues,
        { issue, item, stage: 'pr', result: 'ok', head, workHead, note: `pr=#${prNumber} ${note}` },
        now()
      );
      log(`recorded -> ${file}`);
    };

    const { open, merged } = prsOfBranch(run, o.repo, branch);
    if (!open && merged) {
      log(`publish #${issue}: ${branch} was merged in #${merged.number} — nothing to push (merge-pr.mjs closes the Issue)`);
      return 0;
    }

    const markers = markerFiles(run, o.worktree);
    const problems = [
      ...missingRecords(records, issue, { head, workHead }, item, { runDir: o.runDir, worktree: o.worktree, home: deps.home ?? os.homedir(), warn: log }),
      ...(markers.length > 0 ? [`conflict markers in ${markers.join(', ')} (6-2)`] : []),
      ...fragmentProblems(run, { worktree: o.worktree, runDir: o.runDir, issue, baseRef, item }),
    ];
    if (!open && !o.allowOtherPr) {
      // Every open PR, filtered here: a search would miss a body reference or a branch name.
      const others = ghJson(run, ['pr', 'list', '--repo', o.repo, '--state', 'open', '--limit', '500', '--json', 'number,title,body,headRefName']);
      // The run's own PRs of the Issue's other work items are meant; any other PR of the Issue still stops the run.
      const siblings = siblingPrNumbers(records, issue, item);
      for (const pr of others) {
        if (pr.headRefName !== branch && !siblings.has(pr.number) && refersToIssue(pr, issue)) {
          problems.push(`#${pr.number} (${pr.headRefName}) is already open for #${issue} — pass --allow-other-pr if both are meant`);
        }
      }
    }
    if (problems.length > 0) {
      error(`publish #${issue} ${short}: not published:\n  ${problems.join('\n  ')}`);
      return 1;
    }

    // The title of a new PR is settled before anything is pushed (#4076 B): one that cannot be named stops here.
    let title = null;
    if (!open) {
      const named = prTitle(run, o, issue);
      if ('error' in named) {
        error(`publish #${issue}: ${named.error} — pass --title; not pushed`);
        return 1;
      }
      title = named.title;
    }

    // dev-reports/ goes with the worktree; 6-4 folds this copy into the body later.
    const fragment = moduleReferenceFragment(o.worktree, issue);
    if (fs.existsSync(fragment)) {
      fs.mkdirSync(o.runDir, { recursive: true });
      fs.copyFileSync(fragment, moduleReferenceBackup(o.runDir, issue, item));
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

    let bodyFile = o.bodyFile;
    let tmpDir = null;
    if (!bodyFile) {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-publish-pr-'));
      bodyFile = path.join(tmpDir, 'body.md');
      fs.writeFileSync(bodyFile, defaultBody(git(run, o.worktree, ['log', '-1', '--format=%b', head]), issue));
    }
    try {
      // Sent once: a 5xx may still have opened it, so it is read back instead of sent again (#3633 D).
      const create = ghWrite(run, [
        'pr', 'create', '--repo', o.repo, '--base', o.base, '--head', branch, '--title', title, '--body-file', bodyFile,
        ...(o.label ? ['--label', o.label] : []),
      ], {
        notice: error,
        confirm: () => {
          const opened = prsOfBranch(run, o.repo, branch).open;
          return opened && opened.headRefOid === head ? `${opened.url}\n` : null;
        },
      });
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
