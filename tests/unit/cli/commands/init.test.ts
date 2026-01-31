/**
 * Init Command Tests
 * Tests for commandmate init command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as childProcess from 'child_process';

vi.mock('fs');
vi.mock('child_process');
vi.mock('../../../../src/cli/utils/security-logger');
vi.mock('crypto', async () => {
  const actual = await vi.importActual<typeof import('crypto')>('crypto');
  return {
    ...actual,
    randomBytes: vi.fn(() => Buffer.from('a'.repeat(32))),
  };
});

// Import after mocking
import { initCommand } from '../../../../src/cli/commands/init';
import { ExitCode } from '../../../../src/cli/types';

describe('initCommand', () => {
  let mockExit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Use a mock that throws to stop execution like real process.exit would
    mockExit = vi.fn().mockImplementation(() => {
      // Throw to stop execution like real process.exit would
      throw new Error('process.exit called');
    });
    vi.spyOn(process, 'exit').mockImplementation(mockExit as unknown as typeof process.exit);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('preflight checks', () => {
    it('should exit with DEPENDENCY_ERROR when required dependency missing', async () => {
      // Mock all dependencies found except tmux (using strings for encoding: 'utf-8')
      vi.mocked(childProcess.spawnSync).mockImplementation((command: string) => {
        if (command === 'tmux') {
          const error = new Error('command not found') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          return {
            status: null,
            error,
            stdout: '',
            stderr: '',
            pid: 0,
            output: [],
            signal: null,
          };
        }
        return {
          status: 0,
          stdout: 'v20.0.0',
          stderr: '',
          pid: 1234,
          output: [],
          signal: null,
        };
      });

      try {
        await initCommand({ defaults: true });
      } catch {
        // Expected - process.exit throws
      }

      expect(mockExit).toHaveBeenCalledWith(ExitCode.DEPENDENCY_ERROR);
    });

    it('should continue when all dependencies are met', async () => {
      vi.mocked(childProcess.spawnSync).mockReturnValue({
        status: 0,
        stdout: 'v20.0.0',
        stderr: '',
        pid: 1234,
        output: [],
        signal: null,
      });
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
      vi.mocked(fs.chmodSync).mockReturnValue(undefined);

      try {
        await initCommand({ defaults: true });
      } catch {
        // Expected - process.exit throws
      }

      expect(fs.writeFileSync).toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });
  });

  describe('defaults mode', () => {
    it('should use default values when --defaults is set', async () => {
      vi.mocked(childProcess.spawnSync).mockReturnValue({
        status: 0,
        stdout: 'v20.0.0',
        stderr: '',
        pid: 1234,
        output: [],
        signal: null,
      });
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
      vi.mocked(fs.chmodSync).mockReturnValue(undefined);

      try {
        await initCommand({ defaults: true });
      } catch {
        // Expected - process.exit throws
      }

      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      expect(writeCall).toBeDefined();
      const content = writeCall[1] as string;

      expect(content).toContain('CM_PORT=3000');
      expect(content).toContain('CM_BIND=127.0.0.1');
    });
  });

  describe('force mode', () => {
    it('should backup existing .env when --force is set', async () => {
      vi.mocked(childProcess.spawnSync).mockReturnValue({
        status: 0,
        stdout: 'v20.0.0',
        stderr: '',
        pid: 1234,
        output: [],
        signal: null,
      });
      // First call: check for .env in backupExisting
      // Second call: check for .env in createEnvFile
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.copyFileSync).mockReturnValue(undefined);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
      vi.mocked(fs.chmodSync).mockReturnValue(undefined);

      try {
        await initCommand({ defaults: true, force: true });
      } catch {
        // Expected - process.exit throws
      }

      expect(fs.copyFileSync).toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });
  });
});
