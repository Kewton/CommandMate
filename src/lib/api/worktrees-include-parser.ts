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

/**
 * Query values that turn the tmux-derived status block OFF (Issue #2060).
 *
 * Deliberately an opt-OUT list rather than an opt-in one: `?includeStatus=` is
 * additive, so every request that does not say one of these words — including
 * every request written before #2060 existed, and a bare `?includeStatus`
 * (which Next.js normalises to `includeStatus=`) — keeps the status block it
 * has always had. An unrecognised value is not an error and is not logged, the
 * same rule `parseIncludeParam` applies to `?include=`.
 */
export const STATUS_OFF_VALUES = ['0', 'false', 'no', 'off'] as const;

/**
 * Parse the `?includeStatus=` query parameter (Issue #2060).
 *
 * `true` means "compute the tmux-derived session status", which is what the
 * route did unconditionally before this parameter existed. Only the words in
 * {@link STATUS_OFF_VALUES} (trimmed, case-insensitive) turn it off, so the
 * seven existing consumers of `GET /api/worktrees` are unaffected until one of
 * them opts out on purpose.
 *
 * @param raw - Raw string from searchParams.get('includeStatus')
 * @returns Whether the caller wants the status block
 */
export function parseIncludeStatusParam(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  return !(STATUS_OFF_VALUES as readonly string[]).includes(normalized);
}
