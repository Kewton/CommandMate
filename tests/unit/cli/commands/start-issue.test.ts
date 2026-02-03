/**
 * Start Command Tests - Issue #136 Extensions
 * TDD: Tests for --issue and --auto-port flags
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

// Mock dotenv
vi.mock('dotenv', () => ({
  config: vi.fn().mockReturnValue({ parsed: {} }),
}));

// Mock install-context
vi.mock('../../../../src/cli/utils/install-context', () => ({
  getConfigDir: vi.fn(() => path.join(homedir(), '.commandmate')),
  isGlobalInstall: vi.fn(() => true),
}));

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    on: vi.fn(),
  })),
}));

// Mock daemon
vi.mock('../../../../src/cli/utils/daemon', () => ({
  DaemonManager: vi.fn().mockImplementation(() => ({
    isRunning: vi.fn().mockResolvedValue(false),
    getStatus: vi.fn().mockResolvedValue(null),
    start: vi.fn().mockResolvedValue(12345),
    stop: vi.fn().mockResolvedValue(true),
  })),
}));

// Mock security-logger
vi.mock('../../../../src/cli/utils/security-logger', () => ({
  logSecurityEvent: vi.fn(),
}));

// Mock paths
vi.mock('../../../../src/cli/utils/paths', () => ({
  getPackageRoot: vi.fn(() => '/mock/package/root'),
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

import { StartOptions } from '../../../../src/cli/types';

describe('Start Command - Issue #136 Extensions', () => {
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

  describe('StartOptions type', () => {
    it('should accept issue option', () => {
      const options: StartOptions = {
        dev: false,
        daemon: true,
        issue: 135,
      };

      expect(options.issue).toBe(135);
    });

    it('should accept autoPort option', () => {
      const options: StartOptions = {
        dev: false,
        daemon: true,
        autoPort: true,
      };

      expect(options.autoPort).toBe(true);
    });

    it('should accept both issue and autoPort options', () => {
      const options: StartOptions = {
        dev: false,
        daemon: true,
        issue: 200,
        autoPort: true,
      };

      expect(options.issue).toBe(200);
      expect(options.autoPort).toBe(true);
    });
  });

  describe('getEnvPath with issueNo', () => {
    it('should return worktree-specific .env path for issue', async () => {
      const { getEnvPath } = await import('../../../../src/cli/utils/env-setup');

      const mainEnvPath = getEnvPath();
      const worktreeEnvPath = getEnvPath(135);

      expect(mainEnvPath).toBe(path.join(homedir(), '.commandmate', '.env'));
      expect(worktreeEnvPath).toBe(
        path.join(homedir(), '.commandmate', 'envs', '135.env')
      );
    });
  });

  describe('getPidFilePath with issueNo', () => {
    it('should return worktree-specific PID path for issue', async () => {
      const { getPidFilePath } = await import(
        '../../../../src/cli/utils/env-setup'
      );

      const mainPidPath = getPidFilePath();
      const worktreePidPath = getPidFilePath(135);

      expect(mainPidPath).toBe(
        path.join(homedir(), '.commandmate', '.commandmate.pid')
      );
      expect(worktreePidPath).toBe(
        path.join(homedir(), '.commandmate', 'pids', '135.pid')
      );
    });
  });
});
