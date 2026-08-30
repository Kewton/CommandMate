/**
 * Cloudflare Quick Tunnel Provider (Issue #1937, R2).
 *
 * Implements §6.4 of `docs/design/remote-qr-pairing-1937.md`. Everything below
 * that says "measured" was measured on 2026-08-29 against cloudflared 2025.4.0;
 * the raw capture is in `dev-reports/issue/1937/u3-quicktunnel-url.md`.
 *
 * ## Three properties this file is responsible for
 *
 * 1. **Nothing but loopback is ever exposed.** `LOOPBACK_HOST` is a constant and
 *    is never derived from an argument, so neither the upstream nor the metrics
 *    listener can be pointed anywhere else. That matters twice over for
 *    `--metrics`: `cloudflared tunnel --help` says its default address "binds to
 *    all interfaces" under a virtual environment. CommandMate defaults `CM_BIND`
 *    to 127.0.0.1, and opening a hole in the Provider's own diagnostics port
 *    would give that back.
 *
 * 2. **`stop()` only signals the process this module started.** A Quick Tunnel
 *    writes no persistent Provider configuration, so `preexisting` is `null` and
 *    `owned.revert` is `null`; the whole teardown is one SIGTERM to `owned.pid`.
 *    Measured: the process is gone in about a second and the public URL then
 *    answers HTTP 530. There is no reason to reach for any command that acts on
 *    "every tunnel this machine knows about", and
 *    `tests/unit/config/remote-destructive-command-guard.test.ts` forbids it.
 *    This is not hypothetical — the machine this was measured on had a named
 *    tunnel of the user's own running for nine days at the time.
 *
 * 3. **The URL comes from the metrics API first.** Measured order: the stderr
 *    banner appears at t+3s, the metrics server only at t+4s. So a loop that
 *    tried both every round would find the banner first every single time and
 *    `/quicktunnel` would be dead code. `METRICS_PREFERENCE_WINDOW_MS` is what
 *    keeps the first candidate actually first: for that long, only the metrics
 *    route is consulted.
 *
 * 4. **The tunnel outlives the CLI that started it.** `commandmate remote up`
 *    exits as soon as it has a URL — measured at about 6.5 seconds, taken from
 *    the metrics API. cloudflared has to still be there afterwards, because the
 *    whole point is a QR code someone reads with a phone a minute later. Two
 *    things make that true, and Issue #2146 is what happens without them:
 *    cloudflared's stderr goes to a **file descriptor, never a pipe**, and the
 *    child is spawned `detached` and `unref`ed.
 *
 *    Measured (Issue #2146, `docs/qa/1937-remote-uat-record.md` D-1): with
 *    `stdio: ['ignore', 'ignore', 'pipe']` the child was dead within two
 *    seconds of the parent exiting, and the public URL answered HTTP 530 before
 *    the QR code could be read. The parent's exit closes the read end of that
 *    pipe; cloudflared is Go, does not ignore SIGPIPE, and dies on its next
 *    write to fd 2 — which, at t+6.5s, is still mid log-burst. The same argv
 *    with a parent kept alive for 70 seconds gave a child that lived 70
 *    seconds, so this is the plumbing and not cloudflared giving up.
 *
 *    `'ignore'` would also have fixed it and is the wrong fix: it takes fd 2
 *    away entirely, and fd 2 is where both the **second URL candidate**
 *    (`parseBannerUrl`) and every failure diagnostic (`stderrTail`) come from.
 *    A file keeps both — nothing closes when the CLI exits, and the parser and
 *    the diagnostic read it back by path. `--logfile` was the other candidate:
 *    it covers cloudflared's own log lines but not anything the Go runtime or
 *    the loader writes straight to fd 2, so fd 2 would still have been a pipe.
 *    `'ignore'` for fd 2 is what this falls back to only when the log file
 *    cannot be opened at all: a diagnostic is worth less than a working tunnel.
 *
 * Deliberately absent: the approval prompt. Creating a public URL is an
 * irreversible, user-facing decision, and §6.2 puts it in the orchestrator that
 * owns `src/cli/commands/remote.ts` — the same code that knows whether the
 * session is interactive and whether `--yes` was passed.
 *
 * This module imports Node builtins and `./types` only. No `@/` alias, so the
 * orchestrator can pull it into the `tsconfig.cli.json` build (which sets
 * `paths: {}`) without the import failing to resolve.
 */
