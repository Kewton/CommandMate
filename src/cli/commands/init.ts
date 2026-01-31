/**
 * Init Command
 * Issue #96: npm install CLI support
 * Initialize CommandMate configuration
 */

import { join } from 'path';
import { homedir } from 'os';
import { InitOptions, ExitCode, EnvConfig } from '../types';
import { CLILogger } from '../utils/logger';
import { PreflightChecker } from '../utils/preflight';
import { EnvSetup, ENV_DEFAULTS, sanitizePath } from '../utils/env-setup';
import { logSecurityEvent } from '../utils/security-logger';

const logger = new CLILogger();

/**
 * Execute init command
 */
export async function initCommand(options: InitOptions): Promise<void> {
  try {
    logger.header('CommandMate Init');
    logger.blank();

    // Step 1: Preflight checks
    logger.info('Checking system dependencies...');
    const preflightChecker = new PreflightChecker();
    const preflightResult = await preflightChecker.checkAll();

    // Display results
    for (const result of preflightResult.results) {
      if (result.status === 'ok') {
        logger.success(`${result.name}: ${result.version || 'OK'}`);
      } else if (result.status === 'missing') {
        logger.error(`${result.name}: Not found`);
        logger.info(`  ${PreflightChecker.getInstallHint(result.name)}`);
      } else if (result.status === 'version_mismatch') {
        logger.warn(`${result.name}: ${result.version} (minimum required version not met)`);
      }
    }

    if (!preflightResult.success) {
      logger.blank();
      logger.error('Required dependencies are missing. Please install them and try again.');

      logSecurityEvent({
        timestamp: new Date().toISOString(),
        command: 'init',
        action: 'failure',
        details: 'Preflight check failed',
      });

      process.exit(ExitCode.DEPENDENCY_ERROR);
      return;
    }

    logger.blank();
    logger.success('All required dependencies found');
    logger.blank();

    // Step 2: Setup environment
    const envSetup = new EnvSetup();

    // Create configuration
    const config: EnvConfig = {
      CM_ROOT_DIR: options.defaults
        ? join(homedir(), 'repos')
        : sanitizePath(process.env.CM_ROOT_DIR || join(homedir(), 'repos')),
      CM_PORT: ENV_DEFAULTS.CM_PORT,
      CM_BIND: ENV_DEFAULTS.CM_BIND,
      CM_DB_PATH: ENV_DEFAULTS.CM_DB_PATH,
      CM_LOG_LEVEL: ENV_DEFAULTS.CM_LOG_LEVEL,
      CM_LOG_FORMAT: ENV_DEFAULTS.CM_LOG_FORMAT,
    };

    // Validate configuration
    const validationResult = envSetup.validateConfig(config);
    if (!validationResult.valid) {
      logger.error('Configuration validation failed:');
      for (const error of validationResult.errors) {
        logger.error(`  - ${error}`);
      }

      logSecurityEvent({
        timestamp: new Date().toISOString(),
        command: 'init',
        action: 'failure',
        details: `Validation failed: ${validationResult.errors.join(', ')}`,
      });

      process.exit(ExitCode.CONFIG_ERROR);
      return;
    }

    // Backup existing .env if force mode
    if (options.force) {
      const backupPath = await envSetup.backupExisting();
      if (backupPath) {
        logger.info(`Backed up existing .env to ${backupPath}`);
      }
    }

    // Create .env file
    logger.info('Creating .env file...');
    await envSetup.createEnvFile(config, { force: options.force });
    logger.success('.env file created');

    // Step 3: Initialize database
    logger.info('Initializing database...');
    // Note: Database initialization is handled by the server on startup
    logger.success('Database will be initialized on first server start');

    logger.blank();
    logger.success('CommandMate initialized successfully!');
    logger.blank();
    logger.info('Next steps:');
    logger.info('  1. Edit .env to customize your configuration');
    logger.info('  2. Run "commandmate start" to start the server');
    logger.blank();

    logSecurityEvent({
      timestamp: new Date().toISOString(),
      command: 'init',
      action: 'success',
      details: 'Configuration initialized',
    });

    process.exit(ExitCode.SUCCESS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Initialization failed: ${message}`);

    logSecurityEvent({
      timestamp: new Date().toISOString(),
      command: 'init',
      action: 'failure',
      details: message,
    });

    process.exit(ExitCode.UNEXPECTED_ERROR);
  }
}
