/**
 * /sessions filter (Issue #4386): a pure judgement per worktree.
 *
 * `evaluateSessionsFilter` returns, for each worktree, whether to show it and
 * which instance ids may be shown (roster order). Branch matching is a
 * case-insensitive regular expression against `name` and
 * `gitStatus.currentBranch`.
 *
 * Role part (Issue #4389): an instance matches when its role (from
 * `GET /api/sessions/roles`, #4387) is one of `roleIds`, or it has no role and
 * `includeNoRole` is set, or its role cannot be told and `includeAmbiguous` is
 * set. "Cannot tell" is never folded into "no role". A worktree is shown when at
 * least one of its instances matches, and only the matching instances are
 * returned. Nothing selected means no role condition. When the roles could not be
 * read, the role condition is dropped (not "everything" or "nothing" silently):
 * `roleError` says so, so the screen can tell the user.
 */

import safeRegex from 'safe-regex2';
import type { Worktree } from '@/types/models';
import type { InstanceRoleSummary, InstanceRoleSummaryMap } from '@/types/agent-roles';

export const SESSIONS_BRANCH_PATTERN_MAX_LENGTH = 200;

/** Role condition (Issue #4389). Field names match the stored default of #4388. */
export interface SessionsRoleCondition {
  /** Role ids; an instance with one of these roles matches. */
  roleIds?: readonly string[];
  /** An instance with no role matches. */
  includeNoRole?: boolean;
  /** An instance whose role cannot be told matches (kept apart from "no role"). */
  includeAmbiguous?: boolean;
}

/** What `GET /api/sessions/roles` answered (Issue #4387). */
export interface SessionsRoleSource {
  roleByWorktree: Readonly<Record<string, InstanceRoleSummaryMap>>;
  rolesUnavailable?: boolean;
}

export type SessionsRoleError = 'roles_unavailable';

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
  /** Set when the role condition was dropped because the roles could not be read. */
  roleError: SessionsRoleError | null;
  /** True when the role condition was applied (instanceIds are then the matching ones). */
  roleFiltered: boolean;
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

/** True when the role condition selects anything at all. */
export function hasRoleCondition(role: SessionsRoleCondition | undefined): boolean {
  return Boolean(
    role && ((role.roleIds?.length ?? 0) > 0 || role.includeNoRole || role.includeAmbiguous)
  );
}

/** Whether one instance's role summary satisfies the role condition. */
export function matchesRoleCondition(
  summary: InstanceRoleSummary | undefined,
  role: SessionsRoleCondition
): boolean {
  // An instance the server did not report on is unknown: it is not "no role".
  if (!summary) return false;
  switch (summary.kind) {
    case 'role':
      return (role.roleIds ?? []).includes(summary.roleId);
    case 'none':
      return role.includeNoRole === true;
    case 'ambiguous':
      return role.includeAmbiguous === true;
    default:
      return false;
  }
}

export function evaluateSessionsFilter(
  worktrees: readonly FilterTarget[],
  conditions: SessionsFilterConditions,
  resolveRoster: SessionsRosterResolver = rosterIds,
  roleSource?: SessionsRoleSource | null
): SessionsFilterResult {
  const { regex, error } = compileBranchPattern(conditions.branchPattern);
  const wantsRole = hasRoleCondition(conditions.role);
  const rolesReadable = Boolean(roleSource && !roleSource.rolesUnavailable);
  const roleFiltered = wantsRole && rolesReadable;
  const roleError: SessionsRoleError | null = wantsRole && !rolesReadable ? 'roles_unavailable' : null;
  const verdicts = new Map<string, SessionsFilterVerdict>();
  for (const wt of worktrees) {
    const branchShow = regex
      ? regex.test(wt.name) || regex.test(wt.gitStatus?.currentBranch ?? '')
      : true;
    if (!branchShow) {
      verdicts.set(wt.id, { show: false, instanceIds: [] });
      continue;
    }
    const roster = resolveRoster(wt);
    if (!roleFiltered) {
      verdicts.set(wt.id, { show: true, instanceIds: roster });
      continue;
    }
    const byInstance = roleSource!.roleByWorktree[wt.id] ?? {};
    const matching = roster.filter((id) => matchesRoleCondition(byInstance[id], conditions.role!));
    verdicts.set(wt.id, { show: matching.length > 0, instanceIds: matching });
  }
  return {
    verdicts,
    error,
    activeCount: (regex ? 1 : 0) + (roleFiltered ? 1 : 0),
    roleError,
    roleFiltered,
  };
}
