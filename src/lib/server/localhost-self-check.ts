/**
 * Startup self-check: does the URL we tell users to open actually reach US?
 * Issue #2113
 *
 * CommandMate binds IPv4 `127.0.0.1` by default (server.ts, `CM_BIND`), but every
 * setup guide sends the user to `http://localhost:<port>`. On macOS `localhost`
 * resolves `::1` (IPv6) BEFORE `127.0.0.1`, and a `0.0.0.0`/`::` bind of ours never
 * covers `::1` either — so an unrelated process holding `::1:<port>` silently owns
 * the address the docs advertise. The browser then talks to that process while
 * CommandMate keeps reporting a healthy `> Ready on http://127.0.0.1:<port>`.
 *
 * Measured 2026-08-27 on develop 54e122a9: `127.0.0.1:3000` answered in 14ms while
 * `localhost:3000` and `[::1]:3000` both timed out after 10s against a stray Next.js
 * dev server. Because the squatter was also Next.js, the browser pulled chunks from
 * the WRONG app and rendered CommandMate's own `error.chunkReload.title`
 * ("Updating to the latest version") — an error screen that looks like ours while
 * not being served by us at all.
 *
 * HOW IDENTITY IS DECIDED (the part that has to be exact):
 *
 * The probe sends a GET to `<protocol>://localhost:<port>/api/auth/status` carrying a
 * one-shot random nonce in `x-cm-self-check`, and our own HTTP server carries a
 * temporary `prependListener('request')` that watches for that nonce. The verdict comes
 * from OUR OWN OBSERVATION of the request, never from trusting the response body:
 *
 *   observed the nonce            -> 'self'         (the advertised URL reaches us)
 *   got an HTTP response, no nonce-> 'foreign'      (something else answered)  <- WARN
 *   connection error / timeout    -> 'unreachable'  (nothing there; browsers fall
 *                                                    through to 127.0.0.1)     <- silent
 *
 * `/api/auth/status` is deliberately an EXISTING endpoint (it is in
 * AUTH_EXCLUDED_PATHS, touches no DB and mutates nothing), so no diagnostic route had
 * to be added. Nothing in the verdict depends on what it returns, which is why the
 * check still works with auth on, with an IP ACL that would 403 us, and against an
 * HTTPS server with a self-signed certificate.
 *
 * FAIL-OPEN IS THE CONTRACT. Nothing here throws, nothing here blocks `listen`, and
 * only the 'foreign' verdict produces output. 'unreachable' is deliberately silent:
 * an empty `::1` is the NORMAL case on a machine where nothing squats the port, and
 * Node's Happy Eyeballs (and every browser) then falls through to `127.0.0.1`.
 *
 * @module lib/server/localhost-self-check
 */

import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'http';
import { request as httpsRequest } from 'https';
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
// Relative, NOT `@/cli/utils/...`: this module is pulled into the CLI program by
// src/cli/commands/status.ts, and tsconfig.cli.json resets `paths` to {} — an alias
// import here would break `npm run build:cli`. Same reason as version-probes.ts.
import { getConfigDir } from '../../cli/utils/install-context';

/** Header the probe request carries its nonce in */
export const SELF_CHECK_HEADER = 'x-cm-self-check';

/**
 * Endpoint the probe targets. Existing route, in AUTH_EXCLUDED_PATHS
 * (src/config/auth-config.ts), no DB access, no side effects.
 */
export const SELF_CHECK_PATH = '/api/auth/status';

/** Hostname the docs advertise, and therefore the one under test */
export const SELF_CHECK_HOSTNAME = 'localhost';

/** How long to wait for either the nonce observation or a response */
export const SELF_CHECK_TIMEOUT_MS = 3000;

/**
 * Directory (under the config dir) the conflict records live in.
 *
 * `logs/` and not a dedicated `self-check/`: in a local install `getConfigDir()` is the
 * repository checkout itself, and `.gitignore` already ignores `logs/` there (it does
 * the same for `data/`, `skills/`, `temp/` — "service-owned runtime state lands at the
 * repo root"). A new top-level directory would show up as an untracked change in the
 * user's own repository, which for a worktree manager means dirtying a repo it also
 * displays. The record is diagnostic output keyed by port, so `logs/` fits it anyway.
 */
