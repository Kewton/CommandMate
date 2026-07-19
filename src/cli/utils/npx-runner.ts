/**
 * npx Execution Wrapper
 * Issue #1395: GUI one-click self-update for npx-launched servers.
 *
 * The npx self-update fetches a fresh npx cache and relaunches the daemon from
 * it (design §2.1), rather than mutating a global install (rejected Alt C). This
 * module owns the two npx spawns and the env hygiene they need:
 *
 * - `warmNpxLatest`  — force-download the latest and read back its version, so
 *   staleness can be caught *before* the old daemon is stopped (design §4.2).
 * - `spawnNpxDaemon` — relaunch the server from the freshly-cached version.
 * - `sanitizeNpxEnv` — strip the `npm_*` env a `npm run start` parent leaks, so
 *   it cannot skew npx's registry/cache/prefix resolution (design §7.3).
 *
 * MF-SEC-1 (mirrors npm-runner): every command uses spawnSync with array args,
 * never a shell string. `packageName` is always a literal constant supplied by
 * the caller (update.ts PACKAGE_NAME) — never built from request input (§5).
 *
 * @module npx-runner
 */

import { spawnSync, type SpawnSyncReturns } from 'child_process';
import { homedir } from 'os';

/**
 * Upper bound for the warmup download.
 *
 * The warmup runs *before* the old daemon is stopped, so hitting this bound
 * aborts with zero downtime (design §4.2). Kept comfortably under the banner's
 * UPDATE_TIMEOUT_MS (5 min, UpdateNotificationBanner.tsx) so a stalled download
 * aborts and logs before the GUI gives up (design §8.2 / §9-8).
 */
export const NPX_WARMUP_TIMEOUT_MS = 3 * 60 * 1000;

/** Result of the warmup + version query */
export interface NpxWarmResult {
  /** Whether the warmup succeeded and a version was read */
  success: boolean;
  /** Version reported by `<pkg> --version` (only when success) */
  version?: string;
  /** Human readable failure reason (only when !success) */
  error?: string;
}

/** Result of the daemon relaunch */
export interface NpxDaemonResult {
  /** Whether the relaunch exited 0 */
  success: boolean;
  /** Exit status of the npx process (null when it never ran) */
  status: number | null;
  /** Human readable failure reason (only when !success) */
  error?: string;
}

/**
 * Build an env for an npx spawn with the leaked `npm_*` variables removed.
 *
 * A server started by `npm run start` carries `npm_config_*` / `npm_lifecycle_*`
 * / `npm_package_*` in its env; those flow down the inherit chain into the npx
 * call and npx reads `npm_config_*` as configuration, which would silently
 * redirect its registry/cache/prefix (design §7.3). Everything else — notably
 * `CM_*` (config continuity) and `PATH` (needed to locate npx) — passes through.
 *
 * @param env - Source env (defaults to the current process env)
 * @returns A fresh env object with all `npm_*` keys removed
 */
export function sanitizeNpxEnv(
  env: Record<string, string | undefined> = process.env
): NodeJS.ProcessEnv {
  // Built as a plain record: the project augments ProcessEnv with a required
  // NODE_ENV, so an empty ProcessEnv literal would not typecheck.
  const clean: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^npm_/i.test(key)) {
      continue;
    }
    clean[key] = value;
  }
  return clean as NodeJS.ProcessEnv;
}

/**
 * Force-fetch the latest published version via npx and read back its version.
 *
 * `npx --yes <pkg>@latest --version` downloads the latest into the npx cache
 * (`--yes` suppresses the install prompt) and prints the package version;
 * commander's `.version()` short-circuits before any command runs, so this has
 * no side effects and starts no server (design §2.1). Running it before the
 * stop lets a stale/failed fetch abort with zero downtime (design §4.2).
 *
 * @param packageName - Package name (a literal constant, e.g. `commandmate`)
 * @returns The fetched version, or a classified failure
 */
