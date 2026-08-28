/**
 * Status Command
 * Issue #96: npm install CLI support
 * Issue #125: Use getPidFilePath and load .env for correct settings display
 * Issue #136: Add --issue and --all flags for worktree-specific status
 * Display CommandMate server status
 */

import { readdirSync } from 'fs';
import { DaemonStatus, ExitCode, getErrorMessage, StatusOptions } from '../types';
import { CLILogger } from '../utils/logger';
import { DaemonManager } from '../utils/daemon';
import { getPidFilePath, getEnvPath, getPidsDir } from '../utils/env-setup';
import { readPackageVersion } from '../utils/package-info';
import { validateIssueNoResult } from '../utils/input-validators';
import { getDetectorFreshness } from '../../lib/detection/version-probes';
import {
  formatLocalhostConflictWarning,
  readLocalhostConflict,
} from '../../lib/server/localhost-self-check';
// Relative, NOT `@/lib/push/vapid`: tsconfig.cli.json resets `paths` to {}, so an alias
// import here breaks `npm run build:cli`. The module file, not the '@/lib/push' barrel —
// that barrel pulls in web-push and better-sqlite3, neither of which belongs in the CLI.
import {
  formatVapidReportLines,
  inspectVapidConfig,
} from '../../lib/push/vapid';

const logger = new CLILogger();

/**
 * Print the running daemon's version and, when it differs from the installed CLI, a warning.
 * Issue #1354: a new CLI over a still-running old daemon otherwise reports only "Running", so
 * users cannot tell the server is not on the latest version.
 */
function printVersionInfo(status: DaemonStatus): void {
  if (!status.version) {
    return;
  }

  console.log(`Version: ${status.version}`);

  const cliVersion = readPackageVersion();
  if (cliVersion && cliVersion !== status.version) {
    logger.warn(
      `Installed CLI is v${cliVersion} but the running server is v${status.version}. ` +
        'Restart the server ("commandmate stop && commandmate start") to run the current version.'
    );
  }
}

/**
 * Surface the startup self-check's verdict (Issue #2113).
 *
 * The server probes `http://localhost:<port>` after `listen` and, when something OTHER
 * than itself answers, drops a record under `<configDir>/logs/self-check-<port>.json`. That
 * is the only situation this prints in — the record is deleted on every clean check and
 * on shutdown, so silence here means the advertised URL really does reach the server.
 *
 * Why a file rather than the PID file or a re-probe:
 * - the PID file is written by the CLI parent with O_EXCL *before* the child binds, and
 *   its hybrid layout is a forward-compatibility contract (#1632) — the server cannot
 *   append to it without racing the parent and perturbing that format;
 * - a re-probe from here cannot reproduce the verdict. Identity is established by the
 *   server OBSERVING its own probe request in-process; a separate CLI process has no
 *   way to tell "CommandMate answered" from "some other server answered", short of
 *   platform-specific `lsof` parsing.
 *
 * Staleness is guarded on `startedAt`, NOT on the PID, and that distinction was measured
 * rather than reasoned: `daemon.start()` spawns `npm run start`, so the state file holds
 * the WRAPPER's PID while the record holds the PID of the `node dist/server/server.js`
 * child that actually binds the port (2026-08-27, port 3902: state file 58882, listener
 * 58937). A PID comparison here therefore never matched and the warning never reached
 * `status` — the whole point of the Issue's "log AND status" acceptance condition.
 * A record predating the current daemon's launch cannot be the current daemon's; one
 * written after it can only have come from it, because the record is keyed by port and
 * every startup either overwrites it or deletes it.
 *
 * A state file with no `startedAt` (written before #1354) leaves nothing to compare, so
 * the record is reported: it is refreshed on every start, and hiding a real conflict is
 * the worse failure.
 *
 * Never throws — a diagnostic must not be able to turn `status` into a failure.
 */
function printLocalhostConflict(status: DaemonStatus): void {
  try {
    if (status.port === undefined) return;

    const record = readLocalhostConflict(status.port);
    if (record === null) return;
    if (status.startedAt !== undefined && record.detectedAt < status.startedAt) return;

    console.log('');
    logger.warn(`Startup self-check (${record.detectedAt}):`);
    for (const line of formatLocalhostConflictWarning(record)) {
      console.log(`  ${line}`);
    }
  } catch {
    // Config dir unreadable, record unparsable: report the server, drop the hint.
  }
}

/**
 * Report the server's Web Push configuration, or nothing when it is healthy
 * (Issues #2123 / #2124).
 *
 * The Issues' acceptance condition is "the startup log OR `commandmate status`",
 * and this is the half that is still readable a week later — a daemon started in
 * the background writes its stdout wherever the launcher put it, and the reader
 * who notices "my phone stopped buzzing" reaches for `status`.
 *
 * Read from the env the DAEMON runs with (`getEffectiveEnv()`), not from this
 * process's own environment: `.env` outranks exported variables for the server
 * child (Issue #1266), so `process.env` here would report this shell's idea of
 * the configuration rather than the server's. Exactly what the `CM_ALLOWED_IPS`
 * line below already does.
 *
 * The residual imprecision is the same one that line carries: a variable exported
 * into the daemon's environment at launch and absent from `.env` is invisible
 * here. `commandmate init` writes all three VAPID variables into `.env`, so the
 * supported setup is covered; a hand-exported key pair would be reported as
 * unconfigured, which is why the startup log carries the same lines.
 *
 * Silent on a healthy install — that silence is the negative control both Issues
 * ask for. Never throws: a diagnostic must not turn `status` into a failure.
 */
