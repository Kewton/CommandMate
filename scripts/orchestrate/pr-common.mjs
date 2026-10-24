/**
 * What `publish-pr.mjs` and `merge-pr.mjs` share (Issue #3477, PR 3): the
 * commands they run, the PR of a branch, and the conditions read from the run
 * record before anything is published or merged.
 *
 * Both scripts take every external call (`git`, `gh`, `npx`) through one `run`
 * function, so the tests replace it and nothing is pushed, opened or merged.
 * Both wrap it in withGhRetry, so a reading `gh` call that met GitHub's
 * 502/503/504 or a dropped connection is tried again (#3633 D). A writing one
 * (pr create, pr merge, run rerun, issue close) is never sent twice: ghWrite
 * reads once whether it went through.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { itemOf, latestByStage, unmetStage } from './run-log.mjs';
import { IGNORED_DIRTY, dirtyPaths } from './dirty-tree.mjs';
import { itemProblem, workItemName } from './execution-key.mjs';
import { FOLLOWS_HEAD, verifyEnvState } from './env-manifest.mjs';

export { IGNORED_DIRTY, dirtyPaths };

export const DEFAULT_REPO = 'Kewton/CommandMate';
/** The branch PRs go to (6-x: feature → develop). The remote ref is `origin/<base>`. */
export const DEFAULT_BASE_BRANCH = 'develop';
/**
 * Files the orchestrator may commit on the PR branch after the checks (6-4: the module-reference fold).
 * Copied as ORCHESTRATOR_FILES in src/lib/verification/scope-gate.ts, whose scope gate drops what
 * only such a commit changed (#3588) and whose rule work-evidence uses to not count it (#3633); tests/unit/scripts/orchestrate/orchestrator-files-parity.test.ts
 * keeps the two equal. The scope gate is stricter than workHeads below: it also requires the
 * `Orchestrator-Fold: module-reference` trailer (a worker can commit module-reference alone too)
 * and counts a merge's own edits outside ORCHESTRATOR_FILES as the worker's. workHeads only picks
 * whose records to read,
 * so it stays on the file rule alone.
 */
export const ORCHESTRATOR_FILES = ['docs/module-reference.md'];
/**
 * What the run record must hold before anything is published or merged, and
 * the orchestrate.md step that writes it. The rule for each (which HEAD, which
 * results pass) is run-log.mjs `unmetStage` — the one `status` resumes by:
 * verify / review / findings on the work HEAD, precheck on the HEAD that is
 * published. `review` takes `skip` for an Issue 5-2b does not cover (docs only,
 * tests only): the orchestrator records that decision instead of leaving the
 * stage empty, so a forgotten review and a review that does not apply differ.
 */
export const REQUIRED_RECORDS = [
  { stage: 'verify', why: '3-3 / 5-1' },
  { stage: 'review', why: '5-2b' },
  { stage: 'findings', why: '5-3' },
  { stage: 'precheck', why: '6-1-1' },
];
/** Stages whose passed record is held to the environment it was taken in (#3883 N3, N9). */
export const ENV_BOUND_STAGES = ['verify', 'precheck'];
/** 6-2: the sweep runs over every tracked file, never a fixed list of shared files. */
export const MARKER_PATTERN = '^(<<<<<<< |>>>>>>> |={7}$)';

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

/** Tries of one `gh` call: the first and the retries (#3633 D). */
export const GH_ATTEMPTS = 4;
/** The wait before each retry, in order; the last repeats. */
export const GH_RETRY_DELAYS_MS = [10_000, 30_000, 60_000];

/**
 * What a `gh` failure says when GitHub, not the request, failed: an HTTP 502 /
 * 503 / 504 (the "Partially Degraded" 504 Gateway Timeout of 2026-10-12) or a
 * connection that did not complete. A 4xx, a failed check or a merge conflict
 * is the answer and is not asked again.
 */
export const GH_TRANSIENT_PATTERN =
  /\bHTTP 50[234]\b|\b50[234] (?:Bad Gateway|Service Unavailable|Gateway Timeout)\b|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH)\b|connection reset by peer|connection refused|i\/o timeout|TLS handshake timeout|unexpected EOF|could not resolve host|error connecting to/i;

