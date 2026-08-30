/**
 * Tailscale Serve Provider (Issue #1937, R3).
 *
 * Implements §6.1–§6.3 of `docs/design/remote-qr-pairing-1937.md`. §6.4's
 * Tailscale table was written as a guess on a machine that had no `tailscale`
 * at all (U-2). Everything below marked "measured" was measured on 2026-08-29
 * against Tailscale 1.102.3 (standalone/macsys, `/usr/local/bin/tailscale`) on
 * macOS; the raw session is in `dev-reports/issue/1937/u2-tailscale-serve.md`.
 * Where the two disagree, the measurement wins.
 *
 * ## The one thing this file exists to get right
 *
 * Serve configuration is persistent state owned by tailscaled. The user may
 * already be publishing their own services through it, and **there is no undo
 * and no backup**. So the whole design here is about the blast radius of
 * teardown, and the measurement below is the reason it is not obvious:
 *
 * | invocation | measured effect on a node serving `/` and `/u2-existing-user` |
 * |---|---|
 * | `serve --https=<port> --set-path <path> off` | removes exactly that one handler |
 * | the same command with the path passed positionally instead | **wiped both handlers; config back to `{}`** |
 * | the same command with no path at all | **wiped both handlers; config back to `{}`** |
 *
 * The middle row matters most, because the untargeted form is *what Tailscale
 * itself prints* after a successful `serve`: its success banner recommends
 * re-running `serve` with only `--https=<port>` and the word "off", no path.
 * Following that hint would delete the user's configuration along with ours,
 * silently, with exit status 0. (The banner's exact wording is quoted in the
 * dev report; it is paraphrased here so this file does not trip the guard that
 * forbids the shape — which is itself a small positive control.)
 *
 * Hence {@link buildServeOffArgs} is the only place an `off` argv is built, it
 * always carries `--set-path`, and it derives that path from the handler key it
 * is undoing rather than from anything ambient.
 *
 * ## Why `off` at all, when `serve --help` never mentions it
 *
 * 1.102.3's help lists `status` / `reset` / `drain` / `clear` / `advertise` /
 * `get-config` / `set-config` and no `off`. Two alternatives were measured and
 * rejected before settling on the undocumented-but-live `off`:
 *
 * - `get-config` + `set-config` looked like a "snapshot and restore" route, but
 *   measuring their help shows both are **service**-scoped (`--service`, or
 *   `--all` meaning "all services"). They do not address node-level Serve
 *   handlers at all, so they cannot express "remove this one handler".
 * - `drain` / `clear` are likewise service-scoped, and both are *destructive*
 *   at service granularity. They are now forbidden outright by
 *   `tests/unit/config/remote-destructive-command-guard.test.ts`.
 *
 * That leaves `off`, which is undocumented in `--help` yet is the exact string
 * the CLI recommends in its own success output, and which measured clean:
 * exit 0, only the named handler removed, and the `TCP` entry for the port
 * cleaned up automatically once the last handler on it is gone.
 *
 * ## What `start()` refuses to do
 *
 * Measured: running `serve` for a path that already has a handler **overwrites
 * it, prints the new mapping, and exits 0**. Nothing warns, and the previous
 * upstream is unrecoverable. `preexisting` cannot help after the fact — §6.3-2
 * protects the user's entries from `stop()`, not from `start()`. So `start()`
 * reads the snapshot first and refuses when its target key is already taken.
 *
 * Deliberately absent: `reset()` / `cleanupAll()` (§6.3-1), and any command
 * that operates on "the current configuration" rather than on a handle.
 *
 * This module imports Node builtins and `./types` only. No `@/` alias, so it
 * resolves under `tsconfig.cli.json` (which sets `paths: {}`).
 */
