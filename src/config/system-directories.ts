/**
 * System Directories Configuration
 * Issue #135: DB path resolution logic fix
 *
 * Centralized list of system directories that are not allowed for DB storage.
 * This supports security measures SEC-001, SEC-002, SEC-005.
 *
 * @module system-directories
 */

/**
 * System directories that are not allowed for DB storage
 *
 * SEC-001: System directory protection
 * These directories are protected to prevent writing database files
 * to critical system paths which could cause security issues.
 */
export const SYSTEM_DIRECTORIES = [
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/var',
  '/tmp',
  '/dev',
  '/sys',
  '/proc',
] as const;

/**
 * Check if a path is within a system directory
 *
 * @param resolvedPath - The resolved absolute path to check
 * @returns true if the path is within a system directory
 */
export function isSystemDirectory(resolvedPath: string): boolean {
  return SYSTEM_DIRECTORIES.some((dir) => resolvedPath.startsWith(dir));
}
