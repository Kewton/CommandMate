/**
 * Resource Cleanup Module
 * Issue #404: Long-running server resource leak prevention
 *
 * Section 1: MCP orphaned process cleanup (ppid=1 detection)
 * Section 2: globalThis Map periodic cleanup (orphaned entries)
 * Orchestrator: initResourceCleanup / stopResourceCleanup
 *
 * Security:
 * - execFile() only (no exec()), per Issue #393 convention
 * - PID validation: Number.isInteger(pid) && pid > 0
 * - MCP_PROCESS_PATTERNS boundary match
 * - Container environment detection (skip in Docker)
 */

import { execFile } from 'child_process';
import { existsSync } from 'fs';
import {
  getAutoYesStateWorktreeIds,
  getAutoYesPollerWorktreeIds,
  deleteAutoYesState,
  stopAutoYesPolling,
} from './auto-yes-manager';
import { stopScheduleForWorktree, getScheduleWorktreeIds } from './schedule-manager';
import { getDbInstance } from './db-instance';

// =============================================================================
// Constants
// =============================================================================

/** Cleanup interval: 24 hours */
export const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Process name patterns for MCP orphaned process detection */
export const MCP_PROCESS_PATTERNS: readonly string[] = ['codex mcp-server', 'playwright-mcp'];

/** Maximum ps output buffer size (1MB) */
export const MAX_PS_OUTPUT_BYTES = 1 * 1024 * 1024;

// =============================================================================
// Types
// =============================================================================

/** Result of orphaned MCP process cleanup */
export interface OrphanCleanupResult {
  /** PIDs that were killed */
  killedPids: number[];
  /** PIDs that failed to be killed */
  failedPids: number[];
  /** Whether cleanup was skipped */
  skipped: boolean;
  /** Reason for skipping */
  reason?: string;
}

/** Result of orphaned Map entry cleanup */
export interface CleanupMapResult {
  /** Worktree IDs deleted from autoYesStates */
  deletedAutoYesStateIds: string[];
  /** Worktree IDs deleted from autoYesPollerStates */
  deletedAutoYesPollerIds: string[];
  /** Worktree IDs whose schedules were stopped */
  deletedScheduleWorktreeIds: string[];
}

// =============================================================================
// Global State
// =============================================================================

declare global {
  // eslint-disable-next-line no-var
  var __resourceCleanupTimerId: ReturnType<typeof setInterval> | undefined;
}

// =============================================================================
// Section 1: MCP Orphaned Process Cleanup
// =============================================================================

/**
 * Check if running in a container environment.
 * Detects Docker/container by checking /proc/1/cgroup existence.
 *
 * @returns true if in a container environment
 */
function isContainerEnvironment(): boolean {
  try {
    return existsSync('/proc/1/cgroup');
  } catch {
    return false;
  }
}

/**
 * Check if a process command matches any MCP process pattern.
 * Uses case-insensitive substring match for reliability.
 *
 * @param command - Process command string from ps output
 * @returns true if command matches an MCP process pattern
 */
function matchesMcpPattern(command: string): boolean {
  const lowerCommand = command.toLowerCase();
  return MCP_PROCESS_PATTERNS.some(pattern => lowerCommand.includes(pattern.toLowerCase()));
}

/**
 * Clean up orphaned MCP processes (ppid=1).
 * Finds processes whose parent is init (ppid=1) and whose command
 * matches MCP_PROCESS_PATTERNS, then sends SIGTERM.
 *
 * Skips execution in container environments to avoid killing init processes.
 *
 * @returns Result with killed/failed PIDs
 */
export async function cleanupOrphanedMcpProcesses(): Promise<OrphanCleanupResult> {
  const result: OrphanCleanupResult = {
    killedPids: [],
    failedPids: [],
    skipped: false,
  };

  // Skip in container environments
  if (isContainerEnvironment()) {
    result.skipped = true;
    result.reason = 'container';
    return result;
  }

  return new Promise<OrphanCleanupResult>((resolve) => {
    execFile(
      'ps',
      ['-eo', 'pid,ppid,command'],
      { maxBuffer: MAX_PS_OUTPUT_BYTES },
      (error, stdout) => {
        if (error) {
          console.warn('[resource-cleanup] Failed to list processes:', error);
          resolve(result);
          return;
        }

        const lines = stdout.split('\n');
        // Skip header line
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;

          // Parse: PID  PPID  COMMAND
          const parts = line.split(/\s+/);
          if (parts.length < 3) continue;

          const pid = parseInt(parts[0], 10);
          const ppid = parseInt(parts[1], 10);
          const command = parts.slice(2).join(' ');

          // Validate PID
          if (!Number.isInteger(pid) || pid <= 0) continue;
          if (!Number.isInteger(ppid)) continue;

          // Only target orphaned processes (ppid=1) matching MCP patterns
          if (ppid !== 1) continue;
          if (!matchesMcpPattern(command)) continue;

          try {
            process.kill(pid, 'SIGTERM');
            result.killedPids.push(pid);
            console.log(`[resource-cleanup] Killed orphaned MCP process: PID=${pid}, command="${command}"`);
          } catch (killError) {
            result.failedPids.push(pid);
            console.warn(`[resource-cleanup] Failed to kill PID=${pid}:`, killError);
          }
        }

        if (result.killedPids.length > 0) {
          console.log(`[resource-cleanup] Cleaned up ${result.killedPids.length} orphaned MCP process(es)`);
        }

        resolve(result);
      }
    );
  });
}

