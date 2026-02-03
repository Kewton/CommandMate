/**
 * Install Context Utility
 * Issue #136: DRY refactoring - extract common install detection functions
 *
 * This module provides centralized functions for detecting the install type
 * (global vs local npm install) and resolving configuration directories.
 *
 * Extracted from env-setup.ts to solve circular import issues and follow DRY principle.
 *
 * @module install-context
 */

import { existsSync, realpathSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

/**
 * Check if running as global npm package
 * Issue #119: Determine .env location based on install type
 * Issue #136: Extracted to avoid circular imports
 *
 * @returns true if running as global npm package
 *
 * @example
 * ```typescript
 * if (isGlobalInstall()) {
 *   // Use ~/.commandmate for config
 * } else {
 *   // Use current working directory
 * }
 * ```
 */
export function isGlobalInstall(): boolean {
  // Check if running from global node_modules
  // Global installs typically have paths like:
  // - /usr/local/lib/node_modules/
  // - /Users/xxx/.npm-global/lib/node_modules/
  // - C:\Users\xxx\AppData\Roaming\npm\node_modules\
  const currentPath = dirname(__dirname);
  return (
    currentPath.includes('/lib/node_modules/') ||
    currentPath.includes('\\node_modules\\') ||
    currentPath.includes('/node_modules/commandmate')
  );
}

/**
 * Get the config directory path
 * Issue #119: Returns ~/.commandmate for global, cwd for local
 * Issue #125: Added symlink resolution for security (path traversal protection)
 * Issue #136: Extracted to avoid circular imports
 *
 * @returns Path to config directory (absolute, with symlinks resolved)
 * @throws Error if config directory resolves outside home directory (for global install)
 *
 * @example
 * ```typescript
 * const configDir = getConfigDir();
 * // Global: /Users/username/.commandmate
 * // Local: /path/to/project (resolved from symlinks)
 * ```
 */
export function getConfigDir(): string {
  if (isGlobalInstall()) {
    const configDir = join(homedir(), '.commandmate');

    // Verify config directory is within home directory (security check)
    // Only validate if the directory exists (it may not exist yet during init)
    if (existsSync(configDir)) {
      const realPath = realpathSync(configDir);
      const realHome = realpathSync(homedir());
      if (!realPath.startsWith(realHome)) {
        throw new Error(`Security error: Config directory ${configDir} is outside home directory`);
      }
      return realPath;
    }

    return configDir;
  }

  // Local install - resolve symlinks in cwd
  const cwd = process.cwd();
  return realpathSync(cwd);
}

/**
 * Ensure the config directory exists with proper permissions
 * Issue #136: Utility for creating config directory if needed
 *
 * @returns Path to config directory (created if needed)
 */
export function ensureConfigDir(): string {
  const configDir = isGlobalInstall()
    ? join(homedir(), '.commandmate')
    : process.cwd();

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }

  return getConfigDir();
}
