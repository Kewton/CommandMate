/**
 * remote Command - expose this server to a phone and pair it with a QR code
 * Issue #1937 (R9). Design: `docs/design/remote-qr-pairing-1937.md` §5, §6.2.
 *
 *   commandmate remote            # up (default): start, publish, show the QR
 *   commandmate remote status     # Provider / URL / expiry / pairing state
 *   commandmate remote stop       # close the door, keeping the server running
 *
 * ## What lives here rather than in a Provider (§6.2)
 *
 * Two things, and both for the same reason — they are decisions about an
 * IRREVERSIBLE act (putting this machine on a network it was not on), and a
 * decision buried in a probe helper is a decision nobody reviews:
 *
 *  1. **Which Provider runs.** `detectRemoteProviders()` returns every Provider
 *     in preference order and picks none. "Tailscale first, and never fall
 *     through to a public tunnel on its own" is a rule about selection, so it
 *     is written here, once, as {@link selectProvider}.
 *  2. **Whether a public tunnel may be created at all.** A prompt inside a
 *     Provider would have to re-derive interactive-vs-not per Provider, and its
 *     answer would be invisible to the caller that has to honour `--yes`.
 *
 * ## What this command deliberately does not have
 *
 *  - **`--token`.** `remote` is the side that MINTS a token; one supplied from
 *    outside has no hash on the server to match (§5.1).
 *  - **`--auto-yes` in any form.** Auto-Yes state is an in-memory map that is
 *    empty at server start, so a freshly started server has it off for every
 *    worktree. Not offering a flag is what keeps it that way (§5.5); a test
 *    pins that the launch env carries no Auto-Yes key either.
 *  - **Anything that stops the server on expiry.** `--expires` closes the
 *    outside door only. A `commandmate stop` on a timer would take the user's
 *    local session down along with the remote one (§5.3).
 */

import { Command } from 'commander';

import { ExitCode, getErrorMessage } from '../types';
import type { RemoteOptions } from '../types';
import {
  QUICK_TUNNEL_APPROVAL_QUESTION,
  QUICK_TUNNEL_APPROVAL_REQUIRED,
  QUICK_TUNNEL_APPROVAL_WARNING,
} from '../config/security-messages';
import { DaemonManager } from '../utils/daemon';
import { getPidFilePath } from '../utils/env-setup';
import { CLILogger } from '../utils/logger';
import { closeReadline, confirm, isInteractive } from '../utils/prompt';
import { formatQrForTerminal } from '../utils/qr-terminal';
import {
  REMOTE_STATE_SCHEMA_VERSION,
  readRemoteState,
  removeRemoteState,
  writeRemoteState,
  type RemoteState,
} from '../utils/remote-state';
import { logSecurityEvent } from '../utils/security-logger';
import { waitForServer } from '../utils/server-ready';
import {
  createRemoteProviders,
  detectRemoteProviders,
  type ProviderCandidate,
  type RemoteHandle,
  type RemoteProviderId,
  type StopOutcome,
} from '../../lib/remote';
import { generateToken, hashToken, parseDuration } from '../../lib/security/auth';
import { consumePairingHandoff, createPairingHandoff } from '../../lib/security/pairing-code';
import { existsSync } from 'fs';
import { runStart } from './start';

const logger = new CLILogger();

/** Default remote-session TTL. Follows `parseDuration`'s 1h-30d range (§5.1). */
export const DEFAULT_REMOTE_EXPIRES = '8h';

/** Default pairing-code TTL (§5.1). See {@link parsePairingDuration}. */
export const DEFAULT_PAIRING_EXPIRES = '10m';

/** Shortest pairing window: below a minute the QR cannot be scanned in time. */
export const MIN_PAIRING_TTL_MS = 60 * 1000;

/**
 * Longest pairing window.
 *
 * The handoff file holds the plaintext session token until the code is used
 * (§7.2), so this bound is the maximum time that plaintext sits on disk. It is
 * deliberately far below `--expires`' 30-day ceiling.
 */
export const MAX_PAIRING_TTL_MS = 24 * 60 * 60 * 1000;

/** What the user may type after `--provider`, and what it resolves to. */
export const REMOTE_PROVIDER_ALIASES: Readonly<Record<string, RemoteProviderId>> = {
  tailscale: 'tailscale-serve',
  'tailscale-serve': 'tailscale-serve',
  cloudflare: 'cloudflare-quick',
  'cloudflare-quick': 'cloudflare-quick',
};

