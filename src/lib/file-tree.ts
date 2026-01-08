/**
 * File Tree Business Logic
 *
 * Handles directory traversal, filtering, and sorting for worktree file browsing.
 * Includes security measures to prevent access to sensitive files.
 */

import { readdir, stat, lstat } from 'fs/promises';
import { join, basename, extname, dirname } from 'path';
import type { TreeItem, TreeResponse } from '@/types/models';

// ============================================================================
// Types
// ============================================================================

/**
 * Standard API error response structure
 */
export interface ApiErrorResponse {
  error: string;
  status: number;
}

/**
 * Result type for API operations that may fail
 */
export type ApiResult<T> =
  | { success: true; data: T }
  | { success: false; error: ApiErrorResponse };

/**
 * Patterns for files and directories to exclude from the file tree
 */
export const EXCLUDED_PATTERNS: string[] = [
  '.git',           // Git internal directory
  '.env',           // Environment variables file
  '.env.*',         // Environment variables file (variants)
  'node_modules',   // Dependencies (excluded by default)
  '.DS_Store',      // macOS system file
  'Thumbs.db',      // Windows system file
  '*.pem',          // Private keys
  '*.key',          // Private keys
  '.env.local',     // Local environment file
  '.env.development',
  '.env.production',
  '.env.test',
];

/**
 * Limits for file tree operations
 */
export const LIMITS = {
  /** Maximum number of items per directory */
  MAX_ITEMS_PER_DIR: 500,
  /** Maximum nesting depth */
  MAX_DEPTH: 10,
  /** Maximum file size for preview (1MB) */
  MAX_FILE_SIZE_PREVIEW: 1024 * 1024,
} as const;

/**
 * Check if a file or directory name matches any excluded pattern
 *
 * @param name - File or directory name to check
 * @returns True if the name should be excluded
 */
export function isExcludedPattern(name: string): boolean {
  for (const pattern of EXCLUDED_PATTERNS) {
    // Exact match
    if (pattern === name) {
      return true;
    }

    // Wildcard pattern (*.ext)
    if (pattern.startsWith('*.')) {
      const ext = pattern.slice(1); // Get .ext
      if (name.endsWith(ext)) {
        return true;
      }
    }

    // Prefix pattern (name.*)
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2); // Get prefix without .*
      if (name.startsWith(prefix + '.')) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Filter out excluded items from a list of tree items
 *
 * @param items - List of tree items to filter
 * @returns Filtered list with excluded items removed
 */
export function filterExcludedItems(items: TreeItem[]): TreeItem[] {
  return items.filter(item => !isExcludedPattern(item.name));
}

/**
 * Sort tree items: directories first, then files, both alphabetically
 *
 * @param items - List of tree items to sort
 * @returns Sorted list
 */
export function sortItems(items: TreeItem[]): TreeItem[] {
  return [...items].sort((a, b) => {
    // Directories come first
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    // Alphabetical sort (case-insensitive)
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
}

/**
 * Get the number of items in a directory
 *
 * @param dirPath - Absolute path to the directory
 * @returns Number of items (excluding excluded patterns)
 */
async function getDirectoryItemCount(dirPath: string): Promise<number> {
  try {
    const entries = await readdir(dirPath);
    // Count only non-excluded items
    return entries.filter(name => !isExcludedPattern(name)).length;
  } catch {
    return 0;
  }
}

/**
 * Read a directory and return its contents as TreeResponse
 *
 * @param rootDir - Absolute path to the worktree root directory
 * @param relativePath - Relative path within the worktree (empty string for root)
 * @returns TreeResponse with directory contents
 * @throws Error if directory does not exist or is not a directory
 */
export async function readDirectory(
  rootDir: string,
  relativePath: string = ''
): Promise<TreeResponse> {
  const targetPath = relativePath ? join(rootDir, relativePath) : rootDir;

  // Verify the target is a directory
  let targetStat;
  try {
    targetStat = await stat(targetPath);
  } catch {
    throw new Error(`Directory not found: ${relativePath || '(root)'}`);
  }

  if (!targetStat.isDirectory()) {
    throw new Error(`Path is not a directory: ${relativePath}`);
  }

  // Read directory contents
  const entries = await readdir(targetPath);

  // Process each entry
  const items: TreeItem[] = [];

  for (const name of entries) {
    // Skip excluded patterns
    if (isExcludedPattern(name)) {
      continue;
    }

    const entryPath = join(targetPath, name);

    try {
      // Use lstat to detect symbolic links
      const entryStat = await lstat(entryPath);

      // Skip symbolic links for security
      if (entryStat.isSymbolicLink()) {
        continue;
      }

      if (entryStat.isDirectory()) {
        const itemCount = await getDirectoryItemCount(entryPath);
        items.push({
          name,
          type: 'directory',
          itemCount,
        });
      } else if (entryStat.isFile()) {
        const ext = extname(name);
        const item: TreeItem = {
          name,
          type: 'file',
          size: entryStat.size,
        };
        if (ext && ext.length > 1) {
          item.extension = ext.slice(1); // Remove the leading dot
        }
        items.push(item);
      }
    } catch {
      // Skip entries we cannot access
      continue;
    }

    // Respect item limit
    if (items.length >= LIMITS.MAX_ITEMS_PER_DIR) {
      break;
    }
  }

  // Sort items: directories first, then files, alphabetically
  const sortedItems = sortItems(items);

  // Calculate parent path
  let parentPath: string | null = null;
  if (relativePath) {
    const parent = dirname(relativePath);
    parentPath = parent === '.' ? '' : parent;
  }

  return {
    path: relativePath,
    name: relativePath ? basename(relativePath) : '',
    items: sortedItems,
    parentPath,
  };
}

// ============================================================================
// API Helper Functions
// ============================================================================

/**
 * Parse error message and return appropriate API error response
 *
 * Maps common error messages to HTTP status codes for consistent API responses.
 *
 * @param error - The error to parse
 * @returns ApiErrorResponse with appropriate status code and message
 */
export function parseDirectoryError(error: unknown): ApiErrorResponse {
  const message = error instanceof Error ? error.message : 'Unknown error';

  if (message.includes('not found')) {
    return {
      error: 'Directory not found',
      status: 404,
    };
  }

  if (message.includes('not a directory')) {
    return {
      error: 'Path is not a directory',
      status: 400,
    };
  }

  return {
    error: 'Failed to read directory',
    status: 500,
  };
}

/**
 * Create a standardized worktree not found error response
 *
 * @param worktreeId - The ID of the worktree that was not found
 * @returns ApiErrorResponse for a 404 not found error
 */
export function createWorktreeNotFoundError(worktreeId: string): ApiErrorResponse {
  return {
    error: `Worktree '${worktreeId}' not found`,
    status: 404,
  };
}

/**
 * Create a standardized access denied error response
 *
 * @param reason - Optional reason for the access denial
 * @returns ApiErrorResponse for a 403 forbidden error
 */
export function createAccessDeniedError(
  reason: string = 'Invalid path'
): ApiErrorResponse {
  return {
    error: `Access denied: ${reason}`,
    status: 403,
  };
}
