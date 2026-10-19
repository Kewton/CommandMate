/**
 * Built-in `scope` gate: reconcile what actually changed in the worktree against
 * the contract's `scope.allow` / `scope.deny` (Issue #1546, Phase 2-2).
 *
 * Canonical spec: docs/design/task-contract.md §2.2
 *
 * A parallel worker that edits a shared config file, or quietly rewrites a
 * module another worker owns, produces a green run and a broken integration.
 * The contract already declares which paths the task may touch; this gate is
 * what makes that declaration something other than a comment.
 *
 * Promoted from `.claude/skills/orchestrate-monitor/scripts/verify-scope.sh`.
 * That script is a *grep* guard over one file rather than a diff-versus-glob
 * check, so what carries over is not its logic but the two ways it false-reported
 * (both recorded in feedback_orchestrate_monitor_started_guard):
 *
 *   1. It matched a forbidden pattern that appeared only in explanatory prose.
 *      The analogue here is judging text instead of paths, so nothing in this
 *      module ever greps content: the file set comes from git plumbing, and the
 *      verdict comes from matching whole paths.
 *   2. Its `grep -c ... || echo 0` idiom emitted a two-line "0\n0" that the
 *      caller read as a count. The analogue is git output that parses into
 *      phantom entries, so every git call here is `-z`: the human formats quote
 *      and arrow-join paths, and splitting those on whitespace invents files
 *      that do not exist.
 *
 * Server-only: spawns git and is called from the verification engine.
 *
 * @module lib/verification/scope-gate
 */

import { spawn } from 'child_process';
import type { VerificationGateTerminalStatus } from '@/lib/db';
import type { TaskContractScope } from '@/lib/tasks/contract-parser';
import { collectSkillReceiptOwnedPaths } from '@/lib/skills/receipt-owned-paths';
import { isAgentStateUntrackedEntry } from '@/lib/skills/agent-state-paths';
import {
  MAX_REPORTED_VIOLATIONS,
  type ScopeAdmission,
  formatAdmitted,
  formatAgentStateExcluded,
  formatDecidedPath,
  formatOrchestratorExcluded,
  formatPatterns,
} from './scope-gate-format';
import { ScopeMatcher } from './scope-gate-glob';

export {
  MAX_REPORTED_VIOLATIONS,
  SCOPE_PATTERN_ARROW,
  type ScopeAdmission,
} from './scope-gate-format';
export {
  ALWAYS_ALLOWED_PREFIX,
  SCOPE_EXEMPT_ALWAYS_ALLOWED,
  SCOPE_EXEMPT_CONTRACT_PATH,
  type ScopeDecision,
  ScopeMatcher,
} from './scope-gate-glob';

/**
 * Actionable coda appended to every scope failure report (#1683).
 *
 * The violating paths alone say *what* failed but not what to do about it —
 * #1678 B-2 is a worker structurally unable to pass because a lockfile was
 * missing from the issue's target-file list, and nothing in the output said so.
 * The wording answers both directions a violation can resolve: widen the
 * declared scope when the diff is intended, revert when it is not. Re-sending
 * is named because scope is judged from the contract's send-time snapshot, so
 * editing the YAML in place changes nothing.
 */
export const SCOPE_ALLOW_GUIDANCE =
  "To allow this diff, add the paths above to the contract's scope.allow (the " +
  "issue's target-file list) and re-send the task (`send --contract`) — scope " +
  'is judged from the send-time snapshot, so editing the contract file alone ' +
  'changes nothing. A path matching deny: is a deliberate prohibition; revert ' +
  'it instead.';

/**
 * Execution contracts, dropped from both gates' change sets entirely (#1580).
 *
 * An orchestrator writes `.commandmate/tasks/<task>.yaml` into a worktree and
 * sends immediately, without committing it. Counting that file as change makes
 * an agent that did nothing indistinguishable from one that did something:
 * work-evidence sees a dirty tree and passes, and the run that should have been
 * `not_started` collects a row of green gates instead.
 *
 * Dropping it is tamper-safe because the contract is snapshotted into
 * `tasks.contract_json` at send time (src/lib/db/tasks-db.ts), so editing the
 * file afterwards cannot change what the run is judged against.
 * `.commandmate/verify.yaml` has no such snapshot — the gates are re-read from
 * the file on every run — so it stays in the change set, where a contract's
 * explicit `deny` can still catch an agent weakening its own gates.
 */