/**
 * Providers that publish to the open internet rather than to a private network.
 *
 * Membership here is what triggers the explicit approval below, so this list —
 * not a Provider's own opinion of itself — is the thing to check when a
 * Provider is added.
 */
export const PUBLIC_TUNNEL_PROVIDERS: readonly RemoteProviderId[] = ['cloudflare-quick'];

/**
 * Every environment variable `remote` adds to the server it starts, and no
 * other (§9.1).
 *
 * All three are already-existing keys or a path:
 *
 *  - `CM_AUTH_TOKEN_HASH` / `CM_AUTH_EXPIRE` — what `start --auth` sets.
 *  - `CM_REMOTE_PAIRING_FILE` — a PATH, not a secret. The plaintext token and
 *    the pairing hash live in the 0600 file it names, because a pane spawned by
 *    `src/lib/tmux/**` inherits the server's environment wholesale, so anything
 *    put here would be readable by the very agents CommandMate is driving
 *    (§7.2).
 *
 * `tests/unit/cli/commands/remote-launch-env-1937.test.ts` holds the measured
 * set to this declaration in BOTH directions, the way
 * `agent-launch-plan-secrets-1933.test.ts` does for `prepareLaunch`. Adding a
 * key without adding it here goes red; so does removing one.
 */
export const REMOTE_LAUNCH_ENV_KEYS = [
  'CM_AUTH_TOKEN_HASH',
  'CM_AUTH_EXPIRE',
  'CM_REMOTE_PAIRING_FILE',
] as const;

/** Inputs of {@link buildRemoteLaunchEnv}. */
export interface RemoteLaunchEnvInput {
  /** SHA-256 of the session token. The token itself never reaches the env. */
  authTokenHash: string;
  /** The `--expires` duration string, verbatim, for `computeExpireAt()`. */
  authExpire: string;
  /** Absolute path of the 0600 pairing handoff file. */
  pairingFilePath: string;
}

/** Pairing state as reported by `remote status` (§5.4). */
export type PairingState = 'unused' | 'consumed' | 'expired';

/**
 * Build the exact environment `remote` contributes to the server it starts.
 *
 * Returned as a plain map rather than written straight into `process.env` so
 * the contribution is a value a test can compare against
 * {@link REMOTE_LAUNCH_ENV_KEYS} — "what did remote add" is otherwise only
 * observable by diffing a global.
 *
 * @param input - Hash, expiry and handoff path
 * @returns The three variables, and nothing else
 */
export function buildRemoteLaunchEnv(input: RemoteLaunchEnvInput): Record<string, string> {
  return {
    CM_AUTH_TOKEN_HASH: input.authTokenHash,
    CM_AUTH_EXPIRE: input.authExpire,
    CM_REMOTE_PAIRING_FILE: input.pairingFilePath,
  };
}

/**
 * Copy the launch env into `process.env`, where `daemon.ts` reads it.
 *
 * `runStart` -> `DaemonManager.start()` builds the child environment from
 * `process.env` plus `.env`, exactly as `start --auth` does, so this is the
 * hand-off point. Note what is NOT here: `CM_BIND` is neither read nor written
 * by `remote`, so a user already running `CM_BIND=0.0.0.0` keeps that setting
 * and a user on the 127.0.0.1 default keeps that one (§9.1).
 *
 * @param env - Output of {@link buildRemoteLaunchEnv}
 * @returns A function restoring the previous values, used on the rollback paths
 */
