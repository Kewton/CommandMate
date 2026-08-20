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
 * Separator between a reported path and the pattern that decided it (#1841).
 *
 * Mirrored by the CLI's scope-evidence parser (`src/cli/commands/verify.ts`,
 * SCOPE_PATTERN_ARROW): the gate's report is the only carrier for this evidence
 * — `verification_gate_results` has columns for a status, an exit code and a log
 * body, and nothing else — so the two constants have to agree. A round-trip
 * test feeds a real `evaluateScope` report through that parser rather than
 * trusting the two copies to be edited together.
 *
 * A path containing this exact three-character sequence would split wrongly on
 * the way back. Nothing prevents such a filename; it is accepted because the
 * alternative — encoding paths in a log a human reads first — costs every
 * reader something to protect against a file no repository has.
 */
export const SCOPE_PATTERN_ARROW = '  \u2190 ';

/**
 * Stand-ins for the two ways a path is admitted without matching `allow`.
 *
 * Parenthesised so they cannot be mistaken for a pattern the contract declared:
 * a reader who greps the contract for `(exempt: .commandmate/)` should find
 * nothing, because nothing there put it in scope.
 */
export const SCOPE_EXEMPT_ALWAYS_ALLOWED = `(exempt: ${ALWAYS_ALLOWED_PREFIX})`;
export const SCOPE_EXEMPT_CONTRACT_PATH = '(exempt: contract path)';

/** One admitted change, with the pattern that admitted it (#1841). */
export interface ScopeAdmission {
  path: string;
  /** A declared `allow` pattern, or one of the two exemption stand-ins. */
  pattern: string;
}

/**
 * Why one path was admitted or rejected (#1841).
 *
 * `pattern` is null only for the rejection that no rule names: nothing in
 * `deny` matched, and nothing in `allow` did either.
 */
export type ScopeDecision =
  | { admitted: true; pattern: string }
  | { admitted: false; pattern: string | null };

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
  /** Epoch ms this evaluation began; `durationMs` is measured from it (#1625). */
  startedAt: number;
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

/** A declared pattern kept next to its regex, so the report can name it (#1841). */
interface CompiledPattern {
  pattern: string;
  regexp: RegExp;
}

function compilePattern(pattern: string): CompiledPattern {
  return { pattern, regexp: globToRegExp(pattern) };
}

/**
 * A scope declaration compiled once per run.
 *
 * Compiling per pattern per file would rebuild the same regexes for every one of
 * potentially thousands of changed paths.
 */
export class ScopeMatcher {
  private readonly allow: CompiledPattern[];
  private readonly deny: CompiledPattern[];

  /**
   * @param contractPath the contract's own path, exempted alongside
   *        {@link ALWAYS_ALLOWED_PREFIX} for contracts kept outside `.commandmate/`
   */
  constructor(
    scope: TaskContractScope,
    private readonly contractPath: string | null = null
  ) {
    this.allow = scope.allow.map(compilePattern);
    this.deny = scope.deny.map(compilePattern);
  }

  /**
   * Which declared rule decided `path`, and which way (#1841).
   *
   * The **first** matching pattern is reported, in the contract's declaration
   * order, on both sides. Reporting the last would name a rule the reader
   * cannot use: `allow: ["src/**", "src/lib/**"]` admits `src/lib/a.ts` under
   * the first entry, and deleting the second changes nothing about the verdict.
   *
   * `path` is a repository-root-relative POSIX path as git reports it.
   */
  classify(path: string): ScopeDecision {
    const denied = this.deny.find((entry) => entry.regexp.test(path));
    if (denied) return { admitted: false, pattern: denied.pattern };
    if (path.startsWith(ALWAYS_ALLOWED_PREFIX)) {
      return { admitted: true, pattern: SCOPE_EXEMPT_ALWAYS_ALLOWED };
    }
    if (path === this.contractPath) {
      return { admitted: true, pattern: SCOPE_EXEMPT_CONTRACT_PATH };
    }
    const allowed = this.allow.find((entry) => entry.regexp.test(path));
    return allowed
      ? { admitted: true, pattern: allowed.pattern }
      : { admitted: false, pattern: null };
  }

  /**
   * Whether `path` is a scope violation.
   *
   * Delegates to {@link classify} rather than repeating the rules: the verdict
   * and the evidence for it must never be able to disagree, and two copies of
   * "deny wins, then the exemptions, then allow" is exactly how they would.
   */
  isViolation(path: string): boolean {
    return !this.classify(path).admitted;
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
 * One reported path, optionally naming the rule that decided it (#1841).
 *
 * Admitted paths lead with `+` rather than `-` so the two sections cannot be
 * confused by a reader — or by a grep — that has only one line in front of it.
 */
function formatDecidedPath(marker: '+' | '-', path: string, pattern: string | null): string {
  if (pattern === null) return `  ${marker} ${path}`;
  return `  ${marker} ${path}${SCOPE_PATTERN_ARROW}${pattern}`;
}

/**
 * The `admitted:` section: what this run was allowed to change, and by which
 * rule (#1841).
 *
 * With an `allow` of exact paths the pattern *is* the file and this adds
 * nothing, but #1546 made globs legal, and `src/**` leaves no record of what it
 * actually covered on the day it ran. The contract is the claim; this is the
 * evidence for it, and it has to survive in `log_tail` because the run's own
 * working tree will have moved on by the time anyone asks.
 *
 * Capped by the same rule as the violations, for the same reason (log_tail is
 * stored per gate in SQLite), and the truncation is stated rather than silent —
 * a list that stops at 100 with no marker reads as a complete one.
 */
function formatAdmitted(admitted: ScopeAdmission[]): string[] {
  if (admitted.length === 0) return [];
  const listed = admitted.slice(0, MAX_REPORTED_VIOLATIONS);
  const remainder = admitted.length - listed.length;
  return [
    'admitted:',
    ...listed.map((entry) => formatDecidedPath('+', entry.path, entry.pattern)),
    // Worded `(+N more)` rather than the violations' `... and N more`: the two
    // sections are capped independently and a reader scanning a truncated
    // report should not have to work out which count belongs to which list.
    ...(remainder > 0 ? [`  ... (+${remainder} more)`] : []),
  ];
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
    'Name the task when starting the run (`wait --verify` does this automatically).'
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
