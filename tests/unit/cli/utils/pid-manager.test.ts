/**
 * PID Manager Tests
 * Tests for PIDManager class (SRP - separated from daemon.ts)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { PidManager } from '../../../../src/cli/utils/pid-manager';

vi.mock('fs');

describe('PidManager', () => {
  let pidManager: PidManager;
  const testPidPath = '/tmp/.commandmate-test.pid';

  beforeEach(() => {
    pidManager = new PidManager(testPidPath);
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('exists', () => {
    it('should return true when PID file exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      expect(pidManager.exists()).toBe(true);
      expect(fs.existsSync).toHaveBeenCalledWith(testPidPath);
    });

    it('should return false when PID file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(pidManager.exists()).toBe(false);
    });
  });

  describe('readPid', () => {
    it('should return PID when file exists and contains valid number', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('12345');
      expect(pidManager.readPid()).toBe(12345);
    });

    it('should return null when file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(pidManager.readPid()).toBeNull();
    });

    it('should return null when file contains invalid content', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('invalid');
      expect(pidManager.readPid()).toBeNull();
    });

    it('should trim whitespace from PID', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('  12345\n');
      expect(pidManager.readPid()).toBe(12345);
    });
  });

  describe('writePid', () => {
    it('should write PID to file with atomic flag', () => {
      const mockFd = 3;
      vi.mocked(fs.openSync).mockReturnValue(mockFd);
      vi.mocked(fs.writeSync).mockReturnValue(5);
      vi.mocked(fs.closeSync).mockReturnValue(undefined);

      const result = pidManager.writePid(12345);

      expect(result).toBe(true);
      expect(fs.openSync).toHaveBeenCalledWith(
        testPidPath,
        expect.any(Number), // O_WRONLY | O_CREAT | O_EXCL
        0o600
      );
      expect(fs.writeSync).toHaveBeenCalledWith(mockFd, '12345');
      expect(fs.closeSync).toHaveBeenCalledWith(mockFd);
    });

    it('should return false when file already exists (EEXIST)', () => {
      const error = new Error('file exists') as NodeJS.ErrnoException;
      error.code = 'EEXIST';
      vi.mocked(fs.openSync).mockImplementation(() => { throw error; });

      const result = pidManager.writePid(12345);

      expect(result).toBe(false);
    });

    it('should throw for other errors', () => {
      const error = new Error('permission denied') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      vi.mocked(fs.openSync).mockImplementation(() => { throw error; });

      expect(() => pidManager.writePid(12345)).toThrow('permission denied');
    });
  });

  describe('removePid', () => {
    it('should remove PID file when it exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.unlinkSync).mockReturnValue(undefined);

      pidManager.removePid();

      expect(fs.unlinkSync).toHaveBeenCalledWith(testPidPath);
    });

    it('should not throw when file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      expect(() => pidManager.removePid()).not.toThrow();
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });
  });

  describe('isProcessRunning', () => {
    it('should return true when process exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('12345');

      // Mock process.kill to not throw (process exists)
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      expect(pidManager.isProcessRunning()).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(12345, 0);

      killSpy.mockRestore();
    });

    it('should return false when process does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('12345');

      // Mock process.kill to throw ESRCH (process not found)
      const error = new Error('process not found') as NodeJS.ErrnoException;
      error.code = 'ESRCH';
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => { throw error; });

      expect(pidManager.isProcessRunning()).toBe(false);

      killSpy.mockRestore();
    });

    it('should return false when PID file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      expect(pidManager.isProcessRunning()).toBe(false);
    });

    it('should throw for permission errors', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('12345');

      const error = new Error('permission denied') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => { throw error; });

      expect(() => pidManager.isProcessRunning()).toThrow('permission denied');

      killSpy.mockRestore();
    });
  });
});
