/**
 * Daemon Process Manager
 * Issue #96: npm install CLI support
 * Issue #125: Added .env loading and security warnings
 * SF-1: SRP - Process management only (PID handling delegated to PidManager)
 */

import { spawn } from 'child_process';
import { config as dotenvConfig } from 'dotenv';
import { DaemonStatus, StartOptions } from '../types';
import { DaemonState, PidManager } from './pid-manager';
import { getPackageRoot } from './paths';
import { getEnvPath } from './env-setup';
import { readPackageVersion } from './package-info';
import { REVERSE_PROXY_WARNING } from '../config/security-messages';
import { CLILogger } from './logger';
import { loadEffectiveEnv, resolveServerEndpoint, ServerEnv } from './server-url';
import { isPortInUse } from './server-ready';

/** How long stop() waits for the server's process group after SIGTERM before escalating. */
export const STOP_GRACE_TIMEOUT_MS = 10000;

/** How long stop() waits for the process group after SIGKILL. */
export const STOP_KILL_TIMEOUT_MS = 3000;

/** How long stop() waits for the recorded port to be released once the group is gone. */
export const PORT_RELEASE_TIMEOUT_MS = 3000;

/**
 * Whether a signal can be delivered to `target` (a PID, or a negated PGID).
 * EPERM means it exists but belongs to someone else, which still counts as alive.
 */
function signalTargetExists(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Issue #3087: whether any process of the group the daemon was spawned into is still alive.
 *
 * `start()` spawns with `detached: true`, so the recorded PID is a process-group leader and the
 * server it launches (npm → node server.js) inherits that PGID. A PGID is not reused while any
 * member is alive, so a live group with the recorded ID is ours even after the leader exited.
 */
function processGroupExists(pid: number): boolean {
  return pid > 1 && signalTargetExists(-pid);
}

/**
 * Issue #3087: signal the whole process group, not just the recorded PID.
 *
 * The recorded PID is npm's, and npm does not reliably forward signals to the server it runs
 * (observed on Linux), so `kill(pid)` alone left the server listening as an orphan. Falls back
 * to the bare PID when no such group exists (e.g. a server that is not a group leader).
 */
function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  // Never negate 0 or 1: kill(0) signals our own group and kill(-1) every process we may signal.
  if (pid <= 1) {
    throw new Error(`Refusing to signal invalid PID ${pid}`);
  }
  try {
    process.kill(-pid, signal);
    return;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw err;
    }
  }
  try {
    process.kill(pid, signal);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw err;
    }
  }
}

/**
 * Daemon manager for background server process
 */
export class DaemonManager {
  private pidManager: PidManager;
  private logger: CLILogger;
  private envPath?: string;
  private effectiveEnv?: ServerEnv;

  /**
   * @param pidFilePath - PID file for this server
   * @param envPath - Issue #1266: the worktree .env this server runs with, so getStatus()
   *   reports the port it actually listens on; omit for the main server
   */
  constructor(pidFilePath: string, envPath?: string) {
    this.pidManager = new PidManager(pidFilePath);
    this.logger = new CLILogger();
    this.envPath = envPath;
  }

