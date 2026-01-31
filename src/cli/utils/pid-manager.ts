/**
 * PID File Manager
 * Issue #96: npm install CLI support
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
