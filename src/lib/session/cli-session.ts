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

import { CLIToolManager } from '@/lib/cli-tools/manager';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';
import type { SessionTransport } from '@/lib/tmux/session-transport';
import { getPollingTmuxTransport } from '@/lib/tmux/polling-tmux-transport';
import {
  getOrFetchCapture,
  setCachedCapture,
  invalidateCache,
  sliceOutput,
  CACHE_MAX_CAPTURE_LINES,
} from '@/lib/tmux/tmux-capture-cache';
// Issue #2317: this module is one of the two gateways Issue #1922's import guard
// names, which is why the tmux SURFACE is reached from here and not from
// `worktree-status-helper.ts`. Static, not `await import()`: the guard's
// `no-restricted-syntax` rule blocks the dynamic form outright ("keep it at
// zero"), and this module already imports from `lib/tmux/**` above.
import {
  ensureSessionHooks,
  forgetSessionHooks,
  reconcileDelegatedGeometry,
} from '@/lib/tmux/session-hooks';
import {
  forgetSessionStatus,
  publishSessionStatus,
} from '@/lib/tmux/session-status-options';
import { isLiveAttachEligibleSession } from './tmux-session-surface';

const logger = createLogger('cli-session');

function getDefaultTransport(): SessionTransport {
  return getPollingTmuxTransport();
}

function resolveSessionContext(worktreeId: string, cliToolId: CLIToolType, instanceId?: string) {
  const manager = CLIToolManager.getInstance();
  const cliTool = manager.getTool(cliToolId);
  const sessionName = cliTool.getSessionName(worktreeId, instanceId);
  return { cliTool, sessionName };
}

/**
 * Check if CLI tool session is running
 *
 * @param worktreeId - Worktree ID
 * @param cliToolId - CLI tool ID (claude, codex, gemini)
 * @param instanceId - Optional agent instance ID (defaults to primary)
 * @returns True if session exists and is running
 */
export async function isSessionRunning(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): Promise<boolean> {
  const { sessionName } = resolveSessionContext(worktreeId, cliToolId, instanceId);
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
  lines: number = 1000,
  instanceId?: string
): Promise<string> {
  const log = logger.withContext({ worktreeId, cliToolId });
  log.debug('captureSessionOutput:start', { requestedLines: lines });

  const { cliTool, sessionName } = resolveSessionContext(worktreeId, cliToolId, instanceId);
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
  lines: number = 5000,
  instanceId?: string
): Promise<string> {
  const log = logger.withContext({ worktreeId, cliToolId });
  log.debug('captureSessionOutputFresh:start', { requestedLines: lines });

  const { cliTool, sessionName } = resolveSessionContext(worktreeId, cliToolId, instanceId);
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
 * @param instanceId - Optional agent instance ID (defaults to primary)
 * @returns Session name
 */
export function getSessionName(worktreeId: string, cliToolId: CLIToolType, instanceId?: string): string {
  return resolveSessionContext(worktreeId, cliToolId, instanceId).sessionName;
}

// ===========================================================================
// The tmux SURFACE (Issue #2317)
// ===========================================================================

/**
 * What one session's surface write is about (Issue #2317).
 *
 * Structurally the same object `publishSessionStatus` takes; restated here
 * rather than re-exported so this module's callers do not import a type from
 * `lib/tmux/**` in order to call the gateway that exists to keep them out of it.
 */
export interface SessionSurfacePublication {
  sessionName: string;
  worktreeId: string;
  cliToolId: string;
  instanceId: string;
  /** The `commandmate ls` STATUS word: `idle` / `ready` / `running` / `waiting`. */
  status: string;
}

/**
 * Publish one session's state onto its tmux session, and take back a geometry
 * no human is using (Issue #2317, Phases B and D).
 *
 * ## Why this is here rather than called directly
 *
 * `worktree-status-helper.ts` is the caller, and Issue #1922's import guard
 * (§4 D4) forbids it from reaching `lib/tmux/**` — this module is one of the two
 * sanctioned gateways the guard's own message names, and the guard's allowlist
 * "may only shrink". So the status poll asks this module, and this module owns
 * the three tmux-side calls.
 *
 * Everything below is no-throw by construction (each callee swallows its own
 * errors), and the whole thing is a convenience surface: a tmux hiccup must not
 * be able to fail the poll that the sidebar, the header chip and
 * `commandmate ls` all read.
 *
 * Costs nothing in the steady state: the status write is skipped unless the
 * status CHANGED, the hook reconcile runs once per session per process, and the
 * geometry probe is asked only for the tools `attach --live` accepts.
 *
 * @param publication - Session identity plus the status word to publish
 */
export async function publishSessionSurface(
  publication: SessionSurfacePublication,
): Promise<void> {
  await ensureSessionHooks(publication.sessionName);
  if (isLiveAttachEligibleSession(publication.sessionName)) {
    await reconcileDelegatedGeometry(publication.sessionName);
  }
  await publishSessionStatus(publication);
}

/**
 * Drop every memo held for a session that is known to be gone (Issue #2317).
 *
 * Without it, a session created later under the same name would be deduped
 * against the dead one's last published status and never write its own.
 *
 * @param sessionName - tmux session name that no longer exists
 */
export function forgetSessionSurface(sessionName: string): void {
  forgetSessionStatus(sessionName);
  forgetSessionHooks(sessionName);
}