import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
  type SpawnOptions,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from 'child_process';
import { closeSync, fstatSync, mkdirSync, openSync, readSync } from 'fs';
import { createServer } from 'net';
import { get as httpGet } from 'http';
import { homedir } from 'os';
import { join } from 'path';

import {
  planStop,
  type RemoteHandle,
  type RemoteProvider,
  type ProviderDetection,
  type StopOutcome,
} from './types';

/** The executable. Looked up on PATH by `spawn`, never through a shell. */
export const CLOUDFLARED_BIN = 'cloudflared';

/** Mirrors `PreflightChecker.checkDependency()`: one flag, passed as an array. */
export const CLOUDFLARED_VERSION_ARG = '--version';

/**
 * The only host this Provider ever names.
 *
 * A constant rather than a parameter on purpose: "the upstream is always
 * loopback" is then a property of the code, not of every call site. §9.2 pins it
 * from the outside as well, by asserting the argv `start()` builds.
 */
export const LOOPBACK_HOST = '127.0.0.1';

/** Quick Tunnel hostnames live under this suffix, and nothing else does. */
export const QUICK_TUNNEL_SUFFIX = 'trycloudflare.com';

/** Written next to the rest of CommandMate's state, for humans and for `ps`. */
export const CLOUDFLARED_PIDFILE_NAME = 'cloudflared.pid';

/**
 * Where cloudflared's stderr goes. Beside the pidfile, and for the same reason:
 * a human who wants to know what the tunnel is doing should be able to find it.
 *
 * A fixed name, like the pidfile, so one `remote` session at a time is the
 * assumption in both places rather than in one of them.
 */
export const CLOUDFLARED_LOG_NAME = 'cloudflared.log';

/** Same 5s budget `PreflightChecker` gives every other dependency probe. */
export const DETECT_TIMEOUT_MS = 5_000;

/** How the wait for a public URL is paced. See `QuickTunnelTiming`. */
export interface QuickTunnelTiming {
  /** Total budget for the URL to appear before `start()` gives up. */
  urlWaitMs: number;
  /**
   * How long only `/quicktunnel` is consulted.
   *
   * Measured: the banner lands ~1s *before* the metrics server is listening. A
   * window shorter than that gap turns the documented first candidate into
   * something that never runs.
   */
  metricsPreferenceMs: number;
  /** Gap between polls. */
  pollIntervalMs: number;
}

export const DEFAULT_QUICK_TUNNEL_TIMING: QuickTunnelTiming = {
  urlWaitMs: 30_000,
  metricsPreferenceMs: 5_000,
  pollIntervalMs: 250,
};

/** Per-request budget for the loopback metrics call. */
export const METRICS_REQUEST_TIMEOUT_MS = 1_000;

/**
 * How much of the stderr log is read back, so a chatty reconnect loop cannot
 * make either consumer grow unbounded.
 *
 * The **tail**, not the head: `parseBannerUrl` takes the last match on purpose
 * (a reconnect banner should win), and `stderrTail` wants the last few lines.
 */
export const STDERR_CAPTURE_LIMIT = 64 * 1024;

/**
 * The part of a spawned cloudflared this module uses, and nothing more.
 *
 * No `stderr`: as of Issue #2146 fd 2 is a file, so there is no stream to read
 * and nothing here that could be tempted to hold one open. `unref` is required
 * rather than optional because forgetting it is exactly the class of mistake
 * this interface exists to make impossible.
 */
