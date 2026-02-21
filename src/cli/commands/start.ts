/**
 * Start Command
 * Issue #96: npm install CLI support
 * Issue #125: Use getEnvPath and getPidFilePath for correct path resolution
 * Issue #136: Add --issue and --auto-port flags for worktree support
 * Issue #331: Add --auth, --auth-expire, --https, --cert, --key, --allow-http flags
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
import { REVERSE_PROXY_WARNING } from '../config/security-messages';
import { validateIssueNoResult } from '../utils/input-validators';
import { PortAllocator } from '../utils/port-allocator';
import { DbPathResolver } from '../utils/resource-resolvers';
import { generateToken, hashToken, parseDuration } from '../../lib/auth';

const logger = new CLILogger();

/**
 * Display the generated authentication token to the user.
 * Called once after server start; the token is not persisted and cannot be retrieved later.
 *
 * @param token - The plaintext authentication token to display
 */
function displayAuthToken(token: string): void {
  logger.info('');
  logger.info('Authentication token (save this - it will not be shown again):');
  logger.info(`  ${token}`);
  logger.info('');
}

/** HTTPS certificate warning when --auth is used without --cert/--key */
const HTTPS_WARNING = `
\x1b[1m\x1b[33mWARNING: Authentication enabled without HTTPS\x1b[0m

Token will be transmitted in plain text over HTTP.
For secure authentication, use HTTPS with a TLS certificate.

\x1b[1mQuick setup with mkcert:\x1b[0m
  brew install mkcert     # macOS
  mkcert -install
  mkcert localhost

  commandmate start --auth --cert ./localhost.pem --key ./localhost-key.pem

Use --allow-http to suppress this warning.
`;

/**
 * Execute start command
 * Issue #125: Use getEnvPath and getPidFilePath for correct path resolution
 * Issue #136: Support --issue and --auto-port flags for worktree servers
 * Issue #331: Support --auth, --auth-expire, --https, --cert, --key, --allow-http
 */
