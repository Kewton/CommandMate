/**
 * Status Command Tests
 * Tests for commandmate status command
 * Issue #125: Updated to test getPidFilePath and dotenv usage
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

vi.mock('fs');
vi.mock('dotenv');
vi.mock('../../../../src/cli/utils/env-setup', () => ({
  getPidFilePath: vi.fn(() => '/mock/home/.commandmate/.commandmate.pid'),
  getEnvPath: vi.fn(() => '/mock/home/.commandmate/.env'),
}));

// Import after mocking
import { statusCommand } from '../../../../src/cli/commands/status';
import { ExitCode } from '../../../../src/cli/types';
import { getPidFilePath, getEnvPath } from '../../../../src/cli/utils/env-setup';

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
    vi.unstubAllEnvs();
  });

  describe('path resolution (Issue #125)', () => {
    it('should use getPidFilePath for PID file path resolution', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(dotenv.config).mockReturnValue({ parsed: {} });

      await statusCommand();

      expect(getPidFilePath).toHaveBeenCalled();
    });

    it('should load .env using dotenv for correct settings display', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('12345');
      vi.mocked(dotenv.config).mockReturnValue({
        parsed: { CM_PORT: '4000', CM_BIND: '127.0.0.1' },
      });
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      await statusCommand();

      expect(dotenv.config).toHaveBeenCalledWith({ path: '/mock/home/.commandmate/.env' });
      expect(getEnvPath).toHaveBeenCalled();

      killSpy.mockRestore();
    });

    // Issue #1266: with no PID file there is no server to describe, so .env is never read
    it('should not read .env when there is no PID file', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      await statusCommand();

      expect(dotenv.config).not.toHaveBeenCalled();
    });
  });

  describe('when running', () => {
    it('should display running status with details', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('12345');
      vi.mocked(dotenv.config).mockReturnValue({ parsed: {} });
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      await statusCommand();

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Running'));
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);

      killSpy.mockRestore();
    });

    // Issue #1266: the exported CM_PORT deliberately disagrees with .env here. Setting both
    // to the same value would pass whether or not .env is honoured.
    it('should display the .env port, not the exported CM_PORT', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('12345');
      vi.mocked(dotenv.config).mockReturnValue({
        parsed: { CM_PORT: '4000' },
      });
      vi.stubEnv('CM_PORT', '3000');

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      await statusCommand();

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Port:    4000'));
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);

      killSpy.mockRestore();
    });

    it('should display the URL of the port the server is actually on', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('12345');
      vi.mocked(dotenv.config).mockReturnValue({
        parsed: { CM_PORT: '3101', CM_BIND: '127.0.0.1' },
      });
      vi.stubEnv('CM_PORT', '3000');

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      await statusCommand();

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('http://127.0.0.1:3101'));
      expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('http://127.0.0.1:3000'));
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);

      killSpy.mockRestore();
    });

    /**
     * Issue #1266: reading process.env was only wrong when the two disagreed. dotenv does
     * inject a .env value the shell never exported, so a .env-only ACL displayed correctly
     * before this change; an exported one shadowed the ACL the server actually enforces.
     */
    it('should display the .env IP ACL, not the exported CM_ALLOWED_IPS', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('12345');
      vi.mocked(dotenv.config).mockReturnValue({
        parsed: { CM_ALLOWED_IPS: '192.168.1.0/24' },
      });
      vi.stubEnv('CM_ALLOWED_IPS', '10.0.0.0/8');

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      await statusCommand();

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('IP ACL:  192.168.1.0/24'));
      expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('10.0.0.0/8'));

      killSpy.mockRestore();
    });
  });

  describe('when not running', () => {
    it('should display stopped status when no PID file', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(dotenv.config).mockReturnValue({ parsed: {} });

      await statusCommand();

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Stopped'));
      expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    });

    it('should display not running when stale PID', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('12345');
      vi.mocked(dotenv.config).mockReturnValue({ parsed: {} });

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