export const SELF_CHECK_DIR_NAME = 'logs';

/** Filename prefix of a conflict record inside {@link SELF_CHECK_DIR_NAME} */
export const SELF_CHECK_FILE_PREFIX = 'self-check-';

/**
 * What the startup probe concluded.
 *
 * Only `foreign` is actionable; see the module header for why `unreachable` is silent.
 */
export type LocalhostProbeVerdict = 'self' | 'foreign' | 'unreachable';

/**
 * The record a conflicted server leaves behind for `commandmate status`.
 *
 * `pid` is what makes the record trustworthy: `status` only reports it when it matches
 * the PID it just read out of the state file, so a record left by an earlier server on
 * the same port can never be attributed to the current one.
 */
export interface LocalhostConflictRecord {
  /** Port the conflict was observed on */
  port: number;
  /** PID of the CommandMate server that observed it */
  pid: number;
  /** CM_BIND as configured */
  bind: string;
  /** URL CommandMate actually listens on */
  boundUrl: string;
  /** URL that was probed, i.e. the one the documentation advertises */
  probedUrl: string;
  /** ISO timestamp of the observation */
  detectedAt: string;
}

/**
 * The slice of `http.Server` the probe needs. Structural on purpose: tests hand it a
 * real `http.Server`, and nothing here should be able to touch the rest of the server.
 */
export interface RequestObserver {
  prependListener(event: 'request', listener: (req: IncomingMessage, res: ServerResponse) => void): unknown;
  removeListener(event: 'request', listener: (req: IncomingMessage, res: ServerResponse) => void): unknown;
}

/** Options for {@link probeLocalhostIdentity} */
export interface ProbeLocalhostOptions {
  /** Our own HTTP(S) server, used to observe the probe request landing on us */
  server: RequestObserver;
  /** Port the server listens on */
  port: number;
  /** Protocol the server speaks (default: 'http') */
  protocol?: 'http' | 'https';
  /** Hostname to probe (default: {@link SELF_CHECK_HOSTNAME}); overridden in tests */
  host?: string;
  /** Request path (default: {@link SELF_CHECK_PATH}) */
  path?: string;
  /** Deadline for the whole probe (default: {@link SELF_CHECK_TIMEOUT_MS}) */
  timeoutMs?: number;
  /** Nonce override; generated per call when omitted */
  nonce?: string;
}

/**
 * Ask "if a user opens the URL we advertise, do they reach this process?".
 *
 * Resolves as soon as the answer is known — the nonce observation fires on our
 * server's `request` event, i.e. when headers arrive, so a 'self' verdict does not
 * wait for Next.js to render or compile the route.
 *
 * Never rejects.
 */
