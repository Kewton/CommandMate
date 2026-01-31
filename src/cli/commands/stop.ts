/**
 * Stop Command
 * Issue #96: npm install CLI support
 * Stop CommandMate server
 */

import { join } from 'path';
import { StopOptions, ExitCode } from '../types';
import { CLILogger } from '../utils/logger';
import { DaemonManager } from '../utils/daemon';
import { logSecurityEvent } from '../utils/security-logger';

const logger = new CLILogger();
const PID_FILE = join(process.cwd(), '.commandmate.pid');

/**
 * Execute stop command
 */
export async function stopCommand(options: StopOptions): Promise<void> {
  try {
    const daemonManager = new DaemonManager(PID_FILE);

    // Check if running
    if (!(await daemonManager.isRunning())) {
      const status = await daemonManager.getStatus();
      if (status === null) {
        logger.info('Server is not running (no PID file found)');
        logger.info('Status: Stopped');
      } else {
        logger.info('Server is not running (stale PID file)');
      }
      process.exit(ExitCode.SUCCESS);
      return;
    }

    const status = await daemonManager.getStatus();
    const pid = status?.pid;

    if (options.force) {
      logger.warn(`Force stopping server (PID: ${pid})...`);

      logSecurityEvent({
        timestamp: new Date().toISOString(),
        command: 'stop',
        action: 'warning',
        details: `--force flag used (SIGKILL) on PID ${pid}`,
      });
    } else {
      logger.info(`Stopping server (PID: ${pid})...`);
    }

    const result = await daemonManager.stop(options.force);

    if (result) {
      logger.success('Server stopped');

      logSecurityEvent({
        timestamp: new Date().toISOString(),
        command: 'stop',
        action: 'success',
        details: `Server stopped (PID: ${pid})`,
      });

      process.exit(ExitCode.SUCCESS);
    } else {
      logger.error('Failed to stop server');

      logSecurityEvent({
        timestamp: new Date().toISOString(),
        command: 'stop',
        action: 'failure',
        details: `Failed to stop PID ${pid}`,
      });

      process.exit(ExitCode.STOP_FAILED);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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
