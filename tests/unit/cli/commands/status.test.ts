/**
 * Status Command Tests
 * Tests for commandmate status command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';

vi.mock('fs');

// Import after mocking
import { statusCommand } from '../../../../src/cli/commands/status';
import { ExitCode } from '../../../../src/cli/types';

describe('statusCommand', () => {
  let mockExit: ReturnType<typeof vi.fn>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockExit = vi.fn();
    vi.spyOn(process, 'exit').mockImplementation(mockExit as unknown as typeof process.exit);
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('when running', () => {
    it('should display running status with details', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('12345');
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      await statusCommand();

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Running'));
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);

      killSpy.mockRestore();
    });
  });

  describe('when not running', () => {
    it('should display stopped status when no PID file', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      await statusCommand();

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Stopped'));
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });

    it('should display not running when stale PID', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('12345');

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        const error = new Error('No such process') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      });

      await statusCommand();

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Not running'));
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);

      killSpy.mockRestore();
    });
  });
});
