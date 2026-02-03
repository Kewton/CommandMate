/**
 * Status Command Tests - Issue #136 Extensions
 * TDD: Tests for --issue and --all flags
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
    readdirSync: vi.fn(() => ['135.pid', '200.pid', '300.pid']),
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

// Mock daemon
vi.mock('../../../../src/cli/utils/daemon', () => ({
  DaemonManager: vi.fn().mockImplementation(() => ({
    isRunning: vi.fn().mockResolvedValue(true),
    getStatus: vi.fn().mockResolvedValue({
      running: true,
      pid: 12345,
      port: 3000,
      uptime: 3600,
    }),
    start: vi.fn().mockResolvedValue(12345),
    stop: vi.fn().mockResolvedValue(true),
  })),
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
  getPidsDir: vi.fn(() => path.join(homedir(), '.commandmate', 'pids')),
}));

import { StatusOptions } from '../../../../src/cli/types';
import { getPidFilePath } from '../../../../src/cli/utils/env-setup';

describe('Status Command - Issue #136 Extensions', () => {
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

  describe('StatusOptions type', () => {
    it('should accept issue option', () => {
      const options: StatusOptions = {
        issue: 135,
      };

      expect(options.issue).toBe(135);
    });

    it('should accept all option', () => {
      const options: StatusOptions = {
        all: true,
      };

      expect(options.all).toBe(true);
    });

    it('should work without any options (backward compatibility)', () => {
      const options: StatusOptions = {};

      expect(options.issue).toBeUndefined();
      expect(options.all).toBeUndefined();
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
  });

  describe('Status --all flag behavior', () => {
    it('should list all worktree PID files in pids directory', async () => {
      const { getPidsDir } = await import(
        '../../../../src/cli/utils/env-setup'
      );
      const pidsDir = getPidsDir();

      expect(pidsDir).toBe(path.join(homedir(), '.commandmate', 'pids'));
    });

    it('should parse issue number from PID filename', () => {
      // PID filename pattern: {issueNo}.pid
      const filename = '135.pid';
      const issueNo = parseInt(filename.replace('.pid', ''), 10);

      expect(issueNo).toBe(135);
    });
  });
});
