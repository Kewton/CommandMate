/**
 * Input Validators
 * Issue #136: Phase 1 - Foundation
 *
 * Provides input validation functions for worktree-related operations.
 * These validators are critical for security (command injection prevention).
 *
 * @module input-validators
 */

/**
 * Maximum allowed issue number (2^31 - 1)
 * NTH-SEC-002: Prevent integer overflow
 */
export const MAX_ISSUE_NO = 2147483647;

/**
 * Branch name whitelist pattern
 * MF-SEC-001: Only allow safe characters to prevent command injection
 * Allowed: a-z, A-Z, 0-9, underscore, hyphen, forward slash
 */
export const BRANCH_NAME_PATTERN = /^[a-zA-Z0-9_/-]+$/;

/**
 * Maximum branch name length
 * Prevents DoS via overly long input
 */
export const MAX_BRANCH_NAME_LENGTH = 255;

/**
 * Validate issue number
 * SEC-001: Strict positive integer validation
 *
 * @param issueNo - The issue number to validate
 * @throws Error with code 'INVALID_ISSUE_NO' if not a valid integer
 * @throws Error with code 'ISSUE_NO_OUT_OF_RANGE' if out of range
 *
 * @example
 * ```typescript
 * validateIssueNo(135); // OK
 * validateIssueNo('135'); // throws INVALID_ISSUE_NO
 * validateIssueNo(-1); // throws ISSUE_NO_OUT_OF_RANGE
 * ```
 */
export function validateIssueNo(issueNo: unknown): asserts issueNo is number {
  if (
    typeof issueNo !== 'number' ||
    !Number.isInteger(issueNo) ||
    !Number.isFinite(issueNo)
  ) {
    throw new Error('INVALID_ISSUE_NO');
  }

  if (issueNo <= 0 || issueNo > MAX_ISSUE_NO) {
    throw new Error('ISSUE_NO_OUT_OF_RANGE');
  }
}

/**
 * Validate branch name
 * MF-SEC-001: Whitelist validation to prevent command injection
 *
 * @param branchName - The branch name to validate
 * @throws Error with code 'INVALID_BRANCH_NAME' if contains invalid characters
 * @throws Error with code 'BRANCH_NAME_TOO_LONG' if exceeds max length
 *
 * @example
 * ```typescript
 * validateBranchName('feature/136-worktree'); // OK
 * validateBranchName('feature`rm -rf /`'); // throws INVALID_BRANCH_NAME
 * ```
 */
export function validateBranchName(branchName: string): void {
  if (!branchName || !BRANCH_NAME_PATTERN.test(branchName)) {
    throw new Error('INVALID_BRANCH_NAME');
  }

  if (branchName.length > MAX_BRANCH_NAME_LENGTH) {
    throw new Error('BRANCH_NAME_TOO_LONG');
  }
}

/**
 * Validate port number
 * SEC-003: Port validation for worktree servers
 *
 * @param port - The port number to validate
 * @param minPort - Minimum allowed port (default: 1024, non-privileged)
 * @param maxPort - Maximum allowed port (default: 65535)
 * @throws Error with code 'INVALID_PORT' if not a valid port number
 *
 * @example
 * ```typescript
 * validatePortNumber(3001); // OK
 * validatePortNumber(80); // throws INVALID_PORT (privileged)
 * ```
 */
export function validatePortNumber(
  port: unknown,
  minPort: number = 1024,
  maxPort: number = 65535
): asserts port is number {
  if (
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    !Number.isFinite(port)
  ) {
    throw new Error('INVALID_PORT');
  }

  if (port < minPort || port > maxPort) {
    throw new Error('INVALID_PORT');
  }
}

/**
 * Validation result interface for CLI commands
 * Issue #136: Used by CLI commands for user-friendly error messages
 */
export interface IssueValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Type guard for checking if a value is a valid issue number
 *
 * @param value - Value to check
 * @returns true if value is a valid issue number
 */
export function isValidIssueNo(value: unknown): value is number {
  try {
    validateIssueNo(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate issue number and return result (for CLI commands)
 * Issue #136: CLI-friendly validation that returns result instead of throwing
 *
 * @param issueNo - The issue number to validate
 * @returns Validation result with error message if invalid
 */
export function validateIssueNoResult(issueNo: unknown): IssueValidationResult {
  try {
    validateIssueNo(issueNo);
    return { valid: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    switch (message) {
      case 'INVALID_ISSUE_NO':
        return { valid: false, error: 'Issue number must be a positive integer' };
      case 'ISSUE_NO_OUT_OF_RANGE':
        return { valid: false, error: `Issue number must be between 1 and ${MAX_ISSUE_NO}` };
      default:
        return { valid: false, error: 'Invalid issue number' };
    }
  }
}

/**
 * Type guard for checking if a value is a valid branch name
 *
 * @param value - Value to check
 * @returns true if value is a valid branch name
 */
export function isValidBranchName(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    validateBranchName(value);
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Issue #264: Issue command input validators
// =============================================================================

/**
 * [SEC-MF-001] Maximum issue title length (DoS prevention)
 */
export const MAX_TITLE_LENGTH = 256;

/**
 * [SEC-MF-001] Maximum issue body length (64KB, DoS prevention)
 */
export const MAX_BODY_LENGTH = 65536;

/**
 * Validate issue title length.
 * [SEC-MF-001] Prevents DoS via extremely long input to gh CLI.
 *
 * @param title - Issue title to validate
 * @returns Validation result with error message if invalid
 */
export function validateIssueTitle(title: string): IssueValidationResult {
  if (title.length > MAX_TITLE_LENGTH) {
    return { valid: false, error: `Title exceeds maximum length of ${MAX_TITLE_LENGTH} characters` };
  }
  return { valid: true };
}

/**
 * Validate issue body length.
 * [SEC-MF-001] Prevents DoS via extremely long input to gh CLI.
 *
 * @param body - Issue body to validate
 * @returns Validation result with error message if invalid
 */
export function validateIssueBody(body: string): IssueValidationResult {
  if (body.length > MAX_BODY_LENGTH) {
    return { valid: false, error: `Body exceeds maximum length of ${MAX_BODY_LENGTH} characters` };
  }
  return { valid: true };
}

/**
 * Sanitize a label string by removing control characters and zero-width characters.
 * [SEC-SF-001] Follows env-setup.ts sanitizeInput() pattern.
 *
 * @param label - Label string to sanitize
 * @returns Sanitized label string
 */
export function sanitizeLabel(label: string): string {
  return label.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\uFEFF]/g, '').trim();
}