export const CONTRACT_DIR_PREFIX = '.commandmate/tasks/';

/**
 * Files the orchestrator commits on a PR branch after the worker's checks
 * (orchestrate 6-4: the module-reference fold) (#3588).
 *
 * Copy of `ORCHESTRATOR_FILES` in `scripts/orchestrate/pr-common.mjs`, where
 * `merge-pr.mjs` uses the same file rule to look past a fold commit to the
 * worker's HEAD. A test imports the .mjs and compares the two arrays, so the
 * merge side and this gate cannot drift apart.
 */
export const ORCHESTRATOR_FILES: readonly string[] = ['docs/module-reference.md'];

/**
 * The trailer that marks a fold commit, read the way `git interpret-trailers`
 * reads it — from the message's trailer block only, so the same words in the
 * middle of a body do not count (#3588).
 *
 * The file set alone cannot tell the orchestrator's fold from a worker that
 * committed module-reference on its own, so this gate also requires the
 * trailer. `workHeads` in pr-common.mjs deliberately does not: the merge side
 * only decides which HEAD's records to read, and stays permissive.
 */
export const ORCHESTRATOR_FOLD_TRAILER_KEY = 'Orchestrator-Fold';
export const ORCHESTRATOR_FOLD_TRAILER_VALUE = 'module-reference';

/**
 * Whether a commit's file list is the orchestrator's: at least one file, and
 * every file in {@link ORCHESTRATOR_FILES} — the file rule of `workHeads` in
 * `scripts/orchestrate/pr-common.mjs` (#3588).
 */
export function isOrchestratorOnlyCommit(files: readonly string[]): boolean {
  return files.length > 0 && files.every((file) => ORCHESTRATOR_FILES.includes(file));
}

/** One commit of `<merge-base>..HEAD`, as {@link BRANCH_COMMITS_FORMAT} reports it. */
export interface BranchCommit {
  sha: string;
  parents: string[];
  /** Values of the {@link ORCHESTRATOR_FOLD_TRAILER_KEY} trailer, in order. */
  foldTrailers: string[];
}

const FIELD_SEPARATOR = '\x1f';
const TRAILER_SEPARATOR = '\x1e';
/**
 * Per commit: sha, parents, fold trailer values. With `-z` each record ends in
 * NUL, which no commit message can contain; the sha and parent fields are hex,
 * so only the trailer field is free text, and it is last.
 */
const BRANCH_COMMITS_FORMAT =
  `--format=%H%x1f%P%x1f%(trailers:key=${ORCHESTRATOR_FOLD_TRAILER_KEY},` +
  'valueonly,unfold,separator=%x1e)';

/** Parse `git log -z` output in {@link BRANCH_COMMITS_FORMAT} (#3588). */
export function parseBranchCommits(output: string): BranchCommit[] {
  const commits: BranchCommit[] = [];
  for (const record of output.split('\0')) {
    const first = record.indexOf(FIELD_SEPARATOR);
    const second = record.indexOf(FIELD_SEPARATOR, first + 1);
    if (first <= 0 || second < 0) continue;
    const trailers = record.slice(second + 1);
    commits.push({
      sha: record.slice(0, first),
      parents: record.slice(first + 1, second).split(' ').filter(Boolean),
      foldTrailers: trailers === '' ? [] : trailers.split(TRAILER_SEPARATOR),
    });
  }
  return commits;
}

/** One branch commit with the paths it changed, as {@link orchestratorOnlyPaths} judges it. */
export interface CommitChange {
  /** Paths the commit changed; for a merge, only what it changed itself. */
  files: string[];
  /** Whether the commit is a fold: non-merge, trailer, and the file rule. */
  fold: boolean;
}

/** Whether a non-merge commit is a fold (#3588): the trailer and the file rule both hold. */
export function isFoldCommit(commit: BranchCommit, files: readonly string[]): boolean {
  return (
    commit.parents.length === 1 &&
    commit.foldTrailers.includes(ORCHESTRATOR_FOLD_TRAILER_VALUE) &&
    isOrchestratorOnlyCommit(files)
  );
}

