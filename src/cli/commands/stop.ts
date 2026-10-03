/**
 * Stop Command
 * Issue #96: npm install CLI support
 * Issue #125: Use getPidFilePath for correct path resolution
 * Issue #136: Add --issue flag for worktree-specific server stop
 * Stop CommandMate server
 */

import { StopOptions, ExitCode, getErrorMessage } from '../types';
import { CLILogger } from '../utils/logger';
import { DaemonManager } from '../utils/daemon';
import { logSecurityEvent } from '../utils/security-logger';
import { getPidFilePath } from '../utils/env-setup';
import { validateIssueNoResult } from '../utils/input-validators';
import { isPortInUse } from '../utils/server-ready';
import { resolveServerEndpoint } from '../utils/server-url';
import { describeListeners } from '../utils/process-inspect';

const logger = new CLILogger();

/**
 * Issue #3087: with nothing recorded to stop, make sure nothing answers on the configured port
 * either. A server whose PID file is gone (an orphan from an earlier start, or a file removed by
 * a failed run) still serves there, and "Status: Stopped" would be false. Such a process cannot
 * be proven to be ours, so it is reported, never killed.
 *
 * Only the main server's .env port is known here; a worktree server's port is not re-derived.
 *
 * @returns true when the configured port is free
 */
async function ensureConfiguredPortFree(daemonManager: DaemonManager, serverLabel: string): Promise<boolean> {
  const endpoint = resolveServerEndpoint(daemonManager.getEffectiveEnv());
  const host = endpoint.bind === '0.0.0.0' ? '127.0.0.1' : endpoint.bind;
  if (!(await isPortInUse(host, endpoint.port))) {
    return true;
  }
  const listeners = describeListeners(endpoint.port);
  logger.error(
    `${serverLabel} has no running process on record, but something is answering on ${host}:${endpoint.port}` +
      `${listeners ? `: ${listeners}` : ''}.`
  );
  logger.info(
    'It was not started through this PID file, so it was not stopped. ' +
      'If it is an earlier CommandMate server, stop it yourself (e.g. kill <PID>).'
  );
  logSecurityEvent({
    timestamp: new Date().toISOString(),
    command: 'stop',
    action: 'failure',
    details: `Unrecorded listener on port ${endpoint.port}${listeners ? ` (${listeners})` : ''}`,
  });
  return false;
}

/**
 * Execute stop command
 * Issue #125: Use getPidFilePath for correct path resolution
 * Issue #136: Support --issue flag for worktree-specific server stop
 */
export async function stopCommand(options: StopOptions): Promise<void> {
  try {
    // Issue #136: Validate issue number if provided
    if (options.issue !== undefined) {
      const validation = validateIssueNoResult(options.issue);
      if (!validation.valid) {
        logger.error(`Invalid issue number: ${validation.error}`);
        process.exit(ExitCode.STOP_FAILED);
        return;
      }
    }

    // Issue #125: Get PID file path from correct location
    // Issue #136: Use issue number for worktree-specific PID file
    const pidFilePath = getPidFilePath(options.issue);
    const daemonManager = new DaemonManager(pidFilePath);

    // Issue #136: Show which server we're stopping
    const serverLabel = options.issue !== undefined
      ? `Issue #${options.issue} server`
      : 'Main server';

    // Check if running
    if (!(await daemonManager.isRunning())) {
      const status = await daemonManager.getStatus();
      if (status === null) {
        logger.info(`${serverLabel} is not running (no PID file found)`);
      } else {
        logger.info(`${serverLabel} is not running (stale PID file)`);
        // Issue #3087: the recorded npm process can be gone while the server it launched still
        // listens as an orphan. stop() finds that process group and stops it, and only reports
        // failure when something is left behind.
        if (!(await daemonManager.stop(options.force))) {
          logger.error(`Failed to stop ${serverLabel}: its processes or port are still in use`);
          logSecurityEvent({
            timestamp: new Date().toISOString(),
            command: 'stop',
            action: 'failure',
            details: `Failed to stop orphaned server of PID ${status.pid ?? 'unknown'}${options.issue !== undefined ? ` (Issue #${options.issue})` : ''}`,
          });
          process.exit(ExitCode.STOP_FAILED);
          return;
        }
      }
      if (options.issue === undefined && !(await ensureConfiguredPortFree(daemonManager, serverLabel))) {
        process.exit(ExitCode.STOP_FAILED);
        return;
      }
      if (status === null) {
        logger.info('Status: Stopped');
      }
      process.exit(ExitCode.SUCCESS);
      return;
    }

    const status = await daemonManager.getStatus();
    const pid = status?.pid;

    if (options.force) {
      logger.warn(`Force stopping ${serverLabel} (PID: ${pid})...`);

      logSecurityEvent({
        timestamp: new Date().toISOString(),
        command: 'stop',
        action: 'warning',
        details: `--force flag used (SIGKILL) on PID ${pid}${options.issue !== undefined ? ` (Issue #${options.issue})` : ''}`,
      });
    } else {
      logger.info(`Stopping ${serverLabel} (PID: ${pid})...`);
    }

    const result = await daemonManager.stop(options.force);

    if (result) {
      logger.success(`${serverLabel} stopped`);

      logSecurityEvent({
        timestamp: new Date().toISOString(),
        command: 'stop',
        action: 'success',
        details: `Server stopped (PID: ${pid})${options.issue !== undefined ? ` (Issue #${options.issue})` : ''}`,
      });

      process.exit(ExitCode.SUCCESS);
    } else {
      logger.error(`Failed to stop ${serverLabel}`);

      logSecurityEvent({
        timestamp: new Date().toISOString(),
        command: 'stop',
        action: 'failure',
        details: `Failed to stop PID ${pid}${options.issue !== undefined ? ` (Issue #${options.issue})` : ''}`,
      });

      process.exit(ExitCode.STOP_FAILED);
    }
  } catch (error) {
    const message = getErrorMessage(error);
    logger.error(`Stop failed: ${message}`);

    logSecurityEvent({
      timestamp: new Date().toISOString(),
      command: 'stop',
      action: 'failure',
      details: message,
    });

    process.exit(ExitCode.UNEXPECTED_ERROR);
  }
}