import {
  spawnSync as nodeSpawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from 'child_process';

import {
  planStop,
  type PreexistingSnapshot,
  type RemoteHandle,
  type RemoteProvider,
  type ProviderDetection,
  type StopOutcome,
} from './types';

/** The executable. Looked up on PATH by `spawnSync`, never through a shell. */
export const TAILSCALE_BIN = 'tailscale';

/**
 * Mirrors `PreflightChecker.checkDependency()`: one argument, passed in an
 * array. Measured: `tailscale version` prints `1.102.3` as its first line,
 * while `tailscale --version` prints the same number followed by four lines of
 * commit hashes. Both work; the subcommand is the tidier one to parse.
 */
export const TAILSCALE_VERSION_ARG = 'version';

/**
 * The only host this Provider ever names.
 *
 * A constant rather than a parameter, so "the upstream is always loopback" is a
 * property of the code and not of every call site. §9.2 pins it from outside as
 * well, by asserting the argv `start()` builds.
 *
 * Measured: passing a bare port (`tailscale serve --bg 19001`) also resolves to
 * `http://127.0.0.1:19001`. The full URL is passed anyway, so the guarantee is
 * visible in argv instead of relying on a Tailscale-side default.
 */
export const LOOPBACK_HOST = '127.0.0.1';

/**
 * The HTTPS port Serve publishes on.
 *
 * 443 is the port `tailscale serve <target>` uses by default and the one the
 * tailnet's HTTPS certificate covers (measured: `status --json` reports
 * `CertDomains: ["<node>.<tailnet>.ts.net"]`, so no extra enablement step is
 * needed on this machine).
 */
export const SERVE_HTTPS_PORT = 443;

/**
 * The path CommandMate publishes on.
 *
 * Root, not a prefix: the Next.js app is served without a `basePath`, so a
 * handler mounted at `/commandmate` would return an app whose own asset and API
 * URLs all point back at `/`.
 */
export const SERVE_PATH = '/';

/** Same 5s budget `PreflightChecker` gives every other dependency probe. */
export const DETECT_TIMEOUT_MS = 5_000;

/**
 * Budget for the Serve mutations.
 *
 * Longer than the probe: `serve --bg` talks to tailscaled and, the first time a
 * tailnet uses HTTPS, can provision a certificate. Measured latency on an
 * already-provisioned node was well under a second.
 */
export const SERVE_TIMEOUT_MS = 30_000;

/** `BackendState` from `tailscale status --json` when the node is usable. */
export const BACKEND_STATE_RUNNING = 'Running';

/** The subset of `tailscale serve status --json` this module reads. */
export interface ServeTcpEntry {
  HTTPS?: boolean;
  HTTP?: boolean;
  TCPForward?: string;
  TerminateTLS?: string;
}

/** One `host:port` block of the `Web` map. */
export interface ServeWebEntry {
  Handlers?: Record<string, { Proxy?: string } | null>;
}

/**
 * `tailscale serve status --json`, as measured.
 *
 * With nothing configured the command prints `{}` and exits 0 (the human form
 * says `No serve config`). With two handlers on 443 it prints
 * `{"TCP":{"443":{"HTTPS":true}},"Web":{"<node>.<tailnet>.ts.net:443":
 * {"Handlers":{"/":{"Proxy":"http://127.0.0.1:19002"}, ...}}}}`.
 */
export interface ServeConfig {
  TCP?: Record<string, ServeTcpEntry | null>;
  Web?: Record<string, ServeWebEntry | null>;
}

/** The fields of `tailscale status --json` readiness is decided from. */
export interface TailscaleStatus {
  BackendState?: string;
  MagicDNSSuffix?: string;
  Self?: { DNSName?: string } | null;
  Version?: string;
}

/** The seam that lets this Provider be tested without a tailnet. */
export interface TailscaleProviderDeps {
  spawnSync: (
    command: string,
    args: readonly string[],
    options: SpawnSyncOptionsWithStringEncoding,
  ) => SpawnSyncReturns<string>;
  /** HTTPS port to publish on. Overridable so tests can prove it reaches argv. */
  servePort: number;
  /** Path to publish on. Same reason. */
  servePath: string;
  detectTimeoutMs: number;
  serveTimeoutMs: number;
}

export const defaultTailscaleDeps: TailscaleProviderDeps = {
  spawnSync: nodeSpawnSync,
  servePort: SERVE_HTTPS_PORT,
  servePath: SERVE_PATH,
  detectTimeoutMs: DETECT_TIMEOUT_MS,
  serveTimeoutMs: SERVE_TIMEOUT_MS,
};

/**
 * Drops the trailing dot from a MagicDNS name.
 *
 * Measured: `Self.DNSName` is `maenomac-studio.taile4f402.ts.net.` — fully
 * qualified, with the root dot — while the key Serve uses in its own `Web` map
 * is `maenomac-studio.taile4f402.ts.net:443`, without it. The two must agree
 * or every snapshot key would miss.
 */
export function normalizeDnsName(name: string): string {
  return name.trim().replace(/\.+$/, '');
}

/**
 * The key one Serve handler is known by, in the keyspace `PreexistingSnapshot`
 * and `RemoteHandle.owned.revert` share (§6.3-2).
 *
 * `<host>:<port><path>` — byte-for-byte the `Web` map key with the handler path
 * appended, so a snapshot key and an owned key are comparable by construction
 * rather than by convention.
 */
export function serveHandlerKey(host: string, port: number, path: string): string {
  return `${normalizeDnsName(host)}:${String(port)}${path}`;
}

/** The parts of a handler key an undo command needs. */
export interface ParsedServeHandlerKey {
  host: string;
  port: number;
  path: string;
}

/**
 * Inverse of {@link serveHandlerKey}.
 *
 * Returns null rather than guessing. A key that cannot be parsed is a key whose
 * undo command cannot be built safely, and the caller reports that instead of
 * running a less specific command — which, per the measurement in the file
 * header, is how a whole-port wipe happens.
 */
export function parseServeHandlerKey(key: string): ParsedServeHandlerKey | null {
  const slash = key.indexOf('/');
  if (slash <= 0) return null;

  const hostPort = key.slice(0, slash);
  const path = key.slice(slash);
  const colon = hostPort.lastIndexOf(':');
  if (colon <= 0 || colon === hostPort.length - 1) return null;

  const host = hostPort.slice(0, colon);
  const port = Number(hostPort.slice(colon + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (host.length === 0) return null;

  return { host, port, path };
}

/**
 * Parses `tailscale serve status --json`.
 *
 * Empty output is an empty configuration, not a failure: measured, the command
 * prints `{}` when nothing is served, and a Provider that treated "no config"
 * as "could not read config" would refuse to start on a clean machine.
 */
export function parseServeConfig(text: string): ServeConfig | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as ServeConfig;
}

/**
 * Every handler currently configured, as keys, sorted.
 *
 * This is the list §6.3-2 protects. Anything in here existed before CommandMate
 * ran and must survive `stop()`.
 */
export function serveHandlerKeys(config: ServeConfig): string[] {
  const keys: string[] = [];
  for (const [hostPort, entry] of Object.entries(config.Web ?? {})) {
    const handlers = entry?.Handlers;
    if (typeof handlers !== 'object' || handlers === null) continue;
    for (const path of Object.keys(handlers)) {
      keys.push(`${hostPort}${path}`);
    }
  }
  return keys.sort();
}

/** Wraps a parsed config as the snapshot shape the shared skip rule reads. */
export function snapshotServeConfig(config: ServeConfig): PreexistingSnapshot {
  return { keys: serveHandlerKeys(config), raw: config };
}

/**
 * The argv that publishes `http://127.0.0.1:<upstreamPort>`.
 *
 * `LOOPBACK_HOST` is a constant here and `upstreamPort` is validated before it
 * arrives, so the only caller-supplied value that reaches the command line is a
 * port number. `--yes` keeps tailscaled from ever asking a question on a
 * non-interactive run.
 */
export function buildServeArgs(opts: {
  servePort: number;
  servePath: string;
  upstreamPort: number;
}): string[] {
  return [
    'serve',
    '--bg',
    '--yes',
    `--https=${String(opts.servePort)}`,
    '--set-path',
    opts.servePath,
    `http://${LOOPBACK_HOST}:${String(opts.upstreamPort)}`,
  ];
}

/**
 * The argv that removes exactly one handler.
 *
 * **The `--set-path` is load-bearing.** Measured on 1.102.3, dropping it — or
 * passing the path positionally, the way older Tailscale documentation shows —
 * removes every handler on the port and exits 0. See the table in the file
 * header. This is the only function in the codebase that builds an `off` argv,
 * and it cannot build one without a path.
 */
export function buildServeOffArgs(parsed: ParsedServeHandlerKey): string[] {
  return [
    'serve',
    `--https=${String(parsed.port)}`,
    '--set-path',
    parsed.path,
    '--yes',
    'off',
  ];
}

/** The public URL a handler on `<host>:<port><path>` answers on. */
export function buildServeUrl(host: string, port: number): string {
  const authority = port === 443 ? normalizeDnsName(host) : `${normalizeDnsName(host)}:${String(port)}`;
  return `https://${authority}`;
}

/** Rejects anything that could not be a TCP port before it reaches argv. */
function assertUpstreamPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`tailscale-serve: upstream port must be 1-65535, got ${String(port)}`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Trims a command's output to something safe to put in a user-facing reason. */
function outputTail(result: SpawnSyncReturns<string>): string {
  const text = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-3);
  if (lines.length === 0) return '';
  return `: ${lines.join(' | ').slice(0, 300)}`;
}

/** Outcome of one `tailscale` invocation, with failures flattened into a string. */
interface RunResult {
  ok: boolean;
  stdout: string;
  reason: string;
}

function runTailscale(
  deps: TailscaleProviderDeps,
  args: readonly string[],
  timeoutMs: number,
): RunResult {
  let result: SpawnSyncReturns<string>;
  try {
    // Array args, no `shell`. MF-SEC-1, and the same call shape as
    // `PreflightChecker.checkDependency()`.
    result = deps.spawnSync(TAILSCALE_BIN, args, { encoding: 'utf-8', timeout: timeoutMs });
  } catch (error) {
    return { ok: false, stdout: '', reason: `tailscale ${args[0]} failed: ${messageOf(error)}` };
  }

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    const reason =
      code === 'ENOENT'
        ? 'tailscale is not installed'
        : `tailscale ${args[0]} failed: ${messageOf(result.error)}`;
    return { ok: false, stdout: result.stdout ?? '', reason };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      stdout: result.stdout ?? '',
      reason: `tailscale ${args[0]} exited with ${String(result.status)}${outputTail(result)}`,
    };
  }

  return { ok: true, stdout: result.stdout ?? '', reason: '' };
}