  /**
   * The configuration this server runs with, with .env taking precedence over exported
   * variables exactly as start() hands it to the child process (Issue #1266).
   *
   * Read once per manager: a .env cannot change within a single CLI invocation, and reading
   * it again would emit dotenv's banner a second time.
   */
  getEffectiveEnv(): ServerEnv {
    this.effectiveEnv ??= loadEffectiveEnv(this.envPath);
    return this.effectiveEnv;
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

    // SF-003: Remove CLAUDECODE from env object to prevent nested session detection
    // Uses env object (not process.env) to avoid global side effects (DIP)
    delete env.CLAUDECODE;

    // Command line options override .env values
    if (options.port) {
      env.CM_PORT = String(options.port);
    }

    // Issue #136: Set DB path for worktree servers
    if (options.dbPath) {
      env.CM_DB_PATH = options.dbPath;
    }

    // Issue #331: Forward auth and HTTPS environment variables from parent process to daemon.
    // These are set by startCommand before calling daemon.start().
    // Issue #332: Added CM_ALLOWED_IPS, CM_TRUST_PROXY for IP restriction in daemon mode
    const authEnvKeys = ['CM_AUTH_TOKEN_HASH', 'CM_AUTH_EXPIRE', 'CM_HTTPS_CERT', 'CM_HTTPS_KEY', 'CM_ALLOW_HTTP', 'CM_ALLOWED_IPS', 'CM_TRUST_PROXY'] as const;
    for (const key of authEnvKeys) {
      if (process.env[key]) {
        env[key] = process.env[key];
      }
    }

    // Issue #179: Security warning for external access - recommend reverse proxy
    const bindAddress = env.CM_BIND || '127.0.0.1';
    const port = env.CM_PORT || '3000';
    // Issue #1266: server.ts:160 needs both cert and key to serve HTTPS; announcing https on
    // a lone cert told the user to visit a scheme the child does not speak. The bind address
    // is logged as configured, so this deliberately does not reuse resolveServerEndpoint().
    const protocol = env.CM_HTTPS_CERT && env.CM_HTTPS_KEY ? 'https' : 'http';

    // Issue #332: Suppress warning when CM_ALLOWED_IPS is set (IP restriction provides access control)
    if (bindAddress === '0.0.0.0' && !env.CM_AUTH_TOKEN_HASH && !env.CM_ALLOWED_IPS) {
      console.log(REVERSE_PROXY_WARNING);
    }

    // Issue #3087: refuse to launch onto a port something else already answers on. The new
    // server would fail to listen and exit, while every later TCP check (status, remote's
    // readiness wait) would be answered by that other process and mistake it for this server.
    const probeHost = bindAddress === '0.0.0.0' ? '127.0.0.1' : bindAddress;
    if (await isPortInUse(probeHost, parseInt(port, 10))) {
      throw new Error(
        `Port ${port} on ${probeHost} is already in use by another process ` +
          '(not the server recorded in the PID file, e.g. an earlier server left running). ' +
          'Stop that process or choose another port.'
      );
    }

    // Log startup with accurate settings (Stage 4 review: MF-2)
    this.logger.info(`Starting server at ${protocol}://${bindAddress}:${port}`);

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

    // Issue #1354/#1355/#1358: persist the daemon's version, effective settings, and a
    // process-identity signature so status/stop/start can report and verify the actual server,
    // not re-derive it from a possibly-diverged .env. The port/protocol/auth recorded here are
    // exactly what start() handed the child above.
    const state: DaemonState = {
      pid,
      version: readPackageVersion(),
      port: parseInt(port, 10),
      bind: bindAddress,
      protocol,
      auth: !!env.CM_AUTH_TOKEN_HASH,
      startedAt: new Date().toISOString(),
      startTime: this.pidManager.getStartTime(pid) ?? undefined,
    };

    // Write state file atomically
    if (!this.pidManager.writeState(state)) {
      // Failed to write state - another process may have started
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
   *
   * Issue #3087: signals the daemon's whole process group, waits for every member to exit
   * (escalating to SIGKILL after {@link STOP_GRACE_TIMEOUT_MS}), and then requires the recorded
   * port to be free. "Stopped" is reported only when both hold. A recorded leader that already
   * exited while its group lives on (the orphaned server of #3087) is stopped the same way.
   *
   * @param force Use SIGKILL instead of SIGTERM
   * @returns true if stopped (or the PID file was stale), false if not running or not stopped
   */
  async stop(force: boolean = false): Promise<boolean> {
    const state = this.pidManager.readState();

    if (state === null) {
      return false;
    }

    const pid = state.pid;
    const signal: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM';

    if (!this.pidManager.isProcessRunning()) {
      // The leader is gone. Only when its PID is entirely unused (not reused by an unrelated
      // process) can a live group with that ID be the server it left behind.
      const orphanedGroup = !signalTargetExists(pid) && processGroupExists(pid);
      if (!orphanedGroup) {
        // Process not running - clean up stale PID file
        this.pidManager.removePid();
        return true;
      }
      this.logger.warn(
        `The recorded process ${pid} has exited but its server processes are still running; stopping them.`
      );
    }

    try {
      const exited = await this.terminateGroup(pid, signal);
      if (!exited) {
        this.logger.warn(`Process group ${pid} did not exit.`);
        return false;
      }

      // Clean up PID file: nothing this file describes is alive any more.
      this.pidManager.removePid();

      return await this.waitForPortRelease(state);
    } catch {
      return false;
    }
  }

  /**
   * Signal the daemon's process group and wait until no member is left.
   *
   * @returns true once the group is gone, false if it outlived SIGKILL
   */
  private async terminateGroup(pid: number, signal: NodeJS.Signals): Promise<boolean> {
    signalProcessGroup(pid, signal);
    if (await this.waitForExit(pid, signal === 'SIGKILL' ? STOP_KILL_TIMEOUT_MS : STOP_GRACE_TIMEOUT_MS)) {
      return true;
    }
    if (signal === 'SIGKILL') {
      return false;
    }
    this.logger.warn(
      `Server (process group ${pid}) did not exit within ${STOP_GRACE_TIMEOUT_MS / 1000}s; sending SIGKILL.`
    );
    signalProcessGroup(pid, 'SIGKILL');
    return this.waitForExit(pid, STOP_KILL_TIMEOUT_MS);
  }

  /**
   * Issue #3087: confirm the port the server was started on is free again.
   *
   * A state file from before #1354 records no port; re-deriving one from a .env that may have
   * changed since could blame an unrelated listener, so that legacy case is not checked.
   *
   * @returns true when the port is free (or unknown), false if something still listens on it
   */
  private async waitForPortRelease(state: DaemonState): Promise<boolean> {
    if (state.port === undefined) {
      return true;
    }
    const bind = state.bind ?? '127.0.0.1';
    const host = bind === '0.0.0.0' ? '127.0.0.1' : bind;
    const deadline = Date.now() + PORT_RELEASE_TIMEOUT_MS;

    for (;;) {
      if (!(await isPortInUse(host, state.port, 500))) {
        return true;
      }
      if (Date.now() >= deadline) {
        this.logger.warn(
          `Port ${state.port} on ${host} is still in use after the server stopped; ` +
            'another process is listening on it.'
        );
        return false;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  /**
   * Get daemon status
   * @returns Status object or null if no PID file
   */
  async getStatus(): Promise<DaemonStatus | null> {
    const state = this.pidManager.readState();

    if (state === null) {
      return null;
    }

    const running = this.pidManager.isProcessRunning();

    if (!running) {
      return { running: false };
    }

    let port: number;
    let url: string;

    if (state.port !== undefined) {
      // Issue #1355: report the effective settings the server was started with, recorded in the
      // state file, rather than re-deriving them from a .env that may have changed since.
      port = state.port;
      const protocol = state.protocol ?? 'http';
      const bind = state.bind ?? '127.0.0.1';
      const host = bind === '0.0.0.0' ? '127.0.0.1' : bind;
      url = `${protocol}://${host}:${port}`;
    } else {
      // Legacy state file (PID only, e.g. a daemon started before this change): fall back to
      // Issue #1266's .env resolution, which gives .env precedence exactly as start() does.
      const resolved = resolveServerEndpoint(this.getEffectiveEnv());
      port = resolved.port;
      url = resolved.url;
    }

    // Note: Getting accurate uptime would require storing start time
    // For now, we don't track uptime

    return {
      running: true,
      pid: state.pid,
      port,
      url,
      // Issue #1354: surface the version the daemon actually runs, so status can flag a stale
      // daemon of a different version than the installed CLI.
      version: state.version,
      protocol: state.protocol,
      auth: state.auth,
      // Issue #2113: lets status tell a record written by THIS daemon from one left by an
      // earlier daemon on the same port.
      startedAt: state.startedAt,
    };
  }

  /**
   * Check if daemon is running
   */
  async isRunning(): Promise<boolean> {
    return this.pidManager.isProcessRunning();
  }

  /**
   * Wait until neither the recorded PID nor any member of its process group is alive
   * (Issue #3087: the group, because the server outlives npm).
   *
   * @returns true if everything exited within the timeout
   */
  private async waitForExit(pid: number, timeout: number): Promise<boolean> {
    const startTime = Date.now();
    const checkInterval = 100;

    for (;;) {
      if (!signalTargetExists(pid) && !processGroupExists(pid)) {
        return true;
      }
      if (Date.now() - startTime >= timeout) {
        return false;
      }
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
  }
}