export interface QuickTunnelProcess {
  readonly pid?: number | undefined;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal?: NodeJS.Signals): boolean;
  /** Releases the parent's event-loop reference to this child. */
  unref(): unknown;
}

export type SpawnQuickTunnel = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => QuickTunnelProcess;

export type SpawnSyncProbe = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

/**
 * The seams that let this Provider be tested without a public tunnel.
 *
 * They are constructor arguments rather than members of the Provider because
 * `RemoteProvider` is pinned to exactly `id` / `detect` / `start` / `stop`
 * (§6.3-1): the returned object must not grow a fifth key.
 */
export interface CloudflareProviderDeps {
  spawn: SpawnQuickTunnel;
  spawnSync: SpawnSyncProbe;
  /** Signals a process. Defaults to `process.kill`. */
  kill: (pid: number, signal: NodeJS.Signals) => void;
  /** Picks the `--metrics` port. Bound on loopback, then released. */
  findFreePort: () => Promise<number>;
  /** The first URL candidate: `GET /quicktunnel` on the metrics listener. */
  fetchHostname: (metricsPort: number) => Promise<string | null>;
  /** Directory the pidfile goes in. */
  resolveStateDir: () => string;
  timing: QuickTunnelTiming;
}

/**
 * The argv for one Quick Tunnel.
 *
 * `LOOPBACK_HOST` appears twice and is a constant both times. `port` is the only
 * caller-supplied value that reaches the command line, and it is validated as a
 * port number before it gets here.
 */
export function buildQuickTunnelArgs(opts: {
  port: number;
  metricsPort: number;
  pidfile: string;
}): string[] {
  return [
    'tunnel',
    '--url',
    `http://${LOOPBACK_HOST}:${opts.port}`,
    '--no-autoupdate',
    '--metrics',
    `${LOOPBACK_HOST}:${opts.metricsPort}`,
    '--pidfile',
    opts.pidfile,
  ];
}

/**
 * The spawn options for one Quick Tunnel. Issue #2146 is entirely about these.
 *
 * `stderr` is a **file descriptor**, or `'ignore'` when the log file could not
 * be opened. It is never `'pipe'`: a pipe's read end belongs to `commandmate
 * remote`, which exits as soon as it has the URL, and cloudflared then dies of
 * SIGPIPE on its next write to fd 2. See the file header for the measurement.
 *
 * `detached: true` puts the child in its own session. Without it, a Ctrl-C in
 * the terminal that launched the CLI reaches cloudflared too — the tunnel is
 * supposed to outlive the command, so it must not share its process group.
 * `stop()` is unaffected: it signals a **positive** pid, which is one process,
 * not a group, so detaching changes nothing about teardown.
 */
export function buildQuickTunnelSpawnOptions(stderr: number | 'ignore'): SpawnOptions {
  const stdio: ('ignore' | number)[] = ['ignore', 'ignore', stderr];
  return { detached: true, stdio };
}

/**
 * cloudflared's stderr, as this module hands it out and reads it back.
 *
 * Two consumers depend on it and both survive the change from a pipe to a file,
 * because a file can be re-read by path at any time: `parseBannerUrl()` (the
 * second URL candidate) and `stderrTail()` (the failure diagnostic).
 */
export interface StderrLog {
  /** Goes in slot 2 of `stdio`. A descriptor, or `'ignore'`. Never `'pipe'`. */
  readonly stdio: number | 'ignore';
  /** The file being written to, or `null` when there is none. */
  readonly path: string | null;
  /** The tail of what cloudflared has written so far. Never throws. */
  read(): string;
  /** Closes this process's copy of the descriptor. The child keeps its own. */
  close(): void;
}

/** What `openStderrLog()` falls back to: no log, and still a working tunnel. */
const SILENT_STDERR_LOG: StderrLog = {
  stdio: 'ignore',
  path: null,
  read: () => '',
  close: () => {
    // Nothing was opened, so there is nothing to close.
  },
};

