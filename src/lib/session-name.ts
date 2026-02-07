/**
 * Session name generation utility
 * [Issue #163] Task-PRE-002: Centralized session name generation
 *
 * Consolidates 5 scattered getSessionName() implementations into a single
 * validated utility function. All session names pass through
 * SESSION_NAME_PATTERN validation to prevent command injection.
 */

import type { CLIToolType } from './cli-tools/types';
import { CLI_TOOL_IDS } from './cli-tools/types';
import { validateSessionName } from './cli-tools/validation';

/**
 * Generate a validated tmux session name for a CLI tool and worktree
 *
 * @param worktreeId - Worktree identifier
 * @param cliToolId - CLI tool type ('claude' | 'codex' | 'gemini')
 * @returns Validated session name string
 * @throws Error if the resulting session name contains invalid characters
 */
export function getSessionNameUtil(worktreeId: string, cliToolId: CLIToolType): string {
  if (!worktreeId) {
    throw new Error('worktreeId must not be empty');
  }
  const sessionName = `mcbd-${cliToolId}-${worktreeId}`;
  validateSessionName(sessionName);
  return sessionName;
}

/**
 * Check if a string is a valid CLI tool ID
 *
 * @param id - String to validate
 * @returns true if the id is a valid CLIToolType
 */
export function isValidCliToolId(id: string): id is CLIToolType {
  return (CLI_TOOL_IDS as readonly string[]).includes(id);
}