export function applyRemoteLaunchEnv(env: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * Parse a `--pairing-expires` duration.
 *
 * `parseDuration()` from `auth-config` is NOT reused here even though `remote`
 * uses it for `--expires`: its floor is 1 hour, and the pairing default is ten
 * minutes. Raising that floor would loosen `CM_AUTH_EXPIRE` for every caller of
 * a shared function, so the short-lived case gets its own bounds instead.
 *
 * @param value - Duration string (`Nm` or `Nh`)
 * @returns Duration in milliseconds
 * @throws Error when the format is wrong or the value is out of range
 */
export function parsePairingDuration(value: string): number {
  const match = value.match(/^(\d+)([mh])$/);
  if (!match) {
    throw new Error(`Invalid duration format: "${value}". Use Nm or Nh (e.g., "10m", "1h")`);
  }

  const ms = parseInt(match[1], 10) * (match[2] === 'h' ? 60 * 60 * 1000 : 60 * 1000);

  if (ms < MIN_PAIRING_TTL_MS) {
    throw new Error(`Pairing window too short: minimum is 1m. Got: "${value}"`);
  }
  if (ms > MAX_PAIRING_TTL_MS) {
    throw new Error(`Pairing window too long: maximum is 24h. Got: "${value}"`);
  }

  return ms;
}

/** Outcome of applying the selection rule to a probe result. */
export interface ProviderSelection {
  /** The Provider to use, when there is one. */
  candidate?: ProviderCandidate;
  /** Why there is none. Mutually exclusive with `candidate`. */
  error?: {
    exitCode: ExitCode;
    message: string;
    /** One line per Provider, so the user sees what was tried and why it failed. */
    details: string[];
  };
}

/**
 * Apply the Provider selection rule (§6.2).
 *
 * The rule, in full:
 *
 *  - `--provider` names exactly one Provider. An unusable one is an error, not
 *    a reason to try another: the user asked for that one.
 *  - Without `--provider`, the first READY Provider in preference order wins.
 *    Preference order puts Tailscale (private tailnet) ahead of the Cloudflare
 *    Quick Tunnel (public internet).
 *  - Being chosen is never enough to be started. A Provider in
 *    {@link PUBLIC_TUNNEL_PROVIDERS} still has to clear the explicit approval
 *    in {@link approvePublicTunnel}, which is what makes "Tailscale failed, so
 *    it silently published me to the internet" impossible rather than merely
 *    unlikely.
 *  - No Provider ready is `DEPENDENCY_ERROR`, never a fallback.
 *
 * Pure: it neither probes nor prompts, so the rule can be tested without a
 * Provider being installed.
 *
 * @param candidates - `detectRemoteProviders()` output, in preference order
 * @param requested - The raw `--provider` value, if any
 * @returns The chosen candidate, or the error to exit with
 */
export function selectProvider(
  candidates: readonly ProviderCandidate[],
  requested?: string
): ProviderSelection {
  const details = candidates.map(
    ({ provider, detection }) =>
      `${provider.id}: ${describeDetection(detection.available, detection.ready)}${
        detection.reason ? ` (${detection.reason})` : ''
      }`
  );

  if (requested !== undefined) {
    const wanted = REMOTE_PROVIDER_ALIASES[requested.trim().toLowerCase()];
    if (wanted === undefined) {
      return {
        error: {
          exitCode: ExitCode.CONFIG_ERROR,
          message: `Unknown --provider value: "${requested}". Valid values: tailscale, cloudflare.`,
          details: [],
        },
      };
    }

    const match = candidates.find(({ provider }) => provider.id === wanted);
    if (match === undefined || !match.detection.ready) {
      return {
        error: {
          exitCode: ExitCode.DEPENDENCY_ERROR,
          message: `Provider "${wanted}" is not usable on this machine.`,
          details,
        },
      };
    }
    return { candidate: match };
  }

  const ready = candidates.find(({ detection }) => detection.ready);
  if (ready === undefined) {
    return {
      error: {
        exitCode: ExitCode.DEPENDENCY_ERROR,
        message:
          'No remote provider is usable on this machine. Install and log in to Tailscale, or install cloudflared.',
        details,
      },
    };
  }
  return { candidate: ready };
}

/**
 * @param available - Whether the executable exists
 * @param ready - Whether it could serve right now
 * @returns A short phrase for the `--provider` diagnosis lines
 */
function describeDetection(available: boolean, ready: boolean): string {
  if (!available) return 'not installed';
  return ready ? 'ready' : 'installed but not ready';
}

/**
 * Ask before anything public is created.
 *
 * Non-interactive without `--yes` is a refusal, not a silent yes: a scripted
 * invocation must not be able to publish the machine because nobody was there
 * to object (§6.4).
 *
 * @param options - Parsed command options (`--yes`, `--json`)
 * @returns true when the tunnel may be created
 */
async function approvePublicTunnel(options: RemoteOptions): Promise<boolean> {
  if (options.yes) {
    return true;
  }

  if (!isInteractive()) {
    logger.error(QUICK_TUNNEL_APPROVAL_REQUIRED);
    return false;
  }

  console.log(QUICK_TUNNEL_APPROVAL_WARNING);
  const approved = await confirm(QUICK_TUNNEL_APPROVAL_QUESTION, { default: false });
  closeReadline();

  if (!approved) {
    logger.info('Aborted. Nothing was exposed.');
  }
  return approved;
}

/** Host and port to dial, parsed out of the URL `runStart` reported. */
interface Endpoint {
  host: string;
  port: number;
}

/**
 * @param url - URL as reported by `runStart`
 * @returns The endpoint, or null when the URL is unusable
 */
function parseEndpoint(url: string | undefined): Endpoint | null {
  if (url === undefined) return null;
  try {
    const parsed = new URL(url);
    const port = parsed.port ? parseInt(parsed.port, 10) : parsed.protocol === 'https:' ? 443 : 80;
    if (Number.isNaN(port)) return null;
    return { host: parsed.hostname, port };
  } catch {
    return null;
  }
}

/**
 * Make sure the server this session starts is one `remote` can pair with.
 *
 * The awkward case is a server that is already running WITH auth: its token
 * hash was fixed from its own environment at startup and CommandMate never kept
 * the plaintext, so there is no cookie value a pairing could hand out, and the
 * environment of a running process cannot be added to (§1.2 C, U-4). Restarting
 * it uninvited would drop live sessions, so this stops and says why.
 *
 * @param daemonManager - Manager for the main server's PID file
 * @param options - Parsed command options (for `--yes` / interactivity)
 * @returns An exit code to stop on, or null to continue
 */
async function ensureNoConflictingServer(
  daemonManager: DaemonManager,
  options: RemoteOptions
): Promise<ExitCode | null> {
  if (!(await daemonManager.isRunning())) {
    return null;
  }

  const status = await daemonManager.getStatus();

  if (status?.auth) {
    logger.error(
      `A CommandMate server is already running with authentication enabled (PID: ${status.pid}).`
    );
    logger.info(
      'Its token was fixed at startup and CommandMate did not keep the plaintext, so this session cannot pair with it.'
    );
    logger.info('Stop it with "commandmate stop" and run "commandmate remote" again.');
    return ExitCode.CONFIG_ERROR;
  }

  logger.warn(
    `A CommandMate server is already running without authentication (PID: ${status?.pid}).`
  );
  logger.info('Exposing it remotely requires restarting it with authentication enabled.');

  if (!options.yes) {
    if (!isInteractive()) {
      logger.error(
        'Refusing to restart the running server without approval. Re-run with --yes, or stop it yourself first.'
      );
      return ExitCode.CONFIG_ERROR;
    }

    const approved = await confirm('Stop it and start a new server for this remote session?', {
      default: false,
    });
    closeReadline();
    if (!approved) {
      logger.info('Aborted. The running server was left alone.');
      return ExitCode.CONFIG_ERROR;
    }
  }

  if (!(await daemonManager.stop())) {
    logger.error('Failed to stop the running server.');
    // START_FAILED, not STOP_FAILED: the command the user ran is `remote up`,
    // and what it failed to do is bring up a server it can pair with. §5.2
    // reserves STOP_FAILED for `remote stop`'s own cleanup.
    return ExitCode.START_FAILED;
  }

  return null;
}

/**
 * Run the `up` flow: start, publish, pair (§5.3, steps 1-9).
 *
 * @param options - Parsed command options
 * @returns The exit code the caller should terminate with
 */
export async function runRemoteUp(options: RemoteOptions): Promise<ExitCode> {
  const expires = options.expires ?? DEFAULT_REMOTE_EXPIRES;
  const pairingExpires = options.pairingExpires ?? DEFAULT_PAIRING_EXPIRES;

  let expiresMs: number;
  try {
    expiresMs = parseDuration(expires);
  } catch (error) {
    logger.error(`Invalid --expires value: ${getErrorMessage(error)}`);
    return ExitCode.CONFIG_ERROR;
  }

  let pairingTtlMs: number;
  try {
    pairingTtlMs = parsePairingDuration(pairingExpires);
  } catch (error) {
    logger.error(`Invalid --pairing-expires value: ${getErrorMessage(error)}`);
    return ExitCode.CONFIG_ERROR;
  }

  // 1. Probe every Provider, then apply the selection rule here (§6.2).
  const candidates = await detectRemoteProviders();
  const selection = selectProvider(candidates, options.provider);
  if (selection.error !== undefined || selection.candidate === undefined) {
    const failure = selection.error;
    logger.error(failure?.message ?? 'No remote provider is usable on this machine.');
    for (const line of failure?.details ?? []) {
      logger.info(`  ${line}`);
    }
    logSecurityEvent({
      timestamp: new Date().toISOString(),
      command: 'remote',
      action: 'failure',
      details: `up: no provider selected (${failure?.exitCode ?? ExitCode.DEPENDENCY_ERROR})`,
    });
    return failure?.exitCode ?? ExitCode.DEPENDENCY_ERROR;
  }

  const { provider } = selection.candidate;
  logger.success(`Provider: ${provider.id}`);

  if (PUBLIC_TUNNEL_PROVIDERS.includes(provider.id) && !(await approvePublicTunnel(options))) {
    logSecurityEvent({
      timestamp: new Date().toISOString(),
      command: 'remote',
      action: 'failure',
      details: `up: public tunnel not approved (${provider.id})`,
    });
    return ExitCode.CONFIG_ERROR;
  }

  // 2. A server already up cannot be given a pairing file after the fact.
  const daemonManager = new DaemonManager(getPidFilePath());
  const conflict = await ensureNoConflictingServer(daemonManager, options);
  if (conflict !== null) {
    return conflict;
  }

  // 3/4. Mint the session token and the pairing code. Neither is persisted in
  // plaintext anywhere except the 0600 handoff file, which the server consumes
  // and deletes on the first successful pairing.
  const sessionToken = generateToken();
  const authTokenHash = hashToken(sessionToken);
  const pairing = createPairingHandoff({ ttlMs: pairingTtlMs, sessionToken });

  // 5. Start the server through the existing exit-free core. Not reimplemented:
  // `runStart` already owns .env loading, port allocation and the daemon spawn.
  const restoreEnv = applyRemoteLaunchEnv(
    buildRemoteLaunchEnv({ authTokenHash, authExpire: expires, pairingFilePath: pairing.filePath })
  );

  logger.info('Starting the CommandMate server...');
  const started = await runStart({ daemon: true, port: options.port });
  if (!started.ok) {
    consumePairingHandoff(pairing.filePath);
    restoreEnv();
    return started.exitCode;
  }

  const endpoint = parseEndpoint(started.url);
  if (endpoint === null) {
    logger.error(`Could not determine the server endpoint from "${started.url}".`);
    await rollback(daemonManager, pairing.filePath, restoreEnv);
    return ExitCode.START_FAILED;
  }

  // 6. Wait for the listener. Unlike quickstart, a timeout is fatal here: the
  // next step publishes this endpoint, and fronting a socket that never opened
  // hands the user a public URL that answers nothing.
  logger.info('Waiting for the server to become ready...');
  if (!(await waitForServer(endpoint.host, endpoint.port))) {
    logger.error('The server did not start listening in time.');
    await rollback(daemonManager, pairing.filePath, restoreEnv);
    return ExitCode.START_FAILED;
  }
  logger.success(`Server: ${started.url} (pid ${started.pid})`);

  // 7. Open the outside door. The Provider is handed 127.0.0.1 explicitly; it
  // never reads CM_BIND (§9.1).
  let handle: RemoteHandle;
  try {
    handle = await provider.start({ port: endpoint.port, signal: new AbortController().signal });
  } catch (error) {
    logger.error(`Provider ${provider.id} failed to start: ${getErrorMessage(error)}`);
    await rollback(daemonManager, pairing.filePath, restoreEnv);
    logSecurityEvent({
      timestamp: new Date().toISOString(),
      command: 'remote',
      action: 'failure',
      details: `up: provider start failed (${provider.id})`,
    });
    return ExitCode.START_FAILED;
  }
  logger.success(`URL: ${handle.url}`);

  // 8. Record the handle. Without it `remote stop` has no receipt, and §6.3-4
  // forbids guessing - so a session that cannot be recorded is rolled back
  // rather than left running with no way to prove what it created.
  const now = Date.now();
  const state: RemoteState = {
    schemaVersion: REMOTE_STATE_SCHEMA_VERSION,
    provider: handle.provider,
    url: handle.url,
    startedAt: new Date(now).toISOString(),
    expiresAt: now + expiresMs,
    pairing: { filePath: pairing.filePath, expiresAt: pairing.expiresAt },
    handle,
    server: { pid: started.pid ?? null, port: endpoint.port },
  };

  try {
    writeRemoteState(state);
  } catch (error) {
    logger.error(`Failed to record the remote session: ${getErrorMessage(error)}`);
    await closeRemoteSession(state);
    await rollback(daemonManager, pairing.filePath, restoreEnv);
    return ExitCode.START_FAILED;
  }

  // 9. The one and only display of the pairing code.
  const pairingUrl = buildPairingUrl(handle.url, pairing.code);
  if (!options.json) {
    announcePairing(pairingUrl);
  }

  logSecurityEvent({
    timestamp: new Date().toISOString(),
    command: 'remote',
    action: 'success',
    // Neither the pairing code nor the token appears here (§5.2).
    details: `up: provider=${handle.provider} port=${endpoint.port}`,
  });

  if (options.json) {
    // NOT a pure-JSON stream, and saying so is better than implying otherwise:
    // `up` runs `runStart`, whose own progress lines go to stdout and which
    // this command does not reimplement. The object below is the LAST line of
    // stdout, so a machine caller reads that line rather than piping the whole
    // stream. `status` and `stop` print nothing else and pipe cleanly.
    console.log(
      JSON.stringify(
        {
          action: 'up',
          provider: state.provider,
          url: state.url,
          // The one-time display, in the form a machine caller can use. `status`
          // never emits this field - the code is shown by `up` or not at all.
          pairingUrl,
          expiresAt: new Date(state.expiresAt).toISOString(),
          pairing: { expiresAt: new Date(state.pairing.expiresAt).toISOString() },
          server: { pid: state.server.pid, port: state.server.port, url: started.url },
        },
        null,
        2
      )
    );
  }

  return ExitCode.SUCCESS;
}

/**
 * Undo a half-finished `up`.
 *
 * The handoff file goes first and unconditionally: it is the only plaintext
 * copy of a token for a server that is about to stop existing.
 *
 * @param daemonManager - Manager for the server started by this invocation
 * @param pairingFilePath - Handoff file to delete
 * @param restoreEnv - Undo for {@link applyRemoteLaunchEnv}
 */
async function rollback(
  daemonManager: DaemonManager,
  pairingFilePath: string,
  restoreEnv: () => void
): Promise<void> {
  consumePairingHandoff(pairingFilePath);
  restoreEnv();
  try {
    await daemonManager.stop();
  } catch (error) {
    logger.warn(`Could not stop the server that was just started: ${getErrorMessage(error)}`);
  }
}

/**
 * @param url - Public URL the Provider published
 * @param code - Plaintext pairing code
 * @returns The `/login#code=` URL the QR encodes
 */
export function buildPairingUrl(url: string, code: string): string {
  return `${url.replace(/\/+$/, '')}/login#code=${code}`;
}

/**
 * Print the QR, or the URL when no QR can be shown.
 *
 * `renderQrToTerminal` reports `fits: false` rather than emitting a symbol it
 * knows the terminal will soft-wrap, because a wrapped QR is unscannable. The
 * URL is printed as text ONLY in that case: it carries the pairing code, so
 * putting it in the scrollback of every successful run would leave a live
 * credential in the terminal history for no benefit.
 *
 * @param pairingUrl - The `/login#code=` URL
 */
function announcePairing(pairingUrl: string): void {
  const qr = formatQrForTerminal(pairingUrl, {
    columns: process.stdout.columns,
    color: process.stdout.isTTY === true,
  });

  logger.blank();
  if (qr === null) {
    logger.warn('This terminal is too narrow for a scannable QR code. Open this URL instead:');
    logger.info(`  ${pairingUrl}`);
  } else {
    console.log(qr);
    logger.info('Scan this with your phone. The code works once, and only until it expires.');
  }
  logger.blank();
}

/**
 * Decide what to report on the `Pairing:` line (§5.4).
 *
 * The absence of the handoff file IS the consumed flag (§7.2) - the route
 * unlinks it between verifying the code and setting the cookie - so absence is
 * reported as `consumed` rather than being guessed at from the clock.
 *
 * @param handoffPresent - Whether the handoff file still exists
 * @param pairingExpiresAt - Epoch ms the code dies at
 * @param now - Epoch ms, injectable for tests
 * @returns The state to display
 */
export function derivePairingState(
  handoffPresent: boolean,
  pairingExpiresAt: number,
  now: number = Date.now()
): PairingState {
  if (!handoffPresent) return 'consumed';
  return now > pairingExpiresAt ? 'expired' : 'unused';
}

/**
 * Format a millisecond delta the way `remote status` shows expiry.
 *
 * @param ms - Milliseconds remaining; zero or less reads as expired
 * @returns e.g. `in 6h 12m`, or `expired`
 */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return 'expired';
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `in ${minutes}m`;
  return `in ${hours}h ${minutes % 60}m`;
}

