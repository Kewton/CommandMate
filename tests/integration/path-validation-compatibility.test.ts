/**
 * Path Validation Compatibility Tests
 * [Stage 3 MF-001] Breaking Change Risk Assessment
 *
 * Purpose: Ensure isPathSafe() is compatible with existing route.ts validation logic
 * and that URLencoded paths work correctly.
 */

import { describe, it, expect } from 'vitest';
import { isPathSafe } from '@/lib/security/path-validator';

describe('isPathSafe compatibility with existing validation', () => {
  const worktreeRoot = '/home/user/projects/repo';

  describe('paths that were valid with old validation (normalizedPath.includes("..") check)', () => {
    it('should accept simple file paths', () => {
      expect(isPathSafe('readme.md', worktreeRoot)).toBe(true);
      expect(isPathSafe('docs/readme.md', worktreeRoot)).toBe(true);
      expect(isPathSafe('src/index.ts', worktreeRoot)).toBe(true);
    });

    it('should accept nested directory paths', () => {
      expect(isPathSafe('src/components/Button.tsx', worktreeRoot)).toBe(true);
      expect(isPathSafe('tests/unit/lib/file-tree.test.ts', worktreeRoot)).toBe(true);
    });

    it('should accept paths with dots in filenames', () => {
      expect(isPathSafe('package.json', worktreeRoot)).toBe(true);
      expect(isPathSafe('tsconfig.build.json', worktreeRoot)).toBe(true);
      expect(isPathSafe('.gitignore', worktreeRoot)).toBe(true);
    });

    it('should accept paths with hyphens and underscores', () => {
      expect(isPathSafe('my-file.md', worktreeRoot)).toBe(true);
      expect(isPathSafe('my_file.md', worktreeRoot)).toBe(true);
      expect(isPathSafe('src/my-component/index.tsx', worktreeRoot)).toBe(true);
    });
  });

  describe('paths with ".." (path traversal) - should be rejected', () => {
    it('should reject paths with ".." (existing validation behavior)', () => {
      expect(isPathSafe('../etc/passwd', worktreeRoot)).toBe(false);
      expect(isPathSafe('docs/../../../etc/passwd', worktreeRoot)).toBe(false);
      expect(isPathSafe('..', worktreeRoot)).toBe(false);
    });

    it('should reject multiple traversal attempts', () => {
      expect(isPathSafe('../../../../../../etc/passwd', worktreeRoot)).toBe(false);
      expect(isPathSafe('a/b/c/../../../../etc', worktreeRoot)).toBe(false);
    });
  });

  describe('paths starting with "/" (absolute path) - should be rejected', () => {
    it('should reject absolute paths (existing validation behavior)', () => {
      expect(isPathSafe('/etc/passwd', worktreeRoot)).toBe(false);
      expect(isPathSafe('/home/other/file.txt', worktreeRoot)).toBe(false);
    });
  });

  describe('isPathSafe additional security features (beyond existing validation)', () => {
    it('should reject URL-encoded traversal', () => {
      // %2e%2e = ..
      expect(isPathSafe('%2e%2e/etc/passwd', worktreeRoot)).toBe(false);
      // %2f = /
      expect(isPathSafe('docs%2f..%2f..%2fetc', worktreeRoot)).toBe(false);
    });

    it('should reject null byte injection', () => {
      expect(isPathSafe('docs/readme.md\x00.txt', worktreeRoot)).toBe(false);
      expect(isPathSafe('file\x00/../etc/passwd', worktreeRoot)).toBe(false);
    });

    it('should reject empty paths', () => {
      expect(isPathSafe('', worktreeRoot)).toBe(false);
      expect(isPathSafe('   ', worktreeRoot)).toBe(false);
    });
  });

  describe('URL-encoded normal paths handling [Stage 3 MF-001]', () => {
    it('should handle URL-encoded normal paths correctly', () => {
      // URL-encoded forward slash in path (docs%2Freadme.md)
      // This should be decoded and treated as docs/readme.md
      expect(isPathSafe('docs%2Freadme.md', worktreeRoot)).toBe(true);
    });

    it('should handle URL-encoded spaces and special characters', () => {
      // %20 = space
      expect(isPathSafe('docs%20with%20spaces/readme.md', worktreeRoot)).toBe(true);
    });

    it('should handle partially encoded paths', () => {
      // Mixed encoded and non-encoded
      expect(isPathSafe('docs/file%20name.md', worktreeRoot)).toBe(true);
    });

    it('should handle double-encoded paths safely', () => {
      // %252e%252e = %2e%2e (double-encoded ..)
      // After first decode: %2e%2e
      // This should still be safe as it doesn't resolve to ..
      // Note: isPathSafe only decodes once, so double-encoding stays as literal %2e%2e
      const result = isPathSafe('%252e%252e/etc', worktreeRoot);
      // After single decode: %2e%2e/etc which is a valid relative path
      expect(result).toBe(true);
    });
  });

  describe('edge cases for path normalization', () => {
    it('should handle paths with ./ prefix', () => {
      expect(isPathSafe('./readme.md', worktreeRoot)).toBe(true);
      expect(isPathSafe('./docs/readme.md', worktreeRoot)).toBe(true);
    });

    it('should handle paths with redundant slashes', () => {
      expect(isPathSafe('docs//readme.md', worktreeRoot)).toBe(true);
      expect(isPathSafe('docs///file.md', worktreeRoot)).toBe(true);
    });

    it('should handle paths with trailing slashes', () => {
      expect(isPathSafe('docs/', worktreeRoot)).toBe(true);
      expect(isPathSafe('src/components/', worktreeRoot)).toBe(true);
    });

    it('should handle paths that normalize within root', () => {
      // This should resolve to 'repo2' which is within root
      expect(isPathSafe('repo1/../repo2', worktreeRoot)).toBe(true);
      expect(isPathSafe('./docs/../src/index.ts', worktreeRoot)).toBe(true);
    });
  });
});
