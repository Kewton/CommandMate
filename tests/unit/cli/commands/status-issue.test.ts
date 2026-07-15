/**
 * Status Command Tests - Issue #136 Extensions
 * Tests for --issue and --all flags, exercised against the real statusCommand.
 *
 * Issue #1269: the DaemonManager mock must be built from `function` (or `class`),
 * never an arrow fn. `vi.fn().mockImplementation(() => ({ ... }))` has no
 * [[Construct]], so `new DaemonManager(pid)` throws "is not a constructor".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { homedir } from 'os';
import type { DaemonStatus } from '../../../../src/cli/types';

const daemon = vi.hoisted(() => ({
  ctor: vi.fn(),
  isRunning: vi.fn(),
  getStatus: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    realpathSync: vi.fn((p: string) => p),
    readdirSync: vi.fn(() => ['135.pid', '200.pid']),
  };
});

vi.mock('dotenv', () => ({
  config: vi.fn().mockReturnValue({ parsed: {} }),
}));

vi.mock('../../../../src/cli/utils/install-context', () => ({
  getConfigDir: vi.fn(() => path.join(homedir(), '.commandmate')),
  isGlobalInstall: vi.fn(() => true),
}));

vi.mock('../../../../src/cli/utils/daemon', () => ({
  DaemonManager: vi.fn(function (this: Record<string, unknown>, pidFilePath: string) {
    daemon.ctor(pidFilePath);
    this.isRunning = daemon.isRunning;
    this.getStatus = daemon.getStatus;
    this.start = daemon.start;
    this.stop = daemon.stop;
  }),
}));

vi.mock('../../../../src/cli/utils/env-setup', () => ({
  getEnvPath: vi.fn((issueNo?: number) =>
    issueNo !== undefined
      ? path.join(homedir(), '.commandmate', 'envs', `${issueNo}.env`)
      : path.join(homedir(), '.commandmate', '.env')
  ),
  getPidFilePath: vi.fn((issueNo?: number) =>
    issueNo !== undefined
      ? path.join(homedir(), '.commandmate', 'pids', `${issueNo}.pid`)
      : path.join(homedir(), '.commandmate', '.commandmate.pid')
  ),
  getPidsDir: vi.fn(() => path.join(homedir(), '.commandmate', 'pids')),
}));

import { statusCommand } from '../../../../src/cli/commands/status';
import { ExitCode } from '../../../../src/cli/types';
import { config as dotenvConfig } from 'dotenv';

const RUNNING: DaemonStatus = {
  running: true,
  pid: 12345,
  port: 3135,
  uptime: 3600,
};

const pidPath = (issueNo?: number) =>
  issueNo !== undefined
    ? path.join(homedir(), '.commandmate', 'pids', `${issueNo}.pid`)
    : path.join(homedir(), '.commandmate', '.commandmate.pid');

describe('Status Command - Issue #136 Extensions', () => {
  let mockExit: ReturnType<typeof vi.fn>;
  let output: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    daemon.isRunning.mockResolvedValue(true);
    daemon.getStatus.mockResolvedValue(RUNNING);
    vi.mocked(dotenvConfig).mockReturnValue({ parsed: {} });

    output = [];
    mockExit = vi.fn();
    vi.spyOn(process, 'exit').mockImplementation(mockExit as unknown as typeof process.exit);
    vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      output.push(String(msg));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('--issue flag', () => {
    it('should construct DaemonManager with the worktree PID file', async () => {
      await statusCommand({ issue: 135 });

      expect(daemon.ctor).toHaveBeenCalledWith(pidPath(135));
      expect(daemon.getStatus).toHaveBeenCalled();
    });

    it('should load the worktree .env so getStatus sees the right CM_PORT', async () => {
      await statusCommand({ issue: 135 });

      expect(dotenvConfig).toHaveBeenCalledWith({
        path: path.join(homedir(), '.commandmate', 'envs', '135.env'),
      });
    });

    it('should label the output with the issue number and report the status', async () => {
      await statusCommand({ issue: 135 });

      expect(output.join('\n')).toContain('CommandMate Status - Issue #135');
      expect(output.join('\n')).toContain('Status:  Running (PID: 12345)');
      expect(output.join('\n')).toContain('Port:    3135');
    });

    it('should use the main PID file when no issue is given', async () => {
      await statusCommand({});

      expect(daemon.ctor).toHaveBeenCalledWith(pidPath());
      expect(output.join('\n')).toContain('CommandMate Status - Main Server');
    });

    it('should report stopped when getStatus returns null', async () => {
      daemon.getStatus.mockResolvedValue(null);

      await statusCommand({ issue: 135 });

      expect(output.join('\n')).toContain('Status:  Stopped (no PID file)');
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });

    it('should report a stale PID file and suggest the issue-specific start command', async () => {
      daemon.getStatus.mockResolvedValue({ running: false, pid: 12345 });

      await statusCommand({ issue: 135 });

      expect(output.join('\n')).toContain('Status:  Not running (stale PID file)');
      expect(output.join('\n')).toContain('commandmate start --issue 135');
    });

    it('should reject an invalid issue number before touching DaemonManager', async () => {
      await statusCommand({ issue: -1 });

      expect(daemon.ctor).not.toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(ExitCode.UNEXPECTED_ERROR);
    });
  });

  describe('--all flag', () => {
    it('should report the main server plus every worktree PID file', async () => {
      await statusCommand({ all: true });

      expect(daemon.ctor).toHaveBeenCalledWith(pidPath());
      expect(daemon.ctor).toHaveBeenCalledWith(pidPath(135));
      expect(daemon.ctor).toHaveBeenCalledWith(pidPath(200));
      expect(daemon.ctor).toHaveBeenCalledTimes(3);

      const text = output.join('\n');
      expect(text).toContain('CommandMate Status - Main Server');
      expect(text).toContain('CommandMate Status - Issue #135');
      expect(text).toContain('CommandMate Status - Issue #200');
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });
  });

  describe('error handling', () => {
    it('should exit with UNEXPECTED_ERROR when getStatus throws', async () => {
      daemon.getStatus.mockRejectedValue(new Error('boom'));

      await statusCommand({ issue: 135 });

      expect(mockExit).toHaveBeenCalledWith(ExitCode.UNEXPECTED_ERROR);
    });
  });
});