/**
 * Close the outside door for a recorded session.
 *
 * Everything about this routine is shaped by §6.3: the Provider is handed the
 * recorded `RemoteHandle` and nothing else, so it can only undo what
 * CommandMate created; anything the handle also found already in place comes
 * back in `skipped` and is reported rather than removed. The state file is kept
 * when the revert did not complete, so a second `remote stop` can retry.
 *
 * @param state - The recorded session
 * @returns Whether the Provider reverted cleanly, plus what it reported
 */
async function closeRemoteSession(
  state: RemoteState
): Promise<{ ok: boolean; outcome?: StopOutcome; error?: string }> {
  // The plaintext token goes first, whatever happens to the Provider (§7.4).
  consumePairingHandoff(state.pairing.filePath);

  const provider = createRemoteProviders().find((entry) => entry.id === state.provider);
  if (provider === undefined) {
    return { ok: false, error: `Unknown provider in the state file: ${state.provider}` };
  }

  try {
    const outcome = await provider.stop(state.handle);
    if (outcome.reverted) {
      removeRemoteState();
    }
    return { ok: outcome.reverted, outcome };
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  }
}

/**
 * Report what the outcome of a Provider teardown was.
 *
 * @param outcome - What the Provider said it did
 */
function reportStopOutcome(outcome: StopOutcome | undefined): void {
  for (const skipped of outcome?.skipped ?? []) {
    logger.info(`  Left alone (existed before this session): ${skipped}`);
  }
  for (const warning of outcome?.warnings ?? []) {
    logger.warn(`  ${warning}`);
  }
}

