/**
 * validateFileOperation() Unit Tests
 * [MF-001] Common validation helper for file operations
 *
 * TDD Approach: Red (test first) -> Green (implement) -> Refactor
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { validateFileOperation } from '@/lib/file-operations';
import { removeTempDir } from '@tests/helpers/temp-dir';

describe('validateFileOperation [MF-001]', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `validate-ops-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      removeTempDir(testDir);
    }
  });

  describe('successful validation', () => {
    it('should return success with resolved source path for existing file', () => {
      writeFileSync(join(testDir, 'test.txt'), 'content');

      const result = validateFileOperation(testDir, 'test.txt');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.resolvedSource).toBe(join(testDir, 'test.txt'));
      }
    });

    it('should return success with resolved source path for existing directory', () => {
      mkdirSync(join(testDir, 'subdir'));

      const result = validateFileOperation(testDir, 'subdir');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.resolvedSource).toBe(join(testDir, 'subdir'));
      }
    });

    it('should return success for nested path', () => {
      mkdirSync(join(testDir, 'a', 'b'), { recursive: true });
      writeFileSync(join(testDir, 'a', 'b', 'file.txt'), 'content');

      const result = validateFileOperation(testDir, 'a/b/file.txt');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.resolvedSource).toBe(join(testDir, 'a', 'b', 'file.txt'));
      }
    });
  });

  describe('path safety validation', () => {
    it('should reject path traversal (..)', () => {
      const result = validateFileOperation(testDir, '../etc/passwd');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.error?.code).toBe('INVALID_PATH');
      }
    });

    it('should reject absolute paths outside worktree', () => {
      const result = validateFileOperation(testDir, '/etc/passwd');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.error?.code).toBe('INVALID_PATH');
      }
    });

    it('should reject empty path', () => {
      const result = validateFileOperation(testDir, '');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.error?.code).toBe('INVALID_PATH');
      }
    });
  });

  describe('existence check', () => {
    it('should return FILE_NOT_FOUND for non-existent file', () => {
      const result = validateFileOperation(testDir, 'nonexistent.txt');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.error?.code).toBe('FILE_NOT_FOUND');
      }
    });

    it('should return FILE_NOT_FOUND for non-existent directory', () => {
      const result = validateFileOperation(testDir, 'nonexistent-dir');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.error?.code).toBe('FILE_NOT_FOUND');
      }
    });
  });
});