/**
 * Paths that only fold commits touched on the branch (#3588).
 *
 * A path any other non-merge commit also touched is not returned: a worker
 * that committed `docs/module-reference.md` itself — alone or with other
 * files — is still judged on it. Merges are not passed in
 * ({@link collectBranchCommitChanges} skips them): a merge's own edit inside
 * {@link ORCHESTRATOR_FILES} is the approved integration of a refresh and
 * leaves a fold-only path excluded, while its edits elsewhere stay in the
 * branch diff and are judged as the worker's.
 */
export function orchestratorOnlyPaths(commits: readonly CommitChange[]): Set<string> {
  const byOrchestrator = new Set<string>();
  const byWorker = new Set<string>();
  for (const commit of commits) {
    const target = commit.fold ? byOrchestrator : byWorker;
    commit.files.forEach((file) => target.add(file));
  }
  return new Set([...byOrchestrator].filter((path) => !byWorker.has(path)));
}

/** Whether git reported a path that {@link CONTRACT_DIR_PREFIX} excludes. */
export function isContractPath(path: string): boolean {
  return path.startsWith(CONTRACT_DIR_PREFIX);
}

/** Matches {@link GateOutcome} in gate-runner; kept structural to avoid a cycle. */
export interface ScopeOutcome {
  status: VerificationGateTerminalStatus;
  exitCode: number | null;
  /** Epoch ms this evaluation began; `durationMs` is measured from it (#1625). */
  startedAt: number;
  durationMs: number;
  logTail: string | null;
}

// =============================================================================
// Changed-path collection
// =============================================================================

