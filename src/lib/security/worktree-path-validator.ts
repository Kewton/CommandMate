/**
 * Worktree Path Validator (Issue #56, MF-1)
 *
 * Validates worktree paths to prevent path traversal attacks.
 * This is a simplified validator specifically for worktree paths.
 */

/**
 * Validate a worktree path
 *
 * MF-1: Implements the following checks:
 * 1. Empty string check
 * 2. Path traversal (..) detection
 * 3. Absolute path requirement
 * 4. Allowed base path check
 *
 * @param path - The worktree path to validate
 * @returns True if the path is valid, false otherwise
 */
export function isValidWorktreePath(path: string): boolean {
  // 1. Empty string check
  if (!path || path.trim() === '') {
    return false;
  }

  // 2. Path traversal detection
  if (path.includes('..')) {
    return false;
  }

  // 3. Absolute path requirement
  if (!path.startsWith('/')) {
    return false;
  }

  // 4. Allowed base path check
  const allowedBasePaths = getAlllowedBasePaths();
  return allowedBasePaths.some((base) => path.startsWith(base));
}

/**
 * Get allowed base paths from environment or defaults
 *
 * @returns Array of allowed base paths
 */
function getAlllowedBasePaths(): string[] {
  const envPaths = process.env.ALLOWED_WORKTREE_PATHS;
  if (envPaths) {
    return envPaths.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
  }

  // Default allowed paths (common development directories)
  return ['/Users', '/home', '/var', '/tmp', '/opt'];
}
