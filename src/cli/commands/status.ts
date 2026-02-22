/**
 * Status Command
 * Issue #96: npm install CLI support
 * Issue #125: Use getPidFilePath and load .env for correct settings display
 * Issue #136: Add --issue and --all flags for worktree-specific status
 * Display CommandMate server status
 */

import { config as dotenvConfig } from 'dotenv';
import { readdirSync } from 'fs';
import { ExitCode, getErrorMessage, StatusOptions } from '../types';
import { CLILogger } from '../utils/logger';
import { DaemonManager } from '../utils/daemon';
import { getPidFilePath, getEnvPath, getPidsDir } from '../utils/env-setup';
import { validateIssueNoResult } from '../utils/input-validators';

const logger = new CLILogger();

/**
 * Show status for a single server (main or issue-specific)
 */
async function showSingleStatus(issueNo?: number): Promise<void> {
  const pidFilePath = getPidFilePath(issueNo);
  const envPath = getEnvPath(issueNo);

  // Load .env so getStatus() can access correct CM_PORT and CM_BIND values
  dotenvConfig({ path: envPath });

  const daemonManager = new DaemonManager(pidFilePath);
  const status = await daemonManager.getStatus();

  const serverLabel = issueNo !== undefined
    ? `Issue #${issueNo}`
    : 'Main Server';

  console.log('');
  console.log(`CommandMate Status - ${serverLabel}`);
  console.log('='.repeat(40));

  if (status === null) {
    console.log('Status:  Stopped (no PID file)');
    return;
  }

  if (!status.running) {
    console.log('Status:  Not running (stale PID file)');
    console.log('');
    const startCmd = issueNo !== undefined
      ? `commandmate start --issue ${issueNo}`
      : 'commandmate start';
    console.log(`Run "${startCmd}" to start the server`);
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
}

/**
 * Show status for all servers (main + all worktrees)
 * Issue #136: --all flag support
 */
async function showAllStatus(): Promise<void> {
  // Show main server status
  await showSingleStatus();

  // Check for worktree PID files
  try {
    const pidsDir = getPidsDir();
    const files = readdirSync(pidsDir).filter(f => f.endsWith('.pid'));

    for (const file of files) {
      const issueNo = parseInt(file.replace('.pid', ''), 10);
      if (!isNaN(issueNo)) {
        await showSingleStatus(issueNo);
      }
    }
  } catch {
    // pids directory may not exist yet
  }

  console.log('');
}

/**
 * Execute status command
 * Issue #125: Use getPidFilePath and load .env for correct settings display
 * Issue #136: Support --issue and --all flags
 */
export async function statusCommand(options: StatusOptions = {}): Promise<void> {
  try {
    // Issue #136: Handle --all flag
    if (options.all) {
      await showAllStatus();
      process.exit(ExitCode.SUCCESS);
      return;
    }

    // Issue #136: Validate issue number if provided
    if (options.issue !== undefined) {
      const validation = validateIssueNoResult(options.issue);
      if (!validation.valid) {
        logger.error(`Invalid issue number: ${validation.error}`);
        process.exit(ExitCode.UNEXPECTED_ERROR);
        return;
      }
    }

    // Issue #125: Get PID file path and load .env for correct settings
    // Issue #136: Use issue number for worktree-specific PID file
    const pidFilePath = getPidFilePath(options.issue);
    const envPath = getEnvPath(options.issue);

    // Load .env so getStatus() can access correct CM_PORT and CM_BIND values
    dotenvConfig({ path: envPath });

    const daemonManager = new DaemonManager(pidFilePath);
    const status = await daemonManager.getStatus();

    const serverLabel = options.issue !== undefined
      ? `Issue #${options.issue}`
      : 'Main Server';

    console.log('');
    console.log(`CommandMate Status - ${serverLabel}`);
    console.log('='.repeat(40));

    if (status === null) {
      console.log('Status:  Stopped (no PID file)');
      process.exit(ExitCode.SUCCESS);
      return;
    }

    if (!status.running) {
      console.log('Status:  Not running (stale PID file)');
      console.log('');
      const startCmd = options.issue !== undefined
        ? `commandmate start --issue ${options.issue}`
        : 'commandmate start';
      console.log(`Run "${startCmd}" to start the server`);
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

    // Issue #332: Show IP restriction status
    if (process.env.CM_ALLOWED_IPS) {
      console.log(`IP ACL:  ${process.env.CM_ALLOWED_IPS}`);
    }

    console.log('');

    process.exit(ExitCode.SUCCESS);
  } catch (error) {
    const message = getErrorMessage(error);
    logger.error(`Status check failed: ${message}`);
    process.exit(ExitCode.UNEXPECTED_ERROR);
  }
}