/** Run a git plumbing command. No shell: every argument here is code-supplied. */
function runGit(
  args: string[],
  cwd: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error: Error) => resolve({ code: null, stdout: '', stderr: error.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function splitNul(output: string): string[] {
  return output.split('\0').filter((field) => field !== '');
}

/**
 * Paths in `git status --porcelain -z -uall` output.
 *
 * Measured format (git 2.49): every record is `XY<space><path>NUL`, and a
 * rename or copy appends the original path as the *next* NUL field —
 * `R  new.txt\0old.txt\0`. Note that this is the reverse of the human
 * `old -> new` rendering, and that `-z` writes paths verbatim while the human
 * format C-quotes anything containing a space. Both paths of a rename are
 * returned: moving a file *out of* a permitted directory is a change to that
 * directory, and judging only the destination would miss it.
 *
 * Grouped per entry rather than flattened because work-evidence counts entries,
 * and a rename that moved a contract file into real work has to stay countable
 * as one change (#1580).
 */
export function parsePorcelainEntries(output: string): string[][] {
  return parsePorcelainStatusEntries(output).map((entry) => entry.paths);
}

/** One `git status --porcelain -z` record: its `XY` code and its paths. */
export interface PorcelainStatusEntry {
  /** The two-character status code, e.g. `??` for an untracked file. */
  status: string;
  paths: string[];
}

/** {@link parsePorcelainEntries}, keeping each record's status code (#3092). */
export function parsePorcelainStatusEntries(output: string): PorcelainStatusEntry[] {
  const fields = output.split('\0');
  const entries: PorcelainStatusEntry[] = [];
  let i = 0;

  while (i < fields.length) {
    const entry = fields[i];
    i += 1;
    // "XY " plus at least one path character.
    if (entry.length < 4) continue;

    const paths = [entry.slice(3)];

    const [x, y] = entry;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const original = fields[i];
      i += 1;
      if (original) paths.push(original);
    }

    entries.push({ status: entry.slice(0, 2), paths });
  }

  return entries;
}

/**
 * Whether a status record is an untracked file a recorded Skill install placed
 * there, untouched since (#3092).
 *
 * Untracked only: a tracked Skill file that changed is a change to what the
 * branch carries, and stays counted. `owned` comes from
 * `collectSkillReceiptOwnedPaths`, which already rejects files whose bytes no
 * longer match the receipt.
 */
export function isSkillInstalledUntrackedEntry(
  entry: PorcelainStatusEntry,
  owned: ReadonlySet<string>
): boolean {
  return entry.status === '??' && entry.paths.every((path) => owned.has(path));
}

/** A non-merge commit of `<base>..HEAD` with its files and whether it is a fold. */
export interface BranchCommitChange extends CommitChange {
  sha: string;
}

/**
 * The non-merge commits of `<base>..HEAD` of a worktree, each judged by
 * {@link isFoldCommit} (#3588). The scope gate drops what only folds touched
 * ({@link orchestratorOnlyPaths}); the work-evidence gate does not count a
 * fold as the worker's commit (#3633). Empty when no commit carries the fold
 * trailer: none can be a fold, so the per-commit calls are skipped.
 *
 * File lists come from one `git diff-tree -z` per commit rather than from one
 * `git log --name-only -z` stream: in that stream a commit header and a path
 * are both NUL-terminated fields, and a path may start with a newline or a
 * control character, so no parse of it can tell them apart. diff-tree prints
 * paths and nothing else.
 *
 * A merge's own edits are split by path. Inside {@link ORCHESTRATOR_FILES}
 * they are the approved integration — orchestrate lets the orchestrator
 * resolve a refresh conflict in shared files such as module-reference by
 * machine — so a fold-only path stays excluded. Every other path a merge edits
 * is never a candidate (a fold changes only ORCHESTRATOR_FILES), so it stays in
 * the branch diff and scope judges it as the worker's. Merges are therefore
 * skipped here without asking `git diff-tree --cc`.
 */
export async function collectBranchCommitChanges(
  worktreePath: string,
  base: string
): Promise<{ changes: BranchCommitChange[] } | { error: string }> {
  const log = await runGit(['log', '-z', BRANCH_COMMITS_FORMAT, `${base}..HEAD`], worktreePath);
  if (log.code !== 0) {
    return {
      error:
        `'git log ${base}..HEAD' failed.` + (log.stderr.trim() ? `\n${log.stderr.trim()}` : ''),
    };
  }
  const commits = parseBranchCommits(log.stdout);
  // Nothing to exclude without a trailer; skip the per-commit calls.
  if (!commits.some((commit) => commit.foldTrailers.length > 0)) return { changes: [] };

  const changes: BranchCommitChange[] = [];
  for (const commit of commits) {
    if (commit.parents.length !== 1) continue;
    const tree = await runGit(
      ['diff-tree', '--no-commit-id', '--name-only', '-z', '--no-renames', '-r', commit.sha],
      worktreePath
    );
    if (tree.code !== 0) {
      return {
        error:
          `'git diff-tree ${commit.sha}' failed.` +
          (tree.stderr.trim() ? `\n${tree.stderr.trim()}` : ''),
      };
    }
    const files = splitNul(tree.stdout);
    changes.push({ sha: commit.sha, files, fold: isFoldCommit(commit, files) });
  }

  return { changes };
}

/** {@link orchestratorOnlyPaths} for `<base>..HEAD` of a worktree (#3588). */
async function collectOrchestratorOnlyPaths(
  worktreePath: string,
  base: string
): Promise<{ paths: Set<string> } | { error: string }> {
  const result = await collectBranchCommitChanges(worktreePath, base);
  if ('error' in result) return result;
  return { paths: orchestratorOnlyPaths(result.changes) };
}

export interface ChangedPaths {
  /** Sorted, de-duplicated, repository-root-relative POSIX paths. */
  paths: string[];
  /** Resolved merge-base commit, for the report. */
  mergeBase: string;
  /** Agent-managed state files dropped from the change set (#3126), sorted. */
  agentStateExcluded: string[];
  /** Committed paths only orchestrator commits touched, dropped (#3588), sorted. */
  orchestratorExcluded: string[];
}

/**
 * Every path this worktree changed relative to `baseRef`.
 *
 * The union of committed and uncommitted change is deliberate: looking only at
 * commits misses a deviation the agent has not committed yet, and looking only
 * at the working tree misses everything it did commit.
 *
 * @returns the paths, or a message describing which git call could not answer
 */
export async function collectChangedPaths(
  worktreePath: string,
  baseRef: string
): Promise<ChangedPaths | { error: string }> {
  const mergeBase = await runGit(['merge-base', baseRef, 'HEAD'], worktreePath);
  if (mergeBase.code !== 0 || mergeBase.stdout.trim() === '') {
    return {
      error:
        `'git merge-base ${baseRef} HEAD' failed; base ref is unreachable from this worktree.` +
        (mergeBase.stderr.trim() ? `\n${mergeBase.stderr.trim()}` : ''),
    };
  }
  const base = mergeBase.stdout.trim();

  // --no-renames so a committed rename reports both paths (--name-only alone
  // reports the destination only, once rename detection folds the pair).
  const diff = await runGit(
    ['diff', '--name-only', '-z', '--no-renames', base, 'HEAD'],
    worktreePath
  );
  if (diff.code !== 0) {
    return {
      error:
        `'git diff --name-only ${base} HEAD' failed.` +
        (diff.stderr.trim() ? `\n${diff.stderr.trim()}` : ''),
    };
  }

  // The orchestrator's fold commit (6-4) can sit under a re-instructed worker's
  // commits; what only it touched is not the worker's change (#3588).
  const orchestratorOnly = await collectOrchestratorOnlyPaths(worktreePath, base);
  if ('error' in orchestratorOnly) return orchestratorOnly;
  const orchestratorExcluded = new Set<string>();
  const committed = splitNul(diff.stdout).filter((path) => {
    if (!orchestratorOnly.paths.has(path)) return true;
    orchestratorExcluded.add(path);
    return false;
  });

  // -uall: without it a new directory collapses to a single `?? dir/` entry, and
  // the gate would judge a directory name instead of the files inside it.
  const status = await runGit(
    ['status', '--porcelain', '-z', '--untracked-files=all'],
    worktreePath
  );
  if (status.code !== 0) {
    return {
      error:
        "'git status --porcelain' failed." +
        (status.stderr.trim() ? `\n${status.stderr.trim()}` : ''),
    };
  }

  // Untracked files a recorded Skill install placed are CommandMate's, not the
  // agent's (#3092). Dropped from the working-tree side only; a committed Skill
  // file is still judged by the diff above.
  const skillOwned = collectSkillReceiptOwnedPaths(worktreePath);
  // Likewise the state files an agent CLI writes for itself (#3126), by an
  // explicit declaration of paths; they are reported, not silently dropped.
  const agentStateExcluded = new Set<string>();
  const workingTree = parsePorcelainStatusEntries(status.stdout).filter((entry) => {
    if (isSkillInstalledUntrackedEntry(entry, skillOwned)) return false;
    if (isAgentStateUntrackedEntry(entry)) {
      entry.paths.forEach((path) => agentStateExcluded.add(path));
      return false;
    }
    return true;
  });

  // Both sides are filtered, not just the working tree: an orchestrator may
  // also have committed the contract as a setup commit (#1580). The working
  // tree keeps an uncommitted module-reference edit: no fold commit made it.
  const paths = new Set<string>(
    [...committed, ...workingTree.flatMap((entry) => entry.paths)].filter(
      (path) => !isContractPath(path)
    )
  );
  return {
    paths: [...paths].sort(),
    mergeBase: base,
    agentStateExcluded: [...agentStateExcluded].sort(),
    orchestratorExcluded: [...orchestratorExcluded].filter((path) => !paths.has(path)).sort(),
  };
}

// =============================================================================
// Gate evaluation
// =============================================================================

/**
 * Reasons the gate has nothing to judge, phrased for `log_tail`.
 *
 * A skip is recorded rather than omitted: a run with no scope row at all is
 * indistinguishable from a run predating the gate, and "we looked and no
 * contract declared a scope" is the answer the reader needs.
 */
export const SCOPE_SKIP_NO_CONTRACT =
  'scope: no contract is attached to this run, so no scope is declared to check.';
export const SCOPE_SKIP_NOT_REQUIRED =
  'scope: the contract sets success.requireScopeClean: false.';

/**
 * The skip that is *not* harmless: a contract exists and this run could not be
 * attached to it (#1620).
 *
 * Worded apart from {@link SCOPE_SKIP_NO_CONTRACT} on purpose. Both are skips,
 * but only one of them means "there was nothing to judge" — reporting the other
 * with the same sentence is what let a run whose scope was never checked read
 * as a repository that simply does not use contracts. The task id is named so
 * the reader can go and look at what was not judged.
 */
export function scopeSkipDetachedContract(taskId: string, status: string): string {
  return (
    `scope: task ${taskId} declares a scope for this worktree, but it is ${status} and ` +
    'this run was not attached to it, so its scope was NOT judged. ' +
    '`wait --verify` attaches only to an in-flight task; to re-verify a finished task, run ' +
    `\`commandmate verify <worktree> --task ${taskId}\`.`
  );
}

/**
 * Judge the worktree's changes against a contract's scope.
 *
 * @param scope declared scope, or null when no contract is attached to the run
 * @param requireScopeClean the contract's `success.requireScopeClean`
 * @param baseRef ref the change set is computed against; null when unresolved
 * @param contractPath the contract's own path, always exempt from `allow`
 */
export async function evaluateScope(
  worktreePath: string,
  scope: TaskContractScope | null,
  requireScopeClean: boolean,
  baseRef: string | null,
  contractPath: string | null = null
): Promise<ScopeOutcome> {
  const startedAt = Date.now();
  const done = (
    status: VerificationGateTerminalStatus,
    logTail: string,
    exitCode: number | null
  ): ScopeOutcome => ({
    status,
    exitCode,
    startedAt,
    durationMs: Date.now() - startedAt,
    logTail,
  });

  if (!scope) return done('skipped', SCOPE_SKIP_NO_CONTRACT, null);
  if (!requireScopeClean) return done('skipped', SCOPE_SKIP_NOT_REQUIRED, null);
  if (!baseRef) {
    return done(
      'error',
      'scope: no base ref, so there is nothing to diff against. Set options.baseRef in ' +
        '.commandmate/verify.yaml; origin/HEAD did not resolve a default branch.',
      null
    );
  }

  const changed = await collectChangedPaths(worktreePath, baseRef);
  if ('error' in changed) return done('error', `scope: ${changed.error}`, null);

  const matcher = new ScopeMatcher(scope, contractPath);
  // Every changed path is classified, whether or not it will fit in the report:
  // the cap below is a display rule, and a violation withheld from the listing
  // still counts toward the verdict.
  const admitted: ScopeAdmission[] = [];
  const violations: string[] = [];
  const rejectedBy = new Map<string, string>();
  for (const path of changed.paths) {
    const decision = matcher.classify(path);
    if (decision.admitted) {
      admitted.push({ path, pattern: decision.pattern });
      continue;
    }
    violations.push(path);
    if (decision.pattern !== null) rejectedBy.set(path, decision.pattern);
  }

  const summary = [
    `scope: baseRef=${baseRef} changed=${changed.paths.length} violations=${violations.length}`,
    `allow: ${formatPatterns(scope.allow)}`,
    `deny: ${formatPatterns(scope.deny)}`,
    ...formatAdmitted(admitted),
    ...formatAgentStateExcluded(changed.agentStateExcluded),
    ...formatOrchestratorExcluded(changed.orchestratorExcluded),
  ].join('\n');

  if (violations.length === 0) {
    // An empty change set passes: work-evidence is the gate that judges "nothing
    // happened", and failing here too would report one problem as two.
    return done('passed', summary, 0);
  }

  const listed = violations.slice(0, MAX_REPORTED_VIOLATIONS);
  const remainder = violations.length - listed.length;
  const report = [
    summary,
    'out of scope:',
    // A deny match is named inline: the `deny:` line above lists what the
    // contract declared, not which of those entries this path tripped, and a
    // violation the reader must revert reads differently from one they could
    // fix by widening `allow`.
    ...listed.map((path) => formatDecidedPath('-', path, rejectedBy.get(path) ?? null)),
    ...(remainder > 0 ? [`  ... and ${remainder} more`] : []),
    SCOPE_ALLOW_GUIDANCE,
  ].join('\n');

  return done('failed', report, 1);
}
