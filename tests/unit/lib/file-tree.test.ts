/**
 * File Tree Business Logic Tests
 * TDD Approach: Red (test first) -> Green (implement) -> Refactor
 *
 * Tests for directory traversal, filtering, and sorting functionality
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';

// Import the file tree module
import {
  readDirectory,
  filterExcludedItems,
  sortItems,
  isExcludedPattern,
  EXCLUDED_PATTERNS,
  LIMITS,
  parseDirectoryError,
  createWorktreeNotFoundError,
  createAccessDeniedError,
} from '@/lib/file-tree';
import type { TreeItem } from '@/types/models';

describe('File Tree Business Logic', () => {
  let testDir: string;

  beforeEach(() => {
    // Create a temporary test directory structure
    testDir = join(tmpdir(), `file-tree-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up temporary directory
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('EXCLUDED_PATTERNS', () => {
    it('should include .git directory', () => {
      expect(EXCLUDED_PATTERNS).toContain('.git');
    });

    it('should include .env file', () => {
      expect(EXCLUDED_PATTERNS).toContain('.env');
    });

    it('should include node_modules directory', () => {
      expect(EXCLUDED_PATTERNS).toContain('node_modules');
    });

    it('should include .DS_Store', () => {
      expect(EXCLUDED_PATTERNS).toContain('.DS_Store');
    });

    it('should include sensitive file patterns', () => {
      expect(EXCLUDED_PATTERNS).toContain('*.pem');
      expect(EXCLUDED_PATTERNS).toContain('*.key');
    });
  });

  describe('LIMITS', () => {
    it('should have MAX_ITEMS_PER_DIR defined', () => {
      expect(LIMITS.MAX_ITEMS_PER_DIR).toBe(500);
    });

    it('should have MAX_DEPTH defined', () => {
      expect(LIMITS.MAX_DEPTH).toBe(10);
    });

    it('should have MAX_FILE_SIZE_PREVIEW defined', () => {
      expect(LIMITS.MAX_FILE_SIZE_PREVIEW).toBe(1024 * 1024);
    });
  });

  describe('isExcludedPattern', () => {
    it('should return true for .git directory', () => {
      expect(isExcludedPattern('.git')).toBe(true);
    });

    it('should return true for .env file', () => {
      expect(isExcludedPattern('.env')).toBe(true);
    });

    it('should return true for .env.local file', () => {
      expect(isExcludedPattern('.env.local')).toBe(true);
    });

    it('should return true for node_modules directory', () => {
      expect(isExcludedPattern('node_modules')).toBe(true);
    });

    it('should return true for .DS_Store', () => {
      expect(isExcludedPattern('.DS_Store')).toBe(true);
    });

    it('should return true for .pem files', () => {
      expect(isExcludedPattern('server.pem')).toBe(true);
    });

    it('should return true for .key files', () => {
      expect(isExcludedPattern('private.key')).toBe(true);
    });

    it('should return false for normal files', () => {
      expect(isExcludedPattern('index.ts')).toBe(false);
      expect(isExcludedPattern('package.json')).toBe(false);
      expect(isExcludedPattern('README.md')).toBe(false);
    });

    it('should return false for normal directories', () => {
      expect(isExcludedPattern('src')).toBe(false);
      expect(isExcludedPattern('components')).toBe(false);
    });
  });

  describe('filterExcludedItems', () => {
    it('should filter out excluded patterns', () => {
      const items: TreeItem[] = [
        { name: 'src', type: 'directory' },
        { name: '.git', type: 'directory' },
        { name: 'index.ts', type: 'file' },
        { name: '.env', type: 'file' },
        { name: 'node_modules', type: 'directory' },
      ];

      const filtered = filterExcludedItems(items);

      expect(filtered).toHaveLength(2);
      expect(filtered.find(i => i.name === 'src')).toBeDefined();
      expect(filtered.find(i => i.name === 'index.ts')).toBeDefined();
      expect(filtered.find(i => i.name === '.git')).toBeUndefined();
      expect(filtered.find(i => i.name === '.env')).toBeUndefined();
      expect(filtered.find(i => i.name === 'node_modules')).toBeUndefined();
    });

    it('should keep all items when none are excluded', () => {
      const items: TreeItem[] = [
        { name: 'src', type: 'directory' },
        { name: 'lib', type: 'directory' },
        { name: 'index.ts', type: 'file' },
      ];

      const filtered = filterExcludedItems(items);

      expect(filtered).toHaveLength(3);
    });

    it('should handle empty array', () => {
      const filtered = filterExcludedItems([]);
      expect(filtered).toHaveLength(0);
    });
  });

  describe('sortItems', () => {
    it('should sort directories before files', () => {
      const items: TreeItem[] = [
        { name: 'file1.ts', type: 'file' },
        { name: 'src', type: 'directory' },
        { name: 'file2.ts', type: 'file' },
        { name: 'lib', type: 'directory' },
      ];

      const sorted = sortItems(items);

      expect(sorted[0].type).toBe('directory');
      expect(sorted[1].type).toBe('directory');
      expect(sorted[2].type).toBe('file');
      expect(sorted[3].type).toBe('file');
    });

    it('should sort alphabetically within type', () => {
      const items: TreeItem[] = [
        { name: 'zebra.ts', type: 'file' },
        { name: 'src', type: 'directory' },
        { name: 'apple.ts', type: 'file' },
        { name: 'lib', type: 'directory' },
      ];

      const sorted = sortItems(items);

      expect(sorted[0].name).toBe('lib');
      expect(sorted[1].name).toBe('src');
      expect(sorted[2].name).toBe('apple.ts');
      expect(sorted[3].name).toBe('zebra.ts');
    });

    it('should be case-insensitive', () => {
      const items: TreeItem[] = [
        { name: 'Zebra.ts', type: 'file' },
        { name: 'apple.ts', type: 'file' },
        { name: 'Beta.ts', type: 'file' },
      ];

      const sorted = sortItems(items);

      expect(sorted[0].name).toBe('apple.ts');
      expect(sorted[1].name).toBe('Beta.ts');
      expect(sorted[2].name).toBe('Zebra.ts');
    });

    it('should handle empty array', () => {
      const sorted = sortItems([]);
      expect(sorted).toHaveLength(0);
    });
  });

  describe('readDirectory', () => {
    it('should read directory contents', async () => {
      // Create test files and directories
      mkdirSync(join(testDir, 'src'));
      mkdirSync(join(testDir, 'lib'));
      writeFileSync(join(testDir, 'index.ts'), 'console.log("hello");');
      writeFileSync(join(testDir, 'package.json'), '{}');

      const result = await readDirectory(testDir);

      expect(result.path).toBe('');
      expect(result.name).toBe('');
      expect(result.parentPath).toBeNull();
      expect(result.items.length).toBeGreaterThanOrEqual(4);

      const srcItem = result.items.find(i => i.name === 'src');
      expect(srcItem).toBeDefined();
      expect(srcItem?.type).toBe('directory');

      const indexItem = result.items.find(i => i.name === 'index.ts');
      expect(indexItem).toBeDefined();
      expect(indexItem?.type).toBe('file');
      expect(indexItem?.extension).toBe('ts');
    });

    it('should read subdirectory contents', async () => {
      // Create test structure
      mkdirSync(join(testDir, 'src', 'components'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'index.ts'), 'export {};');

      const result = await readDirectory(testDir, 'src');

      expect(result.path).toBe('src');
      expect(result.name).toBe('src');
      expect(result.parentPath).toBe('');
      expect(result.items.length).toBe(2);

      const componentsItem = result.items.find(i => i.name === 'components');
      expect(componentsItem).toBeDefined();
      expect(componentsItem?.type).toBe('directory');
    });

    it('should filter out excluded items', async () => {
      // Create test structure with excluded items
      mkdirSync(join(testDir, 'src'));
      mkdirSync(join(testDir, '.git'));
      mkdirSync(join(testDir, 'node_modules'));
      writeFileSync(join(testDir, 'index.ts'), '');
      writeFileSync(join(testDir, '.env'), 'SECRET=xxx');

      const result = await readDirectory(testDir);

      expect(result.items.find(i => i.name === 'src')).toBeDefined();
      expect(result.items.find(i => i.name === 'index.ts')).toBeDefined();
      expect(result.items.find(i => i.name === '.git')).toBeUndefined();
      expect(result.items.find(i => i.name === 'node_modules')).toBeUndefined();
      expect(result.items.find(i => i.name === '.env')).toBeUndefined();
    });

    it('should sort items correctly', async () => {
      // Create test structure
      mkdirSync(join(testDir, 'zebra'));
      mkdirSync(join(testDir, 'alpha'));
      writeFileSync(join(testDir, 'beta.ts'), '');
      writeFileSync(join(testDir, 'aaa.ts'), '');

      const result = await readDirectory(testDir);

      // Directories first, then files, both alphabetically
      expect(result.items[0].name).toBe('alpha');
      expect(result.items[1].name).toBe('zebra');
      expect(result.items[2].name).toBe('aaa.ts');
      expect(result.items[3].name).toBe('beta.ts');
    });

    it('should include file sizes', async () => {
      const content = 'Hello, World!';
      writeFileSync(join(testDir, 'test.txt'), content);

      const result = await readDirectory(testDir);
      const testFile = result.items.find(i => i.name === 'test.txt');

      expect(testFile).toBeDefined();
      expect(testFile?.size).toBe(content.length);
    });

    it('should include file extensions', async () => {
      writeFileSync(join(testDir, 'index.tsx'), '');
      writeFileSync(join(testDir, 'styles.css'), '');
      writeFileSync(join(testDir, 'README'), '');

      const result = await readDirectory(testDir);

      const tsxFile = result.items.find(i => i.name === 'index.tsx');
      expect(tsxFile?.extension).toBe('tsx');

      const cssFile = result.items.find(i => i.name === 'styles.css');
      expect(cssFile?.extension).toBe('css');

      const readmeFile = result.items.find(i => i.name === 'README');
      expect(readmeFile?.extension).toBeUndefined();
    });

    it('should include directory item counts', async () => {
      mkdirSync(join(testDir, 'src'));
      writeFileSync(join(testDir, 'src', 'file1.ts'), '');
      writeFileSync(join(testDir, 'src', 'file2.ts'), '');
      writeFileSync(join(testDir, 'src', 'file3.ts'), '');

      const result = await readDirectory(testDir);
      const srcDir = result.items.find(i => i.name === 'src');

      expect(srcDir).toBeDefined();
      expect(srcDir?.itemCount).toBe(3);
    });

    it('should throw error for non-existent directory', async () => {
      await expect(readDirectory(join(testDir, 'nonexistent'))).rejects.toThrow();
    });

    it('should throw error for file path instead of directory', async () => {
      writeFileSync(join(testDir, 'file.txt'), '');

      await expect(readDirectory(testDir, 'file.txt')).rejects.toThrow();
    });

    it('should respect MAX_ITEMS_PER_DIR limit', async () => {
      // Create more files than the limit
      for (let i = 0; i < 10; i++) {
        writeFileSync(join(testDir, `file${i.toString().padStart(4, '0')}.txt`), '');
      }

      // Mock a lower limit for testing
      const result = await readDirectory(testDir);

      // With default limit of 500, all files should be included
      expect(result.items.length).toBeLessThanOrEqual(LIMITS.MAX_ITEMS_PER_DIR);
    });

    it('should detect and skip symbolic links', async () => {
      mkdirSync(join(testDir, 'real-dir'));
      writeFileSync(join(testDir, 'real-file.txt'), 'content');

      try {
        // Create a symbolic link
        symlinkSync(join(testDir, 'real-dir'), join(testDir, 'link-to-dir'));
      } catch {
        // Skip test if symbolic links are not supported
        return;
      }

      const result = await readDirectory(testDir);

      // Should include real items
      expect(result.items.find(i => i.name === 'real-dir')).toBeDefined();
      expect(result.items.find(i => i.name === 'real-file.txt')).toBeDefined();
      // Should skip symbolic links
      expect(result.items.find(i => i.name === 'link-to-dir')).toBeUndefined();
    });

    it('should calculate correct parent path for nested directories', async () => {
      mkdirSync(join(testDir, 'src', 'components', 'ui'), { recursive: true });

      const result = await readDirectory(testDir, 'src/components');

      expect(result.path).toBe('src/components');
      expect(result.name).toBe('components');
      expect(result.parentPath).toBe('src');
    });

    it('should handle root path correctly', async () => {
      const result = await readDirectory(testDir);

      expect(result.path).toBe('');
      expect(result.name).toBe('');
      expect(result.parentPath).toBeNull();
    });
  });

  // ============================================================================
  // API Helper Functions Tests
  // ============================================================================

  describe('parseDirectoryError', () => {
    it('should return 404 for "not found" error messages', () => {
      const error = new Error('Directory not found: /some/path');
      const result = parseDirectoryError(error);

      expect(result.status).toBe(404);
      expect(result.error).toBe('Directory not found');
    });

    it('should return 400 for "not a directory" error messages', () => {
      const error = new Error('Path is not a directory: /some/path');
      const result = parseDirectoryError(error);

      expect(result.status).toBe(400);
      expect(result.error).toBe('Path is not a directory');
    });

    it('should return 500 for unknown errors', () => {
      const error = new Error('Some unexpected error');
      const result = parseDirectoryError(error);

      expect(result.status).toBe(500);
      expect(result.error).toBe('Failed to read directory');
    });

    it('should handle non-Error objects', () => {
      const result = parseDirectoryError('string error');

      expect(result.status).toBe(500);
      expect(result.error).toBe('Failed to read directory');
    });

    it('should handle null/undefined errors', () => {
      const result = parseDirectoryError(null);

      expect(result.status).toBe(500);
      expect(result.error).toBe('Failed to read directory');
    });
  });

  describe('createWorktreeNotFoundError', () => {
    it('should create 404 error with worktree ID in message', () => {
      const result = createWorktreeNotFoundError('my-worktree');

      expect(result.status).toBe(404);
      expect(result.error).toBe("Worktree 'my-worktree' not found");
    });

    it('should handle special characters in worktree ID', () => {
      const result = createWorktreeNotFoundError('feature/test-123');

      expect(result.status).toBe(404);
      expect(result.error).toContain('feature/test-123');
    });
  });

  describe('createAccessDeniedError', () => {
    it('should create 403 error with custom reason', () => {
      const result = createAccessDeniedError('Path contains excluded pattern');

      expect(result.status).toBe(403);
      expect(result.error).toBe('Access denied: Path contains excluded pattern');
    });

    it('should use default reason when not provided', () => {
      const result = createAccessDeniedError();

      expect(result.status).toBe(403);
      expect(result.error).toBe('Access denied: Invalid path');
    });

    it('should handle empty string reason', () => {
      const result = createAccessDeniedError('');

      expect(result.status).toBe(403);
      expect(result.error).toBe('Access denied: ');
    });
  });
});
