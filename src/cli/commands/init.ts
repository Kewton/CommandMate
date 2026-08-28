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
  normalizeBrowseRoots,
  readExistingVapidKeys,
} from '../utils/env-setup';
import { generateVapidKeyPair } from '../utils/vapid-keygen';
// Relative, NOT `@/lib/push/vapid`: tsconfig.cli.json resets `paths` to {}. The module
// file rather than the '@/lib/push' barrel, which pulls in web-push and better-sqlite3.
import { VAPID_DEFAULT_SUBJECT } from '../../lib/push/vapid';
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
    CM_BROWSE_ROOTS: normalizeBrowseRoots(process.env.CM_BROWSE_ROOTS),
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

  // CM_ROOT_DIR: the managed scope. Repositories must live under this directory
  // to be registered, and clones are placed here (Issue #1328).
  logger.info('CommandMate only manages repositories located under this directory,');
  logger.info('and cloned repositories are saved into it.');
  const rootDirInput = await prompt('Managed repository directory (CM_ROOT_DIR)', {
    default: DEFAULT_ROOT_DIR.replace(homedir(), '~'),
  });
  const rootDir = resolvePath(rootDirInput || DEFAULT_ROOT_DIR);

  // Check if path exists. CommandMate does not create it here: cloning creates
  // it on demand, so a missing directory is only a problem for registering
  // repositories that are supposed to already be inside it.
  if (!existsSync(rootDir)) {
    logger.warn(`Directory does not exist: ${rootDir}`);
    logger.info('  It is created automatically when you clone a repository into it.');
    logger.info('  To register existing repositories, they must be moved under it first.');
    const createDir = await confirm('Continue?', {
      default: true,
    });
    if (!createDir) {
      throw new Error('Setup cancelled by user');
    }
  }

  // CM_BROWSE_ROOTS: extra locations the web UI's folder picker may reach
  // (Issue #1517). CM_ROOT_DIR is always browsable, so this is opt-in and blank
  // by default.
  logger.blank();
  logger.info('Repositories kept outside the managed directory can still be registered');
  logger.info('if you list their parent directories here (comma-separated). Leave blank to skip.');
  const browseRootsInput = await prompt('Additional browsable directories (CM_BROWSE_ROOTS)', {
    default: '',
  });
  const browseRoots = normalizeBrowseRoots(browseRootsInput, resolvePath);

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
    CM_BROWSE_ROOTS: browseRoots,
    CM_PORT: port,
    CM_BIND: bind,
    CM_DB_PATH: dbPath,
    CM_LOG_LEVEL: ENV_DEFAULTS.CM_LOG_LEVEL,
    CM_LOG_FORMAT: ENV_DEFAULTS.CM_LOG_FORMAT,
  };
}

/**
 * Settle the three Web Push variables for the `.env` `init` is about to write
 * (Issue #2123; the subject is Issue #2124).
 *
 * Push is off until `CM_VAPID_PUBLIC_KEY` / `CM_VAPID_PRIVATE_KEY` exist, and
 * before this Issue nothing in CommandMate could produce them — the only route
 * was to know that the bundled `web-push` exports `generateVAPIDKeys()` and type
 * a `node -e` one-liner. So `init` generates a pair, unconditionally and in both
 * modes: a key pair costs nothing while no device has subscribed, and making it
 * a question would put the feature back behind knowing it exists.
 *
 * **An existing pair is always reused.** The public key is baked into every
 * `PushSubscription` a browser has already created, so regenerating on
 * `init --force` would orphan every subscribed device — silently, which is the
 * failure mode this Issue pair exists to end.
 *
 * Fail-open: if `web-push` cannot be loaded the miss is reported and `init`
 * finishes normally with push left unconfigured. That is exactly the state every
 * install was in before this change, and the startup self-check now names it.
 *
 * @param envPath - The `.env` about to be written, read for keys to carry over.
 * @returns The trio to write, or `{}` when no pair could be settled.
 */
