/**
 * PID / Daemon State File Manager
 * Issue #96: npm install CLI support
 * Issue #136: Phase 2 - Task 2.4 - Added factory functions for Issue number support
 * Issue #1354/#1355/#1358: the file now records the daemon's version, effective settings, and
 *   a process-identity signature, not just the PID. See DaemonState.
 * Issue #1632: the file is written in a hybrid format (bare PID on line 1, JSON on line 2) so
 *   that CLIs predating #1354 can still recover the PID from it. See formatState().
 * SF-1: SRP - Separated from daemon.ts for single responsibility
 * MF-SEC-2: TOCTOU protection with O_EXCL atomic writes
 */

import {
  existsSync,
  readFileSync,
  unlinkSync,
  openSync,
  writeSync,
  closeSync,
  constants,
} from 'fs';
import { PidPathResolver } from './resource-resolvers';
import { getProcessStartTime, ProcessStartTimeReader } from './process-inspector';

/**
 * The daemon state persisted alongside the PID.
 *
 * Only `pid` is guaranteed: files written by older versions held just the PID as a bare integer,
 * so every other field is optional and readState() tolerates their absence (backward compat).
 */
export interface DaemonState {
  /** Process ID of the daemon */
  pid: number;
  /** Package version the daemon was started with (Issue #1354) */
  version?: string;
  /** Effective port the server listens on (Issue #1355) */
  port?: number;
  /** Effective bind address, as configured (Issue #1355) */
  bind?: string;
  /** Effective protocol the server speaks (Issue #1355) */
  protocol?: 'http' | 'https';
  /** Whether token authentication was enabled at startup (Issue #1355) */
  auth?: boolean;
  /** ISO timestamp of when this record was written */
  startedAt?: string;
  /** OS-reported process start time, used to detect PID reuse (Issue #1358) */
  startTime?: string;
}

/**
 * Serialize the state in the hybrid format (Issue #1632).
 *
 * ```
 * 84890
 * {"pid":84890,"version":"0.18.0","port":3000,...}
 * ```
 *
 * The path of this file has never changed, so a CLI predating #1354 that is still on PATH
 * (a stale `npm install -g`) reads whatever the current daemon wrote. Those CLIs parse it as
 * `parseInt(readFileSync(...).trim(), 10)`, which returned NaN for a leading `{` and made them
 * report "Stopped (no PID file)" for a perfectly healthy server. `parseInt` stops at the first
 * non-digit, so putting the bare PID on line 1 restores that forward compatibility.
 *
 * The JSON is always exactly one line: JSON.stringify escapes control characters inside
 * strings, so it can never emit a raw newline of its own.
 */
function formatState(state: DaemonState): string {
  return `${state.pid}\n${JSON.stringify(state)}\n`;
}

/**
 * Parse the (already trimmed, non-empty) contents of a state file in any format it has had.
 *
 * @returns The daemon state, or null when nothing usable could be parsed
 */
function parseState(content: string): DaemonState | null {
  const firstBreak = content.indexOf('\n');
  // .trim() also drops the \r of a CRLF file, which /^\d+$/ would otherwise reject.
  const head = (firstBreak === -1 ? content : content.slice(0, firstBreak)).trim();

  if (/^\d+$/.test(head)) {
    const pid = parseInt(head, 10);
    if (pid <= 0) {
      return null;
    }

    const body = firstBreak === -1 ? '' : content.slice(firstBreak + 1).trim();
    if (body.length === 0) {
      // Pre-#1354 format: the file held only the PID.
      return { pid };
    }

    // Hybrid format (#1632): line 2 carries the full state. Line 1 is the fallback, so a
    // truncated or corrupt JSON body still yields a usable PID instead of "no PID file".
    return parseJsonState(body) ?? { pid };
  }

  // #1354..#1632 format: the whole file is the JSON state.
  return parseJsonState(content);
}

/**
 * Parse a JSON state object, rejecting anything without a usable PID.
 */
function parseJsonState(json: string): DaemonState | null {
  let parsed: Partial<DaemonState>;
  try {
    parsed = JSON.parse(json) as Partial<DaemonState>;
  } catch {
    return null;
  }

  if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
    return null;
  }
  return parsed as DaemonState;
}

/**
 * PID file manager for daemon process tracking
 */
export class PidManager {
  /**
   * @param pidFilePath - Path to the state file for this server
   * @param readStartTime - Injectable process-identity reader (Issue #1358); defaults to `ps`.
   *   Overridden in tests to avoid spawning a real process.
   */
  constructor(
    private readonly pidFilePath: string,
    private readonly readStartTime: ProcessStartTimeReader = getProcessStartTime
  ) {}

  /**
   * Check if the state file exists
   */
  exists(): boolean {
    return existsSync(this.pidFilePath);
  }

