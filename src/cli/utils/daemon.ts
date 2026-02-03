/**
 * Daemon Process Manager
 * Issue #96: npm install CLI support
 * Issue #125: Added .env loading and security warnings
 * SF-1: SRP - Process management only (PID handling delegated to PidManager)
 */

import { spawn } from 'child_process';
import { config as dotenvConfig } from 'dotenv';
import { DaemonStatus, StartOptions } from '../types';
import { PidManager } from './pid-manager';
import { getPackageRoot } from './paths';
import { getEnvPath } from './env-setup';
import { CLILogger } from './logger';

/**
 * Daemon manager for background server process
 */
export class DaemonManager {
  private pidManager: PidManager;
  private logger: CLILogger;

  constructor(pidFilePath: string) {
    this.pidManager = new PidManager(pidFilePath);
    this.logger = new CLILogger();
  }

  /**
   * Start daemon process
   * Issue #125: Load .env file and add security warnings
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
    // Use package installation directory, not current working directory
    const packageRoot = getPackageRoot();

    // Issue #125: Load .env file from correct location
    const envPath = getEnvPath();
    const envResult = dotenvConfig({ path: envPath });

    // Handle .env loading errors with fallback (Stage 2 review: MF-2)
    if (envResult.error) {
      this.logger.warn(`Failed to load .env file at ${envPath}: ${envResult.error.message}`);
      this.logger.info('Continuing with existing environment variables');
    }

    // Build environment by merging process.env with .env values
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(envResult.parsed || {}),
    };

    // Command line options override .env values
    if (options.port) {
      env.CM_PORT = String(options.port);
    }

    // Issue #136: Set DB path for worktree servers
    if (options.dbPath) {
      env.CM_DB_PATH = options.dbPath;
    }

    // Issue #125: Security warnings for external access (Stage 4 review: MF-2)
    const bindAddress = env.CM_BIND || '127.0.0.1';
    const authToken = env.CM_AUTH_TOKEN;
    const port = env.CM_PORT || '3000';

    if (bindAddress === '0.0.0.0') {
      this.logger.warn('WARNING: Server is accessible from external networks (CM_BIND=0.0.0.0)');

      if (!authToken) {
        this.logger.warn('SECURITY WARNING: No authentication token configured. External access is not recommended without CM_AUTH_TOKEN.');
        this.logger.info('Run "commandmate init" to configure a secure authentication token.');
      }
    }

    // Log startup with accurate settings (Stage 4 review: MF-2)
    this.logger.info(`Starting server at http://${bindAddress}:${port}`);

    // Spawn detached process
    const child = spawn('npm', ['run', npmScript], {
      cwd: packageRoot,
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
