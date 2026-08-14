/**
 * System Directories Configuration Tests
 * Issue #135: DB path resolution logic fix
 * Issue #1285: Path boundary matching and symlink resolution
 * Tests for system-directories.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  SYSTEM_DIRECTORIES,
  VIRTUAL_FILESYSTEM_ROOTS,
  isSystemDirectory,
  isVirtualFilesystemPath,
  isPathWithin,
} from '../../../src/config/system-directories';
import { removeTempDir } from '@tests/helpers/temp-dir';

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

  describe('isPathWithin', () => {
    it('should match the directory itself', () => {
      expect(isPathWithin('/etc', '/etc')).toBe(true);
    });

    it('should match paths under the directory', () => {
      expect(isPathWithin('/etc/nginx/nginx.conf', '/etc')).toBe(true);
    });

    it('should not match a sibling that merely shares the prefix', () => {
      expect(isPathWithin('/etcetera', '/etc')).toBe(false);
      expect(isPathWithin('/etcetera/x.db', '/etc')).toBe(false);
    });

    it('should tolerate a trailing separator on the directory', () => {
      expect(isPathWithin('/etc/nginx', '/etc/')).toBe(true);
      expect(isPathWithin('/etcetera', '/etc/')).toBe(false);
    });

    it('should not match a parent of the directory', () => {
      expect(isPathWithin('/etc', '/etc/nginx')).toBe(false);
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

      for (const systemPath of systemPaths) {
        it(`should return true for ${systemPath}`, () => {
          expect(isSystemDirectory(systemPath)).toBe(true);
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

      for (const safePath of safePaths) {
        it(`should return false for ${safePath}`, () => {
          expect(isSystemDirectory(safePath)).toBe(false);
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
    });

    /**
     * Issue #1285: startsWith() had no path boundary, so every one of these
     * unrelated top-level directories was rejected as a system directory.
     */
    describe('path boundary (Issue #1285)', () => {
      const lookalikePaths = [
        '/tmpfoo/x.db',
        '/variance/x.db',
        '/etcetera/x.db',
        '/binary/x.db',
        '/usrlocal/x.db',
        '/sbinary/x.db',
        '/devices/x.db',
        '/systems/x.db',
        '/procession/x.db',
        '/username/x.db',
      ];

      for (const lookalikePath of lookalikePaths) {
        it(`should return false for ${lookalikePath}`, () => {
          expect(isSystemDirectory(lookalikePath)).toBe(false);
        });
      }
    });

    /**
     * Issue #1285: The guard compares the candidate path against the system
     * directory list. Both sides must be symlink-resolved, otherwise a path
     * that reaches a system directory through a symlink slips past.
     */
    describe('symlink resolution (Issue #1285)', () => {
      let workDir: string;

      beforeAll(() => {
        // The temp dir must NOT itself be inside a system directory, otherwise
        // the assertions below would pass lexically and prove nothing.
        // os.tmpdir() is /var/folders/... on macOS, so use the repo cwd.
        workDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-sysdir-test-'));
      });

      afterAll(() => {
        removeTempDir(workDir);
      });

      it('the work dir itself is not a system directory (test precondition)', () => {
        expect(isSystemDirectory(workDir)).toBe(false);
      });

      it('should reject a path reaching a system directory through a symlink', () => {
        const link = path.join(workDir, 'etc-link');
        fs.symlinkSync('/etc', link);

        // Lexically this is under the repo cwd; only symlink resolution reveals /etc.
        expect(isSystemDirectory(path.join(link, 'commandmate.db'))).toBe(true);
      });

      it('should reject a not-yet-created file under a symlinked system directory', () => {
        const link = path.join(workDir, 'etc-link-2');
        fs.symlinkSync('/etc', link);

        // A DB file is validated before it is created, so realpathSync() throws
        // on the leaf. The nearest existing ancestor must still be resolved.
        const notCreated = path.join(link, 'nested', 'deeper', 'new.db');
        expect(fs.existsSync(notCreated)).toBe(false);
        expect(isSystemDirectory(notCreated)).toBe(true);
      });

      it('should reject a broken symlink placed under the work dir without crashing', () => {
        const link = path.join(workDir, 'broken-link');
        fs.symlinkSync(path.join(workDir, 'does-not-exist'), link);

        expect(() => isSystemDirectory(path.join(link, 'x.db'))).not.toThrow();
        expect(isSystemDirectory(path.join(link, 'x.db'))).toBe(false);
      });

      it('should not reject a symlink pointing at a safe directory', () => {
        const target = path.join(workDir, 'safe-target');
        fs.mkdirSync(target);
        const link = path.join(workDir, 'safe-link');
        fs.symlinkSync(target, link);

        expect(isSystemDirectory(path.join(link, 'cm.db'))).toBe(false);
      });

      /**
       * On macOS /tmp, /var and /etc are symlinks into /private, so the physical
       * location of a system directory must be blocked too. On platforms where
       * none of them are symlinks (Linux) this loop simply has nothing to check.
       */
      it('should reject the physical location of every symlinked system directory', () => {
        const symlinked = SYSTEM_DIRECTORIES.filter((dir) => {
          try {
            return fs.realpathSync(dir) !== dir;
          } catch {
            return false;
          }
        });

        for (const dir of symlinked) {
          const physical = fs.realpathSync(dir);
          expect(isSystemDirectory(physical)).toBe(true);
          expect(isSystemDirectory(path.join(physical, 'cm.db'))).toBe(true);
        }
      });

      it.runIf(process.platform === 'darwin')(
        'should treat /private/tmp the same as /tmp on macOS',
        () => {
          expect(fs.realpathSync('/tmp')).toBe('/private/tmp');

          expect(isSystemDirectory('/tmp/cm.db')).toBe(true);
          expect(isSystemDirectory('/private/tmp/cm.db')).toBe(true);
          expect(isSystemDirectory('/private/var/cm.db')).toBe(true);
          expect(isSystemDirectory('/private/etc/cm.db')).toBe(true);
        }
      );
    });
  });

  /**
   * Issue #1774: the narrower question — "would a recursive mkdir here hang?"
   * rather than "may a database live here?".
   */
  describe('VIRTUAL_FILESYSTEM_ROOTS', () => {
    it('is a subset of SYSTEM_DIRECTORIES', () => {
      // The two lists exist for different reasons and are allowed to differ in
      // size, but a root that is unsafe to mkdir into and yet acceptable for a
      // database would be incoherent. Pinned so they cannot drift apart.
      for (const root of VIRTUAL_FILESYSTEM_ROOTS) {
        expect(SYSTEM_DIRECTORIES).toContain(root);
      }
    });

    it('names exactly the three kernel-backed namespaces', () => {
      expect([...VIRTUAL_FILESYSTEM_ROOTS].sort()).toEqual(['/dev', '/proc', '/sys']);
    });
  });

  describe('isVirtualFilesystemPath', () => {
    let workDir: string;

    beforeAll(() => {
      // Must not itself be inside a system directory, otherwise the symlink
      // assertion below would pass lexically and prove nothing. os.tmpdir() is
      // /var/folders/... on macOS, so use the repo cwd.
      workDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-virtualfs-test-'));
    });

    afterAll(() => {
      removeTempDir(workDir);
    });

    describe('rejects the virtual roots and everything under them', () => {
      const virtual = [
        '/proc',
        '/proc/',
        '/proc/self',
        '/proc/definitely-not-writable/cmate',
        '/sys',
        '/sys/kernel/security',
        '/dev',
        '/dev/null',
        '/dev/shm/commandmate',
      ];

      for (const target of virtual) {
        it(`should return true for ${target}`, () => {
          expect(isVirtualFilesystemPath(target)).toBe(true);
        });
      }
    });

    describe('accepts the system directories that are real filesystems', () => {
      // These are in SYSTEM_DIRECTORIES for SEC-001 (no database here) but a
      // recursive mkdir in them fails cleanly, which is the only thing this
      // predicate is asked about. Blocking them would redirect os.tmpdir()-based
      // test isolation and container log directories onto the real home.
      const real = [
        '/etc/commandmate',
        '/usr/local/share/commandmate',
        '/bin',
        '/sbin',
        '/var/log/commandmate',
        '/tmp/commandmate',
        os.tmpdir(),
      ];

      for (const target of real) {
        it(`should return false for ${target}`, () => {
          expect(isVirtualFilesystemPath(target)).toBe(false);
        });
      }
    });

    it('should not match a sibling that merely shares the prefix', () => {
      expect(isVirtualFilesystemPath('/procfs/x')).toBe(false);
      expect(isVirtualFilesystemPath('/system/x')).toBe(false);
      expect(isVirtualFilesystemPath('/devices/x')).toBe(false);
    });

    it('should resolve traversal before matching', () => {
      expect(isVirtualFilesystemPath('/var/log/../../proc/x')).toBe(true);
    });

    it('should reject a path reaching a virtual filesystem through a symlink', () => {
      // Fails closed in the direction that matters: a missed one hangs the
      // server rather than erroring. `/dev` rather than `/proc` because a
      // symlink is only resolvable when its target exists, and `/dev` is the
      // one of the three that is present on macOS as well as on Linux.
      const link = path.join(workDir, 'virtual-link');
      fs.symlinkSync('/dev', link);

      // Lexically this is under the repo cwd; only symlink resolution reveals /dev.
      expect(isVirtualFilesystemPath(path.join(link, 'commandmate-logs'))).toBe(true);
    });

    it('should not reject an ordinary directory', () => {
      expect(isVirtualFilesystemPath(workDir)).toBe(false);
      expect(isVirtualFilesystemPath(path.join(os.homedir(), '.commandmate', 'hooks'))).toBe(false);
    });
  });
});
