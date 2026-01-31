/**
 * Daemon Process Manager
 * Issue #96: npm install CLI support
 * SF-1: SRP - Process management only (PID handling delegated to PidManager)
 */

import { spawn } from 'child_process';
import { DaemonStatus, StartOptions } from '../types';
import { PidManager } from './pid-manager';

/**
 * Daemon manager for background server process
 */
export class DaemonManager {
  private pidManager: PidManager;

  constructor(pidFilePath: string) {
    this.pidManager = new PidManager(pidFilePath);
  }

  /**
   * Start daemon process
   * @returns Process ID of the started daemon
   * @throws Error if already running
   */
  async start(options: StartOptions): Promise<number> {
    if (this.pidManager.isProcessRunning()) {
      const pid = this.pidManager.readPid();
      throw new Error(`Server is already running (PID: ${pid})`);
    }

    // Clean up stale PID file
    this.pidManager.removePid();

    const npmScript = options.dev ? 'dev' : 'start';
    const cwd = process.cwd();

    // Build environment
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (options.port) {
      env.CM_PORT = String(options.port);
    }

    // Spawn detached process
    const child = spawn('npm', ['run', npmScript], {
      cwd,
      env,
      detached: true,
      stdio: 'ignore',
    });

    // Unref to allow parent to exit
    child.unref();

    const pid = child.pid!;

    // Write PID file atomically
    if (!this.pidManager.writePid(pid)) {
      // Failed to write PID - another process may have started
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Ignore kill errors
      }
      throw new Error('Failed to write PID file - server may already be running');
    }

    return pid;
  }

  /**
   * Stop daemon process
   * @param force Use SIGKILL instead of SIGTERM
   * @returns true if stopped successfully, false if not running
   */
  async stop(force: boolean = false): Promise<boolean> {
    const pid = this.pidManager.readPid();

    if (pid === null) {
      return false;
    }

    if (!this.pidManager.isProcessRunning()) {
      // Process not running - clean up stale PID file
      this.pidManager.removePid();
      return true;
    }

    const signal = force ? 'SIGKILL' : 'SIGTERM';

    try {
      process.kill(pid, signal);

      // Wait for process to exit
      await this.waitForExit(pid, 10000);

      // Clean up PID file
      this.pidManager.removePid();

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get daemon status
   * @returns Status object or null if no PID file
   */
  async getStatus(): Promise<DaemonStatus | null> {
    const pid = this.pidManager.readPid();

    if (pid === null) {
      return null;
    }

    const running = this.pidManager.isProcessRunning();

    if (!running) {
      return { running: false };
    }

    // Get port from environment or default
    const port = parseInt(process.env.CM_PORT || '3000', 10);
    const bind = process.env.CM_BIND || '127.0.0.1';
    const url = `http://${bind === '0.0.0.0' ? '127.0.0.1' : bind}:${port}`;

    // Note: Getting accurate uptime would require storing start time
    // For now, we don't track uptime

    return {
      running: true,
      pid,
      port,
      url,
    };
  }

  /**
   * Check if daemon is running
   */
  async isRunning(): Promise<boolean> {
    return this.pidManager.isProcessRunning();
  }

  /**
   * Wait for process to exit
   */
  private async waitForExit(pid: number, timeout: number): Promise<void> {
    const startTime = Date.now();
    const checkInterval = 100;

    while (Date.now() - startTime < timeout) {
      try {
        process.kill(pid, 0);
        // Process still exists, wait
        await new Promise(resolve => setTimeout(resolve, checkInterval));
      } catch {
        // Process exited
        return;
      }
    }

    // Timeout - process may still be running
  }
}
