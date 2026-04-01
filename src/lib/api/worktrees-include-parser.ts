/**
 * Worktrees API include parameter parser.
 *
 * Issue #600: UX refresh - whitelist validation for ?include= parameter [DR4-001].
 * Invalid values are silently ignored (no error response, no logging) [DR4-007].
 */

/**
 * Valid values for the include parameter.
 */
export const VALID_INCLUDE_VALUES = ['review'] as const;

export type IncludeValue = typeof VALID_INCLUDE_VALUES[number];

/**
 * Parse and validate the ?include= query parameter.
 *
 * Supports comma-separated values. Invalid values are silently filtered out.
 * Returns a Set of valid include values.
 *
 * @param raw - Raw string from searchParams.get('include')
 * @returns Set of validated include values
 */
export function parseIncludeParam(raw: string | null): Set<IncludeValue> {
  if (!raw) return new Set();

  const values = raw.split(',');
  const validSet = new Set<IncludeValue>();

  for (const v of values) {
    const trimmed = v.trim();
    if ((VALID_INCLUDE_VALUES as readonly string[]).includes(trimmed)) {
      validSet.add(trimmed as IncludeValue);
    }
  }

  return validSet;
}
