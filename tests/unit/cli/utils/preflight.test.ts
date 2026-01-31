/**
 * Preflight Check Tests
 * Tests for system dependency checking
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'child_process';
import { PreflightChecker } from '../../../../src/cli/utils/preflight';

vi.mock('child_process');

describe('PreflightChecker', () => {
  let checker: PreflightChecker;

  beforeEach(() => {
    checker = new PreflightChecker();
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('checkDependency', () => {
    it('should return ok status when command exists', async () => {
      // When encoding: 'utf-8' is used, stdout/stderr are strings
      vi.mocked(childProcess.spawnSync).mockReturnValue({
        status: 0,
        stdout: 'v20.0.0',
        stderr: '',
        pid: 1234,
        output: [],
        signal: null,
      });

      const result = await checker.checkDependency({
        name: 'Node.js',
        command: 'node',
        versionArg: '-v',
        required: true,
      });

      expect(result.status).toBe('ok');
      expect(result.version).toBe('20.0.0');
    });

    it('should return missing status when command not found', async () => {
      const error = new Error('command not found') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      vi.mocked(childProcess.spawnSync).mockReturnValue({
        status: null,
        error,
        stdout: '',
        stderr: '',
        pid: 0,
        output: [],
        signal: null,
      });

      const result = await checker.checkDependency({
        name: 'tmux',
        command: 'tmux',
        versionArg: '-V',
        required: true,
      });

      expect(result.status).toBe('missing');
    });

    it('should return version_mismatch when version is below minimum', async () => {
      vi.mocked(childProcess.spawnSync).mockReturnValue({
        status: 0,
        stdout: 'v18.0.0',
        stderr: '',
        pid: 1234,
        output: [],
        signal: null,
      });

      const result = await checker.checkDependency({
        name: 'Node.js',
        command: 'node',
        versionArg: '-v',
        required: true,
        minVersion: '20.0.0',
      });

      expect(result.status).toBe('version_mismatch');
      expect(result.version).toBe('18.0.0');
    });

    it('should return ok when version meets minimum', async () => {
      vi.mocked(childProcess.spawnSync).mockReturnValue({
        status: 0,
        stdout: 'v20.0.0',
        stderr: '',
        pid: 1234,
        output: [],
        signal: null,
      });

      const result = await checker.checkDependency({
        name: 'Node.js',
        command: 'node',
        versionArg: '-v',
        required: true,
        minVersion: '20.0.0',
      });

      expect(result.status).toBe('ok');
    });

    it('should extract version from various formats', async () => {
      // Test git format: "git version 2.39.0"
      vi.mocked(childProcess.spawnSync).mockReturnValue({
        status: 0,
        stdout: 'git version 2.39.0',
        stderr: '',
        pid: 1234,
        output: [],
        signal: null,
      });

      const result = await checker.checkDependency({
        name: 'git',
        command: 'git',
        versionArg: '--version',
        required: true,
      });

      expect(result.version).toBe('2.39.0');
    });
  });

  describe('checkAll', () => {
    it('should return success when all required dependencies are met', async () => {
      // Mock all dependencies as found
      vi.mocked(childProcess.spawnSync).mockReturnValue({
        status: 0,
        stdout: 'v20.0.0',
        stderr: '',
        pid: 1234,
        output: [],
        signal: null,
      });

      const result = await checker.checkAll();

      expect(result.success).toBe(true);
    });

    it('should return failure when a required dependency is missing', async () => {
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

      const result = await checker.checkAll();

      expect(result.success).toBe(false);
      const tmuxResult = result.results.find(r => r.name === 'tmux');
      expect(tmuxResult?.status).toBe('missing');
    });

    it('should succeed even if optional dependencies are missing', async () => {
      vi.mocked(childProcess.spawnSync).mockImplementation((command: string) => {
        if (command === 'claude') {
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

      const result = await checker.checkAll();

      // Should succeed because Claude CLI is optional
      expect(result.success).toBe(true);
      const claudeResult = result.results.find(r => r.name === 'Claude CLI');
      expect(claudeResult?.status).toBe('missing');
    });
  });

  describe('getInstallHint', () => {
    it('should return install hint for tmux', () => {
      const hint = PreflightChecker.getInstallHint('tmux');
      expect(hint).toContain('brew install tmux');
      expect(hint).toContain('apt install tmux');
    });

    it('should return install hint for Node.js', () => {
      const hint = PreflightChecker.getInstallHint('Node.js');
      expect(hint).toContain('nvm install');
    });

    it('should return generic message for unknown dependency', () => {
      const hint = PreflightChecker.getInstallHint('unknown-dep');
      expect(hint).toContain('Please install');
    });
  });
});
