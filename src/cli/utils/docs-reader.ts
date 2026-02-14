/**
 * DocsReader Utility
 * Issue #264: Documentation retrieval for docs command
 *
 * [SF-003] SRP: Separated from docs command handler.
 * This utility manages section mapping, path resolution, file reading, and search logic.
 * The command handler (docs.ts) only handles argument parsing and output formatting.
 *
 * Security:
 * - [SEC-SF-002] Search query length limit (MAX_SEARCH_QUERY_LENGTH = 256)
 * - Path traversal prevention via SECTION_MAP whitelist
 * - [SF-004] package.json anchor-based path resolution
 *
 * @module docs-reader
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Whitelist of available documentation sections.
 * [C-CONS-003] Only files listed here can be accessed via the docs command.
 * Path traversal attempts are prevented by validating section names against this map.
 */
const SECTION_MAP: Record<string, string> = {
  'quick-start': 'docs/user-guide/quick-start.md',
  'commands': 'docs/user-guide/commands-guide.md',
  'webapp': 'docs/user-guide/webapp-guide.md',
  'workflow-examples': 'docs/user-guide/workflow-examples.md',
  'cli-setup': 'docs/user-guide/cli-setup-guide.md',
  'agents': 'docs/user-guide/agents-guide.md',
  'architecture': 'docs/architecture.md',
  'readme': 'README.md',
};

/**
 * [SEC-SF-002] Maximum search query length.
 * String.prototype.includes() is used (no ReDoS risk), but this prevents
 * performance degradation from extremely long queries.
 */
const MAX_SEARCH_QUERY_LENGTH = 256;

/**
 * Resolve the package root directory using package.json as anchor.
 * [SF-004] Uses package.json location to determine root, resilient to
 * compile output structure changes (instead of fragile __dirname relative paths).
 */
function resolvePackageRoot(): string {
  // From src/cli/utils/ -> 3 levels up to project root
  // From dist/cli/utils/ -> 3 levels up to project root
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'package.json');
    try {
      fs.accessSync(candidate);
      return dir;
    } catch {
      dir = path.dirname(dir);
    }
  }
  // Fallback: 3 levels up from __dirname
  return path.resolve(__dirname, '..', '..', '..');
}

/**
 * Get list of available documentation section names.
 */
export function getAvailableSections(): string[] {
  return Object.keys(SECTION_MAP);
}

/**
 * Check if a section name is valid (exists in the whitelist).
 */
export function isValidSection(section: string): boolean {
  return section in SECTION_MAP;
}

/**
 * Read the content of a documentation section.
 *
 * @param section - Section name (must be in SECTION_MAP whitelist)
 * @throws Error if section is invalid or file cannot be read
 */
export function readSection(section: string): string {
  if (!isValidSection(section)) {
    throw new Error(`Invalid section: ${section}`);
  }
  const packageRoot = resolvePackageRoot();
  const filePath = path.join(packageRoot, SECTION_MAP[section]);
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * Search documentation for a query string.
 * Uses String.prototype.includes() for case-insensitive matching (no regex).
 *
 * @param query - Search query (max 256 characters)
 * @throws Error if query exceeds MAX_SEARCH_QUERY_LENGTH
 */
export function searchDocs(query: string): Array<{ section: string; matches: string[] }> {
  if (query.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new Error(`Search query exceeds maximum length of ${MAX_SEARCH_QUERY_LENGTH} characters`);
  }

  const results: Array<{ section: string; matches: string[] }> = [];
  const packageRoot = resolvePackageRoot();
  const lowerQuery = query.toLowerCase();

  for (const [section, relativePath] of Object.entries(SECTION_MAP)) {
    const filePath = path.join(packageRoot, relativePath);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const matches = lines.filter(line =>
        line.toLowerCase().includes(lowerQuery)
      );
      if (matches.length > 0) {
        results.push({ section, matches });
      }
    } catch {
      // File does not exist - skip
    }
  }

  return results;
}
