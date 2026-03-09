/**
 * Generic CLI session management
 * Manages CLI tool sessions (Claude, Codex, Gemini) within tmux.
 *
 * Issue #460 Phase 1:
 * - Introduces SessionTransport as the abstraction seam
 * - Uses PollingTmuxTransport as the current default transport
 *
 * Issue #405: Cache integration via tmux-capture-cache.ts
 * - captureSessionOutput() uses getOrFetchCapture() for cache-backed capture
 * - captureSessionOutputFresh() bypasses cache for prompt-response verification
 */

import { CLIToolManager } from './cli-tools/manager';
import type { CLIToolType } from './cli-tools/types';
import { createLogger } from './logger';
import type { SessionTransport } from './session-transport';
import { getPollingTmuxTransport } from './transports/polling-tmux-transport';
import {
  getOrFetchCapture,
  setCachedCapture,
  invalidateCache,
  sliceOutput,
  CACHE_MAX_CAPTURE_LINES,
} from './tmux-capture-cache';

const logger = createLogger('cli-session');

function getDefaultTransport(): SessionTransport {
  return getPollingTmuxTransport();
}

function resolveSessionContext(worktreeId: string, cliToolId: CLIToolType) {
  const manager = CLIToolManager.getInstance();
  const cliTool = manager.getTool(cliToolId);
  const sessionName = cliTool.getSessionName(worktreeId);
  return { cliTool, sessionName };
}

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
  const { sessionName } = resolveSessionContext(worktreeId, cliToolId);
  return getDefaultTransport().sessionExists(sessionName);
}

/**
 * Capture CLI session output (cache-backed)
 *
 * Issue #405: Uses getOrFetchCapture() for TTL-based caching with singleflight
 * deduplication. Interface is unchanged for backward compatibility.
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

  const { cliTool, sessionName } = resolveSessionContext(worktreeId, cliToolId);
  const transport = getDefaultTransport();

  try {
    const output = await getOrFetchCapture(sessionName, lines, async () => {
      // fetchFn: check session existence then capture
      const exists = await transport.sessionExists(sessionName);
      if (!exists) {
        throw new Error(`${cliTool.name} session ${sessionName} does not exist`);
      }
      return await transport.captureSnapshot(sessionName, { startLine: -CACHE_MAX_CAPTURE_LINES });
    });

    log.debug('captureSessionOutput:success', {
      actualLines: output.split('\n').length,
      lastFewLines: output.split('\n').slice(-3).join(' | '),
    });

    return output;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // Preserve original error messages (session not found vs capture failure)
    if (errorMessage.includes('does not exist')) {
      log.debug('captureSessionOutput:sessionNotFound', { sessionName });
      throw error;
    }
    log.error('captureSessionOutput:failed', { error: errorMessage });
    throw new Error(`Failed to capture ${cliTool.name} output: ${errorMessage}`);
  }
}

/**
 * Capture CLI session output bypassing cache (fresh capture).
 *
 * Issue #405: Used by prompt-response endpoint to ensure fresh output
 * for prompt re-verification. Writes back to cache on success.
 *
 * @param worktreeId - Worktree ID
 * @param cliToolId - CLI tool ID
 * @param lines - Number of lines to capture (default: 5000)
 * @returns Captured output
 */
export async function captureSessionOutputFresh(
  worktreeId: string,
  cliToolId: CLIToolType,
  lines: number = 5000
): Promise<string> {
  const log = logger.withContext({ worktreeId, cliToolId });
  log.debug('captureSessionOutputFresh:start', { requestedLines: lines });

  const { cliTool, sessionName } = resolveSessionContext(worktreeId, cliToolId);
  const transport = getDefaultTransport();

  try {
    const output = await transport.captureSnapshot(sessionName, { startLine: -lines });

    // Write back to cache if non-empty [SEC4-007]
    if (output.length > 0) {
      setCachedCapture(sessionName, output, lines);
    } else {
      invalidateCache(sessionName);
    }

    return sliceOutput(output, lines);
  } catch (error: unknown) {
    // [DA3-005] Invalidate cache on error (TOCTOU safety)
    invalidateCache(sessionName);
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('captureSessionOutputFresh:failed', { error: errorMessage });
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
  return resolveSessionContext(worktreeId, cliToolId).sessionName;
}
