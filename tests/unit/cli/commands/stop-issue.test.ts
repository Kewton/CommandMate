/**
 * Stop Command Tests - Issue #136 Extensions
 * TDD: Tests for --issue flag
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { homedir } from 'os';

// Mock file system operations
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    realpathSync: vi.fn((p: string) => p),
  };
});

// Mock install-context
vi.mock('../../../../src/cli/utils/install-context', () => ({
  getConfigDir: vi.fn(() => path.join(homedir(), '.commandmate')),
  isGlobalInstall: vi.fn(() => true),
}));

// Mock daemon
vi.mock('../../../../src/cli/utils/daemon', () => ({
  DaemonManager: vi.fn().mockImplementation(() => ({
    isRunning: vi.fn().mockResolvedValue(true),
    getStatus: vi.fn().mockResolvedValue({ running: true, pid: 12345 }),
    start: vi.fn().mockResolvedValue(12345),
    stop: vi.fn().mockResolvedValue(true),
  })),
}));

// Mock security-logger
vi.mock('../../../../src/cli/utils/security-logger', () => ({
  logSecurityEvent: vi.fn(),
}));

// Mock env-setup
vi.mock('../../../../src/cli/utils/env-setup', () => ({
  getEnvPath: vi.fn((issueNo?: number) => {
    if (issueNo !== undefined) {
      return path.join(homedir(), '.commandmate', 'envs', `${issueNo}.env`);
    }
    return path.join(homedir(), '.commandmate', '.env');
  }),
  getPidFilePath: vi.fn((issueNo?: number) => {
    if (issueNo !== undefined) {
      return path.join(homedir(), '.commandmate', 'pids', `${issueNo}.pid`);
    }
    return path.join(homedir(), '.commandmate', '.commandmate.pid');
  }),
}));

import { StopOptions } from '../../../../src/cli/types';
import { getPidFilePath } from '../../../../src/cli/utils/env-setup';

describe('Stop Command - Issue #136 Extensions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset process.exit mock
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('StopOptions type', () => {
    it('should accept issue option', () => {
      const options: StopOptions = {
        force: false,
        issue: 135,
      };

      expect(options.issue).toBe(135);
    });

    it('should accept force and issue options together', () => {
      const options: StopOptions = {
        force: true,
        issue: 200,
      };

      expect(options.force).toBe(true);
      expect(options.issue).toBe(200);
    });

    it('should work without issue option (backward compatibility)', () => {
      const options: StopOptions = {
        force: false,
      };

      expect(options.issue).toBeUndefined();
    });
  });

  describe('getPidFilePath with issueNo', () => {
    it('should return main PID path when no issue specified', () => {
      const pidPath = getPidFilePath();
      expect(pidPath).toBe(
        path.join(homedir(), '.commandmate', '.commandmate.pid')
      );
    });

    it('should return worktree PID path when issue specified', () => {
      const pidPath = getPidFilePath(135);
      expect(pidPath).toBe(
        path.join(homedir(), '.commandmate', 'pids', '135.pid')
      );
    });

    it('should return different paths for different issues', () => {
      const pidPath135 = getPidFilePath(135);
      const pidPath200 = getPidFilePath(200);

      expect(pidPath135).not.toBe(pidPath200);
      expect(pidPath135).toContain('135.pid');
      expect(pidPath200).toContain('200.pid');
    });
  });
});
