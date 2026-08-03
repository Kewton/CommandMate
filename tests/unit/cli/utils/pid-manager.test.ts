/**
 * PID Manager Tests
 * Tests for PIDManager class (SRP - separated from daemon.ts)
 * Issue #136: Phase 2 - Task 2.4 - Added factory function tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import {
  PidManager,
  createPidManager,
  createIssuePidManager,
  type DaemonState,
} from '../../../../src/cli/utils/pid-manager';

// Mock install-context module
vi.mock('../../../../src/cli/utils/install-context', () => ({
  getConfigDir: vi.fn(() => path.join(homedir(), '.commandmate')),
}));

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

  describe('readState', () => {
    it('should parse a JSON state file with all fields', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          pid: 12345,
          version: '1.2.3',
          port: 4000,
          bind: '127.0.0.1',
          protocol: 'https',
          auth: true,
          startTime: 'Sat Jul 18 01:03:24 2026',
        })
      );

      const state = pidManager.readState();

      expect(state).toEqual({
        pid: 12345,
        version: '1.2.3',
        port: 4000,
        bind: '127.0.0.1',
        protocol: 'https',
        auth: true,
        startTime: 'Sat Jul 18 01:03:24 2026',
      });
    });

    it('should read a legacy bare-integer PID file (backward compat)', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('12345');

      expect(pidManager.readState()).toEqual({ pid: 12345 });
    });

    it('should return null for JSON without a valid pid', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ version: '1.2.3' }));

      expect(pidManager.readState()).toBeNull();
    });

    it('should return null when file is missing', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      expect(pidManager.readState()).toBeNull();
    });
  });

  describe('writeState', () => {
    it('should write JSON state to file with atomic flag', () => {
      const mockFd = 3;
      vi.mocked(fs.openSync).mockReturnValue(mockFd);
      vi.mocked(fs.writeSync).mockReturnValue(5);
      vi.mocked(fs.closeSync).mockReturnValue(undefined);

      const result = pidManager.writeState({ pid: 12345, version: '1.2.3', port: 4000 });

      expect(result).toBe(true);
      expect(fs.openSync).toHaveBeenCalledWith(
        testPidPath,
        expect.any(Number), // O_WRONLY | O_CREAT | O_EXCL
        0o600
      );
      // Issue #1632: hybrid format — line 1 is the bare PID, line 2 the JSON state
      const written = vi.mocked(fs.writeSync).mock.calls[0][1] as string;
      const [pidLine, jsonLine] = written.split('\n');
      expect(pidLine).toBe('12345');
      expect(JSON.parse(jsonLine)).toEqual({ pid: 12345, version: '1.2.3', port: 4000 });
      expect(fs.closeSync).toHaveBeenCalledWith(mockFd);
    });

    it('should return false when file already exists (EEXIST)', () => {
      const error = new Error('file exists') as NodeJS.ErrnoException;
      error.code = 'EEXIST';
      vi.mocked(fs.openSync).mockImplementation(() => { throw error; });

      const result = pidManager.writeState({ pid: 12345 });

      expect(result).toBe(false);
    });

    it('should throw for other errors', () => {
      const error = new Error('permission denied') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      vi.mocked(fs.openSync).mockImplementation(() => { throw error; });

      expect(() => pidManager.writeState({ pid: 12345 })).toThrow('permission denied');
    });
  });

  /**
   * Issue #1632: a globally installed CLI predating #1354 stays on PATH and reads the very same
   * ~/.commandmate/.commandmate.pid the current daemon writes. Its readPid() is a plain
   * parseInt(), so the #1354 JSON-only file made it report "Stopped (no PID file)" for a healthy
   * server. The hybrid format restores that forward compatibility without losing any state.
   */
  describe('hybrid state file format (Issue #1632)', () => {
    /** Exactly the pre-#1354 reader (src/cli/utils/pid-manager.ts @ v0.2.4, readPid) */
    const legacyReadPid = (fileContent: string): number | null => {
      const pid = parseInt(fileContent.trim(), 10);
      return isNaN(pid) || pid <= 0 ? null : pid;
    };

    const state: DaemonState = {
      pid: 84890,
      version: '0.18.0',
      port: 3000,
      bind: '127.0.0.1',
      protocol: 'http',
      auth: false,
      startedAt: '2026-07-30T12:00:00.000Z',
      startTime: 'Thu Jul 30 21:00:00 2026',
    };

    /** The exact bytes writeState() puts on disk for `state` (format is frozen here) */
    const HYBRID_FIXTURE =
      '84890\n' +
      '{"pid":84890,"version":"0.18.0","port":3000,"bind":"127.0.0.1","protocol":"http",' +
      '"auth":false,"startedAt":"2026-07-30T12:00:00.000Z","startTime":"Thu Jul 30 21:00:00 2026"}\n';

    const write = (value: DaemonState): string => {
      vi.mocked(fs.openSync).mockReturnValue(3);
      vi.mocked(fs.writeSync).mockReturnValue(1);
      vi.mocked(fs.closeSync).mockReturnValue(undefined);
      pidManager.writeState(value);
      return vi.mocked(fs.writeSync).mock.calls[0][1] as string;
    };

    const read = (fileContent: string): DaemonState | null => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(fileContent);
      return pidManager.readState();
    };

    it('writes the frozen hybrid layout: bare PID first, JSON second', () => {
      expect(write(state)).toBe(HYBRID_FIXTURE);
    });

    it('lets the pre-#1354 parseInt reader recover the PID from what we write', () => {
      expect(legacyReadPid(HYBRID_FIXTURE)).toBe(84890);
      expect(legacyReadPid(write(state))).toBe(84890);
    });

    it('reproduces the #1632 failure with the JSON-only format (guards the fixture above)', () => {
      // The format shipped between #1354 and #1632: parseInt('{...') === NaN → "no PID file"
      expect(legacyReadPid(JSON.stringify(state))).toBeNull();
    });

    it('round-trips every field back through readState (version drives the #1354 warning)', () => {
      expect(read(HYBRID_FIXTURE)).toEqual(state);
      expect(read(write(state))).toEqual(state);
    });

    it('falls back to the line-1 PID when the JSON body is corrupt', () => {
      expect(read('84890\n{"pid":84890,"version":"0.1')).toEqual({ pid: 84890 });
    });

    it('still reads a JSON-only file written before this change', () => {
      expect(read(JSON.stringify(state))).toEqual(state);
    });

    it('still reads a bare-integer file written before #1354', () => {
      expect(read('84890')).toEqual({ pid: 84890 });
    });

    it('tolerates CRLF line endings', () => {
      expect(read('84890\r\n{"pid":84890,"version":"0.18.0"}\r\n')).toEqual({
        pid: 84890,
        version: '0.18.0',
      });
    });

    it('returns null when the line-1 PID is not a usable process id', () => {
      expect(read('0\n{"pid":0}')).toBeNull();
    });

    it('keeps the O_EXCL atomic create (no truncating open)', () => {
      write(state);

      const [, flags] = vi.mocked(fs.openSync).mock.calls[0];
      expect(Number(flags) & fs.constants.O_EXCL).toBe(fs.constants.O_EXCL);
      expect(Number(flags) & fs.constants.O_CREAT).toBe(fs.constants.O_CREAT);
      expect(Number(flags) & fs.constants.O_TRUNC).toBe(0);
    });

    it('keeps the #1358 identity check working on a hybrid file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(HYBRID_FIXTURE);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const reused = new PidManager(testPidPath, vi.fn().mockReturnValue('Fri Jul 31 08:00:00 2026'));
      expect(reused.isProcessRunning()).toBe(false);

      const same = new PidManager(testPidPath, vi.fn().mockReturnValue(state.startTime));
      expect(same.isProcessRunning()).toBe(true);

      killSpy.mockRestore();
    });
  });

  describe('getStartTime', () => {
    it('should delegate to the injected start-time reader', () => {
      const reader = vi.fn().mockReturnValue('Sat Jul 18 01:03:24 2026');
      const manager = new PidManager(testPidPath, reader);

      expect(manager.getStartTime(12345)).toBe('Sat Jul 18 01:03:24 2026');
      expect(reader).toHaveBeenCalledWith(12345);
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

    it('should treat EPERM as stale (Issue #1358), not throw', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('12345');

      // EPERM: the PID was reused by a process we do not own
      const error = new Error('permission denied') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => { throw error; });

      expect(pidManager.isProcessRunning()).toBe(false);

      killSpy.mockRestore();
    });

    it('should still throw for genuinely unexpected errors', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('12345');

      const error = new Error('boom') as NodeJS.ErrnoException;
      error.code = 'EIO';
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => { throw error; });

      expect(() => pidManager.isProcessRunning()).toThrow('boom');

      killSpy.mockRestore();
    });

    describe('process identity (Issue #1358)', () => {
      const state = {
        pid: 12345,
        startTime: 'Sat Jul 18 01:03:24 2026',
      };

      it('should return true when the live start time matches the recorded one', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(state));
        const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
        const reader = vi.fn().mockReturnValue(state.startTime);
        const manager = new PidManager(testPidPath, reader);

        expect(manager.isProcessRunning()).toBe(true);
        expect(reader).toHaveBeenCalledWith(12345);

        killSpy.mockRestore();
      });

      it('should return false when the PID was reused (start time differs)', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(state));
        const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
        const reader = vi.fn().mockReturnValue('Sat Jul 18 09:59:59 2026');
        const manager = new PidManager(testPidPath, reader);

        expect(manager.isProcessRunning()).toBe(false);

        killSpy.mockRestore();
      });

      it('should stay best-effort (running) when the start time cannot be read', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(state));
        const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
        const reader = vi.fn().mockReturnValue(null);
        const manager = new PidManager(testPidPath, reader);

        expect(manager.isProcessRunning()).toBe(true);

        killSpy.mockRestore();
      });

      it('should skip the identity check for a legacy file with no start time', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('12345');
        const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
        const reader = vi.fn();
        const manager = new PidManager(testPidPath, reader);

        expect(manager.isProcessRunning()).toBe(true);
        expect(reader).not.toHaveBeenCalled();

        killSpy.mockRestore();
      });
    });
  });
});

