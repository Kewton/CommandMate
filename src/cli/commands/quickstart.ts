/**
 * Quickstart Command
 * Issue #1195: `npx commandmate` with no arguments walks the user from zero to a running server
 *
 * Chains the exit-free cores of init/start (runInit/runStart) so a single invocation can
 * configure, launch, await readiness and open the browser without terminating in between.
 */

import { existsSync } from 'fs';
import { DaemonStatus, ExitCode, getErrorMessage, PreflightResult } from '../types';
import { CLILogger } from '../utils/logger';
import { DaemonManager } from '../utils/daemon';
import { readPackageVersion } from '../utils/package-info';
import { PreflightChecker } from '../utils/preflight';
import { getEnvPath, getPidFilePath } from '../utils/env-setup';
import { isInteractive } from '../utils/prompt';
import { waitForServer } from '../utils/server-ready';
import { openBrowser, shouldOpenBrowser } from '../utils/browser';
import { buildProgram } from '../program';
import { runInit } from './init';
import { runStart } from './start';

const logger = new CLILogger();

/** Exit code commander uses for help({ error: true }); the non-TTY fallback must match it */
const HELP_FALLBACK_EXIT_CODE = 1;

const DEFAULT_PORTS: Record<string, number> = {
  'http:': 80,
  'https:': 443,
};

export interface QuickstartOptions {
  /** Set to false by --no-open */
  open?: boolean;
}

interface Endpoint {
  host: string;
  port: number;
}

/**
 * Execute the guided quickstart flow
 */
export async function quickstartCommand(options: QuickstartOptions = {}): Promise<void> {
  const exitCode = await runQuickstart(options);
  process.exit(exitCode);
}

/**
 * Run the quickstart flow without terminating the process
 *
 * @returns The exit code the caller should terminate with
 */
async function runQuickstart(options: QuickstartOptions): Promise<number> {
  if (!isInteractive()) {
    buildProgram().outputHelp({ error: true });
    return HELP_FALLBACK_EXIT_CODE;
  }

  try {
    const configExitCode = await ensureConfiguration();
    if (configExitCode !== null) {
      return configExitCode;
    }

    const daemonManager = new DaemonManager(getPidFilePath());
    const started = await ensureServerRunning(daemonManager);
    if (started.exitCode !== undefined) {
      return started.exitCode;
    }

    if (started.url) {
      announceServer(started.url, options);
    }

    return ExitCode.SUCCESS;
  } catch (error) {
    logger.error(`Quickstart failed: ${getErrorMessage(error)}`);
    return ExitCode.UNEXPECTED_ERROR;
  }
}

/**
 * Make sure a usable configuration exists, creating one on first run
 *
 * @returns An exit code to stop on, or null to continue
 */
async function ensureConfiguration(): Promise<ExitCode | null> {
  if (!existsSync(getEnvPath())) {
    // runInit performs its own preflight, so checking here as well would double-run it
    const result = await runInit({});
    return result.ok ? null : result.exitCode;
  }

  const preflight = await new PreflightChecker().checkAll();
  if (!preflight.success) {
    reportMissingDependencies(preflight);
    return ExitCode.DEPENDENCY_ERROR;
  }

  return null;
}

/**
 * Start the server unless it is already up
 *
 * @returns The server URL, or an exit code to stop on
 */
async function ensureServerRunning(
  daemonManager: DaemonManager
): Promise<{ url?: string; exitCode?: ExitCode }> {
  if (await daemonManager.isRunning()) {
    // start.ts reports an already-running server as START_FAILED, so it must not be called here
    const status = await daemonManager.getStatus();
    logger.info(`Server is already running (PID: ${status?.pid})`);
    // Issue #1337: this branch returns the existing server's URL without restarting it, so
    // running `npx commandmate@latest` over a still-running old daemon silently never delivers
    // the newer code. Surface that mismatch so the user is not led to believe they are up to date.
    warnOnVersionMismatch(status);
    // Issue #1266: getStatus() now gives .env precedence over exported variables, so the URL
    // it reports is the one the server is on; this no longer needs to be re-derived here
    return { url: status?.url };
  }

  const result = await runStart({ daemon: true });
  if (!result.ok) {
    return { exitCode: result.exitCode };
  }

  await waitUntilReady(result.url);

  return { url: result.url };
}

/**
 * Warn when the already-running daemon is a different version than this CLI.
 *
 * Issue #1337: `npx commandmate@latest` over a still-running old daemon returns the existing URL
 * without restarting, so a published fix silently never reaches the user, while `--version`
 * reports the freshly-fetched CLI and hides the discrepancy. #1354 recorded the daemon's version
 * in its state file; getStatus() surfaces it here so the mismatch becomes visible. This only
 * warns — restarting automatically would kill any in-flight sessions the running server holds.
 */
function warnOnVersionMismatch(status: DaemonStatus | null): void {
  const runningVersion = status?.version;
  if (!runningVersion) {
    // Legacy daemons (started before #1354) record no version; nothing to compare against.
    return;
  }

  const cliVersion = readPackageVersion();
  if (cliVersion && cliVersion !== runningVersion) {
    logger.warn(
      `The running server is v${runningVersion} but this CLI is v${cliVersion}. ` +
        'This command does not restart it, so the running server stays on the old version. ' +
        'To update the running server, run "commandmate update".'
    );
  }
}

/**
 * Poll the server until it accepts connections; a timeout is not fatal
 */
async function waitUntilReady(url: string | undefined): Promise<void> {
  const endpoint = url === undefined ? null : parseEndpoint(url);
  if (endpoint === null) {
    return;
  }

  logger.info('Waiting for the server to become ready...');
  const ready = await waitForServer(endpoint.host, endpoint.port);

  if (!ready) {
    logger.warn('Server is taking longer than expected to respond. It may still be starting up.');
  }
}

/**
 * Show the URL and open a browser when the environment allows it
 */
function announceServer(url: string, options: QuickstartOptions): void {
  logger.blank();
  logger.success(`CommandMate is ready: ${url}`);

  if (options.open !== false && shouldOpenBrowser()) {
    logger.info('Opening your browser...');
    openBrowser(url);
    return;
  }

  logger.info('Open the URL above in your browser.');
}

/**
 * Report dependency problems the same way init does
 */
function reportMissingDependencies(preflight: PreflightResult): void {
  for (const result of preflight.results) {
    if (result.status === 'missing') {
      logger.error(`${result.name}: Not found`);
      logger.info(`  ${PreflightChecker.getInstallHint(result.name)}`);
    } else if (result.status === 'version_mismatch') {
      logger.warn(`${result.name}: ${result.version} (minimum required version not met)`);
    }
  }

  logger.blank();
  logger.error('Required dependencies are missing. Please install them and try again.');
}

/**
 * Resolve the host/port to poll from a URL
 *
 * @returns The endpoint, or null if the URL is unusable
 */
function parseEndpoint(url: string): Endpoint | null {
  try {
    const parsed = new URL(url);
    const port = parsed.port ? parseInt(parsed.port, 10) : DEFAULT_PORTS[parsed.protocol];

    if (port === undefined || Number.isNaN(port)) {
      return null;
    }

    return { host: parsed.hostname, port };
  } catch {
    return null;
  }
}
