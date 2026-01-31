/**
 * Start Command
 * Issue #96: npm install CLI support
 * Start CommandMate server
 */

import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';
import { StartOptions, ExitCode } from '../types';
import { CLILogger } from '../utils/logger';
import { DaemonManager } from '../utils/daemon';
import { logSecurityEvent } from '../utils/security-logger';
import { getPackageRoot } from '../utils/paths';

const logger = new CLILogger();
const PID_FILE = join(process.cwd(), '.commandmate.pid');

/**
 * Execute start command
 */
export async function startCommand(options: StartOptions): Promise<void> {
  try {
    // Check for .env file
    const envPath = join(process.cwd(), '.env');
    if (!existsSync(envPath)) {
      logger.error('.env file not found');
      logger.info('Run "commandmate init" to create a configuration file');
      process.exit(ExitCode.CONFIG_ERROR);
      return;
    }

    const daemonManager = new DaemonManager(PID_FILE);

    // Daemon mode
    if (options.daemon) {
      // Check if already running
      if (await daemonManager.isRunning()) {
        const status = await daemonManager.getStatus();
        logger.error(`Server is already running (PID: ${status?.pid})`);
        process.exit(ExitCode.START_FAILED);
        return;
      }

      logger.info('Starting server in background...');

      try {
        const pid = await daemonManager.start({
          dev: options.dev,
          port: options.port,
        });

        logger.success(`Server started in background (PID: ${pid})`);

        const port = options.port || parseInt(process.env.CM_PORT || '3000', 10);
        const bind = process.env.CM_BIND || '127.0.0.1';
        const url = `http://${bind === '0.0.0.0' ? '127.0.0.1' : bind}:${port}`;
        logger.info(`URL: ${url}`);

        logSecurityEvent({
          timestamp: new Date().toISOString(),
          command: 'start',
          action: 'success',
          details: `Daemon started (PID: ${pid})`,
        });

        process.exit(ExitCode.SUCCESS);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to start daemon: ${message}`);

        logSecurityEvent({
          timestamp: new Date().toISOString(),
          command: 'start',
          action: 'failure',
          details: message,
        });

        process.exit(ExitCode.START_FAILED);
      }
      return;
    }

    // Foreground mode (default)
    const npmScript = options.dev ? 'dev' : 'start';
    logger.info(`Starting server in foreground (${options.dev ? 'development' : 'production'} mode)...`);

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (options.port) {
      env.CM_PORT = String(options.port);
    }

    // Use package installation directory, not current working directory
    const packageRoot = getPackageRoot();

    const child = spawn('npm', ['run', npmScript], {
      cwd: packageRoot,
      env,
      stdio: 'inherit',
    });

    child.on('error', (err) => {
      logger.error(`Failed to start server: ${err.message}`);

      logSecurityEvent({
        timestamp: new Date().toISOString(),
        command: 'start',
        action: 'failure',
        details: err.message,
      });

      process.exit(ExitCode.START_FAILED);
    });

    child.on('close', (code) => {
      const exitCode = code ?? 0;

      logSecurityEvent({
        timestamp: new Date().toISOString(),
        command: 'start',
        action: exitCode === 0 ? 'success' : 'failure',
        details: `Server exited with code ${exitCode}`,
      });

      process.exit(exitCode);
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Start failed: ${message}`);

    logSecurityEvent({
      timestamp: new Date().toISOString(),
      command: 'start',
      action: 'failure',
      details: message,
    });

    process.exit(ExitCode.UNEXPECTED_ERROR);
  }
}
