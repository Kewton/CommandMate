/**
 * /sessions filter (Issue #4386): a pure judgement per worktree.
 *
 * `evaluateSessionsFilter` returns, for each worktree, whether to show it and
 * which instance ids may be shown (roster order). Branch matching is a
 * case-insensitive regular expression against `name` and
 * `gitStatus.currentBranch`. The role part is only a type slot here (#4387 /
 * #4389 fill it in); it is accepted and not used yet.
 */

import safeRegex from 'safe-regex2';
import type { Worktree } from '@/types/models';

export const SESSIONS_BRANCH_PATTERN_MAX_LENGTH = 200;

/** Reserved for later Issues. Accepted, not used yet. */
export interface SessionsRoleCondition {
  roles?: readonly string[];
}

export interface SessionsFilterConditions {
  /** Regular expression source. Empty / whitespace-only means "no condition". */
  branchPattern?: string;
  role?: SessionsRoleCondition;
}

export type SessionsFilterError = 'too_long' | 'invalid_regex' | 'unsafe_regex';

export interface SessionsFilterVerdict {
  show: boolean;
  /** Instance ids that may be shown, in roster order. */
  instanceIds: string[];
}

export interface SessionsFilterResult {
  verdicts: Map<string, SessionsFilterVerdict>;
  /** Set when a condition was dropped because it could not be used. */
  error: SessionsFilterError | null;
  /** Number of conditions actually applied. */
  activeCount: number;
}

export type FilterTarget = Pick<Worktree, 'id' | 'name' | 'gitStatus' | 'agentInstances' | 'selectedAgents'>;

/** Resolves a worktree's roster (instance ids, roster order). Keeps this module pure. */
export type SessionsRosterResolver = (wt: FilterTarget) => string[];

function rosterIds(wt: FilterTarget): string[] {
  if (wt.agentInstances && wt.agentInstances.length > 0) {
    return [...wt.agentInstances].sort((a, b) => a.order - b.order).map((i) => i.id);
  }
  return [...(wt.selectedAgents ?? [])];
}

/** Compile the branch pattern, or report why it cannot be used. */
export function compileBranchPattern(
  pattern: string | undefined
): { regex: RegExp | null; error: SessionsFilterError | null } {
  const source = (pattern ?? '').trim();
  if (source === '') return { regex: null, error: null };
  if (source.length > SESSIONS_BRANCH_PATTERN_MAX_LENGTH) {
    return { regex: null, error: 'too_long' };
  }
  let regex: RegExp;
  try {
    regex = new RegExp(source, 'i');
  } catch {
    return { regex: null, error: 'invalid_regex' };
  }
  // Same rule as the auto-yes stop pattern (src/config/auto-yes-config.ts):
  // nested quantifiers such as (a+)+$ can freeze the page on a long name.
  if (!safeRegex(source)) return { regex: null, error: 'unsafe_regex' };
  return { regex, error: null };
}

export function evaluateSessionsFilter(
  worktrees: readonly FilterTarget[],
  conditions: SessionsFilterConditions,
  resolveRoster: SessionsRosterResolver = rosterIds
): SessionsFilterResult {
  const { regex, error } = compileBranchPattern(conditions.branchPattern);
  const verdicts = new Map<string, SessionsFilterVerdict>();
  for (const wt of worktrees) {
    const show = regex
      ? regex.test(wt.name) || regex.test(wt.gitStatus?.currentBranch ?? '')
      : true;
    verdicts.set(wt.id, { show, instanceIds: show ? resolveRoster(wt) : [] });
  }
  return { verdicts, error, activeCount: regex ? 1 : 0 };
}
