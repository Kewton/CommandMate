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

const logger = new CLILogger();

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
        logger.info('Status: Stopped');
      } else {
        logger.info(`${serverLabel} is not running (stale PID file)`);
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
