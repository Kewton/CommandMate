/**
 * Error Definitions
 * Issue #136: Phase 1 - Foundation
 *
 * Centralized error handling for the application.
 * SF-SEC-003: Separates client-facing and internal error messages.
 *
 * @module errors
 */

/**
 * Standard error codes used throughout the application
 * These codes are safe to expose to clients.
 */
export const ErrorCode = {
  // Input validation errors
  INVALID_ISSUE_NO: 'INVALID_ISSUE_NO',
  ISSUE_NO_OUT_OF_RANGE: 'ISSUE_NO_OUT_OF_RANGE',
  INVALID_BRANCH_NAME: 'INVALID_BRANCH_NAME',
  BRANCH_NAME_TOO_LONG: 'BRANCH_NAME_TOO_LONG',
  INVALID_PORT: 'INVALID_PORT',

  // Resource errors
  PORT_EXHAUSTED: 'PORT_EXHAUSTED',
  PORT_IN_USE: 'PORT_IN_USE',
  WORKTREE_NOT_FOUND: 'WORKTREE_NOT_FOUND',
  WORKTREE_ALREADY_EXISTS: 'WORKTREE_ALREADY_EXISTS',
  PID_FILE_EXISTS: 'PID_FILE_EXISTS',
  PROCESS_NOT_RUNNING: 'PROCESS_NOT_RUNNING',

  // Security errors
  PATH_TRAVERSAL: 'PATH_TRAVERSAL',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',

  // System errors
  DATABASE_ERROR: 'DATABASE_ERROR',
  FILESYSTEM_ERROR: 'FILESYSTEM_ERROR',
  GIT_ERROR: 'GIT_ERROR',
  TIMEOUT: 'TIMEOUT',

  // Generic errors
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Application-specific error class
 *
 * @example
 * ```typescript
 * throw new AppError('INVALID_ISSUE_NO', 'Issue number must be a positive integer', { received: -1 });
 * ```
 */
export class AppError extends Error {
  /**
   * Error code - safe to expose to clients
   */
  readonly code: string;

  /**
   * Additional details - may contain sensitive info, log only
   */
  readonly details?: Record<string, unknown>;

  /**
   * Timestamp when error occurred
   */
  readonly timestamp: string;

  constructor(
    code: string,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
    this.timestamp = new Date().toISOString();

    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AppError);
    }
  }

  /**
   * Create a client-safe representation (excludes sensitive details)
   */
  toClientError(): { code: string; message: string } {
    return {
      code: this.code,
      message: this.message,
    };
  }

  /**
   * Create a log-safe representation (includes details for debugging)
   */
  toLogError(): { code: string; message: string; details?: Record<string, unknown>; timestamp: string } {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      timestamp: this.timestamp,
    };
  }
}

/**
 * Factory function to create AppError
 *
 * @param code - Error code from ErrorCode enum
 * @param message - Human-readable error message
 * @param details - Optional additional details (logged, not sent to client)
 * @returns AppError instance
 *
 * @example
 * ```typescript
 * throw createAppError(ErrorCode.PORT_EXHAUSTED, 'No available ports in range', { range: [3001, 3100] });
 * ```
 */
export function createAppError(
  code: string,
  message: string,
  details?: Record<string, unknown>
): AppError {
  return new AppError(code, message, details);
}

/**
 * Type guard to check if an error is an AppError
 *
 * @param error - Error to check
 * @returns true if error is an AppError
 */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Wrap unknown error into AppError
 *
 * @param error - Unknown error
 * @param defaultCode - Default error code if error is not AppError
 * @returns AppError instance
 */
export function wrapError(error: unknown, defaultCode: string = ErrorCode.UNKNOWN_ERROR): AppError {
  if (isAppError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return new AppError(defaultCode, error.message, { originalError: error.name });
  }

  return new AppError(defaultCode, String(error));
}

/**
 * Get error message from unknown error
 *
 * @param error - Unknown error
 * @returns Error message string
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
