/**
 * Command Helpers Tests
 * Issue #518: Tests for shared TOKEN_WARNING and handleCommandError
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { TOKEN_WARNING, handleCommandError } from '../../../../src/cli/utils/command-helpers';
import { ApiError } from '../../../../src/cli/utils/api-client';
import { ExitCode } from '../../../../src/cli/types';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  mockExit.mockClear();
  mockConsoleError.mockClear();
});

describe('TOKEN_WARNING', () => {
  it('contains WARNING text about process list visibility', () => {
    expect(TOKEN_WARNING).toContain('WARNING');
    expect(TOKEN_WARNING).toContain('process list');
    expect(TOKEN_WARNING).toContain('CM_AUTH_TOKEN');
  });
});

describe('handleCommandError', () => {
  it('exits with ApiError exitCode for ApiError instances', () => {
    const error = new ApiError('Auth failed', ExitCode.CONFIG_ERROR, 401);
    handleCommandError(error);
    expect(mockConsoleError).toHaveBeenCalledWith('Error: Auth failed');
    expect(mockExit).toHaveBeenCalledWith(ExitCode.CONFIG_ERROR);
  });

  it('exits with UNEXPECTED_ERROR for regular Error instances', () => {
    const error = new Error('something went wrong');
    handleCommandError(error);
    expect(mockConsoleError).toHaveBeenCalledWith('Error: something went wrong');
    expect(mockExit).toHaveBeenCalledWith(ExitCode.UNEXPECTED_ERROR);
  });

  it('exits with UNEXPECTED_ERROR for non-Error values', () => {
    handleCommandError('string error');
    expect(mockConsoleError).toHaveBeenCalledWith('Error: string error');
    expect(mockExit).toHaveBeenCalledWith(ExitCode.UNEXPECTED_ERROR);
  });

  it('exits with UNEXPECTED_ERROR for null', () => {
    handleCommandError(null);
    expect(mockConsoleError).toHaveBeenCalledWith('Error: null');
    expect(mockExit).toHaveBeenCalledWith(ExitCode.UNEXPECTED_ERROR);
  });
});
