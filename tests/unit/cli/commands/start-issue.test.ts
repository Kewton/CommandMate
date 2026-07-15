/**
 * Start Command Tests - Issue #136 Extensions
 * Tests for --issue and --auto-port flags, exercised against the real runStart.
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

const resolvers = vi.hoisted(() => ({
  allocate: vi.fn(),
  resolveDbPath: vi.fn(),
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

vi.mock('dotenv', () => ({
  config: vi.fn().mockReturnValue({ parsed: {} }),
}));

vi.mock('../../../../src/cli/utils/install-context', () => ({
  getConfigDir: vi.fn(() => path.join(homedir(), '.commandmate')),
  isGlobalInstall: vi.fn(() => true),
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({ on: vi.fn() })),
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

vi.mock('../../../../src/cli/utils/port-allocator', () => ({
  PortAllocator: {
    getInstance: vi.fn(() => ({ allocate: resolvers.allocate })),
  },
}));

vi.mock('../../../../src/cli/utils/resource-resolvers', () => ({
  DbPathResolver: vi.fn(function (this: Record<string, unknown>) {
    this.resolve = resolvers.resolveDbPath;
  }),
}));

vi.mock('../../../../src/cli/utils/security-logger', () => ({
  logSecurityEvent: vi.fn(),
}));

vi.mock('../../../../src/cli/utils/paths', () => ({
  getPackageRoot: vi.fn(() => '/mock/package/root'),
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

import { runStart } from '../../../../src/cli/commands/start';
import { ExitCode } from '../../../../src/cli/types';

const pidPath = (issueNo?: number) =>
  issueNo !== undefined
    ? path.join(homedir(), '.commandmate', 'pids', `${issueNo}.pid`)
    : path.join(homedir(), '.commandmate', '.commandmate.pid');

describe('Start Command - Issue #136 Extensions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    daemon.isRunning.mockResolvedValue(false);
    daemon.getStatus.mockResolvedValue(null);
    daemon.start.mockResolvedValue(12345);
    resolvers.allocate.mockReturnValue(3135);
    resolvers.resolveDbPath.mockReturnValue('/mock/home/.commandmate/data/cm-135.db');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('--issue flag', () => {
    it('should construct DaemonManager with the worktree PID file', async () => {
      const result = await runStart({ daemon: true, issue: 135 });

      expect(daemon.ctor).toHaveBeenCalledWith(pidPath(135));
      expect(result.ok).toBe(true);
      expect(result.pid).toBe(12345);
    });

    it('should use the main PID file when no issue is given', async () => {
      await runStart({ daemon: true });

      expect(daemon.ctor).toHaveBeenCalledWith(pidPath());
    });

    it('should pass the worktree DB path to DaemonManager.start', async () => {
      await runStart({ daemon: true, issue: 135 });

      expect(resolvers.resolveDbPath).toHaveBeenCalledWith(135);
      expect(daemon.start).toHaveBeenCalledWith(
        expect.objectContaining({ dbPath: '/mock/home/.commandmate/data/cm-135.db' })
      );
    });

    it('should not resolve a worktree DB path for the main server', async () => {
      await runStart({ daemon: true });

      expect(resolvers.resolveDbPath).not.toHaveBeenCalled();
      expect(daemon.start).toHaveBeenCalledWith(
        expect.objectContaining({ dbPath: undefined })
      );
    });

    it('should refuse to start when the issue server is already running', async () => {
      daemon.isRunning.mockResolvedValue(true);
      daemon.getStatus.mockResolvedValue({ running: true, pid: 999 });

      const result = await runStart({ daemon: true, issue: 135 });

      expect(daemon.start).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: false, exitCode: ExitCode.START_FAILED });
    });

    it('should reject an invalid issue number before touching DaemonManager', async () => {
      const result = await runStart({ daemon: true, issue: -5 });

      expect(daemon.ctor).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: false, exitCode: ExitCode.START_FAILED });
    });
  });

  describe('--auto-port flag', () => {
    it('should allocate a port for the issue and pass it to DaemonManager.start', async () => {
      const result = await runStart({ daemon: true, issue: 135, autoPort: true });

      expect(resolvers.allocate).toHaveBeenCalledWith(135);
      expect(daemon.start).toHaveBeenCalledWith(
        expect.objectContaining({ port: 3135 })
      );
      expect(result.url).toContain('3135');
    });

    it('should not allocate a port without --issue', async () => {
      await runStart({ daemon: true, autoPort: true });

      expect(resolvers.allocate).not.toHaveBeenCalled();
    });

    it('should honour an explicit --port over auto allocation', async () => {
      await runStart({ daemon: true, issue: 135, port: 4000 });

      expect(resolvers.allocate).not.toHaveBeenCalled();
      expect(daemon.start).toHaveBeenCalledWith(
        expect.objectContaining({ port: 4000 })
      );
    });
  });

  describe('daemon start failure', () => {
    it('should return START_FAILED when DaemonManager.start throws', async () => {
      daemon.start.mockRejectedValue(new Error('spawn failed'));

      const result = await runStart({ daemon: true, issue: 135 });

      expect(result).toEqual({ ok: false, exitCode: ExitCode.START_FAILED });
    });
  });
});