export async function probeLocalhostIdentity(
  options: ProbeLocalhostOptions
): Promise<LocalhostProbeVerdict> {
  const {
    server,
    port,
    protocol = 'http',
    host = SELF_CHECK_HOSTNAME,
    path = SELF_CHECK_PATH,
    timeoutMs = SELF_CHECK_TIMEOUT_MS,
  } = options;

  const nonce = options.nonce ?? randomBytes(16).toString('hex');

  return new Promise<LocalhostProbeVerdict>((resolve) => {
    let settled = false;
    let observed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Prepended so we read the header before server.ts's own request handler can
    // rewrite anything on it.
    const listener = (req: IncomingMessage): void => {
      const seen = req?.headers?.[SELF_CHECK_HEADER];
      const value = Array.isArray(seen) ? seen[0] : seen;
      if (value === nonce) {
        observed = true;
        settle('self');
      }
    };

    const settle = (verdict: LocalhostProbeVerdict): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      try {
        server.removeListener('request', listener);
      } catch {
        // A server that cannot detach a listener is still not a reason to fail startup.
      }
      resolve(verdict);
    };

    try {
      server.prependListener('request', listener);
    } catch {
      // Without the observer there is no way to tell 'self' from 'foreign'; declaring
      // 'foreign' here would warn on a perfectly healthy machine.
      resolve('unreachable');
      return;
    }

    timer = setTimeout(() => settle(observed ? 'self' : 'unreachable'), timeoutMs);

    let req;
    try {
      const send = protocol === 'https' ? httpsRequest : httpRequest;
      req = send({
        host,
        port,
        path,
        method: 'GET',
        headers: {
          [SELF_CHECK_HEADER]: nonce,
          'user-agent': 'commandmate-self-check',
        },
        // A self-signed certificate is the documented local HTTPS setup
        // (`mkcert localhost`, see `commandmate start --cert`), so verifying here
        // would turn every such install's check into a silent 'unreachable'.
        // Skipping verification is safe HERE and only here: the verdict comes from
        // our own in-process observation rather than from trusting the peer, the
        // request carries no credentials, and its only payload is a random nonce
        // that means nothing to anyone else. NODE_TLS_REJECT_UNAUTHORIZED is never
        // touched — this is scoped to this one request.
        ...(protocol === 'https' ? { rejectUnauthorized: false } : {}),
      });
    } catch {
      settle(observed ? 'self' : 'unreachable');
      return;
    }

    req.setTimeout(timeoutMs, () => {
      req.destroy();
    });

    req.on('response', (res: IncomingMessage) => {
      // Drain so the socket can close; the body is never inspected.
      res.resume();
      settle(observed ? 'self' : 'foreign');
    });

    req.on('error', () => {
      settle(observed ? 'self' : 'unreachable');
    });

    try {
      req.end();
    } catch {
      settle(observed ? 'self' : 'unreachable');
    }
  });
}

/**
 * Bracket a bare IPv6 literal so the result is a URL a user can paste. `localhost` and
 * dotted-quad hosts pass through untouched.
 */
function formatHostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * Build the dialable URL for a bind address, matching resolveServerEndpoint()'s rule
 * that a wildcard bind is reported as 127.0.0.1.
 */
export function formatBoundUrl(protocol: 'http' | 'https', bind: string, port: number): string {
  const host = bind === '0.0.0.0' ? '127.0.0.1' : bind;
  return `${protocol}://${formatHostForUrl(host)}:${port}`;
}

/**
 * The warning, as lines, shared by the startup log and `commandmate status` so the two
 * can never drift apart.
 */
export function formatLocalhostConflictWarning(record: LocalhostConflictRecord): string[] {
  return [
    `Another process is answering on ${record.probedUrl} — it is NOT this CommandMate server.`,
    `  CommandMate is listening on ${record.boundUrl} (CM_BIND=${record.bind}).`,
    `  "localhost" can resolve to ::1 (IPv6) first, and ${record.bind} does not cover ::1,`,
    '  so a browser opening the localhost URL reaches the other process instead.',
    `  Open ${record.boundUrl} instead, or free the port:`,
    `    lsof -nP -iTCP:${record.port} -sTCP:LISTEN`,
  ];
}

/** Directory holding the per-port conflict records */
export function getSelfCheckDir(): string {
  return join(getConfigDir(), SELF_CHECK_DIR_NAME);
}

/**
 * Path of the record for one port (`<configDir>/logs/self-check-<port>.json`).
 *
 * @throws Error when the port is not a plausible TCP port — the value becomes a
 *   filename, so it is validated rather than interpolated blindly.
 */
