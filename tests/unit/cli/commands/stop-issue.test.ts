/**
 * Stop Command Tests - Issue #136 Extensions
 * Tests for the --issue flag, exercised against the real stopCommand.
 *
 * Issue #1269: the DaemonManager mock must be built from `function` (or `class`),
 * never an arrow fn. `vi.fn().mockImplementation(() => ({ ... }))` has no
 * [[Construct]], so `new DaemonManager(pid)` throws "is not a constructor".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { homedir } from 'os';

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
  };
});

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

vi.mock('../../../../src/cli/utils/security-logger', () => ({
  logSecurityEvent: vi.fn(),
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
}));

import { stopCommand } from '../../../../src/cli/commands/stop';
import { ExitCode } from '../../../../src/cli/types';
import { logSecurityEvent } from '../../../../src/cli/utils/security-logger';

const pidPath = (issueNo?: number) =>
  issueNo !== undefined
    ? path.join(homedir(), '.commandmate', 'pids', `${issueNo}.pid`)
    : path.join(homedir(), '.commandmate', '.commandmate.pid');

describe('Stop Command - Issue #136 Extensions', () => {
  let mockExit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    daemon.isRunning.mockResolvedValue(true);
    daemon.getStatus.mockResolvedValue({ running: true, pid: 12345 });
    daemon.stop.mockResolvedValue(true);

    mockExit = vi.fn();
    vi.spyOn(process, 'exit').mockImplementation(mockExit as unknown as typeof process.exit);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('--issue flag', () => {
    it('should construct DaemonManager with the worktree PID file', async () => {
      await stopCommand({ force: false, issue: 135 });

      expect(daemon.ctor).toHaveBeenCalledWith(pidPath(135));
      expect(daemon.stop).toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });

    it('should use the main PID file when no issue is given', async () => {
      await stopCommand({ force: false });

      expect(daemon.ctor).toHaveBeenCalledWith(pidPath());
    });

    it('should target different PID files for different issues', async () => {
      await stopCommand({ force: false, issue: 135 });
      await stopCommand({ force: false, issue: 200 });

      expect(daemon.ctor).toHaveBeenNthCalledWith(1, pidPath(135));
      expect(daemon.ctor).toHaveBeenNthCalledWith(2, pidPath(200));
    });

    it('should reject an invalid issue number before touching DaemonManager', async () => {
      await stopCommand({ force: false, issue: 0 });

      expect(daemon.ctor).not.toHaveBeenCalled();
      expect(daemon.stop).not.toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(ExitCode.STOP_FAILED);
    });
  });

  describe('--force flag', () => {
    it('should forward force=true to DaemonManager.stop and log a security warning', async () => {
      await stopCommand({ force: true, issue: 135 });

      expect(daemon.stop).toHaveBeenCalledWith(true);
      expect(logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'stop',
          action: 'warning',
          details: expect.stringContaining('Issue #135'),
        })
      );
    });

    it('should forward force=false when not forcing', async () => {
      await stopCommand({ force: false, issue: 135 });

      expect(daemon.stop).toHaveBeenCalledWith(false);
    });
  });

  describe('when not running', () => {
    it('should exit SUCCESS without calling stop', async () => {
      daemon.isRunning.mockResolvedValue(false);
      daemon.getStatus.mockResolvedValue(null);

      await stopCommand({ force: false, issue: 135 });

      expect(daemon.stop).not.toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });
  });

  describe('when stop fails', () => {
    it('should exit STOP_FAILED and log a failure event', async () => {
      daemon.stop.mockResolvedValue(false);

      await stopCommand({ force: false, issue: 135 });

      expect(mockExit).toHaveBeenCalledWith(ExitCode.STOP_FAILED);
      expect(logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'stop', action: 'failure' })
      );
    });
  });
});
