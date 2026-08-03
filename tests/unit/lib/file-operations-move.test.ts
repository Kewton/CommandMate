/**
 * moveFileOrDirectory() Unit Tests
 * Security requirements: SEC-005, SEC-006, SEC-007, SEC-008, SEC-009
 *
 * TDD Approach: Red (test first) -> Green (implement) -> Refactor
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join, sep } from 'path';
import { mkdirSync, writeFileSync, existsSync, symlinkSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { moveFileOrDirectory } from '@/lib/file-operations';
import { removeTempDir } from '@tests/helpers/temp-dir';

describe('moveFileOrDirectory', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `move-ops-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      removeTempDir(testDir);
    }
  });

  describe('successful move operations', () => {
    it('should move a file to a different directory', async () => {
      writeFileSync(join(testDir, 'file.txt'), 'content');
      mkdirSync(join(testDir, 'dest'));

      const result = await moveFileOrDirectory(testDir, 'file.txt', 'dest');

      expect(result.success).toBe(true);
      expect(result.path).toBe(join('dest', 'file.txt'));
      expect(existsSync(join(testDir, 'dest', 'file.txt'))).toBe(true);
      expect(existsSync(join(testDir, 'file.txt'))).toBe(false);
    });

    it('should move a directory to a different directory', async () => {
      mkdirSync(join(testDir, 'source'));
      writeFileSync(join(testDir, 'source', 'child.txt'), 'child content');
      mkdirSync(join(testDir, 'dest'));

      const result = await moveFileOrDirectory(testDir, 'source', 'dest');

      expect(result.success).toBe(true);
      expect(result.path).toBe(join('dest', 'source'));
      expect(existsSync(join(testDir, 'dest', 'source', 'child.txt'))).toBe(true);
      expect(existsSync(join(testDir, 'source'))).toBe(false);
    });

    it('should move a file to root directory (empty string destination)', async () => {
      mkdirSync(join(testDir, 'subdir'));
      writeFileSync(join(testDir, 'subdir', 'file.txt'), 'content');

      const result = await moveFileOrDirectory(testDir, 'subdir/file.txt', '');

      expect(result.success).toBe(true);
      expect(result.path).toBe('file.txt');
      expect(existsSync(join(testDir, 'file.txt'))).toBe(true);
      expect(existsSync(join(testDir, 'subdir', 'file.txt'))).toBe(false);
    });

    it('should move a nested file to another nested directory', async () => {
      mkdirSync(join(testDir, 'a', 'b'), { recursive: true });
      mkdirSync(join(testDir, 'c', 'd'), { recursive: true });
      writeFileSync(join(testDir, 'a', 'b', 'file.txt'), 'content');

      const result = await moveFileOrDirectory(testDir, 'a/b/file.txt', 'c/d');

      expect(result.success).toBe(true);
      expect(result.path).toBe(join('c', 'd', 'file.txt'));
      expect(existsSync(join(testDir, 'c', 'd', 'file.txt'))).toBe(true);
    });

    it('should preserve file content after move', async () => {
      writeFileSync(join(testDir, 'data.txt'), 'important data');
      mkdirSync(join(testDir, 'target'));

      await moveFileOrDirectory(testDir, 'data.txt', 'target');

      expect(readFileSync(join(testDir, 'target', 'data.txt'), 'utf-8')).toBe('important data');
    });
  });

  describe('path validation', () => {
    it('should reject path traversal in source path', async () => {
      const result = await moveFileOrDirectory(testDir, '../etc/passwd', 'dest');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_PATH');
    });

    it('should reject path traversal in destination path', async () => {
      writeFileSync(join(testDir, 'file.txt'), 'content');

      const result = await moveFileOrDirectory(testDir, 'file.txt', '../outside');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_PATH');
    });

    it('should return FILE_NOT_FOUND for non-existent source', async () => {
      mkdirSync(join(testDir, 'dest'));

      const result = await moveFileOrDirectory(testDir, 'nonexistent.txt', 'dest');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('FILE_NOT_FOUND');
    });
  });

  describe('[SEC-005] Protected directory check (source)', () => {
    it('should reject moving files from .git directory', async () => {
      mkdirSync(join(testDir, '.git'), { recursive: true });
      writeFileSync(join(testDir, '.git', 'HEAD'), 'ref: refs/heads/main');
      mkdirSync(join(testDir, 'dest'));

      const result = await moveFileOrDirectory(testDir, '.git/HEAD', 'dest');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PROTECTED_DIRECTORY');
    });

    it('should reject moving the .git directory itself', async () => {
      mkdirSync(join(testDir, '.git'), { recursive: true });
      mkdirSync(join(testDir, 'dest'));

      const result = await moveFileOrDirectory(testDir, '.git', 'dest');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PROTECTED_DIRECTORY');
    });

    it('should reject moving files from node_modules', async () => {
      mkdirSync(join(testDir, 'node_modules', 'pkg'), { recursive: true });
      writeFileSync(join(testDir, 'node_modules', 'pkg', 'index.js'), 'module.exports = {};');
      mkdirSync(join(testDir, 'dest'));

      const result = await moveFileOrDirectory(testDir, 'node_modules/pkg/index.js', 'dest');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PROTECTED_DIRECTORY');
    });

    it('should reject moving into .git directory (destination)', async () => {
      writeFileSync(join(testDir, 'file.txt'), 'content');
      mkdirSync(join(testDir, '.git'), { recursive: true });

      const result = await moveFileOrDirectory(testDir, 'file.txt', '.git');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PROTECTED_DIRECTORY');
    });

    it('should reject moving into a subdirectory of .git (destination)', async () => {
      writeFileSync(join(testDir, 'file.txt'), 'content');
      mkdirSync(join(testDir, '.git', 'objects'), { recursive: true });

      const result = await moveFileOrDirectory(testDir, 'file.txt', '.git/objects');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PROTECTED_DIRECTORY');
    });
  });

  describe('[SEC-006] Symlink validation', () => {
    it('should reject moving to a symlink destination pointing outside worktree', async () => {
      const outsideDir = join(tmpdir(), `outside-${Date.now()}`);
      mkdirSync(outsideDir, { recursive: true });

      writeFileSync(join(testDir, 'file.txt'), 'content');

      try {
        symlinkSync(outsideDir, join(testDir, 'symlink-dir'));
      } catch {
        // Skip test if symlink creation fails (e.g., permissions)
        return;
      }

      const result = await moveFileOrDirectory(testDir, 'file.txt', 'symlink-dir');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_PATH');

      // Cleanup
      removeTempDir(outsideDir);
    });
  });

  describe('[SEC-007] MOVE_INTO_SELF check', () => {
    it('should reject moving a directory into itself', async () => {
      mkdirSync(join(testDir, 'parent', 'child'), { recursive: true });

      const result = await moveFileOrDirectory(testDir, 'parent', 'parent/child');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MOVE_INTO_SELF');
    });

    it('should reject moving a directory into a deeply nested child', async () => {
      mkdirSync(join(testDir, 'a', 'b', 'c'), { recursive: true });

      const result = await moveFileOrDirectory(testDir, 'a', 'a/b/c');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MOVE_INTO_SELF');
    });

    it('should NOT reject moving src to src-backup (path separator check)', async () => {
      mkdirSync(join(testDir, 'src'));
      mkdirSync(join(testDir, 'src-backup'));
      writeFileSync(join(testDir, 'src', 'file.txt'), 'content');

      const result = await moveFileOrDirectory(testDir, 'src', 'src-backup');

      expect(result.success).toBe(true);
      expect(result.path).toBe(join('src-backup', 'src'));
    });
  });

  describe('[SEC-008] Final destination path validation', () => {
    it('should validate the final destination path (destinationDir + basename)', async () => {
      writeFileSync(join(testDir, 'file.txt'), 'content');
      mkdirSync(join(testDir, 'dest'));

      // This should succeed since final path is valid
      const result = await moveFileOrDirectory(testDir, 'file.txt', 'dest');

      expect(result.success).toBe(true);
    });
  });

  describe('[SEC-009] TOCTOU defense', () => {
    it('should return FILE_EXISTS when destination file already exists', async () => {
      writeFileSync(join(testDir, 'file.txt'), 'original');
      mkdirSync(join(testDir, 'dest'));
      writeFileSync(join(testDir, 'dest', 'file.txt'), 'existing');

      const result = await moveFileOrDirectory(testDir, 'file.txt', 'dest');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('FILE_EXISTS');
    });
  });

  describe('MOVE_SAME_PATH error', () => {
    it('should reject move when source and destination are the same', async () => {
      mkdirSync(join(testDir, 'dir'));
      writeFileSync(join(testDir, 'dir', 'file.txt'), 'content');

      const result = await moveFileOrDirectory(testDir, 'dir/file.txt', 'dir');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MOVE_SAME_PATH');
    });
  });

  describe('destination directory validation', () => {
    it('should return INVALID_PATH when destination directory does not exist', async () => {
      writeFileSync(join(testDir, 'file.txt'), 'content');

      const result = await moveFileOrDirectory(testDir, 'file.txt', 'nonexistent-dest');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_PATH');
    });

    it('should return INVALID_PATH when destination is a file, not a directory', async () => {
      writeFileSync(join(testDir, 'source.txt'), 'source');
      writeFileSync(join(testDir, 'not-a-dir'), 'just a file');

      const result = await moveFileOrDirectory(testDir, 'source.txt', 'not-a-dir');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_PATH');
    });
  });
});
