/**
 * Tests for worktree-path-validator module (Issue #56, MF-1)
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isValidWorktreePath } from '@/lib/worktree-path-validator';

describe('isValidWorktreePath', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('valid paths', () => {
    it('should accept valid absolute paths under /Users', () => {
      expect(isValidWorktreePath('/Users/test/projects/my-repo')).toBe(true);
    });

    it('should accept valid absolute paths under /home', () => {
      expect(isValidWorktreePath('/home/user/code/project')).toBe(true);
    });

    it('should accept paths under allowed base paths', () => {
      expect(isValidWorktreePath('/var/www/project')).toBe(true);
      expect(isValidWorktreePath('/opt/apps/myapp')).toBe(true);
      expect(isValidWorktreePath('/tmp/test-project')).toBe(true);
    });
  });

  describe('invalid paths', () => {
    it('should reject empty paths', () => {
      expect(isValidWorktreePath('')).toBe(false);
      expect(isValidWorktreePath('   ')).toBe(false);
    });

    it('should reject paths with path traversal', () => {
      expect(isValidWorktreePath('/Users/test/../etc/passwd')).toBe(false);
      expect(isValidWorktreePath('/home/user/../../root')).toBe(false);
      expect(isValidWorktreePath('../etc/passwd')).toBe(false);
    });

    it('should reject relative paths', () => {
      expect(isValidWorktreePath('projects/my-repo')).toBe(false);
      expect(isValidWorktreePath('./my-project')).toBe(false);
    });

    it('should reject paths outside allowed directories', () => {
      expect(isValidWorktreePath('/etc/passwd')).toBe(false);
      expect(isValidWorktreePath('/root/secret')).toBe(false);
      expect(isValidWorktreePath('/bin/bash')).toBe(false);
    });
  });

  describe('environment variable configuration', () => {
    it('should use custom allowed paths from environment', async () => {
      process.env.ALLOWED_WORKTREE_PATHS = '/custom/path,/another/allowed';

      // Need to reimport to pick up new env value
      const { isValidWorktreePath: validator } = await import('@/lib/worktree-path-validator');

      expect(validator('/custom/path/project')).toBe(true);
      expect(validator('/another/allowed/repo')).toBe(true);
      expect(validator('/Users/test/project')).toBe(false); // Not in custom paths
    });
  });
});
