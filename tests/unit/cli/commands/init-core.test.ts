/**
 * runInit Core Tests
 * Issue #1195: init core extracted from initCommand so the quickstart flow can
 * chain init -> start without the process dying on init success.
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
import { runInit } from '../../../../src/cli/commands/init';
import { ExitCode } from '../../../../src/cli/types';

function mockAllDependenciesFound(): void {
  vi.mocked(childProcess.spawnSync).mockReturnValue({
    status: 0,
    stdout: 'v22.0.0',
    stderr: '',
    pid: 1234,
    output: [],
    signal: null,
  });
}

function mockMissingDependency(missing: string): void {
  vi.mocked(childProcess.spawnSync).mockImplementation((command: string) => {
    if (command === missing) {
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
      stdout: 'v22.0.0',
      stderr: '',
      pid: 1234,
      output: [],
      signal: null,
    };
  });
}

describe('runInit', () => {
  let mockExit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockExit = vi.fn().mockImplementation(() => {
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

  it('should return DEPENDENCY_ERROR without exiting when preflight fails', async () => {
    mockMissingDependency('tmux');

    const result = await runInit({ defaults: true });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(ExitCode.DEPENDENCY_ERROR);
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('should not create the .env file when preflight fails', async () => {
    mockMissingDependency('tmux');

    await runInit({ defaults: true });

    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('should return SUCCESS with config and envPath without exiting', async () => {
    mockAllDependenciesFound();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.chmodSync).mockReturnValue(undefined);

    const result = await runInit({ defaults: true });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.config).toMatchObject({
      CM_PORT: 3000,
      CM_BIND: '127.0.0.1',
    });
    expect(result.envPath).toBeDefined();
    expect(result.envPath).toContain('.env');
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('should write the .env file to the returned envPath', async () => {
    mockAllDependenciesFound();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.chmodSync).mockReturnValue(undefined);

    const result = await runInit({ defaults: true });

    const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(writeCall).toBeDefined();
    expect(writeCall[0]).toBe(result.envPath);
  });

  it('should return UNEXPECTED_ERROR without exiting when an unexpected error occurs', async () => {
    mockAllDependenciesFound();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {
      throw new Error('disk full');
    });

    const result = await runInit({ defaults: true });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(ExitCode.UNEXPECTED_ERROR);
    expect(mockExit).not.toHaveBeenCalled();
  });
});