/**
 * Working directory for the npx spawns (Issue #1410).
 *
 * The server — and the detached update process it spawns — run from the npx
 * cache package dir (`~/.npm/_npx/<hash>/node_modules/commandmate`). While
 * `warmNpxLatest` fetches the new version, npx deletes/replaces that dir, so a
 * later npx spawn that inherited it crashes when npm calls `process.cwd()`
 * (`ENOENT: uv_cwd`) during bootstrap, aborting the relaunch after the old
 * server is already stopped. Running the npx spawns from the always-present home
 * directory keeps `process.cwd()` valid regardless of npx cache churn. The
 * relaunched daemon sets its own cwd to the (new) package root, so this does not
 * change where the server ultimately runs.
 */
export function stableNpxCwd(): string {
  return homedir();
}

export function warmNpxLatest(packageName: string): NpxWarmResult {
  const result = spawnSync(
    'npx',
    ['--yes', `${packageName}@latest`, '--version'],
    {
      encoding: 'utf-8',
      timeout: NPX_WARMUP_TIMEOUT_MS,
      cwd: stableNpxCwd(),
      env: sanitizeNpxEnv(),
    }
  );

  if (result.error) {
    const errnoError = result.error as NodeJS.ErrnoException;
    if (errnoError.code === 'ENOENT') {
      return {
        success: false,
        error: 'npx command not found. Install Node.js/npm and try again.',
      };
    }
    return { success: false, error: errnoError.message };
  }

  if (result.status !== 0) {
    const stderr = readStream(result.stderr);
    return {
      success: false,
      error: stderr || `npx exited with status ${String(result.status)}`,
    };
  }

  const version = parseVersion(readStream(result.stdout));
  if (!version) {
    return { success: false, error: 'npx did not report a version' };
  }

  return { success: true, version };
}

/**
 * Relaunch the server as a daemon from the freshly-cached npx version.
 *
 * `npx --yes <pkg>@latest start --daemon` runs the just-warmed package (so no
 * new download) and spawns `npm run start` from the new cache dir; the npx
 * process exits once the daemon is detached. `start --daemon` is used rather
 * than the bare quickstart, which bails in a non-interactive process (design
 * §2.1). The call blocks until npx exits, so the exit status is the relaunch
 * outcome. Output is echoed so it lands in the update log.
 *
 * @param packageName - Package name (a literal constant, e.g. `commandmate`)
 * @returns Success, or a classified failure carrying the exit status
 */
export function spawnNpxDaemon(packageName: string): NpxDaemonResult {
  const result = spawnSync(
    'npx',
    ['--yes', `${packageName}@latest`, 'start', '--daemon'],
    {
      encoding: 'utf-8',
      cwd: stableNpxCwd(),
      env: sanitizeNpxEnv(),
    }
  );

  const stdout = readStream(result.stdout);
  const stderr = readStream(result.stderr);

  if (stdout) {
    console.log(stdout);
  }
  if (stderr) {
    console.error(stderr);
  }

  if (result.error) {
    const errnoError = result.error as NodeJS.ErrnoException;
    if (errnoError.code === 'ENOENT') {
      return {
        success: false,
        status: null,
        error: 'npx command not found. Install Node.js/npm and try again.',
      };
    }
    return { success: false, status: result.status, error: errnoError.message };
  }

  if (result.status !== 0) {
    return {
      success: false,
      status: result.status,
      error: stderr || `npx start exited with status ${String(result.status)}`,
    };
  }

  return { success: true, status: 0 };
}

/**
 * Extract the first semver-looking token from `--version` output.
 * Robust against npx warning noise that may share the stream.
 */
function parseVersion(output: string): string | null {
  const match = output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/);
  return match ? match[1] : null;
}

/**
 * Read a spawnSync stream as a trimmed string.
 * `encoding: 'utf-8'` yields strings, but mocks/edge cases may yield null.
 */
function readStream(stream: SpawnSyncReturns<string>['stdout'] | undefined): string {
  if (typeof stream === 'string') {
    return stream.trim();
  }
  return '';
}
