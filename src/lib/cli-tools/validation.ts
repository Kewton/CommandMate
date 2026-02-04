/**
 * Session name validation module
 * Issue #4: T2.2 - Security validation for session names (MF4-001)
 *
 * This module provides validation functions to prevent command injection
 * attacks through session names used in tmux commands.
 */

/**
 * Session name pattern
 * Only allows alphanumeric characters, underscores, and hyphens
 * This prevents command injection through shell special characters
 *
 * Pattern breakdown:
 * - ^ : Start of string
 * - [a-zA-Z0-9_-] : Allowed characters (alphanumeric, underscore, hyphen)
 * - + : One or more characters (empty strings not allowed)
 * - $ : End of string
 */
export const SESSION_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate session name format
 * Throws an error if the session name contains invalid characters
 *
 * @param sessionName - Session name to validate
 * @throws Error if session name is invalid
 *
 * @example
 * ```typescript
 * validateSessionName('mcbd-claude-test'); // OK
 * validateSessionName('test;rm -rf'); // Throws Error
 * ```
 */
export function validateSessionName(sessionName: string): void {
  if (!SESSION_NAME_PATTERN.test(sessionName)) {
    throw new Error(`Invalid session name format: ${sessionName}`);
  }
}