export function getSelfCheckStatePath(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port for self-check state path: ${String(port)}`);
  }
  return join(getSelfCheckDir(), `${SELF_CHECK_FILE_PREFIX}${port}.json`);
}

/**
 * Persist a conflict for `commandmate status` to read.
 *
 * @returns true when the record was written
 */
export function writeLocalhostConflict(record: LocalhostConflictRecord): boolean {
  try {
    const dir = getSelfCheckDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    writeFileSync(getSelfCheckStatePath(record.port), `${JSON.stringify(record)}\n`, {
      mode: 0o600,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the conflict recorded for a port.
 *
 * Never throws: `status` must keep working on an unreadable, truncated or
 * hand-edited record, and on a machine where the config dir cannot be resolved at all.
 *
 * @returns The record, or null when there is none (or it is unusable)
 */
export function readLocalhostConflict(port: number): LocalhostConflictRecord | null {
  try {
    const statePath = getSelfCheckStatePath(port);
    if (!existsSync(statePath)) {
      return null;
    }
    const parsed: unknown = JSON.parse(readFileSync(statePath, 'utf-8'));
    return isConflictRecord(parsed) && parsed.port === port ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Drop the record for a port. Called on every clean self-check and on shutdown, so a
 * fixed environment stops warning on the next start rather than needing a manual sweep.
 */
export function clearLocalhostConflict(port: number): void {
  try {
    const statePath = getSelfCheckStatePath(port);
    if (existsSync(statePath)) {
      unlinkSync(statePath);
    }
  } catch {
    // Best effort: a stale record is guarded by the PID comparison in `status`.
  }
}

/** Structural check for a record read back off disk */
function isConflictRecord(value: unknown): value is LocalhostConflictRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<LocalhostConflictRecord>;
  return (
    typeof r.port === 'number' &&
    typeof r.pid === 'number' &&
    typeof r.bind === 'string' &&
    typeof r.boundUrl === 'string' &&
    typeof r.probedUrl === 'string' &&
    typeof r.detectedAt === 'string'
  );
}

/** Options for {@link runLocalhostSelfCheck} */
export interface RunLocalhostSelfCheckOptions {
  /** Our own HTTP(S) server */
  server: RequestObserver;
  /** Port the server listens on */
  port: number;
  /** CM_BIND as configured */
  bind: string;
  /** Protocol the server speaks (default: 'http') */
  protocol?: 'http' | 'https';
  /** Hostname to probe (default: {@link SELF_CHECK_HOSTNAME}); overridden in tests */
  host?: string;
  /** Deadline for the probe */
  timeoutMs?: number;
  /** PID to stamp the record with (default: `process.pid`) */
  pid?: number;
  /** Clock, injectable for deterministic tests */
  now?: () => Date;
  /** Where the warning goes (default: `console.warn`) */
  warn?: (message: string) => void;
  /** Probe override, injected by tests */
  probe?: (options: ProbeLocalhostOptions) => Promise<LocalhostProbeVerdict>;
}

/**
 * Run the startup self-check and route its verdict to the log and the status file.
 *
 * Fail-open by construction: every path is wrapped, the function never rejects, and the
 * caller in server.ts does not await it. A `null` return means the check could not be
 * carried out at all — which is reported as nothing, exactly like 'unreachable'.
 *
 * @returns The verdict, or null when the check itself failed
 */
export async function runLocalhostSelfCheck(
  options: RunLocalhostSelfCheckOptions
): Promise<LocalhostProbeVerdict | null> {
  const {
    server,
    port,
    bind,
    protocol = 'http',
    host = SELF_CHECK_HOSTNAME,
    timeoutMs = SELF_CHECK_TIMEOUT_MS,
    pid = process.pid,
    now = () => new Date(),
    warn = (message: string) => console.warn(message),
    probe = probeLocalhostIdentity,
  } = options;

  try {
    const verdict = await probe({ server, port, protocol, host, timeoutMs });

    if (verdict !== 'foreign') {
      clearLocalhostConflict(port);
      return verdict;
    }

    const record: LocalhostConflictRecord = {
      port,
      pid,
      bind,
      boundUrl: formatBoundUrl(protocol, bind, port),
      probedUrl: `${protocol}://${formatHostForUrl(host)}:${port}`,
      detectedAt: now().toISOString(),
    };

    writeLocalhostConflict(record);
    for (const line of formatLocalhostConflictWarning(record)) {
      warn(line);
    }

    return verdict;
  } catch {
    // A diagnostic must never be the reason a server is considered unhealthy.
    return null;
  }
}
