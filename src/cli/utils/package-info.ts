/**
 * Package Info
 * Issue #1354: record and report the version the daemon was started with
 *
 * The daemon records this at launch (into the state file) and `status` reads the currently
 * installed version to warn when a stale daemon of a different version is still running.
 */

import { readFileSync } from 'fs';
import { getPackageJsonPath } from './paths';

/**
 * Read the version from the installed package.json.
 *
 * Reads from disk rather than `require('../../package.json')` so a fresh `npm i -g` is observed
 * without the module cache pinning the version that was current when this process started.
 *
 * @returns The version string, or undefined when package.json cannot be read or has no version
 */
export function readPackageVersion(): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(getPackageJsonPath(), 'utf-8')) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version.length > 0
      ? parsed.version
      : undefined;
  } catch {
    return undefined;
  }
}
