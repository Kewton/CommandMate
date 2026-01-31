/**
 * Daemon Manager Tests
 * Tests for daemon process management (start/stop)
 * Note: Testing DaemonManager methods via integration with PidManager
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'child_process';
import * as fs from 'fs';

vi.mock('child_process');
vi.mock('fs');

// Import after mocking
import { DaemonManager } from '../../../../src/cli/utils/daemon';

describe('DaemonManager', () => {
  let daemonManager: DaemonManager;
  const testPidPath = '/tmp/test-commandmate.pid';

  beforeEach(() => {
    vi.clearAllMocks();
    daemonManager = new DaemonManager(testPidPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('start', () => {
    it('should start daemon process when not running', async () => {
      // Mock PidManager.isProcessRunning() via fs checks
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.openSync).mockReturnValue(3);
      vi.mocked(fs.writeSync).mockReturnValue(5);
      vi.mocked(fs.closeSync).mockReturnValue(undefined);

      const mockChild = {
        pid: 12345,
        unref: vi.fn(),
        on: vi.fn(),
      };
      vi.mocked(childProcess.spawn).mockReturnValue(mockChild as unknown as childProcess.ChildProcess);

      const pid = await daemonManager.start({});

      expect(pid).toBe(12345);
      expect(childProcess.spawn).toHaveBeenCalledWith(
        'npm',
        ['run', 'start'],
        expect.objectContaining({
          detached: true,
          stdio: 'ignore',
        })
      );
      expect(mockChild.unref).toHaveBeenCalled();
    });

    it('should throw error if already running', async () => {
      // Mock process already running
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('99999');

      // Mock process.kill to return true (process exists)
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      await expect(daemonManager.start({})).rejects.toThrow('already running');

      killSpy.mockRestore();
    });

    it('should use dev mode when specified', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.openSync).mockReturnValue(3);
      vi.mocked(fs.writeSync).mockReturnValue(5);
      vi.mocked(fs.closeSync).mockReturnValue(undefined);

      const mockChild = {
        pid: 12345,
        unref: vi.fn(),
        on: vi.fn(),
      };
      vi.mocked(childProcess.spawn).mockReturnValue(mockChild as unknown as childProcess.ChildProcess);

      await daemonManager.start({ dev: true });

      expect(childProcess.spawn).toHaveBeenCalledWith(
        'npm',
        ['run', 'dev'],
        expect.any(Object)
      );
    });
  });

  describe('stop', () => {
    it('should stop daemon and remove PID file', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('12345');
      vi.mocked(fs.unlinkSync).mockReturnValue(undefined);

      // kill(pid, 0) for isProcessRunning returns true
      // kill(pid, SIGTERM) succeeds
      // Subsequent kill(pid, 0) throws ESRCH (process exited)
      const killSpy = vi.spyOn(process, 'kill')
        .mockImplementationOnce(() => true)  // isProcessRunning check
        .mockImplementationOnce(() => true)  // SIGTERM
        .mockImplementation(() => {
          // waitForExit: process no longer running
          const error = new Error('No such process') as NodeJS.ErrnoException;
          error.code = 'ESRCH';
          throw error;
        });

      const result = await daemonManager.stop();

      expect(result).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM');

      killSpy.mockRestore();
    });

    it('should return false when no PID file exists', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await daemonManager.stop();

      expect(result).toBe(false);
    });

    it('should clean up stale PID when process not running', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('12345');
      vi.mocked(fs.unlinkSync).mockReturnValue(undefined);

      // Process not found
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        const error = new Error('No such process') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      });

      const result = await daemonManager.stop();

      expect(result).toBe(true);
      expect(fs.unlinkSync).toHaveBeenCalled();

      killSpy.mockRestore();
    });
  });

  describe('getStatus', () => {
    it('should return running status with details', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('12345');

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const status = await daemonManager.getStatus();

      expect(status).not.toBeNull();
      expect(status?.running).toBe(true);
      expect(status?.pid).toBe(12345);

      killSpy.mockRestore();
    });

    it('should return not running when process is dead', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('12345');

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        const error = new Error('No such process') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      });

      const status = await daemonManager.getStatus();

      expect(status?.running).toBe(false);

      killSpy.mockRestore();
    });

    it('should return null when no PID file exists', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const status = await daemonManager.getStatus();

      expect(status).toBeNull();
    });
  });

  describe('isRunning', () => {
    it('should return true when process is running', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('12345');

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      expect(await daemonManager.isRunning()).toBe(true);

      killSpy.mockRestore();
    });

    it('should return false when process is not running', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      expect(await daemonManager.isRunning()).toBe(false);
    });
  });
});
