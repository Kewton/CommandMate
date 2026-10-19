/**
 * `log_tail` formatting for the built-in `scope` gate (Issue #3647: split out of
 * scope-gate.ts, which re-exports everything public here).
 *
 * @module lib/verification/scope-gate-format
 */

/**
 * Violations listed in `log_tail` before the rest are summarised as a count.
 *
 * A worker that ran in the wrong directory can put thousands of paths out of
 * scope, and log_tail is stored per gate in SQLite.
 */
export const MAX_REPORTED_VIOLATIONS = 100;

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

/** One admitted change, with the pattern that admitted it (#1841). */
export interface ScopeAdmission {
  path: string;
  /** A declared `allow` pattern, or one of the two exemption stand-ins. */
  pattern: string;
}

export function formatPatterns(patterns: string[]): string {
  return patterns.length > 0 ? patterns.join(', ') : '(none)';
}

/**
 * One reported path, optionally naming the rule that decided it (#1841).
 *
 * Admitted paths lead with `+` rather than `-` so the two sections cannot be
 * confused by a reader — or by a grep — that has only one line in front of it.
 */
export function formatDecidedPath(marker: '+' | '-', path: string, pattern: string | null): string {
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
export function formatAdmitted(admitted: ScopeAdmission[]): string[] {
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

/** The `excluded:` section naming agent-managed state files left out (#3126). */
export function formatAgentStateExcluded(excluded: string[]): string[] {
  if (excluded.length === 0) return [];
  const listed = excluded.slice(0, MAX_REPORTED_VIOLATIONS);
  const remainder = excluded.length - listed.length;
  return [
    'excluded (agent-managed state files, not counted as change):',
    ...listed.map((path) => `  ~ ${path}`),
    ...(remainder > 0 ? [`  ... (+${remainder} more)`] : []),
  ];
}

/** The `excluded:` section naming orchestrator-only committed paths (#3588). */
export function formatOrchestratorExcluded(excluded: string[]): string[] {
  if (excluded.length === 0) return [];
  return [
    'excluded (changed only by orchestrator commits, not counted as change):',
    ...excluded.map((path) => `  ~ ${path}`),
  ];
}
