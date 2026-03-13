/**
 * Path Validation Utilities
 * Prevents directory traversal attacks and ensures paths stay within allowed directories
 * [SEC-394] Added resolveAndValidateRealPath for symlink traversal prevention
 */

import path from 'path';
import { realpathSync, existsSync, lstatSync, readlinkSync } from 'fs';
import { createLogger } from '@/lib/logger';

const logger = createLogger('path-validator');

/**
 * [SEC-394] Check whether resolvedPath is within resolvedRoot.
 *
 * A path is considered "within" if it equals the root or starts with root + separator.
 * This is a pure string comparison helper extracted for DRY compliance.
 *
 * @internal Exported for unit testing only.
 * @param resolvedPath - The fully resolved (realpath) path to check
 * @param resolvedRoot - The fully resolved (realpath) root directory
 * @returns true if resolvedPath is within resolvedRoot
 */
export function isWithinRoot(resolvedPath: string, resolvedRoot: string): boolean {
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot + path.sep);
}

/**
 * Check if a path is safe (within the allowed root directory)
 *
 * Security features:
 * - Prevents directory traversal attacks (../)
 * - Prevents absolute paths outside root
 * - Detects null byte injection
 * - Handles URL encoding attempts
 * - Normalizes paths before comparison
 *
 * @param targetPath - The path to validate (absolute or relative)
 * @param rootDir - The root directory that must contain the target path
 * @returns True if the path is safe, false otherwise
 *
 * @example
 * ```typescript
 * isPathSafe('/home/user/projects/repo1', '/home/user/projects'); // true
 * isPathSafe('/home/user/../etc/passwd', '/home/user/projects'); // false
 * isPathSafe('../etc', '/home/user/projects'); // false
 * ```
 */
export function isPathSafe(targetPath: string, rootDir: string): boolean {
  // Check for empty paths
  if (!targetPath || targetPath.trim() === '') {
    return false;
  }

  // Check for null bytes (security vulnerability)
  if (targetPath.includes('\x00')) {
    return false;
  }

  // Decode URL encoding to prevent bypass attempts
  let decodedPath = targetPath;
  try {
    decodedPath = decodeURIComponent(targetPath);
  } catch {
    // If decoding fails, use original path
    decodedPath = targetPath;
  }

  // Check for null bytes in decoded path
  if (decodedPath.includes('\x00')) {
    return false;
  }

  // Resolve both paths to absolute, normalized paths
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(rootDir, decodedPath);

  // Check if target path is within root directory
  // The resolved path must start with the root path
  const relative = path.relative(resolvedRoot, resolvedTarget);

  // If relative path starts with '..' or is an absolute path, it's outside root
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }

  return true;
}

/**
 * Validate a worktree path and return the normalized absolute path
 *
 * @param targetPath - The path to validate (absolute or relative)
 * @param rootDir - The root directory that must contain the target path
 * @returns The normalized absolute path if valid
 * @throws {Error} If the path is invalid or outside the allowed directory
 *
 * @example
 * ```typescript
 * // Valid path
 * validateWorktreePath('repo1', '/home/user/projects');
 * // Returns: '/home/user/projects/repo1'
 *
 * // Invalid path (throws error)
 * validateWorktreePath('../etc', '/home/user/projects');
 * // Throws: Error: Path is outside allowed directory
 * ```
 */
export function validateWorktreePath(targetPath: string, rootDir: string): string {
  // Check for empty paths
  if (!targetPath || targetPath.trim() === '') {
    throw new Error('Invalid path: Path cannot be empty');
  }

  // Check for null bytes
  if (targetPath.includes('\x00')) {
    throw new Error('Invalid path: Null bytes not allowed');
  }

  // Check if path is safe
  if (!isPathSafe(targetPath, rootDir)) {
    throw new Error(
      `Path is outside allowed directory: ${targetPath} (allowed root: ${rootDir})`
    );
  }

  // Decode URL encoding
  let decodedPath = targetPath;
  try {
    decodedPath = decodeURIComponent(targetPath);
  } catch {
    decodedPath = targetPath;
  }

  // Return normalized absolute path
  return path.resolve(rootDir, decodedPath);
}

/**
 * [SEC-394] Validate that a path does not escape the worktree root via symlinks.
 *
 * This function resolves symlinks using realpathSync and verifies that
 * the resolved real path remains within the resolved real root directory.
 * For non-existent paths (e.g., file creation), it walks up the directory
 * tree to find the nearest existing ancestor and validates that ancestor.
 *
 * IMPORTANT: This function is intended to be called AFTER isPathSafe()
 * as a defense-in-depth measure. isPathSafe() handles lexical path
 * traversal; this function handles symlink-based traversal.
 *
 * @param targetPath - Relative path to validate (relative to rootDir)
 * @param rootDir - The worktree root directory (absolute path)
 * @returns true if the resolved real path is within the resolved real root, false otherwise
 *
 * @example
 * ```typescript
 * // Symlink pointing outside root -> rejected
 * resolveAndValidateRealPath('evil-link', '/home/user/worktree'); // false
 *
 * // Normal file inside root -> allowed
 * resolveAndValidateRealPath('src/file.ts', '/home/user/worktree'); // true
 * ```
 */
export function resolveAndValidateRealPath(targetPath: string, rootDir: string): boolean {
  // 1. Resolve rootDir with realpathSync (handles macOS /var -> /private/var)
  let resolvedRoot: string;
  try {
    resolvedRoot = realpathSync(rootDir);
  } catch {
    // fail-safe: if rootDir cannot be resolved, reject
    return false;
  }

  const fullPath = path.resolve(rootDir, targetPath);

  // 2. If the target path exists (following symlinks), resolve it and compare
  if (existsSync(fullPath)) {
    try {
      const resolvedTarget = realpathSync(fullPath);
      const ok = isWithinRoot(resolvedTarget, resolvedRoot);
      if (!ok) {
        logger.warn('security:symlink-rejected', { targetPath, resolvedTarget });
      }
      return ok;
    } catch {
      // fail-safe: if realpathSync fails on the target, reject
      return false;
    }
  }

  // 2b. Handle dangling symlinks: the symlink file itself exists (lstat) but its target does not
  try {
    const lstats = lstatSync(fullPath);
    if (lstats.isSymbolicLink()) {
      // Dangling symlink detected - resolve link target and validate
      try {
        const linkTarget = readlinkSync(fullPath);
        const resolvedLinkTarget = path.resolve(path.dirname(fullPath), linkTarget);
        const ok = isWithinRoot(resolvedLinkTarget, resolvedRoot);
        if (!ok) {
          logger.warn('security:dangling-symlink-rejected', { targetPath, resolvedLinkTarget });
        }
        return ok;
      } catch {
        return false;
      }
    }
  } catch {
    // lstat failed - path truly does not exist, continue to ancestor walk
  }

  // 3. For non-existent paths (create/upload), walk up to the nearest existing ancestor
  let currentPath = path.dirname(fullPath);
  while (currentPath !== path.dirname(currentPath)) {
    // Stop at filesystem root
    if (existsSync(currentPath)) {
      try {
        const resolvedAncestor = realpathSync(currentPath);
        const ok = isWithinRoot(resolvedAncestor, resolvedRoot);
        if (!ok) {
          logger.warn('security:symlink-ancestor-rejected', { currentPath, resolvedAncestor });
        }
        return ok;
      } catch {
        // fail-safe
        return false;
      }
    }
    currentPath = path.dirname(currentPath);
  }

  // fail-safe: reached filesystem root without finding an existing ancestor
  return false;
}
