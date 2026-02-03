/**
 * DB Path Resolver
 * Issue #135: DB path resolution logic fix
 * Issue #136: Import from install-context.ts to avoid circular imports
 *
 * Provides consistent DB path resolution for both global and local installs.
 * This module centralizes DB path logic to follow SRP (Single Responsibility Principle).
 *
 * @module db-path-resolver
 */

import path from 'path';
import { homedir } from 'os';
import { isGlobalInstall, getConfigDir } from '../cli/utils/install-context';
import { isSystemDirectory } from '../config/system-directories';

/**
 * Get the default database path based on install type
 *
 * For global installs: ~/.commandmate/data/cm.db
 * For local installs: <cwd>/data/cm.db (as absolute path)
 *
 * @returns Absolute path to the default database file
 *
 * @example
 * ```typescript
 * const dbPath = getDefaultDbPath();
 * // Global: /Users/username/.commandmate/data/cm.db
 * // Local: /path/to/project/data/cm.db
 * ```
 */
export function getDefaultDbPath(): string {
  if (isGlobalInstall()) {
    return path.join(homedir(), '.commandmate', 'data', 'cm.db');
  }
  return path.resolve(process.cwd(), 'data', 'cm.db');
}

/**
 * Get the database path for a specific issue (worktree)
 * Issue #136: Worktree-specific DB path
 *
 * @param issueNo - The issue number
 * @returns Absolute path to the issue-specific database file
 *
 * @example
 * ```typescript
 * const dbPath = getIssueDbPath(135);
 * // Returns: /Users/username/.commandmate/data/cm-135.db
 * ```
 */
export function getIssueDbPath(issueNo: number): string {
  const configDir = getConfigDir();
  return path.join(configDir, 'data', `cm-${issueNo}.db`);
}

/**
 * Validate database path for security
 *
 * SEC-001: Protects against writing to system directories
 * - Global install: DB path must be within home directory
 * - Local install: DB path must not be in system directories
 *
 * @param dbPath - The database path to validate
 * @returns The resolved absolute path if valid
 * @throws Error if path is in a forbidden location
 *
 * @example
 * ```typescript
 * // Valid paths
 * validateDbPath('~/.commandmate/data/cm.db'); // Global
 * validateDbPath('./data/cm.db'); // Local
 *
 * // Invalid paths (throws)
 * validateDbPath('/etc/cm.db');
 * validateDbPath('/var/lib/cm.db');
 * ```
 */
export function validateDbPath(dbPath: string): string {
  const resolvedPath = path.resolve(dbPath);

  if (isGlobalInstall()) {
    // Global install: DB path must be within home directory
    const homeDir = homedir();
    if (!resolvedPath.startsWith(homeDir)) {
      throw new Error(
        `Security error: DB path must be within home directory: ${resolvedPath}`
      );
    }
  } else {
    // Local install: DB path must not be in system directories (SEC-001)
    if (isSystemDirectory(resolvedPath)) {
      throw new Error(
        `Security error: DB path cannot be in system directory: ${resolvedPath}`
      );
    }
  }

  return resolvedPath;
}
