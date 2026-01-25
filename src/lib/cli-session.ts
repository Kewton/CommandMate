/**
 * Generic CLI session management
 * Manages CLI tool sessions (Claude, Codex, Gemini) within tmux
 */

import { hasSession, capturePane } from './tmux';
import { CLIToolManager } from './cli-tools/manager';
import type { CLIToolType } from './cli-tools/types';
import { createLogger } from './logger';

const logger = createLogger('cli-session');

/**
 * Check if CLI tool session is running
 *
 * @param worktreeId - Worktree ID
 * @param cliToolId - CLI tool ID (claude, codex, gemini)
 * @returns True if session exists and is running
 */
export async function isSessionRunning(
  worktreeId: string,
  cliToolId: CLIToolType
): Promise<boolean> {
  const manager = CLIToolManager.getInstance();
  const cliTool = manager.getTool(cliToolId);
  const sessionName = cliTool.getSessionName(worktreeId);
  return await hasSession(sessionName);
}

/**
 * Capture CLI session output
 *
 * @param worktreeId - Worktree ID
 * @param cliToolId - CLI tool ID (claude, codex, gemini)
 * @param lines - Number of lines to capture (default: 1000)
 * @returns Captured output
 */
export async function captureSessionOutput(
  worktreeId: string,
  cliToolId: CLIToolType,
  lines: number = 1000
): Promise<string> {
  const log = logger.withContext({ worktreeId, cliToolId });
  log.debug('captureSessionOutput:start', { requestedLines: lines });

  const manager = CLIToolManager.getInstance();
  const cliTool = manager.getTool(cliToolId);
  const sessionName = cliTool.getSessionName(worktreeId);

  // Check if session exists
  const exists = await hasSession(sessionName);
  if (!exists) {
    log.debug('captureSessionOutput:sessionNotFound', { sessionName });
    throw new Error(`${cliTool.name} session ${sessionName} does not exist`);
  }

  try {
    const output = await capturePane(sessionName, { startLine: -lines });
    const actualLines = output.split('\n').length;

    log.debug('captureSessionOutput:success', {
      actualLines,
      lastFewLines: output.split('\n').slice(-3).join(' | '),
    });

    return output;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('captureSessionOutput:failed', { error: errorMessage });
    throw new Error(`Failed to capture ${cliTool.name} output: ${errorMessage}`);
  }
}

/**
 * Get session name for a CLI tool and worktree
 *
 * @param worktreeId - Worktree ID
 * @param cliToolId - CLI tool ID
 * @returns Session name
 */
export function getSessionName(worktreeId: string, cliToolId: CLIToolType): string {
  const manager = CLIToolManager.getInstance();
  const cliTool = manager.getTool(cliToolId);
  return cliTool.getSessionName(worktreeId);
}
