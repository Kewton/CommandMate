/**
 * Start Command Tests
 * Tests for commandmate start command
 * Issue #125: Updated to test getEnvPath and getPidFilePath usage
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
import { startCommand } from '../../../../src/cli/commands/start';
import { ExitCode } from '../../../../src/cli/types';
import { getEnvPath, getPidFilePath } from '../../../../src/cli/utils/env-setup';
import { config as dotenvConfig } from 'dotenv';

describe('startCommand', () => {
  let mockExit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockExit = vi.fn();
    vi.spyOn(process, 'exit').mockImplementation(mockExit as unknown as typeof process.exit);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('.env check (Issue #125)', () => {
    it('should exit with CONFIG_ERROR when .env does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      await startCommand({});

      expect(mockExit).toHaveBeenCalledWith(ExitCode.CONFIG_ERROR);
    });

    it('should use getEnvPath for .env path resolution', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      await startCommand({});

      expect(getEnvPath).toHaveBeenCalled();
    });

    it('should use getPidFilePath for PID file path resolution', async () => {
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (typeof path === 'string' && path.endsWith('.env')) {
          return true;
        }
        return false;
      });
      vi.mocked(fs.openSync).mockReturnValue(3);
      vi.mocked(fs.writeSync).mockReturnValue(5);
      vi.mocked(fs.closeSync).mockReturnValue(undefined);

      const mockChild = {
        pid: 12345,
        unref: vi.fn(),
        on: vi.fn(),
      };
      vi.mocked(childProcess.spawn).mockReturnValue(mockChild as unknown as childProcess.ChildProcess);

      await startCommand({ daemon: true });

      expect(getPidFilePath).toHaveBeenCalled();
    });

    it('should load .env file using dotenv in foreground mode', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const mockChild = {
        pid: 12345,
        on: vi.fn((event: string, callback: (code: number) => void) => {
          if (event === 'close') {
            // Don't call callback to avoid process.exit
          }
          return mockChild;
        }),
      };
      vi.mocked(childProcess.spawn).mockReturnValue(mockChild as unknown as childProcess.ChildProcess);

      // Start in foreground mode (no daemon flag)
      // Note: This won't complete because we don't trigger 'close' event
      startCommand({});

      // Give it time to set up
      await new Promise(resolve => setTimeout(resolve, 10));

      // Verify dotenv.config was called with correct path
      expect(dotenvConfig).toHaveBeenCalledWith({ path: '/mock/home/.commandmate/.env' });
    });

    it('should pass .env values to child process in foreground mode', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const mockChild = {
        pid: 12345,
        on: vi.fn(() => mockChild),
      };
      vi.mocked(childProcess.spawn).mockReturnValue(mockChild as unknown as childProcess.ChildProcess);

      // Start in foreground mode
      startCommand({});

      await new Promise(resolve => setTimeout(resolve, 10));

      // Verify spawn was called with env containing .env values
      expect(childProcess.spawn).toHaveBeenCalledWith(
        'npm',
        ['run', 'start'],
        expect.objectContaining({
          env: expect.objectContaining({
            CM_ROOT_DIR: '/mock/repos',
            CM_PORT: '3000',
            CM_BIND: '127.0.0.1',
          }),
        })
      );
    });
  });

  describe('daemon mode', () => {
    it('should start in background when --daemon is set', async () => {
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (typeof path === 'string' && path.endsWith('.env')) {
          return true;
        }
        return false;
      });
      vi.mocked(fs.openSync).mockReturnValue(3);
      vi.mocked(fs.writeSync).mockReturnValue(5);
      vi.mocked(fs.closeSync).mockReturnValue(undefined);

      const mockChild = {
        pid: 12345,
        unref: vi.fn(),
        on: vi.fn(),
      };
      vi.mocked(childProcess.spawn).mockReturnValue(mockChild as unknown as childProcess.ChildProcess);

      await startCommand({ daemon: true });

      expect(childProcess.spawn).toHaveBeenCalledWith(
        'npm',
        expect.any(Array),
        expect.objectContaining({
          detached: true,
          stdio: 'ignore',
        })
      );
      expect(mockChild.unref).toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });

    it('should fail when already running', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('99999');

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      await startCommand({ daemon: true });

      expect(mockExit).toHaveBeenCalledWith(ExitCode.START_FAILED);

      killSpy.mockRestore();
    });

    it('should use dev mode when --dev is set', async () => {
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (typeof path === 'string' && path.endsWith('.env')) {
          return true;
        }
        return false;
      });
      vi.mocked(fs.openSync).mockReturnValue(3);
      vi.mocked(fs.writeSync).mockReturnValue(5);
      vi.mocked(fs.closeSync).mockReturnValue(undefined);

      const mockChild = {
        pid: 12345,
        unref: vi.fn(),
        on: vi.fn(),
      };
      vi.mocked(childProcess.spawn).mockReturnValue(mockChild as unknown as childProcess.ChildProcess);

      await startCommand({ daemon: true, dev: true });

      expect(childProcess.spawn).toHaveBeenCalledWith(
        'npm',
        ['run', 'dev'],
        expect.any(Object)
      );
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });

    it('should use custom port when --port is set', async () => {
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (typeof path === 'string' && path.endsWith('.env')) {
          return true;
        }
        return false;
      });
      vi.mocked(fs.openSync).mockReturnValue(3);
      vi.mocked(fs.writeSync).mockReturnValue(5);
      vi.mocked(fs.closeSync).mockReturnValue(undefined);

      const mockChild = {
        pid: 12345,
        unref: vi.fn(),
        on: vi.fn(),
      };
      vi.mocked(childProcess.spawn).mockReturnValue(mockChild as unknown as childProcess.ChildProcess);

      await startCommand({ daemon: true, port: 4000 });

      expect(childProcess.spawn).toHaveBeenCalledWith(
        'npm',
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({
            CM_PORT: '4000',
          }),
        })
      );
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });
  });

  // Note: Foreground mode tests are skipped because they rely on child process
  // event handlers that trigger process.exit, which causes Vitest worker to exit.
  // These are tested via integration/e2e tests instead.
  describe.skip('foreground mode', () => {
    it('should start in foreground by default', () => {
      // Covered by integration tests
    });
  });

  describe('error handling', () => {
    it('should exit with UNEXPECTED_ERROR on unexpected exception', async () => {
      vi.mocked(fs.existsSync).mockImplementation(() => {
        throw new Error('Unexpected filesystem error');
      });

      await startCommand({});

      expect(mockExit).toHaveBeenCalledWith(ExitCode.UNEXPECTED_ERROR);
    });

    it('should log error message on failure', async () => {
      const consoleSpy = vi.spyOn(console, 'error');
      vi.mocked(fs.existsSync).mockImplementation(() => {
        throw new Error('Test error message');
      });

      await startCommand({});

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Test error message'));
    });

    it('should exit with START_FAILED when daemon start fails', async () => {
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (typeof path === 'string' && path.endsWith('.env')) {
          return true;
        }
        return false;
      });
      vi.mocked(fs.openSync).mockImplementation(() => {
        throw new Error('Failed to write PID file');
      });

      const mockChild = {
        pid: 12345,
        unref: vi.fn(),
        on: vi.fn(),
      };
      vi.mocked(childProcess.spawn).mockReturnValue(mockChild as unknown as childProcess.ChildProcess);

      await startCommand({ daemon: true });

      expect(mockExit).toHaveBeenCalledWith(ExitCode.START_FAILED);
    });
  });
});
