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

/**
 * Violations listed in `log_tail` before the rest are summarised as a count.
 *
 * A worker that ran in the wrong directory can put thousands of paths out of
 * scope, and log_tail is stored per gate in SQLite.
 */
export const MAX_REPORTED_VIOLATIONS = 100;

/**
 * Paths that are in scope no matter what the contract says.
 *
 * The contract file lives here, so a contract whose own `allow` list forgot to
 * mention `.commandmate/` would fail the moment it was committed — the scope
 * declaration would make its own storage a violation. The exemption covers the
 * `allow` requirement only; an explicit `deny` still applies, because a deny is
 * a deliberate prohibition and silently ignoring one is worse than the accident
 * this exemption prevents.
 */
export const ALWAYS_ALLOWED_PREFIX = '.commandmate/';

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

/** Whether git reported a path that {@link CONTRACT_DIR_PREFIX} excludes. */
export function isContractPath(path: string): boolean {
  return path.startsWith(CONTRACT_DIR_PREFIX);
}

/** Matches {@link GateOutcome} in gate-runner; kept structural to avoid a cycle. */
export interface ScopeOutcome {
  status: VerificationGateTerminalStatus;
  exitCode: number | null;
  durationMs: number;
  logTail: string | null;
}

// =============================================================================
// Glob matching
// =============================================================================

/**
 * Translate a scope glob into an anchored regular expression.
 *
 * Deliberately a small, documented subset rather than a glob library. The
 * semantics are fixed in docs/design/task-contract.md §2.2:
 *
 * - `**` as a whole path segment crosses directory boundaries, including zero of
 *   them: `a/**` matches `a/b` and `a/b/c`, `**\/*.ts` matches `x.ts`.
 * - `*` and `?` never cross `/`. Leading dots are ordinary characters, so
 *   `.github/**` and `*.md` behave the way they read.
 * - `{a,b}` is alternation, nestable. Unbalanced braces are literal, as in a
 *   shell — `src/{a` is a path with a brace in it, not a syntax error.
 * - `[` and `]` are **literal**. This repository routes through
 *   `src/app/proxy/[...path]/`, and treating those as character classes would
 *   make the pattern that names them match nothing at all — a silent no-match is
 *   the failure mode this gate exists to avoid.
 * - A pattern that matches a directory also matches everything beneath it, so
 *   `src/lib`, `src/lib/` and `src/lib/**` all mean the same thing. Without this
 *   rule, `allow: ["src/lib/verification"]` — the way people write a directory —
 *   would put every file inside it out of scope.
 */
function globToRegExp(rawPattern: string): RegExp {
  // A trailing slash carries no information once the rule above applies.
  const pattern = rawPattern.replace(/\/+$/, '');
  const bracesBalanced = hasBalancedBraces(pattern);

  let source = '';
  let depth = 0;
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === '*') {
      let end = i;
      while (pattern[end] === '*') end += 1;
      const isGlobstar = end - i > 1;
      const atSegmentStart = i === 0 || pattern[i - 1] === '/';

      if (isGlobstar && atSegmentStart && pattern[end] === '/') {
        // Consume the following slash too: `a/**/b` has to match `a/b`.
        source += '(?:[^/]*/)*';
        i = end + 1;
        continue;
      }
      if (isGlobstar && atSegmentStart && end === pattern.length) {
        source += '.*';
        i = end;
        continue;
      }
      // `**` that is not a whole segment (`a**b`) cannot mean "cross
      // directories" without also matching `a/x/b`, which the pattern does not
      // say. Collapse it to a single-segment wildcard.
      source += '[^/]*';
      i = end;
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      i += 1;
      continue;
    }
    if (bracesBalanced && char === '{') {
      depth += 1;
      source += '(?:';
      i += 1;
      continue;
    }
    if (bracesBalanced && char === '}' && depth > 0) {
      depth -= 1;
      source += ')';
      i += 1;
      continue;
    }
    if (bracesBalanced && char === ',' && depth > 0) {
      source += '|';
      i += 1;
      continue;
    }

    source += char.replace(/[.*+?^${}()|[\]\\]/, '\\$&');
    i += 1;
  }

  return new RegExp(`^${source}(?:/.*)?$`);
}

function hasBalancedBraces(pattern: string): boolean {
  let depth = 0;
  for (const char of pattern) {
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/**
 * A scope declaration compiled once per run.
 *
 * Compiling per pattern per file would rebuild the same regexes for every one of
 * potentially thousands of changed paths.
 */
export class ScopeMatcher {
  private readonly allow: RegExp[];
  private readonly deny: RegExp[];

  /**
   * @param contractPath the contract's own path, exempted alongside
   *        {@link ALWAYS_ALLOWED_PREFIX} for contracts kept outside `.commandmate/`
   */
  constructor(
    scope: TaskContractScope,
    private readonly contractPath: string | null = null
  ) {
    this.allow = scope.allow.map(globToRegExp);
    this.deny = scope.deny.map(globToRegExp);
  }

  /**
   * Whether `path` is a scope violation.
   *
   * `path` is a repository-root-relative POSIX path as git reports it.
   */
  isViolation(path: string): boolean {
    if (this.deny.some((pattern) => pattern.test(path))) return true;
    if (path.startsWith(ALWAYS_ALLOWED_PREFIX) || path === this.contractPath) return false;
    return !this.allow.some((pattern) => pattern.test(path));
  }
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
  const fields = output.split('\0');
  const entries: string[][] = [];
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

    entries.push(paths);
  }

  return entries;
}

export interface ChangedPaths {
  /** Sorted, de-duplicated, repository-root-relative POSIX paths. */
  paths: string[];
  /** Resolved merge-base commit, for the report. */
  mergeBase: string;
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

  // Both sides are filtered, not just the working tree: an orchestrator may
  // also have committed the contract as a setup commit (#1580).
  const paths = new Set<string>(
    [...splitNul(diff.stdout), ...parsePorcelainEntries(status.stdout).flat()].filter(
      (path) => !isContractPath(path)
    )
  );
  return { paths: [...paths].sort(), mergeBase: base };
}

// =============================================================================
// Gate evaluation
// =============================================================================

function formatPatterns(patterns: string[]): string {
  return patterns.length > 0 ? patterns.join(', ') : '(none)';
}

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
  ): ScopeOutcome => ({ status, exitCode, durationMs: Date.now() - startedAt, logTail });

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
  const violations = changed.paths.filter((path) => matcher.isViolation(path));

  const summary =
    `scope: baseRef=${baseRef} changed=${changed.paths.length} violations=${violations.length}\n` +
    `allow: ${formatPatterns(scope.allow)}\ndeny: ${formatPatterns(scope.deny)}`;

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
    ...listed.map((path) => `  - ${path}`),
    ...(remainder > 0 ? [`  ... and ${remainder} more`] : []),
  ].join('\n');

  return done('failed', report, 1);
}
