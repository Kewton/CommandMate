/**
 * Types for the /sessions default filter (Issue #4388).
 *
 * Stored server-wide in `app_settings` under `sessions_default_filter`.
 */

export interface SessionsFilterCondition {
  /** Branch regex source, matched case-insensitively. '' means "no branch filter". */
  branchPattern: string;
  /** Role ids to include. [] means "no role filter". */
  roleIds: string[];
  /** Also show sessions that have no role. */
  includeNoRole: boolean;
  /** Also show sessions whose role cannot be determined (ambiguous). */
  includeAmbiguous: boolean;
}

/** The condition that filters nothing. */
export const EMPTY_SESSIONS_FILTER: SessionsFilterCondition = Object.freeze({
  branchPattern: '',
  roleIds: [],
  includeNoRole: false,
  includeAmbiguous: false,
}) as SessionsFilterCondition;

/** Maximum branchPattern length (same rule as the /sessions filter, #4386). */
export const SESSIONS_FILTER_BRANCH_PATTERN_MAX = 200;

/** Maximum number of role ids a condition may carry. */
export const SESSIONS_FILTER_ROLE_IDS_MAX = 100;

/** Shape of a role id: lowercase alphanumeric segments joined by single hyphens, <= 64 chars. */
export const SESSIONS_FILTER_ROLE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SESSIONS_FILTER_ROLE_ID_MAX_LENGTH = 64;