/**
 * Reads the last `limit` bytes of a log file.
 *
 * The tail rather than the head, because both consumers want the end: the
 * banner parser takes the last match so a reconnect wins, and the diagnostic
 * wants the last few lines. Never throws — a log that cannot be read is a
 * missing diagnostic, not a failed tunnel.
 */
function readLogTail(logPath: string, limit: number): string {
  let fd: number | null = null;
  try {
    fd = openSync(logPath, 'r');
    const { size } = fstatSync(fd);
    const start = size > limit ? size - limit : 0;
    const length = size - start;
    if (length <= 0) return '';
    const buffer = Buffer.alloc(length);
    const bytes = readSync(fd, buffer, 0, length, start);
    // A tail can start mid-codepoint. cloudflared logs ASCII, and at worst one
    // leading character is mangled; neither consumer anchors on the first byte.
    return buffer.subarray(0, bytes).toString('utf-8');
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
    }
  }
}

/**
 * Opens the file cloudflared's stderr is redirected into.
 *
 * Truncating (`'w'`) rather than appending, because `parseBannerUrl()` takes the
 * last URL in the buffer and a previous session's banner names a tunnel that no
 * longer exists. Starting from empty means the only banner that can be read is
 * this session's.
 *
 * Returns `SILENT_STDERR_LOG` rather than throwing when the file cannot be
 * opened: `start()` still has `/quicktunnel` — the *first* URL candidate — and
 * a tunnel with no diagnostics beats no tunnel.
 */
export function openStderrLog(logPath: string): StderrLog {
  let fd: number;
  try {
    fd = openSync(logPath, 'w', 0o600);
  } catch {
    return SILENT_STDERR_LOG;
  }

  let open = true;
  return {
    stdio: fd,
    path: logPath,
    read: () => readLogTail(logPath, STDERR_CAPTURE_LIMIT),
    close: () => {
      if (!open) return;
      open = false;
      try {
        closeSync(fd);
      } catch {
        // The child holds its own duplicate either way.
      }
    },
  };
}

/** `QUICK_TUNNEL_SUFFIX` as a regex fragment, so the suffix has one definition. */
const SUFFIX_PATTERN = QUICK_TUNNEL_SUFFIX.replace(/\./g, '\\.');

/** One DNS label, the shape cloudflared hands out (`four-random-words`). */
const LABEL_PATTERN = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';

/** A single-label Quick Tunnel hostname, e.g. `four-random-words.<suffix>`. */
const QUICK_TUNNEL_HOSTNAME = new RegExp(`^${LABEL_PATTERN}\\.${SUFFIX_PATTERN}$`);

/** True for a hostname cloudflared could actually have handed out. */
export function isQuickTunnelHostname(value: string): boolean {
  return QUICK_TUNNEL_HOSTNAME.test(value);
}

/**
 * Reads the hostname out of a `/quicktunnel` response body.
 *
 * Measured body: `{"hostname":"villas-activists-hey-barbie.trycloudflare.com"}`
 * — served as `text/plain`, and **without a scheme**, so the `https://` is ours
 * to add. The shape is checked before it is used because this string becomes the
 * QR code a phone is asked to open; a value that is not a Quick Tunnel hostname
 * is treated as no answer rather than as a destination.
 */
export function parseQuickTunnelHostname(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const hostname = (parsed as { hostname?: unknown }).hostname;
  if (typeof hostname !== 'string') return null;
  const trimmed = hostname.trim();
  return isQuickTunnelHostname(trimmed) ? trimmed : null;
}