describe('createPidManager factory', () => {
  const mockConfigDir = path.join(homedir(), '.commandmate');

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createPidManager', () => {
    it('should create PidManager with main PID path when no issueNo provided', () => {
      const manager = createPidManager();

      // Verify it returns a PidManager instance
      expect(manager).toBeInstanceOf(PidManager);

      // The path should be the main PID path (backward compatibility)
      // We test this by checking the internal path via exists() call pattern
      vi.mocked(fs.existsSync).mockReturnValue(false);
      manager.exists();

      expect(fs.existsSync).toHaveBeenCalledWith(
        path.join(mockConfigDir, '.commandmate.pid')
      );
    });

    it('should create PidManager with issue-specific PID path when issueNo provided', () => {
      const manager = createPidManager(135);

      // Verify it returns a PidManager instance
      expect(manager).toBeInstanceOf(PidManager);

      vi.mocked(fs.existsSync).mockReturnValue(false);
      manager.exists();

      expect(fs.existsSync).toHaveBeenCalledWith(
        path.join(mockConfigDir, 'pids', '135.pid')
      );
    });
  });

  describe('createIssuePidManager', () => {
    it('should create PidManager for specific issue number', () => {
      const manager = createIssuePidManager(200);

      expect(manager).toBeInstanceOf(PidManager);

      vi.mocked(fs.existsSync).mockReturnValue(false);
      manager.exists();

      expect(fs.existsSync).toHaveBeenCalledWith(
        path.join(mockConfigDir, 'pids', '200.pid')
      );
    });

    it('should create managers for different issues with different paths', () => {
      const manager1 = createIssuePidManager(100);
      const manager2 = createIssuePidManager(200);

      vi.mocked(fs.existsSync).mockReturnValue(false);

      manager1.exists();
      expect(fs.existsSync).toHaveBeenLastCalledWith(
        path.join(mockConfigDir, 'pids', '100.pid')
      );

      manager2.exists();
      expect(fs.existsSync).toHaveBeenLastCalledWith(
        path.join(mockConfigDir, 'pids', '200.pid')
      );
    });
  });
});