/** What `tailscale status --json` says about this node being able to serve. */
export interface ServeReadiness {
  ready: boolean;
  /** The MagicDNS name, without its trailing dot, when there is one. */
  dnsName: string | null;
  reason?: string;
}

/**
 * Decides `ready` from `tailscale status --json`.
 *
 * Two signals, both measured present on a working node: `BackendState` is
 * `Running`, and `Self.DNSName` carries the MagicDNS name Serve publishes on.
 * They are checked separately because they fail separately — a logged-out node
 * reports a non-`Running` state, while a tailnet with MagicDNS disabled is
 * `Running` with no name to serve under.
 */
export function readServeReadiness(text: string): ServeReadiness {
  let status: TailscaleStatus;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) {
      return { ready: false, dnsName: null, reason: 'tailscale status --json was not an object' };
    }
    status = parsed as TailscaleStatus;
  } catch (error) {
    return {
      ready: false,
      dnsName: null,
      reason: `could not parse tailscale status --json: ${messageOf(error)}`,
    };
  }

  const backendState = typeof status.BackendState === 'string' ? status.BackendState : 'unknown';
  if (backendState !== BACKEND_STATE_RUNNING) {
    return {
      ready: false,
      dnsName: null,
      reason: `tailscale is not connected (BackendState=${backendState}); log in with the Tailscale app or CLI first`,
    };
  }

  const rawName = typeof status.Self?.DNSName === 'string' ? status.Self.DNSName : '';
  const dnsName = normalizeDnsName(rawName);
  if (dnsName.length === 0) {
    const suffix =
      typeof status.MagicDNSSuffix === 'string' && status.MagicDNSSuffix.length > 0
        ? ` (MagicDNS suffix: ${status.MagicDNSSuffix})`
        : '';
    return {
      ready: false,
      dnsName: null,
      reason: `this node has no MagicDNS name, so Serve has no hostname to publish on${suffix}`,
    };
  }

  return { ready: true, dnsName };
}

