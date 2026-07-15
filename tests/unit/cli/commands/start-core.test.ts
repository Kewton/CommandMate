/**
 * runStart Core Tests
 * Issue #1195: start core extracted from startCommand so the quickstart flow can
 * start the daemon and keep running (URL display / browser open) afterwards.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as childProcess from 'child_process';

vi.mock('fs');
vi.mock('child_process');
vi.mock('dotenv', () => ({
  config: vi.fn(() => ({
    parsed: {
      CM_ROOT_DIR: '/mock/repos',
      CM_PORT: '3000',
      CM_BIND: '127.0.0.1',
    },
  })),
}));
vi.mock('../../../../src/cli/utils/security-logger');
vi.mock('../../../../src/cli/utils/env-setup', () => ({
  getEnvPath: vi.fn(() => '/mock/home/.commandmate/.env'),
  getPidFilePath: vi.fn(() => '/mock/home/.commandmate/.commandmate.pid'),
}));

// Import after mocking
import { runStart, startCommand } from '../../../../src/cli/commands/start';
import { ExitCode } from '../../../../src/cli/types';
import { REVERSE_PROXY_WARNING } from '../../../../src/cli/config/security-messages';
import { config as dotenvConfig } from 'dotenv';

/** .env exists, PID file does not */
function mockEnvPresentAndNotRunning(): void {
  vi.mocked(fs.existsSync).mockImplementation((path) => {
    if (typeof path === 'string' && path.endsWith('.env')) {
      return true;
    }
    return false;
  });
  vi.mocked(fs.openSync).mockReturnValue(3);
  vi.mocked(fs.writeSync).mockReturnValue(5);
  vi.mocked(fs.closeSync).mockReturnValue(undefined);
}

function mockSpawnedChild(): { pid: number; unref: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> } {
  const mockChild = {
    pid: 12345,
    unref: vi.fn(),
    on: vi.fn(),
  };
  vi.mocked(childProcess.spawn).mockReturnValue(mockChild as unknown as childProcess.ChildProcess);
  return mockChild;
}

describe('runStart', () => {
  let mockExit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockExit = vi.fn().mockImplementation(() => {
      throw new Error('process.exit called');
    });
    vi.spyOn(process, 'exit').mockImplementation(mockExit as unknown as typeof process.exit);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.clearAllMocks();
    vi.stubEnv('CM_PORT', '3000');
    vi.stubEnv('CM_BIND', '127.0.0.1');
    vi.stubEnv('CM_AUTH_TOKEN_HASH', '');
    vi.stubEnv('CM_ALLOWED_IPS', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('daemon mode', () => {
    it('should return SUCCESS with url and pid without exiting', async () => {
      mockEnvPresentAndNotRunning();
      mockSpawnedChild();

      const result = await runStart({ daemon: true });

      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(ExitCode.SUCCESS);
      expect(result.pid).toBe(12345);
      expect(result.url).toBe('http://127.0.0.1:3000');
      expect(mockExit).not.toHaveBeenCalled();
    });

    // Reproduces a real defect: with CM_PORT exported in the shell, dotenv leaves process.env
    // untouched while daemon.ts hands the child {...process.env, ...parsed}, so the reported URL
    // pointed at the shell's port while the server listened on the .env port.
    it('should resolve the url from .env, not a conflicting exported CM_PORT', async () => {
      mockEnvPresentAndNotRunning();
      mockSpawnedChild();
      vi.stubEnv('CM_PORT', '3000');
      vi.mocked(dotenvConfig).mockReturnValue({
        parsed: { CM_PORT: '31951', CM_BIND: '127.0.0.1' },
      } as ReturnType<typeof dotenvConfig>);

      const result = await runStart({ daemon: true });

      expect(result.url).toBe('http://127.0.0.1:31951');
    });

    it('should let an explicit --port override .env', async () => {
      mockEnvPresentAndNotRunning();
      mockSpawnedChild();
      vi.mocked(dotenvConfig).mockReturnValue({
        parsed: { CM_PORT: '31951', CM_BIND: '127.0.0.1' },
      } as ReturnType<typeof dotenvConfig>);

      const result = await runStart({ daemon: true, port: 4000 });

      expect(result.url).toBe('http://127.0.0.1:4000');
    });

    it('should start the server through DaemonManager (detached, stdio ignored)', async () => {
      mockEnvPresentAndNotRunning();
      const mockChild = mockSpawnedChild();

      await runStart({ daemon: true });

      expect(childProcess.spawn).toHaveBeenCalledWith(
        'npm',
        expect.any(Array),
        expect.objectContaining({
          detached: true,
          stdio: 'ignore',
        })
      );
      expect(mockChild.unref).toHaveBeenCalled();
    });

    it('should keep the reverse proxy warning when binding externally', async () => {
      mockEnvPresentAndNotRunning();
      mockSpawnedChild();
      vi.mocked(dotenvConfig).mockReturnValue({ parsed: { CM_BIND: '0.0.0.0' } });

      await runStart({ daemon: true });

      expect(console.log).toHaveBeenCalledWith(REVERSE_PROXY_WARNING);
    });

    it('should return START_FAILED without exiting when already running', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('99999');
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const result = await runStart({ daemon: true });

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(ExitCode.START_FAILED);
      expect(mockExit).not.toHaveBeenCalled();

      killSpy.mockRestore();
    });

    it('should return START_FAILED without exiting when the daemon fails to start', async () => {
      mockEnvPresentAndNotRunning();
      vi.mocked(fs.openSync).mockImplementation(() => {
        throw new Error('Failed to write PID file');
      });
      mockSpawnedChild();

      const result = await runStart({ daemon: true });

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(ExitCode.START_FAILED);
      expect(mockExit).not.toHaveBeenCalled();
    });
  });

  describe('foreground mode', () => {
    /** Foreground exits from the child 'close' handler; exiting right after spawn would detach the user's terminal */
    it('should flag the handoff and keep startCommand from exiting after spawn', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const mockChild: { pid: number; on: ReturnType<typeof vi.fn> } = {
        pid: 12345,
        on: vi.fn(() => mockChild),
      };
      vi.mocked(childProcess.spawn).mockReturnValue(mockChild as unknown as childProcess.ChildProcess);

      const result = await runStart({});

      expect(result.foreground).toBe(true);
      expect(childProcess.spawn).toHaveBeenCalledWith('npm', ['run', 'start'], expect.any(Object));

      await startCommand({});

      expect(mockExit).not.toHaveBeenCalled();
    });
  });

  describe('configuration errors', () => {
    it('should return CONFIG_ERROR without exiting when .env is missing', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await runStart({ daemon: true });

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(ExitCode.CONFIG_ERROR);
      expect(mockExit).not.toHaveBeenCalled();
      expect(childProcess.spawn).not.toHaveBeenCalled();
    });

    it('should return START_FAILED without exiting for an invalid issue number', async () => {
      mockEnvPresentAndNotRunning();

      const result = await runStart({ daemon: true, issue: -1 });

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(ExitCode.START_FAILED);
      expect(mockExit).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should return UNEXPECTED_ERROR without exiting on an unexpected exception', async () => {
      vi.mocked(fs.existsSync).mockImplementation(() => {
        throw new Error('Unexpected filesystem error');
      });

      const result = await runStart({ daemon: true });

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(ExitCode.UNEXPECTED_ERROR);
      expect(mockExit).not.toHaveBeenCalled();
    });
  });
});
