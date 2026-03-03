/**
 * Path Validation Tests
 * TDD Approach: Red (test first) -> Green (implement) -> Refactor
 *
 * Purpose: Prevent directory traversal attacks and ensure paths stay within allowed directories
 * [SEC-394] Added resolveAndValidateRealPath symlink traversal tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { symlinkSync, mkdirSync } from 'fs';

// Import path validator functions
import { isPathSafe, validateWorktreePath, resolveAndValidateRealPath, isWithinRoot } from '@/lib/path-validator';
import {
  createSymlinkFixture,
  cleanupSymlinkFixture,
  SymlinkTestFixture,
} from '@tests/helpers/symlink-test-fixtures';

describe('Path Validation', () => {
  const rootDir = '/home/user/projects';

  describe('isPathSafe', () => {
    describe('safe paths', () => {
      it('should allow paths within root directory', () => {
        expect(isPathSafe('/home/user/projects/repo1', rootDir)).toBe(true);
        expect(isPathSafe('/home/user/projects/repo1/subdir', rootDir)).toBe(true);
      });

      it('should allow paths equal to root directory', () => {
        expect(isPathSafe('/home/user/projects', rootDir)).toBe(true);
      });

      it('should allow relative paths that resolve within root', () => {
        expect(isPathSafe('repo1', rootDir)).toBe(true);
        expect(isPathSafe('./repo1', rootDir)).toBe(true);
        expect(isPathSafe('repo1/subdir', rootDir)).toBe(true);
      });

      it('should handle normalized paths correctly', () => {
        expect(isPathSafe('/home/user/projects/repo1/../repo2', rootDir)).toBe(true);
        expect(isPathSafe('/home/user/projects/./repo1', rootDir)).toBe(true);
      });
    });

    describe('unsafe paths - directory traversal attempts', () => {
      it('should reject paths with .. that escape root', () => {
        expect(isPathSafe('/home/user/projects/../etc/passwd', rootDir)).toBe(false);
        expect(isPathSafe('/home/user/../etc', rootDir)).toBe(false);
      });

      it('should reject relative paths that escape root', () => {
        expect(isPathSafe('../etc', rootDir)).toBe(false);
        expect(isPathSafe('../../etc/passwd', rootDir)).toBe(false);
      });

      it('should reject absolute paths outside root', () => {
        expect(isPathSafe('/etc/passwd', rootDir)).toBe(false);
        expect(isPathSafe('/tmp/malicious', rootDir)).toBe(false);
      });

      it('should reject paths with multiple traversal attempts', () => {
        expect(isPathSafe('/home/user/projects/repo1/../../../etc', rootDir)).toBe(false);
      });

      it('should reject encoded traversal attempts', () => {
        // URL encoded ../ = %2e%2e%2f
        expect(isPathSafe('/home/user/projects/%2e%2e/etc', rootDir)).toBe(false);
      });

      it('should reject paths with null bytes', () => {
        expect(isPathSafe('/home/user/projects/repo1\x00/../../etc', rootDir)).toBe(false);
      });
    });

    describe('edge cases', () => {
      it('should handle empty paths', () => {
        expect(isPathSafe('', rootDir)).toBe(false);
      });

      it('should handle root directory itself', () => {
        expect(isPathSafe('/', rootDir)).toBe(false);
      });

      it('should handle Windows-style paths (if on Windows)', () => {
        if (process.platform === 'win32') {
          const winRoot = 'C:\\Users\\user\\projects';
          expect(isPathSafe('C:\\Users\\user\\projects\\repo1', winRoot)).toBe(true);
          expect(isPathSafe('C:\\Users\\user\\..\\..\\Windows', winRoot)).toBe(false);
        }
      });

      it('should handle paths with trailing slashes', () => {
        expect(isPathSafe('/home/user/projects/repo1/', rootDir)).toBe(true);
        expect(isPathSafe('/home/user/projects/../etc/', rootDir)).toBe(false);
      });

      it('should handle paths with multiple slashes', () => {
        expect(isPathSafe('/home/user//projects///repo1', rootDir)).toBe(true);
      });
    });
  });

  describe('validateWorktreePath', () => {
    describe('valid worktree paths', () => {
      it('should accept valid worktree paths', () => {
        expect(() => validateWorktreePath('/home/user/projects/repo1', rootDir)).not.toThrow();
        expect(() => validateWorktreePath('/home/user/projects/repo1/feature-branch', rootDir)).not.toThrow();
      });

      it('should accept relative paths within root', () => {
        expect(() => validateWorktreePath('repo1', rootDir)).not.toThrow();
        expect(() => validateWorktreePath('./repo1/branch', rootDir)).not.toThrow();
      });
    });

    describe('invalid worktree paths', () => {
      it('should throw error for paths outside root', () => {
        expect(() => validateWorktreePath('/etc/passwd', rootDir)).toThrow('Path is outside allowed directory');
      });

      it('should throw error for directory traversal attempts', () => {
        expect(() => validateWorktreePath('../etc', rootDir)).toThrow('Path is outside allowed directory');
        expect(() => validateWorktreePath('/home/user/projects/../etc', rootDir)).toThrow('Path is outside allowed directory');
      });

      it('should throw error for empty paths', () => {
        expect(() => validateWorktreePath('', rootDir)).toThrow('Invalid path');
      });

      it('should throw error for null bytes', () => {
        expect(() => validateWorktreePath('/home/user/projects/repo\x00', rootDir)).toThrow('Invalid path');
      });

      it('should provide descriptive error messages', () => {
        try {
          validateWorktreePath('/etc/passwd', rootDir);
          expect.fail('Should have thrown error');
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toContain('outside allowed directory');
        }
      });
    });

    describe('normalized path return', () => {
      it('should return normalized absolute path', () => {
        const result = validateWorktreePath('repo1', rootDir);
        expect(result).toBe(path.join(rootDir, 'repo1'));
      });

      it('should normalize paths with ..', () => {
        const result = validateWorktreePath('/home/user/projects/repo1/../repo2', rootDir);
        expect(result).toBe(path.join(rootDir, 'repo2'));
      });

      it('should normalize paths with .', () => {
        const result = validateWorktreePath('/home/user/projects/./repo1', rootDir);
        expect(result).toBe(path.join(rootDir, 'repo1'));
      });
    });
  });

  describe('isWithinRoot [SEC-394]', () => {
    it('should return true when path equals root', () => {
      expect(isWithinRoot('/home/user/projects', '/home/user/projects')).toBe(true);
    });

    it('should return true when path is a child of root', () => {
      expect(isWithinRoot('/home/user/projects/repo', '/home/user/projects')).toBe(true);
    });

    it('should return false when path is outside root', () => {
      expect(isWithinRoot('/home/user/other', '/home/user/projects')).toBe(false);
    });

    it('should return false for prefix-matching directory names (no separator)', () => {
      // /home/user/projects-evil should NOT be within /home/user/projects
      expect(isWithinRoot('/home/user/projects-evil', '/home/user/projects')).toBe(false);
    });
  });

  describe('resolveAndValidateRealPath [SEC-394]', () => {
    let fixture: SymlinkTestFixture;
    let testRoot: string;
    let externalDir: string;

    beforeEach(() => {
      fixture = createSymlinkFixture({
        rootPrefix: 'pv-test-root-',
        externalPrefix: 'pv-test-external-',
        internalFiles: { 'src/file.ts': 'content' },
        externalFiles: { 'secret.txt': 'secret' },
      });
      testRoot = fixture.testRoot;
      externalDir = fixture.externalDir;
    });

    afterEach(() => {
      cleanupSymlinkFixture(fixture);
    });

    it('should reject symlink pointing outside worktree root', () => {
      // Create symlink inside testRoot pointing to external file
      symlinkSync(
        path.join(externalDir, 'secret.txt'),
        path.join(testRoot, 'evil-link')
      );
      const result = resolveAndValidateRealPath('evil-link', testRoot);
      expect(result).toBe(false);
    });

    it('should allow symlink pointing within worktree root (internal symlink)', () => {
      // Create symlink inside testRoot pointing to internal file
      symlinkSync(
        path.join(testRoot, 'src', 'file.ts'),
        path.join(testRoot, 'internal-link')
      );
      const result = resolveAndValidateRealPath('internal-link', testRoot);
      expect(result).toBe(true);
    });

    it('should reject dangling symlink (target does not exist)', () => {
      // Create symlink pointing to a non-existent path outside root
      symlinkSync(
        path.join(externalDir, 'nonexistent'),
        path.join(testRoot, 'dangling-link')
      );
      const result = resolveAndValidateRealPath('dangling-link', testRoot);
      expect(result).toBe(false);
    });

    it('should reject multi-level symlink chain resolving outside root', () => {
      // symlink1 -> symlink2 -> external file
      symlinkSync(
        path.join(externalDir, 'secret.txt'),
        path.join(testRoot, 'link-level2')
      );
      symlinkSync(
        path.join(testRoot, 'link-level2'),
        path.join(testRoot, 'link-level1')
      );
      const result = resolveAndValidateRealPath('link-level1', testRoot);
      expect(result).toBe(false);
    });

    it('should handle macOS tmpdir symlink compatibility (rootDir contains OS symlink)', () => {
      // On macOS, /tmp is a symlink to /private/tmp. Using the real tmpdir() path
      // ensures resolveAndValidateRealPath handles OS-level symlinks in rootDir.
      // The file exists inside testRoot (created via tmpdir which resolves through the symlink).
      const result = resolveAndValidateRealPath('src/file.ts', testRoot);
      expect(result).toBe(true);
    });

    it('should validate non-existent path via nearest ancestor (create scenario)', () => {
      // src/ exists inside testRoot, so creating src/newfile.ts should pass
      const result = resolveAndValidateRealPath('src/newfile.ts', testRoot);
      expect(result).toBe(true);
    });

    it('should return false when ancestor walk reaches filesystem root', () => {
      // Use a completely non-existent root dir that does not match any real path
      const result = resolveAndValidateRealPath(
        'some/deep/path',
        '/nonexistent-root-dir-394-test'
      );
      expect(result).toBe(false);
    });

    it('should return false (fail-safe) when realpathSync fails on rootDir', () => {
      // Pass a rootDir that does not exist - realpathSync will throw
      const result = resolveAndValidateRealPath(
        'file.txt',
        '/this-root-does-not-exist-at-all-394'
      );
      expect(result).toBe(false);
    });

    it('should return true when resolvedTarget equals resolvedRoot', () => {
      // Passing '.' as targetPath resolves to rootDir itself
      const result = resolveAndValidateRealPath('.', testRoot);
      expect(result).toBe(true);
    });

    it('should allow non-existent path under internal symlink directory (create scenario)', () => {
      // Create a symlink directory pointing within the worktree
      mkdirSync(path.join(testRoot, 'real-subdir'), { recursive: true });
      symlinkSync(
        path.join(testRoot, 'real-subdir'),
        path.join(testRoot, 'link-subdir')
      );
      // Creating a new file under the internal symlink dir should succeed
      const result = resolveAndValidateRealPath('link-subdir/newfile.ts', testRoot);
      expect(result).toBe(true);
    });
  });
});
