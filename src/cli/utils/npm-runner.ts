/**
 * npm Execution Wrapper
 * Issue #1194: registry query + global install (D-15 / S3-007)
 *
 * Registry queries go through `npm view` rather than a direct fetch to the
 * registry API so that the user's `.npmrc` (registry / proxy / scope / auth) is
 * honoured and the *same* registry is used as the subsequent `npm install -g`.
 * A hard-coded registry URL would break mirror/proxy setups (making the post
 * install version check fail permanently) and would add a new fixed external
 * endpoint of the kind [SEC-001] guards against.
 *
 * MF-SEC-1: all commands use spawnSync with array args (never a shell string),
 * following the safe pattern of `preflight.ts:23-66`.
 *
 * @module npm-runner
 */

import { spawnSync, type SpawnSyncReturns } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/** Timeout for `npm view` (longer than preflight's 5s: this is a network round trip) */
export const NPM_VIEW_TIMEOUT_MS = 10_000;

/** Timeout for `npm root -g` (a local path lookup, so preflight's 5s is plenty) */
export const NPM_ROOT_TIMEOUT_MS = 5_000;

/**
 * Result of a registry version query
 */
export interface NpmViewResult {
  /** Whether the query succeeded */
  success: boolean;
  /** Resolved version (only when success) */
  version?: string;
  /** Human readable failure reason (only when !success) */
  error?: string;
}

/**
 * Result of a global install
 */
export interface NpmInstallResult {
  /** Whether the install succeeded */
  success: boolean;
  /** Whether the failure was a permission error (EACCES) */
  permissionDenied: boolean;
  /** Human readable failure reason (only when !success) */
  error?: string;
}

/**
 * Query the npm registry for the latest published version of a package.
 *
 * @param packageName - Package name (e.g. `commandmate`)
 * @returns The resolved version, or a classified failure
 */
export function viewLatestVersion(packageName: string): NpmViewResult {
  const result = spawnSync('npm', ['view', packageName, 'version'], {
    encoding: 'utf-8',
    timeout: NPM_VIEW_TIMEOUT_MS,
  });

  if (result.error) {
    const errnoError = result.error as NodeJS.ErrnoException;
    if (errnoError.code === 'ENOENT') {
      return {
        success: false,
        error: 'npm command not found. Install Node.js/npm and try again.',
      };
    }
    return { success: false, error: errnoError.message };
  }

  if (result.status !== 0) {
    const stderr = readStream(result.stderr);
    return {
      success: false,
      error: stderr || `npm view exited with status ${String(result.status)}`,
    };
  }

  const version = readStream(result.stdout);
  if (!version) {
    return { success: false, error: 'npm view returned no version' };
  }

  return { success: true, version };
}

/**
 * Install the latest published version of a package globally.
 *
 * npm output is captured and echoed so the user sees what happened. spawnSync
 * cannot both stream and capture, and the output is needed to classify EACCES.
 *
 * @param packageName - Package name (e.g. `commandmate`)
 * @returns Success, or a classified failure (EACCES flagged separately)
 */
export function installGlobalLatest(packageName: string): NpmInstallResult {
  const result = spawnSync('npm', ['install', '-g', `${packageName}@latest`], {
    encoding: 'utf-8',
  });

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
        permissionDenied: false,
        error: 'npm command not found. Install Node.js/npm and try again.',
      };
    }
    return {
      success: false,
      permissionDenied: errnoError.code === 'EACCES',
      error: errnoError.message,
    };
  }

  if (result.status !== 0) {
    return {
      success: false,
      permissionDenied: isPermissionDenied(`${stdout}\n${stderr}`),
      error: stderr || `npm install exited with status ${String(result.status)}`,
    };
  }

  return { success: true, permissionDenied: false };
}

/**
 * A package present in the npm global root (`npm root -g`)
 */
export interface GlobalInstallation {
  /** Absolute path of the installed package directory */
  path: string;
  /** Version read from its package.json; undefined when that cannot be read */
  version?: string;
}

/**
 * Locate a globally installed (`npm install -g`) package.
 *
 * Issue #1633: an npx self-update refreshes only the npx cache, so a global install left on the
 * machine keeps shadowing `commandmate` on PATH at whatever version it was — a divergence that
 * went unnoticed for months and surfaced as #1632. Callers only *warn* about what this reports,
 * so every failure mode (npm missing, `npm root -g` failing on permissions, an unreadable
 * package.json) degrades to "nothing to report" instead of propagating.
 *
 * @param packageName - Package name (e.g. `commandmate`)
 * @returns The installation, or null when npm could not be asked or the package is not there
 */
export function findGlobalInstallation(packageName: string): GlobalInstallation | null {
  const result = spawnSync('npm', ['root', '-g'], {
    encoding: 'utf-8',
    timeout: NPM_ROOT_TIMEOUT_MS,
  });

  // Covers ENOENT (no npm), a timeout, and a non-zero exit alike: nothing to report.
  if (result.error || result.status !== 0) {
    return null;
  }

  const root = readStream(result.stdout);
  if (!root) {
    return null;
  }

  const packagePath = join(root, packageName);
  if (!existsSync(packagePath)) {
    return null;
  }

  return { path: packagePath, version: readInstalledVersion(packagePath) };
}

/**
 * Best-effort version read from an installed package's package.json.
 * The install itself is what matters, so an unreadable manifest still reports the install.
 */
function readInstalledVersion(packagePath: string): string | undefined {
  try {
    const raw = readFileSync(join(packagePath, 'package.json'), 'utf-8');
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === 'string' && version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Detect an npm global permission error.
 */
function isPermissionDenied(output: string): boolean {
  return /EACCES|permission denied/i.test(output);
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
