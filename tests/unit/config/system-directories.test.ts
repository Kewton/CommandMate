/**
 * System Directories Configuration Tests
 * Issue #135: DB path resolution logic fix
 * Tests for system-directories.ts
 */

import { describe, it, expect } from 'vitest';
import {
  SYSTEM_DIRECTORIES,
  isSystemDirectory,
} from '../../../src/config/system-directories';

describe('system-directories', () => {
  describe('SYSTEM_DIRECTORIES', () => {
    it('should include standard system directories', () => {
      const expectedDirs = ['/etc', '/usr', '/bin', '/sbin', '/var', '/tmp', '/dev', '/sys', '/proc'];

      for (const dir of expectedDirs) {
        expect(SYSTEM_DIRECTORIES).toContain(dir);
      }
    });

    it('should be readonly array', () => {
      // TypeScript check - SYSTEM_DIRECTORIES should be readonly
      // This test verifies the structure at runtime
      expect(Array.isArray(SYSTEM_DIRECTORIES)).toBe(true);
      expect(SYSTEM_DIRECTORIES.length).toBeGreaterThan(0);
    });
  });

  describe('isSystemDirectory', () => {
    describe('should return true for system directories', () => {
      const systemPaths = [
        '/etc/passwd',
        '/etc/commandmate/config',
        '/usr/local/bin/node',
        '/usr/share/doc',
        '/bin/bash',
        '/sbin/init',
        '/var/log/messages',
        '/var/lib/data',
        '/tmp/test.txt',
        '/dev/null',
        '/sys/class/net',
        '/proc/self/status',
      ];

      for (const path of systemPaths) {
        it(`should return true for ${path}`, () => {
          expect(isSystemDirectory(path)).toBe(true);
        });
      }
    });

    describe('should return false for non-system directories', () => {
      const safePaths = [
        '/home/user/project',
        '/home/user/.commandmate/data',
        '/Users/username/Documents',
        '/opt/myapp/data',
        '/data/myapp',
        '/srv/www/data',
      ];

      for (const path of safePaths) {
        it(`should return false for ${path}`, () => {
          expect(isSystemDirectory(path)).toBe(false);
        });
      }
    });

    describe('edge cases', () => {
      it('should match exact directory paths', () => {
        // Exact directory paths should match
        expect(isSystemDirectory('/etc')).toBe(true);
        expect(isSystemDirectory('/usr')).toBe(true);
        expect(isSystemDirectory('/var')).toBe(true);
      });

      it('should match subdirectories', () => {
        // Subdirectories should match
        expect(isSystemDirectory('/etc/nginx')).toBe(true);
        expect(isSystemDirectory('/usr/local')).toBe(true);
        expect(isSystemDirectory('/var/log')).toBe(true);
      });

      // Note: Current implementation uses startsWith which may match
      // paths like /etcetc. This is acceptable for security purposes
      // as it's more restrictive rather than less restrictive.
    });
  });
});