/** Whether a finished `gh` call failed for a reason worth trying again. */
export function isTransientGhFailure({ status, stdout, stderr }) {
  if (status === 0) return false;
  return GH_TRANSIENT_PATTERN.test(`${stderr ?? ''}\n${stdout ?? ''}`);
}

/**
 * The `gh` subcommands that only read, by group. Only these are tried again: a
 * write that timed out at the gateway may have been done, and sending it again
 * could open a second PR or rerun a run twice (#3633 D).
 */
const GH_READS = {
  pr: ['view', 'list', 'checks', 'diff', 'status'],
  issue: ['view', 'list', 'status'],
  run: ['view', 'list', 'watch'],
  repo: ['view'],
  release: ['view', 'list'],
  label: ['list'],
  auth: ['status'],
};
/** `gh api` flags that make the request a write (it is a POST once a field is given). */
const GH_API_WRITE_FLAGS = /^(?:-f|-F|--field|--raw-field|--input)(?:=|$)|^-[fF]./;

/** Whether `gh <args>` only reads, so asking it again changes nothing on GitHub. */
export function isGhRead(args) {
  const [group, sub] = args;
  if (group === 'api') {
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (GH_API_WRITE_FLAGS.test(arg)) return false;
      const method = arg === '-X' || arg === '--method' ? args[i + 1] : /^(?:-X|--method=)(.+)$/.exec(arg)?.[1];
      if (method !== undefined && method.toUpperCase() !== 'GET') return false;
    }
    return true;
  }
  return GH_READS[group]?.includes(sub) ?? false;
}

/**
 * `run` with reading `gh` calls tried again on a transient failure (#3633 D):
 * up to GH_ATTEMPTS tries, GH_RETRY_DELAYS_MS apart, each retry said on
 * `notice`. A writing `gh` call (see isGhRead), every other command, and every
 * other failure pass through as they were. The last answer is returned as is,
 * so a caller reads gh's own message.
 *
 * @param {typeof defaultRun} run
 * @param {{ sleep?: (ms: number) => void, notice?: (line: string) => void }} [options]
 */
export function withGhRetry(run, { sleep = defaultSleep, notice = (line) => console.error(line) } = {}) {
  return (command, args, opts) => {
    if (command !== 'gh' || !isGhRead(args)) return run(command, args, opts);
    for (let attempt = 1; ; attempt++) {
      const out = run(command, args, opts);
      if (attempt >= GH_ATTEMPTS || !isTransientGhFailure(out)) return out;
      const delay = GH_RETRY_DELAYS_MS[Math.min(attempt, GH_RETRY_DELAYS_MS.length) - 1];
      const reason = `${out.stderr || out.stdout}`.trim().split('\n')[0];
      notice(`gh ${args.slice(0, 2).join(' ')}: ${reason} — retrying in ${delay / 1000}s (attempt ${attempt + 1}/${GH_ATTEMPTS})`);
      sleep(delay);
    }
  };
}

/**
 * A writing `gh` call, sent once (#3633 D). When it fails for a transient
 * reason (a 5xx or a dropped connection) GitHub may still have done it, so it
 * is not sent again: `confirm` reads once whether it went through and returns
 * what the call would have printed (a string, `''` when nothing), or null when
 * it did not. Done → a success with that output (`confirmed: true`); not done,
 * or the read failed too → the call's own failure, as before.
 *
 * @param {typeof defaultRun} run
 * @param {string[]} args
 * @param {{ confirm: () => string | null, notice?: (line: string) => void }} options
 */