function printVapidStatus(env: Readonly<Record<string, string | undefined>>): void {
  try {
    const lines = formatVapidReportLines(inspectVapidConfig(env));
    if (lines.length === 0) return;

    console.log('');
    logger.warn(lines[0]);
    for (const line of lines.slice(1)) {
      console.log(line);
    }
  } catch {
    // Unreadable .env, unparsable value: report the server, drop the hint.
  }
}

/**
 * Warn when this build's detection rules were read off an older CLI than the one
 * installed (Issue #1929, design §4 D2).
 *
 * `status` is the diagnostic command and an operator-initiated one-off, so
 * unlike the `capture` polling path it may await the probes — the design draws
 * exactly that line ("露出面ごとに待つ / 待たない を分ける"). Measured cost is
 * the slowest single `--version` (~0.9s on the reference machine) because they
 * run concurrently, and every probe is bounded by its own timeout.
 *
 * Silent when nothing is stale, so the existing output is unchanged on a machine
 * whose CLIs match — a skew nobody can act on is not worth a line. Never throws:
 * a broken probe must not turn `commandmate status` into a failure.
 */
async function printDetectorFreshness(): Promise<void> {
  try {
    const stale = (await getDetectorFreshness()).filter((row) => row.stale);
    if (stale.length === 0) return;

    console.log('');
    console.log('Detector rules verified against an older CLI:');
    for (const row of stale) {
      console.log(`  ${row.tool}: installed ${row.installed}, rules read off ${row.verifiedAgainst}`);
    }
    console.log('  Detection may misread this tool; see docs/design/multi-agent-state-architecture.md.');
  } catch {
    // A version probe is a hint. Losing it changes nothing about server status.
  }
}

/**
 * Show status for a single server (main or issue-specific)
 */
async function showSingleStatus(issueNo?: number): Promise<void> {
  const pidFilePath = getPidFilePath(issueNo);
  const envPath = getEnvPath(issueNo);

  // Issue #1266: getStatus() resolves CM_PORT/CM_BIND from this .env, giving it precedence
  // over exported variables the way the server itself was started
  const daemonManager = new DaemonManager(pidFilePath, envPath);
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

  printVersionInfo(status);

  if (status.port) {
    console.log(`Port:    ${status.port}`);
  }

  if (status.uptime !== undefined) {
    console.log(`Uptime:  ${CLILogger.formatDuration(status.uptime)}`);
  }

  if (status.url) {
    console.log(`URL:     ${status.url}`);
  }

  // Issue #2113: the advertised localhost URL may not reach this server at all
  printLocalhostConflict(status);

  // Issue #2123 / #2124: whether Web Push can work at all on this server
  printVapidStatus(daemonManager.getEffectiveEnv());
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

  // Once for the whole listing: the probe cache is process-level, so repeating
  // it per server would print the same skew N times for one measurement.
  await printDetectorFreshness();

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

    // Issue #1266: getStatus() resolves CM_PORT/CM_BIND from this .env, giving it precedence
    // over exported variables the way the server itself was started
    const daemonManager = new DaemonManager(pidFilePath, envPath);
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

    printVersionInfo(status);

    if (status.port) {
      console.log(`Port:    ${status.port}`);
    }

    if (status.uptime !== undefined) {
      console.log(`Uptime:  ${CLILogger.formatDuration(status.uptime)}`);
    }

    if (status.url) {
      console.log(`URL:     ${status.url}`);
    }

    // Issue #2113: the advertised localhost URL may not reach this server at all
    printLocalhostConflict(status);

    // Issue #2123 / #2124: whether Web Push can work at all on this server
    printVapidStatus(daemonManager.getEffectiveEnv());

    // Issue #332: Show IP restriction status
    // Issue #1266: read the env the server actually runs with. An exported CM_ALLOWED_IPS
    // shadowed the .env one here, reporting an ACL the server does not enforce.
    const allowedIps = daemonManager.getEffectiveEnv().CM_ALLOWED_IPS;
    if (allowedIps) {
      console.log(`IP ACL:  ${allowedIps}`);
    }

    // Issue #1929: the other authenticated surface §4 D2 exposes detector
    // staleness on (the first is `capture --json`). Only reached on a running
    // server, where a detection skew is something the operator can act on.
    await printDetectorFreshness();

    console.log('');

    process.exit(ExitCode.SUCCESS);
  } catch (error) {
    const message = getErrorMessage(error);
    logger.error(`Status check failed: ${message}`);
    process.exit(ExitCode.UNEXPECTED_ERROR);
  }
}
