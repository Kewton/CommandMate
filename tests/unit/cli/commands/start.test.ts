/**
 * Start Command Tests
 * Tests for commandmate start command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as childProcess from 'child_process';

vi.mock('fs');
vi.mock('child_process');
vi.mock('../../../../src/cli/utils/security-logger');

// Import after mocking
import { startCommand } from '../../../../src/cli/commands/start';
import { ExitCode } from '../../../../src/cli/types';

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

  describe('.env check', () => {
    it('should exit with CONFIG_ERROR when .env does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      await startCommand({});

      expect(mockExit).toHaveBeenCalledWith(ExitCode.CONFIG_ERROR);
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
});