/**
 * Second candidate: the URL cloudflared prints on stderr.
 *
 * Anchored on the **shape of the URL**, not on the surrounding words. Two
 * measured facts drive that. The banner text and the URL are on *different*
 * lines — the URL sits alone inside a box-drawn frame — so "read what follows
 * `Visit it at`" does not work against the real output. And the wording is
 * exactly the part Cloudflare is free to reword, while the hostname suffix is
 * the service's identity.
 *
 * The same stderr also carries `https://www.cloudflare.com/website-terms/` and
 * `https://developers.cloudflare.com/...`; neither ends in the Quick Tunnel
 * suffix, and the `Requesting new quick Tunnel on trycloudflare.com...` line has
 * no scheme. All three are negative controls in the unit test.
 *
 * The last match wins, so a reconnect that prints a fresher banner is preferred.
 */
export function parseBannerUrl(stderr: string): string | null {
  const pattern = new RegExp(`https://${LABEL_PATTERN}\\.${SUFFIX_PATTERN}`, 'g');
  const matches = stderr.match(pattern);
  if (matches === null || matches.length === 0) return null;
  return matches[matches.length - 1];
}

/** Rejects anything that could not be a TCP port before it reaches argv. */
function assertUpstreamPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`cloudflare-quick: upstream port must be 1-65535, got ${String(port)}`);
  }
}

/**
 * Asks the OS for a free port on loopback and hands it back unheld.
 *
 * Binding the probe to `LOOPBACK_HOST` rather than to every interface is part of
 * the same guarantee as the `--metrics` argument: the port this returns is one
 * that is free *on loopback*, which is the only place it will be used.
 */
export function findFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('cloudflare-quick: could not read a free port')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/**
 * `GET http://127.0.0.1:<metricsPort>/quicktunnel`.
 *
 * Never rejects: "no answer yet" and "no such route" are both normal during the
 * poll, and neither should look different from a slow start.
 */
export function fetchQuickTunnelHostname(
  metricsPort: number,
  timeoutMs: number = METRICS_REQUEST_TIMEOUT_MS,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const request = httpGet(
      { host: LOOPBACK_HOST, port: metricsPort, path: '/quicktunnel', timeout: timeoutMs },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          settle(null);
          return;
        }
        response.setEncoding('utf-8');
        let body = '';
        response.on('data', (chunk: string) => {
          if (body.length < 4096) body += chunk;
        });
        response.on('end', () => settle(parseQuickTunnelHostname(body)));
        response.on('error', () => settle(null));
      },
    );

    request.on('timeout', () => request.destroy(new Error('metrics request timed out')));
    request.on('error', () => settle(null));
    request.on('close', () => settle(null));
  });
}

/**
 * Where the pidfile goes: the same `~/.commandmate` the rest of CommandMate
 * uses.
 *
 * Not read from the environment. §6.2 keeps state-file locations out of
 * Providers, and an env-supplied directory would also have to defend against the
 * `/proc` recursive-mkdir hang that `resolveSafeDirectory()` exists for. Tests
 * override it through `CloudflareProviderDeps` instead.
 */
export function resolveCloudflareStateDir(): string {
  return join(homedir(), '.commandmate');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function describeExit(exit: ExitInfo): string {
  if (exit.signal !== null) return `killed by ${exit.signal}`;
  return `exit code ${exit.code === null ? 'unknown' : String(exit.code)}`;
}

/** Last few stderr lines, capped, so a failure says something useful. */
function stderrTail(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-5);
  if (lines.length === 0) return '';
  return `; last output: ${lines.join(' | ').slice(0, 400)}`;
}

export const defaultCloudflareDeps: CloudflareProviderDeps = {
  spawn: nodeSpawn,
  spawnSync: nodeSpawnSync,
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
  findFreePort: findFreeLoopbackPort,
  fetchHostname: (metricsPort) => fetchQuickTunnelHostname(metricsPort),
  resolveStateDir: resolveCloudflareStateDir,
  timing: DEFAULT_QUICK_TUNNEL_TIMING,
};

/**
 * Builds the Provider.
 *
 * The returned object has exactly the four members `RemoteProvider` declares —
 * the seams stay closed over in here rather than becoming a fifth key, because
 * the contract test pins that list and §6.3-1 is the reason it does.
 */