  /**
   * Read the daemon state from file.
   *
   * Understands all three formats this file has ever had (Issue #1632):
   * - hybrid (current): bare PID on line 1, JSON state on line 2
   * - JSON only (#1354 .. #1632): the full state as one JSON object
   * - bare integer (pre-#1354): just the PID, returned as `{ pid }`
   *
   * Reading the JSON of the hybrid format is not optional: falling back to the line-1 PID
   * would silently drop `version`, disabling the CLI↔server version mismatch warning added
   * by #1354, and drop `port`/`protocol`/`bind`, sending status back to re-deriving the URL
   * from a possibly-diverged .env (#1355).
   *
   * @returns The daemon state, or null when the file is missing or invalid
   */
  readState(): DaemonState | null {
    if (!this.exists()) {
      return null;
    }

    try {
      const content = readFileSync(this.pidFilePath, 'utf-8').trim();
      if (content.length === 0) {
        return null;
      }
      return parseState(content);
    } catch {
      return null;
    }
  }

  /**
   * Read PID from the state file
   * @returns PID number or null if file doesn't exist or is invalid
   */
  readPid(): number | null {
    return this.readState()?.pid ?? null;
  }

  /**
   * Write the daemon state to file atomically
   * MF-SEC-2: Uses O_EXCL to prevent TOCTOU race conditions
   * Issue #1632: written in the hybrid format (see formatState)
   *
   * @returns true if successful, false if file already exists
   * @throws Error for other filesystem errors
   */
  writeState(state: DaemonState): boolean {
    try {
      // O_EXCL: Fail if file already exists (atomic check-and-create)
      const fd = openSync(
        this.pidFilePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600
      );

      try {
        writeSync(fd, formatState(state));
        return true;
      } finally {
        closeSync(fd);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        // File already exists - another process is likely running
        return false;
      }
      throw err;
    }
  }

  /**
   * Read a live process's start-time signature via the injected reader.
   * Used by start() to record the daemon's identity at launch (Issue #1358).
   *
   * @param pid - Process ID to inspect
   * @returns The start-time signature, or null when it cannot be read
   */
  getStartTime(pid: number): string | null {
    return this.readStartTime(pid);
  }

  /**
   * Remove the state file
   */
  removePid(): void {
    if (this.exists()) {
      try {
        unlinkSync(this.pidFilePath);
      } catch {
        // Ignore errors during cleanup
      }
    }
  }

  /**
   * Check if the process recorded in the state file is the daemon we started.
   * NTH-1: ISP - Lightweight process check API
   *
   * Issue #1358: `process.kill(pid, 0)` alone only proves the PID is in use. When the state
   * records a start-time signature, the live process's is compared to catch PID reuse; a
   * mismatch is treated as not-running so stop() never kills, and start() never defers to, an
   * unrelated process. EPERM (the PID was reused by a process we don't own) is likewise treated
   * as stale rather than thrown, so a reused PID no longer crashes the command.
   *
   * @returns true if the daemon is running, false otherwise
   */
  isProcessRunning(): boolean {
    const state = this.readState();
    if (state === null) {
      return false;
    }

    try {
      // Sending signal 0 checks if process exists without killing it
      process.kill(state.pid, 0);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        // Process not found
        return false;
      }
      if (code === 'EPERM') {
        // Issue #1358: the PID now belongs to a process we don't own — i.e. it was reused by
        // an unrelated (possibly other-user) process. Treat as stale, not an error.
        return false;
      }
      // Other, genuinely unexpected errors still surface
      throw err;
    }

    // Issue #1358: the PID exists, but on a long-running machine the OS may have reused it for
    // an unrelated process after our daemon died. If we recorded the start time, verify the live
    // process still has it. A null reading (no `ps`, etc.) leaves the best-effort answer intact.
    if (state.startTime) {
      const current = this.readStartTime(state.pid);
      if (current !== null && current !== state.startTime) {
        return false;
      }
    }

    return true;
  }
}

/**
 * Factory function to create PidManager instance
 * Issue #136: Uses PidPathResolver for path resolution
 *
 * @param issueNo - Optional issue number for worktree-specific PID
 * @returns PidManager instance
 *
 * @example
 * ```typescript
 * // Main server PID manager
 * const mainManager = createPidManager();
 *
 * // Worktree-specific PID manager
 * const issueManager = createPidManager(135);
 * ```
 */
export function createPidManager(issueNo?: number): PidManager {
  const resolver = new PidPathResolver();
  const pidPath = resolver.resolve(issueNo);
  return new PidManager(pidPath);
}

/**
 * Factory function to create PidManager for a specific issue
 * Issue #136: Convenience function for worktree PID management
 *
 * @param issueNo - Issue number
 * @returns PidManager instance for the specified issue
 *
 * @example
 * ```typescript
 * const manager = createIssuePidManager(135);
 * if (manager.isProcessRunning()) {
 *   console.log('Worktree server for issue #135 is running');
 * }
 * ```
 */
export function createIssuePidManager(issueNo: number): PidManager {
  return createPidManager(issueNo);
}
