/**
 * Path Utilities for CLI
 * Issue #96: npm install CLI support
 *
 * Provides utilities to resolve package installation directory
 * regardless of where the CLI is invoked from.
 */

import { join } from 'path';

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
