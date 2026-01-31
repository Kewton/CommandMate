/**
 * Status Command
 * Issue #96: npm install CLI support
 * Display CommandMate server status
 */

import { join } from 'path';
import { ExitCode } from '../types';
import { CLILogger } from '../utils/logger';
import { DaemonManager } from '../utils/daemon';

const logger = new CLILogger();
const PID_FILE = join(process.cwd(), '.commandmate.pid');

/**
 * Execute status command
 */
export async function statusCommand(): Promise<void> {
  try {
    const daemonManager = new DaemonManager(PID_FILE);
    const status = await daemonManager.getStatus();

    console.log('');
    console.log('CommandMate Status');
    console.log('==================');

    if (status === null) {
      console.log('Status:  Stopped (no PID file)');
      process.exit(ExitCode.SUCCESS);
      return;
    }

    if (!status.running) {
      console.log('Status:  Not running (stale PID file)');
      console.log('');
      console.log('Run "commandmate start" to start the server');
      process.exit(ExitCode.SUCCESS);
      return;
    }

    console.log(`Status:  Running (PID: ${status.pid})`);

    if (status.port) {
      console.log(`Port:    ${status.port}`);
    }

    if (status.uptime !== undefined) {
      console.log(`Uptime:  ${CLILogger.formatDuration(status.uptime)}`);
    }

    if (status.url) {
      console.log(`URL:     ${status.url}`);
    }

    console.log('');

    process.exit(ExitCode.SUCCESS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Status check failed: ${message}`);
    process.exit(ExitCode.UNEXPECTED_ERROR);
  }
}
