/**
 * Init Command
 * Issue #96: npm install CLI support
 * Issue #119: Interactive init support
 * Initialize CommandMate configuration
 */

import { existsSync } from 'fs';
import { homedir } from 'os';
import { InitOptions, ExitCode, EnvConfig } from '../types';
import { CLILogger } from '../utils/logger';
import { PreflightChecker } from '../utils/preflight';
import { AI_INTEGRATION_GUIDE } from '../config/ai-integration-messages';
import {
  EnvSetup,
  ENV_DEFAULTS,
  DEFAULT_ROOT_DIR,
  getEnvPath,
  sanitizePath,
  getDefaultDbPath,
} from '../utils/env-setup';
import {
  prompt,
  confirm,
  resolvePath,
  validatePort,
  isInteractive,
  closeReadline,
} from '../utils/prompt';
import { logSecurityEvent } from '../utils/security-logger';
import { REVERSE_PROXY_WARNING } from '../config/security-messages';

const logger = new CLILogger();

/**
 * Create default configuration (non-interactive mode)
 * Issue #135: Use getDefaultDbPath() for dynamic DB path resolution
 */
function createDefaultConfig(): EnvConfig {
  return {
    CM_ROOT_DIR: sanitizePath(process.env.CM_ROOT_DIR || DEFAULT_ROOT_DIR),
    CM_PORT: ENV_DEFAULTS.CM_PORT,
    CM_BIND: ENV_DEFAULTS.CM_BIND,
    CM_DB_PATH: getDefaultDbPath(), // Issue #135: Use absolute path
    CM_LOG_LEVEL: ENV_DEFAULTS.CM_LOG_LEVEL,
    CM_LOG_FORMAT: ENV_DEFAULTS.CM_LOG_FORMAT,
  };
}

/**
 * Prompt user for configuration (interactive mode)
 * Issue #119: Interactive init support
 */
async function promptForConfig(): Promise<EnvConfig> {
  logger.info('--- Required Settings ---');
  logger.blank();

  // CM_ROOT_DIR
  const rootDirInput = await prompt('Repository root directory (CM_ROOT_DIR)', {
    default: DEFAULT_ROOT_DIR.replace(homedir(), '~'),
  });
  const rootDir = resolvePath(rootDirInput || DEFAULT_ROOT_DIR);

  // Check if path exists
  if (!existsSync(rootDir)) {
    logger.warn(`Directory does not exist: ${rootDir}`);
    const createDir = await confirm('Directory will be validated when adding repositories. Continue?', {
      default: true,
    });
    if (!createDir) {
      throw new Error('Setup cancelled by user');
    }
  }

  logger.blank();
  logger.info('--- Server Settings ---');
  logger.blank();

  // CM_PORT
  const portInput = await prompt('Server port (CM_PORT)', {
    default: String(ENV_DEFAULTS.CM_PORT),
    validate: validatePort,
  });
  const port = parseInt(portInput || String(ENV_DEFAULTS.CM_PORT), 10);

  // External access
  const enableExternal = await confirm('Enable external access (bind to 0.0.0.0)?', {
    default: false,
  });

  let bind: string = ENV_DEFAULTS.CM_BIND;

  if (enableExternal) {
    bind = '0.0.0.0';
    logger.blank();
    logger.success('External access enabled');
    logger.info(`  Bind address: 0.0.0.0`);
    // Issue #332: Mention IP restriction as an alternative security measure
    logger.info('  Tip: Use --allowed-ips to restrict access by IP address/CIDR.');
    console.log(REVERSE_PROXY_WARNING);
  }

  // CM_DB_PATH - Issue #135: Use getDefaultDbPath() for absolute path
  const defaultDbPath = getDefaultDbPath();
  const dbPathInput = await prompt('Database path (CM_DB_PATH)', {
    default: defaultDbPath,
  });
  const dbPath = dbPathInput || defaultDbPath;

  return {
    CM_ROOT_DIR: rootDir,
    CM_PORT: port,
    CM_BIND: bind,
    CM_DB_PATH: dbPath,
    CM_LOG_LEVEL: ENV_DEFAULTS.CM_LOG_LEVEL,
    CM_LOG_FORMAT: ENV_DEFAULTS.CM_LOG_FORMAT,
  };
}

/**
 * Display configuration summary
 * Issue #119: Show settings after configuration
 */
function displayConfigSummary(config: EnvConfig, envPath: string): void {
  logger.blank();
  logger.info('==================================');
  logger.info('Configuration Summary');
  logger.info('==================================');
  logger.blank();
  logger.info(`  CM_ROOT_DIR:  ${config.CM_ROOT_DIR}`);
  logger.info(`  CM_PORT:      ${config.CM_PORT}`);
  logger.info(`  CM_BIND:      ${config.CM_BIND}`);
  logger.info(`  CM_DB_PATH:   ${config.CM_DB_PATH}`);
  logger.blank();
  logger.info(`  Config file:  ${envPath}`);
  logger.blank();

}

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

    // Step 2: Get environment path
    const envPath = getEnvPath();
    const envSetup = new EnvSetup(envPath);

    // Backup existing .env if force mode
    if (options.force) {
      const backupPath = await envSetup.backupExisting();
      if (backupPath) {
        logger.info(`Backed up existing .env to ${backupPath}`);
      }
    }

    // Step 3: Create configuration
    let config: EnvConfig;

    // Determine if interactive mode should be used
    // Use interactive mode if:
    // - Not using --defaults flag
    // - Running in a TTY (interactive terminal)
    const useInteractive = !options.defaults && isInteractive();

    if (useInteractive) {
      config = await promptForConfig();
      closeReadline(); // Close readline after prompts
    } else {
      config = createDefaultConfig();
    }

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

    // Step 4: Create .env file
    logger.blank();
    logger.info('--- Generating .env ---');
    logger.blank();
    logger.info('Creating .env file...');
    await envSetup.createEnvFile(config, { force: options.force });
    logger.success('.env file created');

    // Step 5: Initialize database message
    logger.info('Initializing database...');
    // Note: Database initialization is handled by the server on startup
    logger.success('Database will be initialized on first server start');

    // Display configuration summary
    displayConfigSummary(config, envPath);

    logger.success('CommandMate initialized successfully!');
    logger.blank();
    logger.info('Next steps:');
    if (!useInteractive) {
      logger.info('  1. Edit .env to customize your configuration');
      logger.info('  2. Run "commandmate start" to start the server');
    } else {
      logger.info('  1. Run "commandmate start" to start the server');
    }
    logger.blank();

    // Issue #264: Display AI tool integration guide
    console.log(AI_INTEGRATION_GUIDE);

    logSecurityEvent({
      timestamp: new Date().toISOString(),
      command: 'init',
      action: 'success',
      details: `Configuration initialized (interactive: ${useInteractive})`,
    });

    process.exit(ExitCode.SUCCESS);
  } catch (error) {
    closeReadline(); // Ensure readline is closed on error
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