/**
 * Run the `status` flow (§5.4).
 *
 * This is also where `--expires` is enforced in Phase 1: `up` starts the server
 * as a daemon and returns, so no `remote` process survives to hold a timer.
 * §5.3 allows either, and "the expiry is judged when `remote status` runs" is
 * the half that works without a resident process. It closes the Provider only -
 * the server keeps running, because the local user is still using it.
 *
 * @param options - Parsed command options
 * @returns The exit code the caller should terminate with
 */
export async function runRemoteStatus(options: RemoteOptions): Promise<ExitCode> {
  const state = readRemoteState();
  const server = await new DaemonManager(getPidFilePath()).getStatus();
  const now = Date.now();

  if (state === null) {
    if (options.json) {
      console.log(JSON.stringify({ action: 'status', remote: null, server }, null, 2));
    } else {
      logger.info('Provider:        (none - no remote session recorded)');
      logger.info(`Server:          ${describeServer(server)}`);
    }
    return ExitCode.SUCCESS;
  }

  // Read first: closing an expired session deletes the handoff file, and its
  // absence is what `derivePairingState` reads as "consumed". Asking afterwards
  // would report every expired session as having been paired.
  const pairing = derivePairingState(
    existsSync(state.pairing.filePath),
    state.pairing.expiresAt,
    now
  );

  const expired = now > state.expiresAt;
  let closed: { ok: boolean; outcome?: StopOutcome; error?: string } | null = null;
  if (expired) {
    closed = await closeRemoteSession(state);
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          action: 'status',
          remote: {
            provider: state.provider,
            // The URL is public information; the pairing code and the token are
            // not, and neither appears here or anywhere else in `status` (§5.4).
            url: state.url,
            startedAt: state.startedAt,
            expiresAt: new Date(state.expiresAt).toISOString(),
            expired,
            closed: closed === null ? null : closed.ok,
            pairing: {
              state: pairing,
              expiresAt: new Date(state.pairing.expiresAt).toISOString(),
            },
          },
          server,
        },
        null,
        2
      )
    );
  } else {
    logger.info(`Provider:        ${state.provider}`);
    logger.info(`URL:             ${state.url}`);
    logger.info(
      `Remote expires:  ${new Date(state.expiresAt).toISOString()} (${formatRemaining(state.expiresAt - now)})`
    );
    logger.info(`Pairing:         ${pairing}`);
    logger.info(`Server:          ${describeServer(server)}`);
  }

  if (closed !== null && !options.json) {
    if (closed.ok) {
      logger.info('The remote session expired and its provider was closed. The server is still running.');
    } else {
      logger.warn(`The remote session expired but could not be closed: ${closed.error ?? 'see below'}`);
      reportStopOutcome(closed.outcome);
    }
  }

  return ExitCode.SUCCESS;
}