export function createCloudflareProvider(
  overrides: Partial<CloudflareProviderDeps> = {},
): RemoteProvider {
  const deps: CloudflareProviderDeps = { ...defaultCloudflareDeps, ...overrides };

  return {
    id: 'cloudflare-quick',

    async detect(): Promise<ProviderDetection> {
      let result: SpawnSyncReturns<string>;
      try {
        // Array args, no `shell`. MF-SEC-1, and the same call shape as
        // `PreflightChecker.checkDependency()`.
        result = deps.spawnSync(CLOUDFLARED_BIN, [CLOUDFLARED_VERSION_ARG], {
          encoding: 'utf-8',
          timeout: DETECT_TIMEOUT_MS,
        });
      } catch (error) {
        return {
          available: false,
          ready: false,
          reason: `cloudflared probe failed: ${messageOf(error)}`,
        };
      }

      if (result.error) {
        const code = (result.error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          return { available: false, ready: false, reason: 'cloudflared is not installed' };
        }
        return {
          available: false,
          ready: false,
          reason: `cloudflared probe failed: ${messageOf(result.error)}`,
        };
      }

      if (result.status !== 0) {
        return {
          available: false,
          ready: false,
          reason: `cloudflared ${CLOUDFLARED_VERSION_ARG} exited with ${String(result.status)}`,
        };
      }

      const output = (result.stdout || result.stderr || '').trim();
      const version = /(\d+\.\d+\.\d+)/.exec(output)?.[1];

      // A Quick Tunnel needs no account, no login and no prior configuration, so
      // "installed" and "usable right now" are the same question here. Tailscale
      // is the Provider that has to answer them separately.
      return version === undefined
        ? { available: true, ready: true }
        : { available: true, version, ready: true };
    },

    async start({ port, signal }): Promise<RemoteHandle> {
      assertUpstreamPort(port);
      if (signal.aborted) {
        throw new Error('cloudflare-quick: aborted before cloudflared was started');
      }

      const metricsPort = await deps.findFreePort();
      const stateDir = deps.resolveStateDir();
      const pidfile = join(stateDir, CLOUDFLARED_PIDFILE_NAME);
      try {
        mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      } catch {
        // The pidfile is a convenience for humans and `ps`; `owned.pid` is what
        // `stop()` actually uses. Not being able to create the directory is not
        // a reason to refuse to go remote.
      }

      const args = buildQuickTunnelArgs({ port, metricsPort, pidfile });
      const stderrLog = openStderrLog(join(stateDir, CLOUDFLARED_LOG_NAME));

      let child: QuickTunnelProcess;
      try {
        child = deps.spawn(CLOUDFLARED_BIN, args, buildQuickTunnelSpawnOptions(stderrLog.stdio));
      } finally {
        // `spawn` duplicates the descriptor into the child before it returns, so
        // this copy has no remaining job. Keeping it would tie fd 2's lifetime
        // to the CLI's, which is the mistake Issue #2146 is about.
        stderrLog.close();
      }

      // The tunnel has to outlive `commandmate remote`, which exits as soon as
      // it has a URL. `unref()` means the CLI's event loop is not held open by a
      // child it never intends to wait for.
      child.unref();

      const state: { exit: ExitInfo | null } = { exit: null };
      child.once('exit', (code, exitSignal) => {
        state.exit = { code, signal: exitSignal };
      });

      const pid = child.pid;
      if (pid === undefined) {
        child.kill('SIGTERM');
        throw new Error('cloudflare-quick: cloudflared could not be started (no pid)');
      }

      let url: string;
      try {
        url = await waitForQuickTunnelUrl({
          metricsPort,
          signal,
          timing: deps.timing,
          fetchHostname: deps.fetchHostname,
          readStderr: () => stderrLog.read(),
          readExit: () => state.exit,
        });
      } catch (error) {
        // Nothing usable came back, so the child is ours to clean up and no
        // handle ever reaches the caller that could have done it for us.
        child.kill('SIGTERM');
        throw error;
      }

      return {
        provider: 'cloudflare-quick',
        url,
        // `revert: null` is the honest answer, not a placeholder: a Quick Tunnel
        // leaves nothing behind to undo. The process is the whole of it.
        owned: { pid, revert: null },
        // No persistent Provider configuration exists, so there is nothing for
        // §6.3-2 to protect. `planStop()` reads this as "protects nothing",
        // which is right here and wrong for Tailscale — which is why the two
        // Providers answer it differently instead of sharing a default.
        preexisting: null,
      };
    },

    async stop(handle: RemoteHandle): Promise<StopOutcome> {
      // Routed through the shared rule even though this Provider never has
      // revert entries, so the two Providers cannot drift apart on §6.3-2.
      const plan = planStop(handle);
      const warnings: string[] = [];

      for (const key of Object.keys(plan.revert)) {
        // Unreachable for a handle this Provider produced. If it ever fires,
        // something built a handle by hand — say it out loud rather than
        // inventing an undo step for a key with no defined meaning.
        warnings.push(`cloudflare-quick: no revert step for "${key}"; left in place`);
      }

      const pid = handle.owned.pid;
      if (pid !== null) {
        try {
          // The entire teardown. Measured: cloudflared exits in about a second
          // and the public URL immediately starts answering HTTP 530.
          deps.kill(pid, 'SIGTERM');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            // Already gone. That is the goal state, so it is a success, not a
            // warning — the same posture `stop.ts` takes toward a stale PID.
          } else {
            warnings.push(
              `cloudflare-quick: could not signal pid ${String(pid)}: ${messageOf(error)}`,
            );
          }
        }
      }

      return { reverted: warnings.length === 0, skipped: plan.skipped, warnings };
    },
  };
}

