/**
 * `resolveSafeDirectory` — the guard that keeps a configured path out of a
 * virtual filesystem (Issue #1774).
 *
 * Everything here is driven by **plain string arguments**. No environment
 * variable is assigned and no directory is created, which is the only way to
 * exercise a `/proc` path without risking the failure being guarded against: on
 * Linux a recursive mkdir under `/proc` never returns and the event loop stops,
 * so vitest's own timeout cannot fire (PR #1773 ran 5h31m that way). The
 * function under test reads the filesystem only through `realpath`, which
 * answers ENOENT immediately for such a path.
 *
 * `tests/unit/guards/no-procfs-env-fixtures.test.ts` bans the other spelling —
 * assigning one of these paths to an environment variable — mechanically.
 *
 * @vitest-environment node
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { existsSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

// `vi.hoisted` so the mock exists by the time `vi.mock` is lifted to the top.
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  },
}));
mockLogger.withContext.mockReturnValue(mockLogger);

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

import { resolveSafeDirectory, resetSafeDirectoryWarnings } from '@/config/safe-directory';

const FALLBACK = '/srv/commandmate/default-dir';

describe('resolveSafeDirectory (Issue #1774)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSafeDirectoryWarnings();
  });

  describe('refuses a path inside a virtual filesystem', () => {
    // The roots themselves, a child, a grandchild, and a file rather than a
    // directory — `CM_OPENCODE_PORT_FILE` names a file, and the mkdir it
    // reaches is on the file's parent.
    const refused = [
      '/proc',
      '/proc/x',
      '/proc/definitely-not-writable/cmate',
      '/proc/self/fd/1',
      '/sys',
      '/sys/kernel/cmate',
      '/dev',
      '/dev/cmate/logs',
      '/dev/null',
      '/proc/ports.json',
      '/sys/x/opencode-ports.json',
    ];

    for (const candidate of refused) {
      it(`returns the fallback for ${candidate}`, () => {
        expect(resolveSafeDirectory(candidate, FALLBACK, 'CM_TEST_DIR')).toBe(FALLBACK);
      });
    }

    it('normalises before deciding, so a traversal cannot smuggle a root past it', () => {
      expect(resolveSafeDirectory('/var/log/../../proc/x', FALLBACK, 'CM_TEST_DIR')).toBe(FALLBACK);
    });

    it('warns with the setting name, the refused value and the substitute', () => {
      resolveSafeDirectory('/proc/x', FALLBACK, 'CM_LOG_DIR');

      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'virtual-filesystem-path-rejected',
        expect.objectContaining({
          source: 'CM_LOG_DIR',
          candidate: '/proc/x',
          fallback: FALLBACK,
        })
      );
    });

    it('warns once per setting, not once per call', () => {
      // getLogDir() runs on the path of every log write. An unconditional
      // warning would turn one bad variable into a flood.
      for (let i = 0; i < 5; i += 1) {
        expect(resolveSafeDirectory('/proc/x', FALLBACK, 'CM_LOG_DIR')).toBe(FALLBACK);
      }

      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    });

    it('warns separately for a different setting and for a different value', () => {
      resolveSafeDirectory('/proc/x', FALLBACK, 'CM_LOG_DIR');
      resolveSafeDirectory('/proc/x', FALLBACK, 'CM_AGENT_HOOKS_DIR');
      resolveSafeDirectory('/proc/y', FALLBACK, 'CM_LOG_DIR');

      expect(mockLogger.warn).toHaveBeenCalledTimes(3);
    });

    it('never throws — a bad log directory must not take out logging', () => {
      expect(() => resolveSafeDirectory('/proc/x', FALLBACK, 'CM_LOG_DIR')).not.toThrow();
    });

    it('creates nothing on disk', () => {
      // Belt and braces: the fix is worthless if the guard itself is what
      // reaches mkdir. `existsSync` is a read.
      resolveSafeDirectory('/proc/commandmate-1774', FALLBACK, 'CM_TEST_DIR');
      expect(existsSync('/proc/commandmate-1774')).toBe(false);
    });
  });

  describe('lets an ordinary path through', () => {
    // Over-rejection is the other way to break this. `/tmp` and `/var` are in
    // SYSTEM_DIRECTORIES because a *database* has no business there, but they
    // are ordinary writable directories: os.tmpdir() is inside one on both
    // platforms, which is where every isolated test directory lives, and
    // /var/log is where a container deployment puts its logs.
    const allowed = [
      '/tmp/commandmate-logs',
      '/var/log/commandmate',
      '/etc/commandmate',
      '/usr/local/share/commandmate',
      '/opt/commandmate/logs',
      tmpdir(),
      join(tmpdir(), 'commandmate-test-codex-home'),
      join(homedir(), '.commandmate', 'hooks'),
      join(homedir(), '.codex'),
      join(process.cwd(), 'data', 'logs'),
    ];

    for (const candidate of allowed) {
      it(`returns ${candidate} unchanged`, () => {
        expect(resolveSafeDirectory(candidate, FALLBACK, 'CM_TEST_DIR')).toBe(candidate);
        expect(mockLogger.warn).not.toHaveBeenCalled();
      });
    }

    it('returns a relative path unchanged, exactly as before this guard', () => {
      // Callers hand the value on verbatim; resolution against cwd happens
      // inside the check only, so a relative override still behaves as it did.
      expect(resolveSafeDirectory('data/logs', FALLBACK, 'CM_LOG_DIR')).toBe('data/logs');
      expect(resolveSafeDirectory('./data/logs', FALLBACK, 'CM_LOG_DIR')).toBe('./data/logs');
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('returns a shell-expanded home path unchanged', () => {
      // `CM_LOG_DIR=~/logs` reaches the process already expanded by the shell.
      const expanded = join(homedir(), 'logs');
      expect(resolveSafeDirectory(expanded, FALLBACK, 'CM_LOG_DIR')).toBe(expanded);
    });

    it('does not reject a sibling that merely shares the prefix', () => {
      for (const lookalike of [
        '/procfs/logs',
        '/proc-backup/logs',
        '/system/logs',
        '/sysroot/commandmate',
        '/devices/commandmate',
        '/development/commandmate',
      ]) {
        expect(resolveSafeDirectory(lookalike, FALLBACK, 'CM_TEST_DIR')).toBe(lookalike);
      }
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });
  });

  describe('an unset candidate', () => {
    it('yields the fallback without warning', () => {
      expect(resolveSafeDirectory(undefined, FALLBACK, 'CM_LOG_DIR')).toBe(FALLBACK);
      expect(resolveSafeDirectory('', FALLBACK, 'CM_LOG_DIR')).toBe(FALLBACK);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('does not treat an empty string as the current directory', () => {
      // path.resolve('') is cwd, so a check written the naive way would answer
      // "safe" and hand '' back to mkdir.
      expect(resolveSafeDirectory('', FALLBACK, 'CM_LOG_DIR')).not.toBe('');
    });
  });

  describe('resetSafeDirectoryWarnings', () => {
    it('lets the same rejection warn again', () => {
      resolveSafeDirectory('/proc/x', FALLBACK, 'CM_LOG_DIR');
      resetSafeDirectoryWarnings();
      resolveSafeDirectory('/proc/x', FALLBACK, 'CM_LOG_DIR');

      expect(mockLogger.warn).toHaveBeenCalledTimes(2);
    });
  });
});