/**
 * @param server - Daemon status, or null when there is no PID file
 * @returns The `Server:` line
 */
function describeServer(server: Awaited<ReturnType<DaemonManager['getStatus']>>): string {
  if (server === null || !server.running) return 'stopped';
  return `running (pid ${server.pid}, ${server.url}, auth: ${server.auth ? 'on' : 'off'})`;
}

/**
 * Run the `stop` flow (§6.3-4).
 *
 * With no readable state file this exits SUCCESS having done nothing. That is
 * the point, not a shortcut: the alternative is inferring a Provider and tearing
 * down whatever configuration it currently holds, and for Tailscale Serve that
 * configuration can be the user's own, with no way to restore it. `stop.ts`
 * treats a stale PID file with the same restraint.
 *
 * @param options - Parsed command options
 * @returns The exit code the caller should terminate with
 */
export async function runRemoteStop(options: RemoteOptions): Promise<ExitCode> {
  const state = readRemoteState();

  if (state === null) {
    if (options.json) {
      console.log(
        JSON.stringify({ action: 'stop', cleaned: false, reason: 'no-remote-state' }, null, 2)
      );
    } else {
      logger.info('No remote session is recorded, so there is nothing to clean up.');
      logger.info('Nothing was changed: CommandMate only undoes what it recorded creating.');
    }
    return ExitCode.SUCCESS;
  }

  const closed = await closeRemoteSession(state);
  if (!options.json) {
    reportStopOutcome(closed.outcome);
  }

  logSecurityEvent({
    timestamp: new Date().toISOString(),
    command: 'remote',
    action: closed.ok ? 'success' : 'failure',
    details: `stop: provider=${state.provider} reverted=${closed.ok}`,
  });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          action: 'stop',
          cleaned: closed.ok,
          provider: state.provider,
          skipped: closed.outcome?.skipped ?? [],
          warnings: closed.outcome?.warnings ?? [],
          error: closed.error ?? null,
        },
        null,
        2
      )
    );
  } else if (closed.ok) {
    logger.success(`Closed the ${state.provider} session. The CommandMate server is still running.`);
  } else {
    logger.error(`Failed to close the ${state.provider} session${closed.error ? `: ${closed.error}` : '.'}`);
    logger.info('The state file was kept so "commandmate remote stop" can be retried.');
  }

  return closed.ok ? ExitCode.SUCCESS : ExitCode.STOP_FAILED;
}

