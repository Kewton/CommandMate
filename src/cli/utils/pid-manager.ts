/**
 * PID File Manager
 * Issue #96: npm install CLI support
 * Issue #136: Phase 2 - Task 2.4 - Added factory functions for Issue number support
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

/**
 * PID file manager for daemon process tracking
 */
export class PidManager {
  constructor(private readonly pidFilePath: string) {}

  /**
   * Check if PID file exists
   */
  exists(): boolean {
    return existsSync(this.pidFilePath);
  }

  /**
   * Read PID from file
   * @returns PID number or null if file doesn't exist or is invalid
   */
  readPid(): number | null {
    if (!this.exists()) {
      return null;
    }

    try {
      const content = readFileSync(this.pidFilePath, 'utf-8').trim();
      const pid = parseInt(content, 10);

      if (isNaN(pid) || pid <= 0) {
        return null;
      }

      return pid;
    } catch {
      return null;
    }
  }

  /**
   * Write PID to file atomically
   * MF-SEC-2: Uses O_EXCL to prevent TOCTOU race conditions
   *
   * @returns true if successful, false if file already exists
   * @throws Error for other filesystem errors
   */
  writePid(pid: number): boolean {
    try {
      // O_EXCL: Fail if file already exists (atomic check-and-create)
      const fd = openSync(
        this.pidFilePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600
      );

      try {
        writeSync(fd, String(pid));
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
   * Remove PID file
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
   * Check if the process recorded in PID file is running
   * NTH-1: ISP - Lightweight process check API
   *
   * @returns true if process is running, false otherwise
   */
  isProcessRunning(): boolean {
    const pid = this.readPid();
    if (pid === null) {
      return false;
    }

    try {
      // Sending signal 0 checks if process exists without killing it
      process.kill(pid, 0);
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
        // Process not found
        return false;
      }
      // Other errors (e.g., EPERM) mean process exists but we can't signal it
      throw err;
    }
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
