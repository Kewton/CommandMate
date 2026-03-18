/**
 * Shared Command Helpers
 * Issue #518: DRY - Extract duplicated patterns from command files
 *
 * Provides:
 * - TOKEN_WARNING: Shared help text for --token option [SEC4-01]
 * - handleCommandError(): Unified error handler for command catch blocks
 */

import { ExitCode } from '../types';
import { ApiError } from './api-client';

/**
 * Token option warning text [SEC4-01]
 * Shared across all commands that accept --token.
 */
export const TOKEN_WARNING = 'Auth token (WARNING: visible in process list. Prefer CM_AUTH_TOKEN env var)';

/**
 * Unified error handler for CLI command catch blocks.
 * Prints error message to stderr and exits with appropriate code.
 *
 * @param error - Caught error (ApiError or unknown)
 */
export function handleCommandError(error: unknown): never {
  if (error instanceof ApiError) {
    console.error(`Error: ${error.message}`);
    process.exit(error.exitCode);
  }
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(ExitCode.UNEXPECTED_ERROR);
}