export async function startCommand(options: StartOptions): Promise<void> {
  try {
    // Issue #136: Validate issue number if provided
    if (options.issue !== undefined) {
      const validation = validateIssueNoResult(options.issue);
      if (!validation.valid) {
        logger.error(`Invalid issue number: ${validation.error}`);
        process.exit(ExitCode.START_FAILED);
        return;
      }
    }

    // Issue #331: Validate auth-expire format before proceeding
    if (options.authExpire) {
      try {
        parseDuration(options.authExpire);
      } catch (error) {
        logger.error(`Invalid --auth-expire value: ${getErrorMessage(error)}`);
        process.exit(ExitCode.CONFIG_ERROR);
        return;
      }
    }

    // Issue #125: Check for .env file at correct location
    // Issue #136: Use issue number for worktree-specific paths
    const envPath = getEnvPath(options.issue);
    const pidFilePath = getPidFilePath(options.issue);

    // Issue #136: Worktree-specific server label
    const serverLabel = options.issue !== undefined
      ? `Issue #${options.issue} server`
      : 'Main server';

    // Issue #136: For worktree servers, main .env must exist but worktree-specific .env is optional
    const mainEnvPath = getEnvPath();
    if (!existsSync(mainEnvPath)) {
      logger.error(`.env file not found at ${mainEnvPath}`);
      logger.info('Run "commandmate init" to create a configuration file');
      process.exit(ExitCode.CONFIG_ERROR);
      return;
    }

    const daemonManager = new DaemonManager(pidFilePath);

    // Issue #136: Handle auto-port allocation for worktree servers
    let port = options.port;
    if (options.autoPort && options.issue !== undefined) {
      const portAllocator = PortAllocator.getInstance();
      port = portAllocator.allocate(options.issue);
      logger.info(`Auto-allocated port ${port} for Issue #${options.issue}`);
    }

    // Issue #136: Set worktree-specific DB path
    let dbPath: string | undefined;
    if (options.issue !== undefined) {
      const dbResolver = new DbPathResolver();
      dbPath = dbResolver.resolve(options.issue);
      logger.info(`Using database: ${dbPath}`);
    }

    // Issue #331: Generate token and hash if --auth is enabled
    let authTokenHash: string | undefined;
    let authToken: string | undefined;
    if (options.auth) {
      authToken = generateToken();
      authTokenHash = hashToken(authToken);
    }

    // Issue #331: Determine protocol
    const hasCert = !!(options.cert && options.key);
    const useHttps = hasCert && (options.auth || options.https);
    const protocol = useHttps ? 'https' : 'http';

    // Issue #331: HTTPS certificate validation
    if (hasCert) {
      if (!existsSync(options.cert!)) {
        logger.error(`Certificate file not found: ${options.cert}`);
        process.exit(ExitCode.CONFIG_ERROR);
        return;
      }
      if (!existsSync(options.key!)) {
        logger.error(`Key file not found: ${options.key}`);
        process.exit(ExitCode.CONFIG_ERROR);
        return;
      }
    }

    // Issue #331: Warn about --auth without HTTPS
    if (options.auth && !hasCert && !options.allowHttp) {
      console.log(HTTPS_WARNING);
    }

    // Load .env to check for legacy CM_AUTH_TOKEN
    const mainEnvResult = dotenvConfig({ path: mainEnvPath });
    let envResult = mainEnvResult;

    if (options.issue !== undefined && existsSync(envPath) && envPath !== mainEnvPath) {
      envResult = dotenvConfig({ path: envPath, override: true });
    }

    // Issue #331: Warn about legacy CM_AUTH_TOKEN
    const allEnvParsed = {
      ...(mainEnvResult.parsed || {}),
      ...(envResult.parsed || {}),
    };
    if (allEnvParsed.CM_AUTH_TOKEN) {
      logger.warn('CM_AUTH_TOKEN found in .env file. This is no longer used.');
      logger.warn('Use "commandmate start --auth" instead. The token is now generated automatically.');
    }

    if (mainEnvResult.error) {
      logger.warn(`Failed to load .env file at ${mainEnvPath}: ${mainEnvResult.error.message}`);
      logger.info('Continuing with existing environment variables');
    }

    // Daemon mode
    if (options.daemon) {
      // Check if already running
      if (await daemonManager.isRunning()) {
        const status = await daemonManager.getStatus();
        logger.error(`${serverLabel} is already running (PID: ${status?.pid})`);
        process.exit(ExitCode.START_FAILED);
        return;
      }

      logger.info(`Starting ${serverLabel} in background...`);

      try {
        const pid = await daemonManager.start({
          dev: options.dev,
          port: port,
          // Issue #136: Pass DB path for worktree servers
          dbPath: dbPath,
          // Issue #331: Pass auth and HTTPS options
          auth: options.auth,
          authExpire: options.authExpire,
          cert: options.cert,
          key: options.key,
          allowHttp: options.allowHttp,
        });

        logger.success(`${serverLabel} started in background (PID: ${pid})`);

        const actualPort = port || parseInt(process.env.CM_PORT || '3000', 10);
        const bind = process.env.CM_BIND || '127.0.0.1';
        const url = `${protocol}://${bind === '0.0.0.0' ? '127.0.0.1' : bind}:${actualPort}`;
        logger.info(`URL: ${url}`);

        // Issue #331: Show token to user (shown once, not persisted)
        if (authToken) {
          displayAuthToken(authToken);
        }

        logSecurityEvent({
          timestamp: new Date().toISOString(),
          command: 'start',
          action: 'success',
          details: `Daemon started (PID: ${pid})${options.issue !== undefined ? ` (Issue #${options.issue})` : ''}${options.auth ? ' [auth enabled]' : ''}`,
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
    logger.info(`Starting ${serverLabel} in foreground (${options.dev ? 'development' : 'production'} mode)...`);

    // Build environment by merging process.env with .env values
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(mainEnvResult.parsed || {}),
      ...(envResult.parsed || {}),
    };

    // Command line options override .env values
    if (port) {
      env.CM_PORT = String(port);
    }

    // Issue #136: Set DB path for worktree servers
    if (dbPath) {
      env.CM_DB_PATH = dbPath;
    }

    // Issue #331: Set auth environment variables
    if (authTokenHash) {
      env.CM_AUTH_TOKEN_HASH = authTokenHash;
    }
    if (options.authExpire) {
      env.CM_AUTH_EXPIRE = options.authExpire;
    }
    if (options.cert) {
      env.CM_HTTPS_CERT = options.cert;
    }
    if (options.key) {
      env.CM_HTTPS_KEY = options.key;
    }
    if (options.allowHttp) {
      env.CM_ALLOW_HTTP = '1';
    }

    // Issue #179: Security warning for external access - recommend reverse proxy
    const bindAddress = env.CM_BIND || '127.0.0.1';

    if (bindAddress === '0.0.0.0' && !options.auth) {
      console.log(REVERSE_PROXY_WARNING);
    }

    // Issue #331: Show token to user (foreground mode, shown once, not persisted)
    if (authToken) {
      displayAuthToken(authToken);
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