// =============================================================================
// Section 2: globalThis Map Periodic Cleanup
// =============================================================================

/**
 * Get all valid worktree IDs from the database.
 *
 * @returns Set of valid worktree IDs
 */
function getDbWorktreeIds(): Set<string> {
  try {
    const db = getDbInstance();
    const rows = db.prepare('SELECT id FROM worktrees').all() as { id: string }[];
    return new Set(rows.map(r => r.id));
  } catch (error) {
    console.warn('[resource-cleanup] Failed to query worktrees from DB:', error);
    return new Set();
  }
}

/**
 * Clean up orphaned entries from globalThis Maps.
 * Compares Map keys against DB worktree IDs and removes entries
 * for worktrees that no longer exist.
 *
 * Uses better-sqlite3's synchronous API, so the DB query and Map
 * mutation happen in the same synchronous block (no race conditions).
 *
 * @returns Result with deleted entry IDs
 */
export function cleanupOrphanedMapEntries(): CleanupMapResult {
  const result: CleanupMapResult = {
    deletedAutoYesStateIds: [],
    deletedAutoYesPollerIds: [],
    deletedScheduleWorktreeIds: [],
  };

  const validWorktreeIds = getDbWorktreeIds();
  if (validWorktreeIds.size === 0) {
    // If DB query returned nothing, skip cleanup to avoid false positives
    return result;
  }

  // Cleanup autoYesStates
  const autoYesStateIds = getAutoYesStateWorktreeIds();
  for (const worktreeId of autoYesStateIds) {
    if (!validWorktreeIds.has(worktreeId)) {
      deleteAutoYesState(worktreeId);
      result.deletedAutoYesStateIds.push(worktreeId);
    }
  }

  // Cleanup autoYesPollerStates
  const autoYesPollerIds = getAutoYesPollerWorktreeIds();
  for (const worktreeId of autoYesPollerIds) {
    if (!validWorktreeIds.has(worktreeId)) {
      stopAutoYesPolling(worktreeId);
      result.deletedAutoYesPollerIds.push(worktreeId);
    }
  }

  // Cleanup schedule manager entries (via encapsulated accessor)
  const scheduleWorktreeIds = getScheduleWorktreeIds();
  for (const worktreeId of scheduleWorktreeIds) {
    if (!validWorktreeIds.has(worktreeId)) {
      stopScheduleForWorktree(worktreeId);
      result.deletedScheduleWorktreeIds.push(worktreeId);
    }
  }

  const totalDeleted =
    result.deletedAutoYesStateIds.length +
    result.deletedAutoYesPollerIds.length +
    result.deletedScheduleWorktreeIds.length;

  if (totalDeleted > 0) {
    console.log(
      `[resource-cleanup] Cleaned up ${totalDeleted} orphaned Map entries:`,
      {
        autoYesStates: result.deletedAutoYesStateIds.length,
        autoYesPollers: result.deletedAutoYesPollerIds.length,
        schedules: result.deletedScheduleWorktreeIds.length,
      }
    );
  }

  return result;
}

// =============================================================================
// Orchestrator
// =============================================================================

/**
 * Run the complete cleanup cycle.
 * Executes both MCP process cleanup and Map entry cleanup.
 */
async function runCleanupCycle(): Promise<void> {
  try {
    await cleanupOrphanedMcpProcesses();
  } catch (error) {
    console.warn('[resource-cleanup] MCP cleanup error:', error);
  }

  try {
    cleanupOrphanedMapEntries();
  } catch (error) {
    console.warn('[resource-cleanup] Map cleanup error:', error);
  }
}

/**
 * Initialize resource cleanup.
 * Starts a periodic timer that runs the cleanup cycle every CLEANUP_INTERVAL_MS.
 * Prevents duplicate timers via globalThis.__resourceCleanupTimerId check.
 */
export function initResourceCleanup(): void {
  if (globalThis.__resourceCleanupTimerId !== undefined) {
    console.log('[resource-cleanup] Already initialized, skipping');
    return;
  }

  // Run initial cleanup
  void runCleanupCycle();

  // Start periodic timer
  globalThis.__resourceCleanupTimerId = setInterval(() => {
    void runCleanupCycle();
  }, CLEANUP_INTERVAL_MS);

  console.log('[resource-cleanup] Initialized (interval: 24h)');
}

/**
 * Stop resource cleanup.
 * Clears the periodic timer.
 */
export function stopResourceCleanup(): void {
  if (globalThis.__resourceCleanupTimerId !== undefined) {
    clearInterval(globalThis.__resourceCleanupTimerId);
    globalThis.__resourceCleanupTimerId = undefined;
    console.log('[resource-cleanup] Stopped');
  }
}