export function ghWrite(run, args, { confirm, notice = (line) => console.error(line) }) {
  const out = run('gh', args);
  if (out.status === 0 || !isTransientGhFailure(out)) return out;
  const name = `gh ${args.slice(0, 2).join(' ')}`;
  const reason = `${out.stderr || out.stdout}`.trim().split('\n')[0];
  let done = null;
  try {
    done = confirm();
  } catch (err) {
    notice(`${name}: ${reason} — not sent again; could not read whether it went through: ${err instanceof Error ? err.message : String(err)}`);
    return out;
  }
  if (done === null || done === undefined) {
    notice(`${name}: ${reason} — not sent again; it did not go through`);
    return out;
  }
  notice(`${name}: ${reason} — not sent again; it went through`);
  return { status: 0, stdout: done, stderr: '', confirmed: true };
}

/** `gh …` parsed as JSON; throws with gh's own message when it fails. */
export function ghJson(run, args) {
  const { status, stdout, stderr } = run('gh', args);
  if (status !== 0) throw new Error(`gh ${args.join(' ')} failed: ${(stderr || stdout).trim()}`);
  return JSON.parse(stdout);
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

/** The worker's last commit under `head` (the last of workHeads). */
export function workHeadOf(run, worktree, head) {
  const heads = workHeads(run, worktree, head);
  return heads[heads.length - 1] ?? head;
}

/**
 * What the run record lacks at `{ head, workHead }`: REQUIRED_RECORDS judged by
 * run-log.mjs `unmetStage`, so a publish stops exactly where `status` says the
 * run has to resume. `item` is the work item (run-log.mjs inItem): the scripts
 * pass `--item`, or null for the Issue's own records, so another PR of the same
 * Issue — its later records, at its own HEAD — neither stops nor passes this one
 * (#3883). Left out, every record of the Issue is read, as before.
 *
 * With `env` (#3883 N3, N9), a passed verify and a passed precheck are also
 * held to the environment they were taken in (env-manifest.mjs
 * verifyEnvState): an input that differs now, or an `env=` whose manifest is
 * not in the run directory, is a missing record of that stage (verify again /
 * precheck again). The lockfile and the installed versions of a verify on an
 * earlier HEAD (a refresh or a fold on top) are left out only when the
 * precheck of the current HEAD was taken in this environment (its own
 * manifest is `same` now, or it is a record from before H-8) — that precheck
 * checked the code with them. A record without `env=` (taken before H-8) is
 * used as before and `env.warn` says so.
 *
 * With `env.defer` (merge-pr.mjs, #3883 N10), a verify of an earlier HEAD that
 * differs from now only in those inputs, with no such precheck yet, is handed
 * to `defer` instead of being a missing record: the caller runs the precheck of
 * the current HEAD first and asks again without `defer`. Any other difference
 * (the models, the local settings, `node_modules`'s location) is still missing.
 *
 * @param {{ runDir: string, worktree: string, home: string, warn?: (line: string) => void, defer?: (reason: string) => void }} [env]
 */
export function missingRecords(records, issue, heads, item, env) {
  const stages = latestByStage(records, issue, item);
  const where = env ? { runDir: env.runDir, worktree: env.worktree, home: env.home } : null;
  const precheckNow =
    where && stages.precheck?.head === heads.head && stages.precheck.result === 'ok' &&
    ['same', 'unrecorded'].includes(verifyEnvState(stages.precheck, where).state);
  return REQUIRED_RECORDS.map(({ stage, why }) => {
    const reason = unmetStage(stage, stages[stage], heads);
    if (reason) return `${reason} (${why})`;
    if (!ENV_BOUND_STAGES.includes(stage) || !where) return null;
    const record = stages[stage];
    const coveredByPrecheck = stage === 'verify' && record.head !== heads.head && precheckNow;
    const state = verifyEnvState(record, { ...where, ...(coveredByPrecheck ? { ignore: FOLLOWS_HEAD } : {}) });
    if (state.state === 'unrecorded') {
      env.warn?.(`warning: ${stage} at ${String(record.head ?? '-').slice(0, 7)}: ${state.detail}`);
      return null;
    }
    if (state.state === 'same') return null;
    const depsOnly = stage === 'verify' && record.head !== heads.head && state.state === 'changed' && state.fields.every(FOLLOWS_HEAD);
    if (depsOnly && env.defer) {
      env.defer(`verify at ${String(record.head).slice(0, 7)}: ${state.detail} — waits for the precheck of ${String(heads.head).slice(0, 7)}`);
      return null;
    }
    const precheckHint = stage === 'verify' && record.head !== heads.head && state.fields.some(FOLLOWS_HEAD)
      ? ` (no precheck of ${String(heads.head).slice(0, 7)} in this environment covers the dependencies)`
      : '';
    return `${stage}: environment ${state.state} — ${state.detail}${precheckHint}; ${stage === 'verify' ? 'verify' : 'precheck'} again (${why})`;
  }).filter(Boolean);
}

/** Tracked files with a conflict marker line (`git grep` exits 1 when there are none). */
export function markerFiles(run, worktree) {
  const out = run('git', ['-C', worktree, 'grep', '-l', '-E', MARKER_PATTERN, '--', '.']);
  if (out.status === 1) return [];
  if (out.status !== 0) throw new Error(`git grep failed in ${worktree}: ${out.stderr.trim()}`);
  return lines(out.stdout);
}

/**
 * Whether an open PR of another branch is for `issue`: its title names
 * `(#N)`, its body references it the way /create-pr writes it (`Closes #N`,
 * also Fixes / Resolves / Refs), or its branch carries the number
 * (`feature/<N>-…`, `feature/<N>b-…`).
 */
export function refersToIssue(pr, issue) {
  const n = String(issue);
  if (String(pr.title ?? '').includes(`(#${n})`)) return true;
  if (new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\\s*:?\\s+#${n}(?!\\d)`, 'i').test(String(pr.body ?? ''))) return true;
  return new RegExp(`(?:^|/)${n}(?!\\d)`).test(String(pr.headRefName ?? ''));
}

export function moduleReferenceFragment(worktree, issue) {
  return path.join(worktree, 'dev-reports', 'module-reference', `issue-${issue}.md`);
}

/** The run directory's copy of the fragment: one per work item (`module-reference-3883-d1.md`, #3883). */
export function moduleReferenceBackup(runDir, issue, item) {
  return path.join(runDir, `module-reference-${workItemName(issue, item)}.md`);
}

/**
 * `--item` of precheck / publish-pr / merge-pr (#3883): the work item whose
 * records are read and written. Absent is null — the Issue's own records, the
 * unit `status` resumes for records without `item` — never "any work item".
 */
export function itemOption(options) {
  const problem = itemProblem(options.item);
  if (problem) return { error: problem };
  return { item: options.item ? String(options.item) : null };
}

/**
 * The PR numbers the run record has for the Issue's other work items (`pr`
 * stage, `pr=#N` in the note). Those PRs are this Issue's on purpose (#3883):
 * publish-pr does not take them for a second PR of the same work.
 */
export function siblingPrNumbers(records, issue, item) {
  const numbers = new Set();
  for (const record of records) {
    if (record.issue !== issue || record.stage !== 'pr' || itemOf(record) === item) continue;
    const match = /(?:^|\s)pr=#(\d+)\b/.exec(record.note ?? '');
    if (match) numbers.add(Number(match[1]));
  }
  return numbers;
}

/**
 * 6-4: a PR without its fragments is not published or merged. The CHANGELOG
 * fragment must be in the branch's commits; the module-reference one is in
 * dev-reports/ (never committed), or in the run directory's copy of it.
 */
export function fragmentProblems(run, { worktree, runDir, issue, baseRef, item = null }) {
  const problems = [];
  const fragment = `changelog.d/${issue}.md`;
  const status = lines(git(run, worktree, ['diff', '--name-status', '--no-renames', `${baseRef}...HEAD`, '--', 'changelog.d/']));
  if (!status.some((line) => /^[AM]\s/.test(line) && line.replace(/^[AM]\s+/, '') === fragment)) {
    problems.push(`${fragment} is not in the branch's commits (6-4)`);
  }
  if (!fs.existsSync(moduleReferenceFragment(worktree, issue)) && !fs.existsSync(moduleReferenceBackup(runDir, issue, item))) {
    problems.push(`dev-reports/module-reference/issue-${issue}.md is missing (6-4)`);
  }
  return problems;
}
