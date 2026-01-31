/**
 * File Search Business Logic
 * [Issue #21] File tree search functionality
 *
 * Provides server-side file content search with security measures:
 * - [SEC-MF-001] No RegExp usage (ReDoS prevention) - uses indexOf/includes
 * - [SEC-SF-001] Returns relative paths only (no absolute path exposure)
 * - [SEC-SF-002] Content truncated to 500 characters
 * - Path traversal protection via isPathSafe
 * - Excluded patterns from file-tree.ts
 * - Binary file exclusion
 */

import { readdir, readFile, lstat } from 'fs/promises';
import { join, relative, extname, basename } from 'path';
import { isPathSafe } from './path-validator';
import { isExcludedPattern, LIMITS } from './file-tree';
import { isBinaryExtension, isBinaryContent } from '@/config/binary-extensions';
import type { SearchResultItem } from '@/types/models';

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum number of search results to return
 */
export const SEARCH_MAX_RESULTS = 100;

/**
 * Maximum length of content line in search results
 * [SEC-SF-002] Security measure to prevent large content exposure
 */
export const SEARCH_MAX_CONTENT_LENGTH = 500;

/**
 * Default search timeout in milliseconds
 */
export const SEARCH_DEFAULT_TIMEOUT_MS = 5000;

/**
 * Maximum query length
 */
export const SEARCH_MAX_QUERY_LENGTH = 1000;

// ============================================================================
// Types
// ============================================================================

/**
 * Search options for file content search
 */
export interface SearchOptions {
  /** Search query string */
  query: string;
  /** Maximum number of results (default: 100) */
  maxResults?: number;
  /** Timeout in milliseconds (default: 5000) */
  timeoutMs?: number;
  /** Maximum file size to search (default: 1MB) */
  maxFileSize?: number;
  /** Maximum directory depth (default: 10) */
  maxDepth?: number;
}

/**
 * Internal search state for tracking progress
 */
interface SearchState {
  results: SearchResultItem[];
  totalMatches: number;
  truncated: boolean;
  startTime: number;
}

/**
 * Configuration for directory search
 * [SRP] Encapsulates search configuration to reduce function parameter count
 */
