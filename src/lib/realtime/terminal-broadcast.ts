/**
 * Server-side realtime broadcasters for terminal output and session status.
 * Issue #1120.
 *
 * `broadcastTerminalSnapshot` is invoked from the response poller tick while a
 * session is generating, pushing the same payload the `/current-output` route
 * would return to every subscriber of the worktree room. A monotonic `version`
 * per (worktreeId, cliToolId, instanceId) lets clients drop out-of-order frames
 * (stale-response parity with the polling guard). The tmux capture is skipped
 * entirely when the room has no subscribers.
 */

import { broadcast, hasRoomSubscribers } from '@/lib/ws-server';
import { getDbInstance } from '@/lib/db/db-instance';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';

const logger = createLogger('terminal-broadcast');

const versionCounters = new Map<string, number>();

function nextVersion(key: string): number {
  const version = (versionCounters.get(key) ?? 0) + 1;
  versionCounters.set(key, version);
  return version;
}

/**
 * Capture the current terminal output for a session and push it to the worktree
 * room. Best-effort: any failure is swallowed (HTTP polling remains the
 * fallback). No-op when the room has no subscribers.
 */
export async function broadcastTerminalSnapshot(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
): Promise<void> {
  if (!hasRoomSubscribers(worktreeId)) return;

  try {
    const db = getDbInstance();
    const payload = await buildCurrentOutput(db, worktreeId, cliToolId, instanceId);
    const resolvedInstanceId = instanceId ?? cliToolId;
    const key = `${worktreeId}:${cliToolId}:${resolvedInstanceId}`;

    broadcast(worktreeId, {
      type: 'terminal_snapshot',
      worktreeId,
      cliToolId,
      instanceId: resolvedInstanceId,
      output: payload.fullOutput ?? '',
      isRunning: payload.isRunning,
      thinking: payload.thinking ?? false,
      isPromptWaiting: payload.isPromptWaiting ?? false,
      promptData: payload.promptData ?? null,
      isSelectionListActive: payload.isSelectionListActive ?? false,
      isPagerActive: payload.isPagerActive ?? false,
      isUnclassifiedActive: payload.isUnclassifiedActive ?? false,
      version: nextVersion(key),
    });
  } catch (error) {
    logger.error('terminal-snapshot:failed', {
      worktreeId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Push a session running/stopped transition to the worktree room so sidebar
 * status dots update immediately instead of waiting for the next status poll.
 */
export function broadcastSessionStatus(
  worktreeId: string,
  isRunning: boolean,
  opts?: { cliTool?: string | null; instance?: string | null },
): void {
  broadcast(worktreeId, {
    type: 'session_status_changed',
    worktreeId,
    isRunning,
    cliTool: opts?.cliTool ?? null,
    instance: opts?.instance ?? null,
  });
}

/** Test helper: reset the per-session version counters. */
export function __resetTerminalBroadcastState(): void {
  versionCounters.clear();
}