/**
 * Builds the Provider.
 *
 * The returned object has exactly the four members `RemoteProvider` declares —
 * the seams stay closed over in here rather than becoming a fifth key, because
 * the contract test pins that list and §6.3-1 is the reason it does.
 */
export function createTailscaleProvider(
  overrides: Partial<TailscaleProviderDeps> = {},
): RemoteProvider {
  const deps: TailscaleProviderDeps = { ...defaultTailscaleDeps, ...overrides };

  /** Reads the current Serve configuration. Side-effect free. */
  function readServeConfig(): { config: ServeConfig | null; reason: string } {
    const run = runTailscale(deps, ['serve', 'status', '--json'], deps.detectTimeoutMs);
    if (!run.ok) return { config: null, reason: run.reason };
    const config = parseServeConfig(run.stdout);
    if (config === null) {
      return { config: null, reason: 'could not parse tailscale serve status --json' };
    }
    return { config, reason: '' };
  }

  return {
    id: 'tailscale-serve',

    async detect(): Promise<ProviderDetection> {
      const version = runTailscale(
        deps,
        [TAILSCALE_VERSION_ARG],
        deps.detectTimeoutMs,
      );
      if (!version.ok) {
        return { available: false, ready: false, reason: version.reason };
      }

      // `available` is settled here: the executable exists and answered. Every
      // failure past this point leaves `available: true` and only moves
      // `ready`, which is the split §6.1 asks for and the split the
      // orchestrator's selection rule is written against.
      const parsedVersion = /(\d+\.\d+\.\d+)/.exec(version.stdout.trim())?.[1];
      const base = parsedVersion === undefined ? {} : { version: parsedVersion };

      const status = runTailscale(deps, ['status', '--json'], deps.detectTimeoutMs);
      if (!status.ok) {
        return { available: true, ...base, ready: false, reason: status.reason };
      }

      const readiness = readServeReadiness(status.stdout);
      if (!readiness.ready) {
        return { available: true, ...base, ready: false, reason: readiness.reason };
      }

      return { available: true, ...base, ready: true };
    },

    async start({ port, signal }): Promise<RemoteHandle> {
      assertUpstreamPort(port);
      if (signal.aborted) {
        throw new Error('tailscale-serve: aborted before anything was served');
      }

      const status = runTailscale(deps, ['status', '--json'], deps.detectTimeoutMs);
      if (!status.ok) throw new Error(`tailscale-serve: ${status.reason}`);
      const readiness = readServeReadiness(status.stdout);
      if (!readiness.ready || readiness.dnsName === null) {
        throw new Error(`tailscale-serve: ${readiness.reason ?? 'not ready'}`);
      }
      const host = readiness.dnsName;

      // §6.3-2: the snapshot is taken before anything is created, and `start()`
      // may not return without it. Failing to read it is fatal rather than
      // degraded — a handle with an empty `preexisting` would tell `stop()`
      // that the user has no configuration to protect.
      const snapshot = readServeConfig();
      if (snapshot.config === null) {
        throw new Error(
          `tailscale-serve: refusing to serve without a pre-existing-config snapshot (${snapshot.reason})`,
        );
      }
      const preexisting = snapshotServeConfig(snapshot.config);

      const key = serveHandlerKey(host, deps.servePort, deps.servePath);
      if (preexisting.keys.includes(key)) {
        // Measured: running `serve` over an occupied path overwrites it, prints
        // the new mapping and exits 0. The old upstream is then unrecoverable,
        // and §6.3-2 cannot help — it governs `stop()`, not `start()`. So the
        // only safe answer is to not start.
        throw new Error(
          `tailscale-serve: ${key} is already served (by ${describeExistingProxy(snapshot.config, key)}). ` +
            'CommandMate will not overwrite a handler it did not create; remove it yourself, or free the path first.',
        );
      }

      const tcpConflict = findTcpConflict(snapshot.config, deps.servePort);
      if (tcpConflict !== null) {
        throw new Error(
          `tailscale-serve: port ${String(deps.servePort)} is already used as ${tcpConflict}, not for HTTPS. ` +
            'CommandMate will not repurpose it.',
        );
      }

      if (signal.aborted) {
        throw new Error('tailscale-serve: aborted before anything was served');
      }

      const args = buildServeArgs({
        servePort: deps.servePort,
        servePath: deps.servePath,
        upstreamPort: port,
      });
      const served = runTailscale(deps, args, deps.serveTimeoutMs);
      if (!served.ok) throw new Error(`tailscale-serve: ${served.reason}`);

      const upstream = `http://${LOOPBACK_HOST}:${String(port)}`;

      // Verify against tailscaled rather than trusting exit 0. If the handler
      // is not there, nothing was created, so there is nothing to undo and the
      // failure can be reported without touching any configuration.
      const after = readServeConfig();
      if (after.config === null || !serveHandlerKeys(after.config).includes(key)) {
        throw new Error(
          `tailscale-serve: ${key} was not created (checked with serve status --json${
            after.config === null ? `; ${after.reason}` : ''
          })`,
        );
      }

      return {
        provider: 'tailscale-serve',
        url: buildServeUrl(host, deps.servePort),
        // `pid: null` because Serve is configuration held by tailscaled, not a
        // child process: `--bg` returns immediately and leaves nothing of ours
        // running. The revert entry is the upstream we installed, kept so a
        // human reading the state file can see what the key meant.
        owned: { pid: null, revert: { [key]: upstream } },
        preexisting,
      };
    },

    async stop(handle: RemoteHandle): Promise<StopOutcome> {
      // The shared §6.3-2 rule, used by both Providers so they cannot drift.
      const plan = planStop(handle);
      const warnings: string[] = [];

      for (const key of Object.keys(plan.revert)) {
        const parsed = parseServeHandlerKey(key);
        if (parsed === null) {
          // Refusing to act beats acting imprecisely: the less specific undo
          // command is exactly the one that wipes the whole port.
          warnings.push(
            `tailscale-serve: cannot parse owned key "${key}"; left in place rather than guessing a removal command`,
          );
          continue;
        }
        const off = runTailscale(deps, buildServeOffArgs(parsed), deps.serveTimeoutMs);
        if (!off.ok) {
          warnings.push(`tailscale-serve: could not remove ${key}: ${off.reason}`);
        }
      }

      if (handle.owned.pid !== null) {
        // This Provider never records a pid, so a handle that has one was not
        // produced here. Signalling an unknown process is not a teardown step
        // this Provider is entitled to take.
        warnings.push(
          `tailscale-serve: handle claims pid ${String(handle.owned.pid)}, which this provider never creates; left alone`,
        );
      }

      return { reverted: warnings.length === 0, skipped: plan.skipped, warnings };
    },
  };
}

