/**
 * Pure helpers for the /sessions default filter (Issue #4388).
 *
 * - {@link validateSessionsFilter}: shape check used by PUT.
 * - {@link applySessionsDefaultFilter}: drop roles that no longer exist and say so.
 * - {@link differsFromDefault}: is the current condition different from the default?
 *
 * The branch-pattern rule (<= 200 chars, `new RegExp(p, 'i')` must compile)
 * intentionally mirrors the /sessions filter of #4386; a candidate for sharing later.
 */

import { validateStopPattern } from '@/config/auto-yes-config';
import {
  EMPTY_SESSIONS_FILTER,
  SESSIONS_FILTER_BRANCH_PATTERN_MAX,
  SESSIONS_FILTER_ROLE_IDS_MAX,
  SESSIONS_FILTER_ROLE_ID_MAX_LENGTH,
  SESSIONS_FILTER_ROLE_ID_PATTERN,
  type SessionsFilterCondition,
} from '@/types/sessions-default-filter';

export type SessionsFilterValidation =
  | { ok: true; value: SessionsFilterCondition }
  | { ok: false; error: string };

export function isValidRoleIdShape(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= SESSIONS_FILTER_ROLE_ID_MAX_LENGTH &&
    SESSIONS_FILTER_ROLE_ID_PATTERN.test(id)
  );
}

export function validateSessionsFilter(input: unknown): SessionsFilterValidation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'Invalid request body: an object is required' };
  }
  const o = input as Record<string, unknown>;

  const { branchPattern, roleIds, includeNoRole, includeAmbiguous } = o;
  if (typeof branchPattern !== 'string') {
    return { ok: false, error: '"branchPattern" must be a string' };
  }
  if (branchPattern.length > SESSIONS_FILTER_BRANCH_PATTERN_MAX) {
    return {
      ok: false,
      error: `"branchPattern" must be at most ${SESSIONS_FILTER_BRANCH_PATTERN_MAX} characters`,
    };
  }
  try {
    new RegExp(branchPattern, 'i');
  } catch {
    return { ok: false, error: '"branchPattern" is not a valid regular expression' };
  }
  // Same ReDoS guard (safe-regex2) as the auto-yes stop pattern.
  if (!validateStopPattern(branchPattern).valid) {
    return { ok: false, error: '"branchPattern" may cause performance issues (catastrophic backtracking)' };
  }
  if (!Array.isArray(roleIds)) {
    return { ok: false, error: '"roleIds" must be an array' };
  }
  if (roleIds.length > SESSIONS_FILTER_ROLE_IDS_MAX) {
    return { ok: false, error: `"roleIds" must have at most ${SESSIONS_FILTER_ROLE_IDS_MAX} items` };
  }
  if (!roleIds.every(isValidRoleIdShape)) {
    return { ok: false, error: '"roleIds" contains an invalid role id' };
  }
  if (typeof includeNoRole !== 'boolean') {
    return { ok: false, error: '"includeNoRole" must be a boolean' };
  }
  if (typeof includeAmbiguous !== 'boolean') {
    return { ok: false, error: '"includeAmbiguous" must be a boolean' };
  }

  return {
    ok: true,
    value: {
      branchPattern,
      roleIds: [...new Set(roleIds as string[])],
      includeNoRole,
      includeAmbiguous,
    },
  };
}

/** Read a stored value defensively; anything malformed reads as "nothing stored". */
export function parseStoredSessionsFilter(raw: string | null): SessionsFilterCondition | null {
  if (raw === null) return null;
  try {
    const v = validateSessionsFilter(JSON.parse(raw));
    return v.ok ? v.value : null;
  } catch {
    return null;
  }
}

export interface AppliedSessionsDefaultFilter {
  condition: SessionsFilterCondition;
  /** True when at least one stored role no longer exists (show a notice; never silently widen). */
  droppedRoles: boolean;
  /** The role ids that were removed. */
  droppedRoleIds: string[];
}

/**
 * Apply the stored default against the roles that exist now.
 * Deleted roles are removed from `roleIds`; every other field is kept as is.
 * If every role was deleted, `roleIds` becomes [] and `droppedRoles` is true.
 */
export function applySessionsDefaultFilter(
  stored: SessionsFilterCondition,
  existingRoleIds: Iterable<string>
): AppliedSessionsDefaultFilter {
  const existing = new Set(existingRoleIds);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const id of stored.roleIds) {
    (existing.has(id) ? kept : dropped).push(id);
  }
  return {
    condition: { ...stored, roleIds: kept },
    droppedRoles: dropped.length > 0,
    droppedRoleIds: dropped,
  };
}

/** True when `current` is not the same condition as `defaults` (role order is ignored). */
export function differsFromDefault(
  current: SessionsFilterCondition,
  defaults: SessionsFilterCondition | null
): boolean {
  const base = defaults ?? EMPTY_SESSIONS_FILTER;
  if (current.branchPattern !== base.branchPattern) return true;
  if (current.includeNoRole !== base.includeNoRole) return true;
  if (current.includeAmbiguous !== base.includeAmbiguous) return true;
  const a = new Set(current.roleIds);
  const b = new Set(base.roleIds);
  if (a.size !== b.size) return true;
  for (const id of a) if (!b.has(id)) return true;
  return false;
}