/**
 * Dispatch one `remote` invocation and terminate.
 *
 * The exit-free `run*` functions above are what the tests drive and what a
 * future caller (a `quickstart --remote`, say) would compose, exactly as
 * `runStart` / `startCommand` are split (#1195).
 *
 * @param action - `up` (default), `status` or `stop`
 * @param options - Parsed command options
 */
export async function remoteCommand(
  action: string | undefined,
  options: RemoteOptions
): Promise<void> {
  let exitCode: ExitCode;

  try {
    switch (action ?? 'up') {
      case 'up':
        exitCode = await runRemoteUp(options);
        break;
      case 'status':
        exitCode = await runRemoteStatus(options);
        break;
      case 'stop':
        exitCode = await runRemoteStop(options);
        break;
      default:
        logger.error(`Unknown action '${action}'. Valid actions: up, status, stop.`);
        exitCode = ExitCode.CONFIG_ERROR;
    }
  } catch (error) {
    logger.error(`remote failed: ${getErrorMessage(error)}`);
    logSecurityEvent({
      timestamp: new Date().toISOString(),
      command: 'remote',
      action: 'failure',
      details: `unexpected: ${getErrorMessage(error)}`,
    });
    exitCode = ExitCode.UNEXPECTED_ERROR;
  }

  process.exit(exitCode);
}