interface SearchConfig {
  basePath: string;
  lowerQuery: string;
  maxDepth: number;
  maxResults: number;
  maxFileSize: number;
  signal?: AbortSignal;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Validate search query
 *
 * @param query - Search query string
 * @returns True if query is valid
 */
export function validateSearchQuery(query: string): boolean {
  if (!query || query.trim().length === 0) {
    return false;
  }
  if (query.length > SEARCH_MAX_QUERY_LENGTH) {
    return false;
  }
  return true;
}

/**
 * Truncate content to maximum length
 * [SEC-SF-002] Security measure
 *
 * @param content - Content to truncate
 * @param maxLength - Maximum length (default: 500)
 * @returns Truncated content with '...' suffix if truncated
 */
export function truncateContent(content: string, maxLength: number = SEARCH_MAX_CONTENT_LENGTH): string {
  if (content.length <= maxLength) {
    return content;
  }
  return content.slice(0, maxLength) + '...';
}

/**
 * Check if content contains the query (case-insensitive)
 * [SEC-MF-001] Uses indexOf instead of RegExp to prevent ReDoS
 *
 * @param content - Content to search in
 * @param query - Query to search for
 * @returns True if content contains query
 */
export function contentContainsQuery(content: string, query: string): boolean {
  return content.toLowerCase().includes(query.toLowerCase());
}

/**
 * Find all matching lines in content
 * [SEC-MF-001] Uses indexOf instead of RegExp to prevent ReDoS
 * [SEC-SF-002] Truncates each line to 500 characters
 *
 * @param content - File content
 * @param query - Search query
 * @returns Array of matching lines with line numbers
 */
export function findMatchingLines(
  content: string,
  query: string
): Array<{ line: number; content: string }> {
  const lines = content.split('\n');
  const lowerQuery = query.toLowerCase();
  const matches: Array<{ line: number; content: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // [SEC-MF-001] Use includes instead of RegExp
    if (line.toLowerCase().includes(lowerQuery)) {
      matches.push({
        line: i + 1, // 1-based line numbers
        content: truncateContent(line),
      });
    }
  }

  return matches;
}

// ============================================================================
// Main Search Function
// ============================================================================

/**
 * Search for files containing the query text
 * [SEC-MF-001] No RegExp usage - uses string methods for search
 * [SEC-SF-001] Returns relative paths only
 * [SEC-SF-002] Content truncated to 500 characters
 *
 * @param basePath - Base directory path to search in
 * @param options - Search options
 * @param signal - Optional AbortSignal for cancellation
 * @returns Array of search result items
 */
export async function searchFileContents(
  basePath: string,
  options: SearchOptions,
  signal?: AbortSignal
): Promise<{
  results: SearchResultItem[];
  totalMatches: number;
  truncated: boolean;
}> {
  const {
    query,
    maxResults = SEARCH_MAX_RESULTS,
    maxFileSize = LIMITS.MAX_FILE_SIZE_PREVIEW,
    maxDepth = LIMITS.MAX_DEPTH,
  } = options;

  // Validate query
  if (!validateSearchQuery(query)) {
    return { results: [], totalMatches: 0, truncated: false };
  }

  const state: SearchState = {
    results: [],
    totalMatches: 0,
    truncated: false,
    startTime: Date.now(),
  };

  // Create search config to reduce parameter count [SRP]
  const config: SearchConfig = {
    basePath,
    lowerQuery: query.toLowerCase(),
    maxDepth,
    maxResults,
    maxFileSize,
    signal,
  };

  // Recursive search function
  await searchDirectory(basePath, 0, config, state);

  return {
    results: state.results,
    totalMatches: state.totalMatches,
    truncated: state.truncated,
  };
}

/**
 * Recursively search a directory for files containing the query
 * [SRP] Uses SearchConfig to encapsulate configuration parameters
 *
 * @param currentPath - Current directory path
 * @param depth - Current depth
 * @param config - Search configuration
 * @param state - Search state object (mutated)
 */
async function searchDirectory(
  currentPath: string,
  depth: number,
  config: SearchConfig,
  state: SearchState
): Promise<void> {
  const { basePath, maxDepth, maxResults, signal } = config;

  // Check for abort
  if (signal?.aborted) {
    throw new DOMException('Search aborted', 'AbortError');
  }

  // Check depth limit
  if (depth > maxDepth) {
    return;
  }

  // Check result limit
  if (state.results.length >= maxResults) {
    state.truncated = true;
    return;
  }

  // Path safety check
  // [CONS-MF-001] Correct argument order: isPathSafe(targetPath, rootDir)
  if (!isPathSafe(currentPath, basePath)) {
    return;
  }

  let entries: string[];
  try {
    entries = await readdir(currentPath);
  } catch {
    // Skip directories we cannot access
    return;
  }

  for (const entry of entries) {
    // Check for abort
    if (signal?.aborted) {
      throw new DOMException('Search aborted', 'AbortError');
    }

    // Check result limit
    if (state.results.length >= maxResults) {
      state.truncated = true;
      return;
    }

    // Skip excluded patterns
    // [CONS-SF-001] Use EXCLUDED_PATTERNS from file-tree.ts
    if (isExcludedPattern(entry)) {
      continue;
    }

    const entryPath = join(currentPath, entry);

    // Path safety check
    if (!isPathSafe(entryPath, basePath)) {
      continue;
    }

    try {
      const entryStat = await lstat(entryPath);

      // Skip symbolic links
      if (entryStat.isSymbolicLink()) {
        continue;
      }

      if (entryStat.isDirectory()) {
        // Recurse into directory
        await searchDirectory(entryPath, depth + 1, config, state);
      } else if (entryStat.isFile()) {
        // Process file entry
        await processFileEntry(entryPath, entry, entryStat.size, config, state);
      }
    } catch {
      // Skip entries we cannot access
      continue;
    }
  }
}

/**
 * Process a single file entry during search
 * [SRP] Extracted from searchDirectory for single responsibility
 *
 * @param entryPath - Full path to the file
 * @param entry - File name
 * @param fileSize - Size of the file in bytes
 * @param config - Search configuration
 * @param state - Search state object (mutated)
 */
async function processFileEntry(
  entryPath: string,
  entry: string,
  fileSize: number,
  config: SearchConfig,
  state: SearchState
): Promise<void> {
  const { basePath, lowerQuery, maxFileSize } = config;

  // Check file size
  if (fileSize > maxFileSize) {
    return;
  }

  // Check if binary by extension
  const ext = extname(entry);
  if (isBinaryExtension(ext)) {
    return;
  }

  // Read file content
  let content: Buffer;
  try {
    content = await readFile(entryPath);
  } catch {
    // Skip files we cannot read
    return;
  }

  // Check if binary by content
  if (isBinaryContent(content)) {
    return;
  }

  // Convert to string
  let textContent: string;
  try {
    textContent = content.toString('utf-8');
  } catch {
    // Skip non-UTF-8 files
    return;
  }

  // Search for matches
  // [SEC-MF-001] Use includes instead of RegExp
  if (textContent.toLowerCase().includes(lowerQuery)) {
    const matches = findMatchingLines(textContent, lowerQuery);

    if (matches.length > 0) {
      // [SEC-SF-001] Use relative path only
      const relativePath = relative(basePath, entryPath);

      state.results.push({
        filePath: relativePath,
        fileName: basename(entry),
        matches,
      });
      state.totalMatches += matches.length;
    }
  }
}

/**
 * Custom error class for search timeout
 */
export class SearchTimeoutError extends Error {
  constructor(message: string = 'Search timed out') {
    super(message);
    this.name = 'SearchTimeoutError';
  }
}

/**
 * Execute search with timeout
 *
 * @param basePath - Base directory path to search in
 * @param options - Search options
 * @returns Search results
 * @throws SearchTimeoutError if search exceeds timeout
 */
export async function searchWithTimeout(
  basePath: string,
  options: SearchOptions
): Promise<{
  results: SearchResultItem[];
  totalMatches: number;
  truncated: boolean;
  executionTimeMs: number;
}> {
  const timeoutMs = options.timeoutMs ?? SEARCH_DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const startTime = Date.now();

  try {
    const result = await searchFileContents(basePath, options, controller.signal);
    const executionTimeMs = Date.now() - startTime;

    return {
      ...result,
      executionTimeMs,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new SearchTimeoutError(`Search timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
