/**
 * Path Utilities for CLI
 * Issue #96: npm install CLI support
 *
 * Provides utilities to resolve package installation directory
 * regardless of where the CLI is invoked from.
 */

import { join } from 'path';
import { getConfigDir } from './install-context';

/**
 * Get the root directory of the CommandMate package installation.
 *
 * When installed globally via npm, the CLI runs from:
 *   <global-modules>/commandmate/dist/cli/utils/paths.js
 *
 * This function returns the package root:
 *   <global-modules>/commandmate/
 *
 * @returns Absolute path to the package root directory
 */
export function getPackageRoot(): string {
  // __dirname points to dist/cli/utils when this file is compiled
  // We need to go up 3 levels: utils → cli → dist → package root
  return join(__dirname, '..', '..', '..');
}

/**
 * Get the path to package.json
 * @returns Absolute path to package.json
 */
export function getPackageJsonPath(): string {
  return join(getPackageRoot(), 'package.json');
}

/**
 * Issue #3731: the file a `start --daemon` server's stdout/stderr is appended to.
 *
 * Lives under `<configDir>/logs/` next to the PID files' config, not under `CM_LOG_DIR`:
 * that variable is read by the server itself (conversation logs, served through the API),
 * while this path must be known before the server is spawned and by `status` afterwards.
 * Worktree servers (`--issue`) get their own file so parallel servers never share one.
 *
 * @param issueNo - Issue number of a worktree server; omit for the main server
 * @returns `<configDir>/logs/server.log` or `<configDir>/logs/server-<issueNo>.log`
 */
export function getServerLogPath(issueNo?: number): string {
  const fileName = issueNo !== undefined ? `server-${issueNo}.log` : 'server.log';
  return join(getConfigDir(), 'logs', fileName);
}