/** Names the upstream currently behind a key, for a refusal message. */
function describeExistingProxy(config: ServeConfig, key: string): string {
  for (const [hostPort, entry] of Object.entries(config.Web ?? {})) {
    const handlers = entry?.Handlers;
    if (typeof handlers !== 'object' || handlers === null) continue;
    for (const [path, handler] of Object.entries(handlers)) {
      if (`${hostPort}${path}` !== key) continue;
      const proxy = handler?.Proxy;
      return typeof proxy === 'string' && proxy.length > 0 ? proxy : 'an existing handler';
    }
  }
  return 'an existing handler';
}

/**
 * Reports a non-HTTPS use of the port CommandMate wants.
 *
 * A raw TCP forwarder or a TLS-terminated forwarder occupies the whole port;
 * adding an HTTPS handler there would take it over. Measured: an HTTPS handler
 * records `{"HTTPS": true}` under `TCP.<port>`, which is the compatible case
 * and is what lets a second path be added alongside an existing one.
 */
function findTcpConflict(config: ServeConfig, port: number): string | null {
  const entry = config.TCP?.[String(port)];
  if (entry === null || entry === undefined) return null;
  if (entry.HTTPS === true) return null;
  if (typeof entry.TCPForward === 'string' && entry.TCPForward.length > 0) {
    return `a TCP forwarder to ${entry.TCPForward}`;
  }
  if (typeof entry.TerminateTLS === 'string' && entry.TerminateTLS.length > 0) {
    return `a TLS-terminated forwarder for ${entry.TerminateTLS}`;
  }
  if (entry.HTTP === true) return 'a plain-HTTP listener';
  return 'a non-HTTPS listener';
}

/** The shipped Provider, wired to the real `tailscale`. */
export const tailscaleProvider: RemoteProvider = createTailscaleProvider();
