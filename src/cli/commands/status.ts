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
import { loadEnvFileValues } from '../utils/server-url';
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
  type VapidInspection,
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

/** `src/app/api/push/vapid/route.ts` — public key + a `configured` flag, no secrets. */
const VAPID_PROBE_PATH = '/api/push/vapid';

/**
 * Budget for the probe below. A loopback round trip to a healthy server is ~2ms;
 * anything near this bound is a server that cannot answer, and an unanswered
 * probe costs nothing but the fallback.
 */
const VAPID_PROBE_TIMEOUT_MS = 1000;

/**
 * Ask the running server whether it actually holds a VAPID key pair (Issue #2585).
 *
 * The daemon is the only process that can answer: it was handed its environment at
 * launch and has held it ever since, while every reader in this CLI is reconstructing
 * that environment from the outside. `GET /api/push/vapid` already exists for the web
 * client and returns `{configured, publicKey}` — the public key only, so this adds no
 * exposure that the browser did not already have.
 *
 * @returns The server's verdict, or `null` when it did not give one — unreachable,
 *   unauthenticated, answered by something that is not this server (#2113), or not
 *   JSON. Every one of those is "I do not know", never "not configured": inventing a
 *   warning out of a failed probe is how a diagnostic starts lying.
 */
async function probeServerVapid(baseUrl: string): Promise<boolean | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VAPID_PROBE_TIMEOUT_MS);

  try {
    // The one `process.env` read this path keeps, and deliberately: a token is a fact
    // about THIS invocation (the caller's credential), not about the daemon's
    // configuration. Without it an authenticated server answers 302 to /login, which
    // `redirect: 'manual'` keeps visible instead of following it to an HTML 200.
    const token = process.env.CM_AUTH_TOKEN;
    const response = await fetch(`${baseUrl}${VAPID_PROBE_PATH}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      redirect: 'manual',
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const payload: unknown = await response.json();
    const configured = (payload as { configured?: unknown } | null)?.configured;
    return typeof configured === 'boolean' ? configured : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fold the server's answer into the verdict read off its `.env` (Issue #2585).
 *
 * They disagree in exactly two ways, and both are real situations rather than
 * defensive padding:
 *
 * - **Server has keys, `.env` names none.** They were exported into the daemon at
 *   launch. Unsupported (`commandmate init` writes the file), but real, and warning
 *   about push being off on a server that is demonstrably sending it would be wrong.
 * - **Server has none, `.env` names both.** The file was edited after the daemon
 *   started. The warning stands — the running server still cannot send — and
 *   {@link explainVapidMismatch} adds the sentence that makes it actionable.
 *
 * The subject (#2124) is never reconciled, because the endpoint does not report it:
 * it stays whatever the `.env` says, which is the only VAPID value a running server
 * cannot be asked about.
 */
function reconcileVapid(
  fileVerdict: VapidInspection,
  serverConfigured: boolean | null
): VapidInspection {
  if (serverConfigured === null || serverConfigured === fileVerdict.configured) {
    return fileVerdict;
  }

  if (serverConfigured) {
    return {
      ...fileVerdict,
      configured: true,
      status: fileVerdict.subjectIssue === null ? 'ok' : 'invalid-subject',
    };
  }

  return { ...fileVerdict, configured: false, status: 'unconfigured' };
}

/**
 * The sentence that closes the gap between "push is off" and "but I set those keys!"
 * (Issue #2585) — appended to the shared lines, never replacing them.
 *
 * Both branches exist because both were measured: #2575 spent an investigation on a
 * shell that exported the pair for a server that never had it, and a `.env` edited
 * under a running daemon is the same confusion with the file in the shell's place.
 *
 * @returns Extra lines, or nothing at all when the report needs no qualifier.
 */
function explainVapidMismatch(
  verdict: VapidInspection,
  fileVerdict: VapidInspection,
  serverConfigured: boolean | null,
  envPath: string
): string[] {
  // Push works. Nothing is being reported, so there is nothing to qualify.
  if (verdict.configured) return [];

  if (serverConfigured === false && fileVerdict.configured) {
    return [
      `  ${envPath} does set both keys, so the running server predates that edit:`,
      '  restart it ("commandmate stop && commandmate start") to pick them up.',
    ];
  }

  // Names only, never values — the same rule the shared lines follow.
  const shellOnly = fileVerdict.missingKeys.filter(
    (key) => (process.env[key] ?? '').trim() !== ''
  );
  if (shellOnly.length === 0) return [];

  const pronoun = shellOnly.length > 1 ? 'them' : 'it';
  return [
    `  This shell exports ${shellOnly.join(' and ')}, but the server was not started`,
    `  with ${pronoun}: set ${pronoun} in ${envPath} and restart the server.`,
  ];
}

/**
 * Report the server's Web Push configuration, or nothing when it is healthy
 * (Issues #2123 / #2124 / #2585).
 *
 * The Issues' acceptance condition is "the startup log OR `commandmate status`",
 * and this is the half that is still readable a week later — a daemon started in
 * the background writes its stdout wherever the launcher put it, and the reader
 * who notices "my phone stopped buzzing" reaches for `status`.
 *
 * ## Who is asked, in order
 *
 *  1. **The running server**, over `GET /api/push/vapid`. It is the only party
 *     that knows what it was launched with, and #2585 is the proof that everything
 *     else is inference.
 *  2. **Its `.env` files alone** ({@link loadEnvFileValues}) — for the subject,
 *     which the endpoint does not report, and for the whole verdict when the probe
 *     comes back `null`.
 *
 * `process.env` is NOT a layer under either, which is the fix. This used to read
 * `getEffectiveEnv()`, whose `{...process.env, ...parsed}` reproduces what
 * `daemon.start()` hands the child — exact for a key the `.env` defines, a guess
 * for one it does not. `CM_VAPID_*` exported in the calling terminal therefore
 * read as the daemon's own configuration and silenced this warning for a server
 * that had none (#2575, measured 2026-09-16: `:60301` answered
 * `{"configured":false}` while `status` said nothing).
 *
 * ## When the server does not answer
 *
 * A stopped daemon never reaches this function — both callers return at
 * "Not running". A *running* daemon that does not answer (auth on with no
 * `CM_AUTH_TOKEN`, a wedged process, something else on the advertised port) falls
 * back to the `.env` verdict, and never to the shell. The residual is then the
 * mirror of the bug that was fixed: a pair exported into the daemon at launch and
 * absent from `.env` reads as unconfigured, i.e. a warning that is not warranted.
 * That direction is the deliberate one — a false warning names the variables and
 * the file and can be checked in one command, whereas the silence it replaces is
 * what #2575 could not diagnose at all.
 *
 * Silent on a healthy install — that silence is the negative control both Issues
 * ask for. Never throws: a diagnostic must not turn `status` into a failure.
 */
async function printVapidStatus(status: DaemonStatus, envPath: string): Promise<void> {
  try {
    const fileVerdict = inspectVapidConfig(loadEnvFileValues(envPath));
    const serverConfigured = status.url ? await probeServerVapid(status.url) : null;
    const verdict = reconcileVapid(fileVerdict, serverConfigured);

    const lines = formatVapidReportLines(verdict);
    if (lines.length === 0) return;

    console.log('');
    logger.warn(lines[0]);
    for (const line of lines.slice(1)) {
      console.log(line);
    }
    for (const line of explainVapidMismatch(verdict, fileVerdict, serverConfigured, envPath)) {
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
  // Issue #2585: asked of the server, and read off its .env — never off this shell
  await printVapidStatus(status, envPath);
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
    // Issue #2585: asked of the server, and read off its .env — never off this shell
    await printVapidStatus(status, envPath);

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