async function resolveVapidConfig(
  envPath: string
): Promise<Pick<EnvConfig, 'CM_VAPID_PUBLIC_KEY' | 'CM_VAPID_PRIVATE_KEY' | 'CM_VAPID_SUBJECT'>> {
  const existing = readExistingVapidKeys(envPath);

  if (existing.CM_VAPID_PUBLIC_KEY && existing.CM_VAPID_PRIVATE_KEY) {
    logger.info('Web Push: keeping the existing VAPID key pair');
    logger.info('  (replacing it would orphan every device that has already subscribed)');
    return {
      CM_VAPID_PUBLIC_KEY: existing.CM_VAPID_PUBLIC_KEY,
      CM_VAPID_PRIVATE_KEY: existing.CM_VAPID_PRIVATE_KEY,
      CM_VAPID_SUBJECT: existing.CM_VAPID_SUBJECT || VAPID_DEFAULT_SUBJECT,
    };
  }

  const result = await generateVapidKeyPair();
  if (!result.ok) {
    logger.warn(`Web Push: could not generate VAPID keys (${result.error})`);
    logger.info('  Push notifications stay disabled; see docs/user-guide/webapp-guide.md');
    return {};
  }

  logger.success('Web Push: generated a VAPID key pair');
  return {
    CM_VAPID_PUBLIC_KEY: result.keys.publicKey,
    CM_VAPID_PRIVATE_KEY: result.keys.privateKey,
    CM_VAPID_SUBJECT: existing.CM_VAPID_SUBJECT || VAPID_DEFAULT_SUBJECT,
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
  if (config.CM_BROWSE_ROOTS) {
    logger.info(`  CM_BROWSE_ROOTS: ${config.CM_BROWSE_ROOTS}`);
  }
  logger.info(`  CM_PORT:      ${config.CM_PORT}`);
  logger.info(`  CM_BIND:      ${config.CM_BIND}`);
  logger.info(`  CM_DB_PATH:   ${config.CM_DB_PATH}`);
  // Issue #2123: the keys themselves are secrets, so the summary reports only
  // whether push is configured — enough for the reader to know it is on.
  logger.info(
    `  Web Push:     ${
      config.CM_VAPID_PUBLIC_KEY && config.CM_VAPID_PRIVATE_KEY
        ? `configured (CM_VAPID_SUBJECT=${config.CM_VAPID_SUBJECT ?? VAPID_DEFAULT_SUBJECT})`
        : 'not configured'
    }`
  );
  logger.blank();
  logger.info(`  Config file:  ${envPath}`);
  logger.blank();

}

/**
 * Result of an init run
 * Issue #1195: allows callers to chain init -> start without exiting the process
 */
export interface InitResult {
  ok: boolean;
  exitCode: ExitCode;
  config?: EnvConfig;
  envPath?: string;
}

/**
 * Run init without terminating the process
 * Issue #1195: extracted from initCommand so the quickstart flow can chain commands
 */
export async function runInit(options: InitOptions): Promise<InitResult> {
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

      return { ok: false, exitCode: ExitCode.DEPENDENCY_ERROR };
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

      return { ok: false, exitCode: ExitCode.CONFIG_ERROR };
    }

    // Step 4: Create .env file
    logger.blank();
    logger.info('--- Generating .env ---');
    logger.blank();

    // Issue #2123 / #2124: settle the Web Push trio before the file is written.
    // Reads `envPath` first, so `--force` carries an existing key pair across
    // instead of orphaning every subscribed device.
    Object.assign(config, await resolveVapidConfig(envPath));

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
    if (config.CM_VAPID_PUBLIC_KEY && config.CM_VAPID_PRIVATE_KEY) {
      // Issue #2123: keys alone are not the whole setup — a phone also needs
      // HTTPS, and iOS needs the app installed to the Home Screen. Point at the
      // one document that says so rather than repeating it here.
      logger.info('  Phone notifications: docs/user-guide/webapp-guide.md');
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

    return { ok: true, exitCode: ExitCode.SUCCESS, config, envPath };
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

    return { ok: false, exitCode: ExitCode.UNEXPECTED_ERROR };
  }
}

/**
 * Execute init command
 */
export async function initCommand(options: InitOptions): Promise<void> {
  const result = await runInit(options);
  process.exit(result.exitCode);
}