/**
 * Create the remote command.
 * [DR1-08] Factory pattern for addCommand() registration, as `createSyncCommand()`
 * and `createInstancesCommand()` do. `instances`' shape is followed too - a
 * default action with the verb as an optional positional - the only difference
 * being that the default here is `up` rather than a listing.
 *
 * @returns The configured commander command
 */
export function createRemoteCommand(): Command {
  const cmd = new Command('remote');
  cmd
    .description('Expose this server to your phone over a provider tunnel and pair it with a QR code')
    .argument('[action]', 'up (default), status, or stop')
    .option('--provider <name>', 'Force a provider instead of choosing one (tailscale or cloudflare)')
    .option('--expires <duration>', `Remote session TTL, 1h-30d (default: ${DEFAULT_REMOTE_EXPIRES})`)
    .option(
      '--pairing-expires <duration>',
      `Pairing code TTL, 1m-24h (default: ${DEFAULT_PAIRING_EXPIRES})`
    )
    .option('-p, --port <number>', 'Port for the server to expose', parseInt)
    .option('--yes', 'Approve creating a public tunnel without prompting (required when non-interactive)')
    .option('--json', 'JSON output')
    // Deliberately absent: --token (remote mints its own; see the file header)
    // and every --auto-yes flag (§5.5).
    .action(async (action: string | undefined, options: RemoteOptions) => {
      await remoteCommand(action, options);
    });
  return cmd;
}
