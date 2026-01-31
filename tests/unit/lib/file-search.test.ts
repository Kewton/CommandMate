/**
 * File Search Unit Tests
 * [Issue #21] File tree search functionality
 *
 * Tests for:
 * - [SEC-MF-001] No RegExp usage (ReDoS prevention)
 * - [SEC-SF-001] Relative paths only
 * - [SEC-SF-002] Content truncation
 * - Query validation
 * - Matching logic
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  validateSearchQuery,
  truncateContent,
  contentContainsQuery,
  findMatchingLines,
  searchFileContents,
  SearchTimeoutError,
  searchWithTimeout,
  SEARCH_MAX_CONTENT_LENGTH,
  SEARCH_MAX_QUERY_LENGTH,
  SEARCH_MAX_RESULTS,
} from '@/lib/file-search';
import * as fs from 'fs/promises';
import * as path from 'path';

// Mock fs/promises
vi.mock('fs/promises');

describe('File Search', () => {
  // ============================================================================
  // validateSearchQuery Tests
  // ============================================================================
  describe('validateSearchQuery', () => {
    it('should return false for empty string', () => {
      expect(validateSearchQuery('')).toBe(false);
    });

    it('should return false for whitespace-only string', () => {
      expect(validateSearchQuery('   ')).toBe(false);
      expect(validateSearchQuery('\t\n')).toBe(false);
    });

    it('should return false for query exceeding max length', () => {
      const longQuery = 'a'.repeat(SEARCH_MAX_QUERY_LENGTH + 1);
      expect(validateSearchQuery(longQuery)).toBe(false);
    });

    it('should return true for valid queries', () => {
      expect(validateSearchQuery('test')).toBe(true);
      expect(validateSearchQuery('hello world')).toBe(true);
      expect(validateSearchQuery('a')).toBe(true);
    });

    it('should return true for query at max length', () => {
      const maxQuery = 'a'.repeat(SEARCH_MAX_QUERY_LENGTH);
      expect(validateSearchQuery(maxQuery)).toBe(true);
    });

    it('should handle special characters', () => {
      expect(validateSearchQuery('.*+?^${}()|[]\\/')).toBe(true);
      expect(validateSearchQuery('function()')).toBe(true);
    });

    it('should handle Japanese characters', () => {
      expect(validateSearchQuery('検索')).toBe(true);
      expect(validateSearchQuery('こんにちは')).toBe(true);
    });
  });

  // ============================================================================
  // truncateContent Tests
  // [SEC-SF-002] Content truncation security
  // ============================================================================
  describe('truncateContent', () => {
    it('should not truncate content shorter than max length', () => {
      const content = 'short content';
      expect(truncateContent(content)).toBe(content);
    });

    it('should not truncate content at exact max length', () => {
      const content = 'a'.repeat(SEARCH_MAX_CONTENT_LENGTH);
      expect(truncateContent(content)).toBe(content);
    });

    it('should truncate content exceeding max length', () => {
      const content = 'a'.repeat(SEARCH_MAX_CONTENT_LENGTH + 50);
      const result = truncateContent(content);
      expect(result.length).toBe(SEARCH_MAX_CONTENT_LENGTH + 3); // +3 for '...'
      expect(result.endsWith('...')).toBe(true);
    });

    it('should use custom max length when provided', () => {
      const content = 'hello world';
      const result = truncateContent(content, 5);
      expect(result).toBe('hello...');
    });

    it('should handle empty string', () => {
      expect(truncateContent('')).toBe('');
    });
  });

  // ============================================================================
  // contentContainsQuery Tests
  // [SEC-MF-001] No RegExp usage - uses indexOf/includes
  // ============================================================================
  describe('contentContainsQuery', () => {
    it('should find exact matches', () => {
      expect(contentContainsQuery('hello world', 'hello')).toBe(true);
      expect(contentContainsQuery('hello world', 'world')).toBe(true);
    });

    it('should be case-insensitive', () => {
      expect(contentContainsQuery('Hello World', 'hello')).toBe(true);
      expect(contentContainsQuery('hello world', 'HELLO')).toBe(true);
      expect(contentContainsQuery('HELLO WORLD', 'hello world')).toBe(true);
    });

    it('should return false for non-matches', () => {
      expect(contentContainsQuery('hello world', 'foo')).toBe(false);
      expect(contentContainsQuery('hello world', 'worlds')).toBe(false);
    });

    it('should handle empty content', () => {
      expect(contentContainsQuery('', 'test')).toBe(false);
    });

    it('should handle empty query', () => {
      expect(contentContainsQuery('hello', '')).toBe(true);
    });

    it('[SEC-MF-001] should NOT use RegExp - handles special chars as literals', () => {
      // These would be special in RegExp but should be treated as literals
      expect(contentContainsQuery('hello.world', '.')).toBe(true);
      expect(contentContainsQuery('hello*world', '*')).toBe(true);
      expect(contentContainsQuery('hello+world', '+')).toBe(true);
      expect(contentContainsQuery('hello?world', '?')).toBe(true);
      expect(contentContainsQuery('[test]', '[test]')).toBe(true);
      expect(contentContainsQuery('(a|b)', '(a|b)')).toBe(true);

      // This pattern would match anything with RegExp but should only match literal
      expect(contentContainsQuery('hello', '.*')).toBe(false);
    });
  });

  // ============================================================================
  // findMatchingLines Tests
  // [SEC-MF-001] No RegExp usage
  // [SEC-SF-002] Content truncation
  // ============================================================================
  describe('findMatchingLines', () => {
    it('should find matching lines with correct line numbers', () => {
      const content = `line one
line two with match
line three
line four with match`;
      const matches = findMatchingLines(content, 'match');
      expect(matches).toHaveLength(2);
      expect(matches[0].line).toBe(2);
      expect(matches[1].line).toBe(4);
    });

    it('should be case-insensitive', () => {
      const content = `Hello World
HELLO WORLD
hello world`;
      const matches = findMatchingLines(content, 'hello');
      expect(matches).toHaveLength(3);
    });

    it('should return empty array for no matches', () => {
      const content = 'hello world';
      const matches = findMatchingLines(content, 'foo');
      expect(matches).toHaveLength(0);
    });

    it('[SEC-SF-002] should truncate long lines', () => {
      const longLine = 'match' + 'a'.repeat(SEARCH_MAX_CONTENT_LENGTH);
      const content = longLine;
      const matches = findMatchingLines(content, 'match');
      expect(matches).toHaveLength(1);
      expect(matches[0].content.length).toBeLessThanOrEqual(SEARCH_MAX_CONTENT_LENGTH + 3);
      expect(matches[0].content.endsWith('...')).toBe(true);
    });

    it('[SEC-MF-001] should NOT use RegExp', () => {
      const content = 'hello.world';
      // '.' with RegExp would match any char, but we treat it literally
      const matches = findMatchingLines(content, '.');
      expect(matches).toHaveLength(1);
      expect(matches[0].content).toBe('hello.world');
    });

    it('should handle empty content', () => {
      const matches = findMatchingLines('', 'test');
      expect(matches).toHaveLength(0);
    });

    it('should handle content with only newlines', () => {
      const matches = findMatchingLines('\n\n\n', 'test');
      expect(matches).toHaveLength(0);
    });
  });

  // ============================================================================
  // searchFileContents Integration Tests (with mocked fs)
  // ============================================================================
  describe('searchFileContents', () => {
    beforeEach(() => {
      vi.resetAllMocks();
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should return empty results for invalid query', async () => {
      const result = await searchFileContents('/base', { query: '' });
      expect(result.results).toHaveLength(0);
      expect(result.totalMatches).toBe(0);
    });

    it('should search files and return relative paths [SEC-SF-001]', async () => {
      const mockFs = fs as unknown as {
        readdir: ReturnType<typeof vi.fn>;
        lstat: ReturnType<typeof vi.fn>;
        readFile: ReturnType<typeof vi.fn>;
      };

      mockFs.readdir.mockResolvedValue(['test.ts']);
      mockFs.lstat.mockResolvedValue({
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
        size: 100,
      });
      mockFs.readFile.mockResolvedValue(Buffer.from('hello world\ntest content'));

      const result = await searchFileContents('/base/path', { query: 'hello' });

      expect(result.results).toHaveLength(1);
      // [SEC-SF-001] Should return relative path, not absolute
      expect(result.results[0].filePath).toBe('test.ts');
      expect(result.results[0].filePath.startsWith('/base')).toBe(false);
    });

    it('should skip excluded patterns', async () => {
      const mockFs = fs as unknown as {
        readdir: ReturnType<typeof vi.fn>;
        lstat: ReturnType<typeof vi.fn>;
        readFile: ReturnType<typeof vi.fn>;
      };

      mockFs.readdir.mockResolvedValue(['.git', 'node_modules', '.env', 'test.ts']);
      mockFs.lstat.mockResolvedValue({
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
        size: 100,
      });
      mockFs.readFile.mockResolvedValue(Buffer.from('hello'));

      const result = await searchFileContents('/base', { query: 'hello' });

      // Only test.ts should be searched
      expect(result.results).toHaveLength(1);
      expect(result.results[0].fileName).toBe('test.ts');
    });

    it('should skip binary files by extension', async () => {
      const mockFs = fs as unknown as {
        readdir: ReturnType<typeof vi.fn>;
        lstat: ReturnType<typeof vi.fn>;
        readFile: ReturnType<typeof vi.fn>;
      };

      mockFs.readdir.mockResolvedValue(['image.png', 'test.ts']);
      mockFs.lstat.mockResolvedValue({
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
        size: 100,
      });
      mockFs.readFile.mockResolvedValue(Buffer.from('hello'));

      const result = await searchFileContents('/base', { query: 'hello' });

      // Only test.ts should be searched (png is binary)
      expect(result.results).toHaveLength(1);
      expect(result.results[0].fileName).toBe('test.ts');
    });

    it('should skip files larger than maxFileSize', async () => {
      const mockFs = fs as unknown as {
        readdir: ReturnType<typeof vi.fn>;
        lstat: ReturnType<typeof vi.fn>;
        readFile: ReturnType<typeof vi.fn>;
      };

      mockFs.readdir.mockResolvedValue(['large.ts', 'small.ts']);
      mockFs.lstat
        .mockResolvedValueOnce({
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
          size: 2 * 1024 * 1024, // 2MB - too large
        })
        .mockResolvedValueOnce({
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
          size: 100, // Small
        });
      mockFs.readFile.mockResolvedValue(Buffer.from('hello'));

      const result = await searchFileContents('/base', {
        query: 'hello',
        maxFileSize: 1024 * 1024,
      });

      // Only small.ts should be searched
      expect(result.results).toHaveLength(1);
      expect(result.results[0].fileName).toBe('small.ts');
    });

    it('should truncate results when exceeding maxResults', async () => {
      const mockFs = fs as unknown as {
        readdir: ReturnType<typeof vi.fn>;
        lstat: ReturnType<typeof vi.fn>;
        readFile: ReturnType<typeof vi.fn>;
      };

      // Create many files
      const files = Array.from({ length: 150 }, (_, i) => `file${i}.ts`);
      mockFs.readdir.mockResolvedValue(files);
      mockFs.lstat.mockResolvedValue({
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
        size: 100,
      });
      mockFs.readFile.mockResolvedValue(Buffer.from('hello'));

      const result = await searchFileContents('/base', {
        query: 'hello',
        maxResults: 10,
      });

      expect(result.results.length).toBeLessThanOrEqual(10);
      expect(result.truncated).toBe(true);
    });

    it('should handle symbolic links by skipping them', async () => {
      const mockFs = fs as unknown as {
        readdir: ReturnType<typeof vi.fn>;
        lstat: ReturnType<typeof vi.fn>;
        readFile: ReturnType<typeof vi.fn>;
      };

      mockFs.readdir.mockResolvedValue(['link.ts', 'normal.ts']);
      mockFs.lstat
        .mockResolvedValueOnce({
          isFile: () => false,
          isDirectory: () => false,
          isSymbolicLink: () => true,
          size: 100,
        })
        .mockResolvedValueOnce({
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
          size: 100,
        });
      mockFs.readFile.mockResolvedValue(Buffer.from('hello'));

      const result = await searchFileContents('/base', { query: 'hello' });

      // Only normal.ts should be searched
      expect(result.results).toHaveLength(1);
      expect(result.results[0].fileName).toBe('normal.ts');
    });

    it('should recurse into directories', async () => {
      const mockFs = fs as unknown as {
        readdir: ReturnType<typeof vi.fn>;
        lstat: ReturnType<typeof vi.fn>;
        readFile: ReturnType<typeof vi.fn>;
      };

      // First call: root directory
      mockFs.readdir
        .mockResolvedValueOnce(['subdir', 'root.ts'])
        // Second call: subdir
        .mockResolvedValueOnce(['nested.ts']);

      mockFs.lstat
        // subdir
        .mockResolvedValueOnce({
          isFile: () => false,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        })
        // root.ts
        .mockResolvedValueOnce({
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
          size: 100,
        })
        // nested.ts
        .mockResolvedValueOnce({
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
          size: 100,
        });

      mockFs.readFile.mockResolvedValue(Buffer.from('hello'));

      const result = await searchFileContents('/base', { query: 'hello' });

      expect(result.results).toHaveLength(2);
      expect(result.results.map((r) => r.fileName)).toContain('root.ts');
      expect(result.results.map((r) => r.fileName)).toContain('nested.ts');
    });

    it('should respect maxDepth limit', async () => {
      const mockFs = fs as unknown as {
        readdir: ReturnType<typeof vi.fn>;
        lstat: ReturnType<typeof vi.fn>;
        readFile: ReturnType<typeof vi.fn>;
      };

      // Setup deeply nested structure
      mockFs.readdir
        .mockResolvedValueOnce(['level1'])
        .mockResolvedValueOnce(['level2'])
        .mockResolvedValueOnce(['deep.ts']);

      mockFs.lstat
        .mockResolvedValueOnce({
          isFile: () => false,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        })
        .mockResolvedValueOnce({
          isFile: () => false,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        })
        .mockResolvedValueOnce({
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
          size: 100,
        });

      mockFs.readFile.mockResolvedValue(Buffer.from('hello'));

      const result = await searchFileContents('/base', {
        query: 'hello',
        maxDepth: 1, // Only go 1 level deep
      });

      // Should not reach deep.ts at level 2
      expect(result.results).toHaveLength(0);
    });

    it('should skip binary content files', async () => {
      const mockFs = fs as unknown as {
        readdir: ReturnType<typeof vi.fn>;
        lstat: ReturnType<typeof vi.fn>;
        readFile: ReturnType<typeof vi.fn>;
      };

      mockFs.readdir.mockResolvedValue(['binary.dat', 'text.ts']);
      mockFs.lstat.mockResolvedValue({
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
        size: 100,
      });
      mockFs.readFile
        // binary.dat - contains NULL byte
        .mockResolvedValueOnce(Buffer.from([0x00, 0x01, 0x02]))
        // text.ts
        .mockResolvedValueOnce(Buffer.from('hello'));

      const result = await searchFileContents('/base', { query: 'hello' });

      // Only text.ts should have results
      expect(result.results).toHaveLength(1);
      expect(result.results[0].fileName).toBe('text.ts');
    });
  });

  // ============================================================================
  // SearchTimeoutError Tests
  // ============================================================================
  describe('SearchTimeoutError', () => {
    it('should have correct name and message', () => {
      const error = new SearchTimeoutError('custom message');
      expect(error.name).toBe('SearchTimeoutError');
      expect(error.message).toBe('custom message');
    });

    it('should use default message', () => {
      const error = new SearchTimeoutError();
      expect(error.message).toBe('Search timed out');
    });

    it('should be an instance of Error', () => {
      const error = new SearchTimeoutError();
      expect(error).toBeInstanceOf(Error);
    });
  });

  // ============================================================================
  // searchWithTimeout Tests
  // ============================================================================
  describe('searchWithTimeout', () => {
    beforeEach(() => {
      vi.resetAllMocks();
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.clearAllMocks();
      vi.useRealTimers();
    });

    it('should return results with executionTimeMs', async () => {
      const mockFs = fs as unknown as {
        readdir: ReturnType<typeof vi.fn>;
        lstat: ReturnType<typeof vi.fn>;
        readFile: ReturnType<typeof vi.fn>;
      };

      mockFs.readdir.mockResolvedValue(['test.ts']);
      mockFs.lstat.mockResolvedValue({
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
        size: 100,
      });
      mockFs.readFile.mockResolvedValue(Buffer.from('hello'));

      const resultPromise = searchWithTimeout('/base', { query: 'hello' });
      vi.advanceTimersByTime(0);
      const result = await resultPromise;

      expect(result.executionTimeMs).toBeDefined();
      expect(typeof result.executionTimeMs).toBe('number');
    });
  });

  // ============================================================================
  // Constants Tests
  // ============================================================================
  describe('Constants', () => {
    it('should have reasonable default values', () => {
      expect(SEARCH_MAX_RESULTS).toBe(100);
      expect(SEARCH_MAX_CONTENT_LENGTH).toBe(500);
      expect(SEARCH_MAX_QUERY_LENGTH).toBe(1000);
    });
  });
});