async function waitForQuickTunnelUrl(params: {
  metricsPort: number;
  signal: AbortSignal;
  timing: QuickTunnelTiming;
  fetchHostname: (metricsPort: number) => Promise<string | null>;
  readStderr: () => string;
  readExit: () => ExitInfo | null;
}): Promise<string> {
  const { metricsPort, signal, timing, fetchHostname, readStderr, readExit } = params;
  const startedAt = Date.now();
  const deadline = startedAt + timing.urlWaitMs;
  const bannerAllowedAt = startedAt + timing.metricsPreferenceMs;

  for (;;) {
    if (signal.aborted) {
      throw new Error('cloudflare-quick: aborted while waiting for the public URL');
    }

    const hostname = await fetchHostname(metricsPort);
    let candidate = hostname === null ? null : `https://${hostname}`;

    // The banner is only consulted once the metrics route has had its window.
    // Measured: cloudflared prints the banner about a second *before* it starts
    // the metrics server, so without the window the second candidate would win
    // every race and the first would never run.
    if (candidate === null && Date.now() >= bannerAllowedAt) {
      candidate = parseBannerUrl(readStderr());
    }

    // Re-read the exit state before handing a URL back. The `await` above spans
    // real time, and a URL scraped from a process that has since exited names a
    // tunnel nobody is serving — a QR code for a dead endpoint is worse than an
    // error. Checked after the candidate rather than before it so a child that
    // dies mid-poll cannot slip a stale URL through.
    const exit = readExit();
    if (exit !== null) {
      throw new Error(
        `cloudflare-quick: cloudflared ${describeExit(exit)} before a public URL appeared` +
          stderrTail(readStderr()),
      );
    }

    if (candidate !== null) return candidate;

    if (Date.now() >= deadline) {
      throw new Error(
        `cloudflare-quick: no public URL after ${String(timing.urlWaitMs)}ms` +
          stderrTail(readStderr()),
      );
    }

    await sleep(timing.pollIntervalMs);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The shipped Provider, wired to the real `cloudflared`. */
export const cloudflareProvider: RemoteProvider = createCloudflareProvider();
