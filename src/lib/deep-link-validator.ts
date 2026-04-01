/**
 * Deep Link Validator - Runtime type guard for DeepLinkPane values.
 *
 * Issue #600: UX refresh - validates ?pane= query parameter values
 * against whitelist [DR4-002, DR4-010].
 *
 * Security: Prevents DOM-based XSS by ensuring only known pane values
 * are used in component logic. Invalid values fall back to 'terminal'.
 */

import type { DeepLinkPane } from '@/types/ui-state';

/**
 * Set of valid DeepLinkPane values for runtime validation.
 */
export const VALID_PANES: ReadonlySet<DeepLinkPane> = new Set<DeepLinkPane>([
  'terminal',
  'history',
  'git',
  'files',
  'notes',
  'logs',
  'agent',
  'timer',
  'info',
]);

/**
 * Runtime type guard for DeepLinkPane values.
 *
 * @param value - String value to validate
 * @returns true if value is a valid DeepLinkPane
 */
export function isDeepLinkPane(value: string): value is DeepLinkPane {
  return VALID_PANES.has(value as DeepLinkPane);
}

/**
 * Validate and normalize a pane value with fallback to 'terminal'.
 *
 * @param value - Raw string value (e.g., from searchParams)
 * @returns Valid DeepLinkPane value, falling back to 'terminal' for invalid input
 */
export function normalizeDeepLinkPane(value: string | null | undefined): DeepLinkPane {
  if (value && isDeepLinkPane(value)) {
    return value;
  }
  return 'terminal';
}
