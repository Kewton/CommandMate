/**
 * Start Command
 * Issue #96: npm install CLI support
 * Issue #125: Use getEnvPath and getPidFilePath for correct path resolution
 * Start CommandMate server
 */

import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { config as dotenvConfig } from 'dotenv';
import { StartOptions, ExitCode, getErrorMessage } from '../types';
import { CLILogger } from '../utils/logger';
import { DaemonManager } from '../utils/daemon';
import { logSecurityEvent } from '../utils/security-logger';
import { getPackageRoot } from '../utils/paths';
import { getEnvPath, getPidFilePath } from '../utils/env-setup';

const logger = new CLILogger();

/**
 * Execute start command
 * Issue #125: Use getEnvPath and getPidFilePath for correct path resolution
 */
export async function startCommand(options: StartOptions): Promise<void> {
  try {
    // Issue #125: Check for .env file at correct location
    const envPath = getEnvPath();
    const pidFilePath = getPidFilePath();

    if (!existsSync(envPath)) {
      logger.error(`.env file not found at ${envPath}`);
      logger.info('Run "commandmate init" to create a configuration file');
      process.exit(ExitCode.CONFIG_ERROR);
      return;
    }

    const daemonManager = new DaemonManager(pidFilePath);

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
        const message = getErrorMessage(error);
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

    // Issue #125: Load .env file from correct location (same as daemon mode)
    const envResult = dotenvConfig({ path: envPath });

    if (envResult.error) {
      logger.warn(`Failed to load .env file at ${envPath}: ${envResult.error.message}`);
      logger.info('Continuing with existing environment variables');
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

    // Issue #125: Security warnings for external access
    const bindAddress = env.CM_BIND || '127.0.0.1';
    const authToken = env.CM_AUTH_TOKEN;

    if (bindAddress === '0.0.0.0') {
      logger.warn('WARNING: Server is accessible from external networks (CM_BIND=0.0.0.0)');

      if (!authToken) {
        logger.warn('SECURITY WARNING: No authentication token configured. External access is not recommended without CM_AUTH_TOKEN.');
        logger.info('Run "commandmate init" to configure a secure authentication token.');
      }
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
    const message = getErrorMessage(error);
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
