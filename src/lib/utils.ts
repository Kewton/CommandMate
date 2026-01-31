/**
 * Utility Functions
 * [MF-001] Common utility functions for the application
 */

/**
 * Creates a debounced version of a function that delays execution
 * until after the specified delay has passed since the last invocation.
 *
 * @param fn - The function to debounce
 * @param delay - The delay in milliseconds
 * @returns A debounced version of the function
 *
 * @example
 * ```typescript
 * const debouncedSearch = debounce((query: string) => {
 *   console.log('Searching for:', query);
 * }, 300);
 *
 * debouncedSearch('a');
 * debouncedSearch('ab');
 * debouncedSearch('abc'); // Only this will execute after 300ms
 * ```
 */
export function debounce<T extends (...args: Parameters<T>) => void>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return (...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, delay);
  };
}

/**
 * Escape special characters in a string for use in RegExp
 * [Issue #21] File tree search functionality
 *
 * NOTE: This function is for CLIENT-SIDE highlight rendering only.
 * Server-side search MUST NOT use RegExp (ReDoS prevention - SEC-MF-001).
 * Server-side uses indexOf/includes for string matching.
 *
 * @param str - String to escape
 * @returns String with RegExp special characters escaped
 *
 * @example
 * ```typescript
 * escapeRegExp('hello.world');  // 'hello\\.world'
 * escapeRegExp('[test]');       // '\\[test\\]'
 * escapeRegExp('a*b+c?');       // 'a\\*b\\+c\\?'
 * ```
 */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compute matched file paths and their parent directories from search results
 * [Issue #21] Shared utility to avoid code duplication between useFileSearch and FileTreeView
 *
 * @param filePaths - Array of matched file paths from search results
 * @returns Set containing file paths and all their parent directory paths
 *
 * @example
 * ```typescript
 * const paths = computeMatchedPaths(['src/lib/file.ts', 'src/hooks/hook.ts']);
 * // Returns Set { 'src/lib/file.ts', 'src/lib', 'src', 'src/hooks/hook.ts', 'src/hooks' }
 * ```
 */
export function computeMatchedPaths(filePaths: string[]): Set<string> {
  const paths = new Set<string>();

  for (const filePath of filePaths) {
    paths.add(filePath);

    // Add all parent directories
    const parts = filePath.split('/');
    let currentPath = '';
    for (let i = 0; i < parts.length - 1; i++) {
      currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
      paths.add(currentPath);
    }
  }

  return paths;
}
