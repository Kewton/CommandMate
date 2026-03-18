/**
 * ApiClient Tests
 * Issue #518: [DR1-01] Individual tests for resolveAuthToken, handleApiError, get/post
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveAuthToken,
  handleApiError,
  isValidWorktreeId,
  ApiClient,
  ApiError,
  MAX_STOP_PATTERN_LENGTH,
} from '../../../../src/cli/utils/api-client';
import { ExitCode } from '../../../../src/cli/types';
import { mockFetchResponse, mockFetchError, restoreFetch } from '../../../helpers/mock-api';

describe('resolveAuthToken', () => {
  const originalEnv = process.env.CM_AUTH_TOKEN;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CM_AUTH_TOKEN;
    } else {
      process.env.CM_AUTH_TOKEN = originalEnv;
    }
  });

  it('returns --token option value when provided', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = resolveAuthToken({ token: 'my-token' });
    expect(result).toBe('my-token');
    // [SEC4-01] Should warn about token exposure
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('--token flag exposes token')
    );
    consoleSpy.mockRestore();
  });

  it('returns CM_AUTH_TOKEN env var when no --token', () => {
    process.env.CM_AUTH_TOKEN = 'env-token';
    const result = resolveAuthToken({});
    expect(result).toBe('env-token');
  });

  it('returns undefined when no token available', () => {
    delete process.env.CM_AUTH_TOKEN;
    const result = resolveAuthToken({});
    expect(result).toBeUndefined();
  });

  it('prefers --token over CM_AUTH_TOKEN', () => {
    process.env.CM_AUTH_TOKEN = 'env-token';
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = resolveAuthToken({ token: 'cli-token' });
    expect(result).toBe('cli-token');
    consoleSpy.mockRestore();
  });
});

describe('handleApiError', () => {
  it('maps ECONNREFUSED to DEPENDENCY_ERROR', () => {
    const result = handleApiError(new Error('connect ECONNREFUSED 127.0.0.1:3000'));
    expect(result.exitCode).toBe(ExitCode.DEPENDENCY_ERROR);
    expect(result.message).toContain('commandmate start');
  });

  it('maps 400 to CONFIG_ERROR', () => {
    const result = handleApiError(null, 400);
    expect(result.exitCode).toBe(ExitCode.CONFIG_ERROR);
  });

  it('maps 401 to CONFIG_ERROR', () => {
    const result = handleApiError(null, 401);
    expect(result.exitCode).toBe(ExitCode.CONFIG_ERROR);
    expect(result.message).toContain('Authentication failed');
  });

  it('maps 403 to CONFIG_ERROR', () => {
    const result = handleApiError(null, 403);
    expect(result.exitCode).toBe(ExitCode.CONFIG_ERROR);
  });

  it('maps 404 to UNEXPECTED_ERROR', () => {
    const result = handleApiError(null, 404);
    expect(result.exitCode).toBe(ExitCode.UNEXPECTED_ERROR);
    expect(result.message).toContain('not found');
  });

  it('maps 429 to DEPENDENCY_ERROR with retry message', () => {
    const result = handleApiError(null, 429);
    expect(result.exitCode).toBe(ExitCode.DEPENDENCY_ERROR);
    expect(result.message).toContain('Rate limited');
  });

  it('maps 500 to UNEXPECTED_ERROR', () => {
    const result = handleApiError(null, 500);
    expect(result.exitCode).toBe(ExitCode.UNEXPECTED_ERROR);
    expect(result.message).toContain('Server error');
  });

  it('maps AbortError to DEPENDENCY_ERROR', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    const result = handleApiError(err);
    expect(result.exitCode).toBe(ExitCode.DEPENDENCY_ERROR);
    expect(result.message).toContain('did not respond in time');
  });

  it('maps TypeError to DEPENDENCY_ERROR', () => {
    const err = new TypeError('fetch failed');
    const result = handleApiError(err);
    expect(result.exitCode).toBe(ExitCode.DEPENDENCY_ERROR);
  });

  it('maps unknown error to UNEXPECTED_ERROR', () => {
    const result = handleApiError('some string error');
    expect(result.exitCode).toBe(ExitCode.UNEXPECTED_ERROR);
  });
});

describe('isValidWorktreeId', () => {
  it('accepts valid IDs', () => {
    expect(isValidWorktreeId('abc123')).toBe(true);
    expect(isValidWorktreeId('my-worktree')).toBe(true);
    expect(isValidWorktreeId('feature_123')).toBe(true);
  });

  it('rejects invalid IDs', () => {
    expect(isValidWorktreeId('')).toBe(false);
    expect(isValidWorktreeId('../etc/passwd')).toBe(false);
    expect(isValidWorktreeId('-starts-with-dash')).toBe(false);
  });
});

describe('MAX_STOP_PATTERN_LENGTH', () => {
  it('is 500', () => {
    expect(MAX_STOP_PATTERN_LENGTH).toBe(500);
  });
});

describe('ApiClient', () => {
  afterEach(() => {
    restoreFetch();
    delete process.env.CM_AUTH_TOKEN;
    delete process.env.CM_PORT;
  });

  it('uses default base URL with CM_PORT', () => {
    process.env.CM_PORT = '4000';
    mockFetchResponse({ data: 'test' });
    const client = new ApiClient();
    client.get('/api/test');
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:4000/api/test',
      expect.any(Object)
    );
  });

  it('uses default port 3000 when CM_PORT not set', () => {
    delete process.env.CM_PORT;
    mockFetchResponse({ data: 'test' });
    const client = new ApiClient();
    client.get('/api/test');
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/test',
      expect.any(Object)
    );
  });

  it('includes Bearer token in headers', async () => {
    process.env.CM_AUTH_TOKEN = 'test-token';
    mockFetchResponse({ ok: true });
    const client = new ApiClient();
    await client.get('/api/test');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      })
    );
  });

  it('get returns parsed JSON on success', async () => {
    const data = { worktrees: [{ id: 'abc', name: 'main' }] };
    mockFetchResponse(data);
    const client = new ApiClient();
    const result = await client.get<typeof data>('/api/worktrees');
    expect(result).toEqual(data);
  });

  it('get throws ApiError on HTTP error', async () => {
    mockFetchResponse({ error: 'Not Found' }, 404);
    const client = new ApiClient();
    await expect(client.get('/api/worktrees/xyz')).rejects.toThrow(ApiError);
  });

  it('get throws ApiError on network error', async () => {
    mockFetchError('connect ECONNREFUSED 127.0.0.1:3000');
    const client = new ApiClient();
    await expect(client.get('/api/test')).rejects.toThrow(ApiError);
  });

  it('post sends JSON body', async () => {
    mockFetchResponse({ success: true }, 201);
    const client = new ApiClient();
    const body = { content: 'hello', cliToolId: 'claude' };
    await client.post('/api/worktrees/abc/send', body);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(body),
      })
    );
  });

  it('post throws ApiError on HTTP error', async () => {
    mockFetchResponse({ error: 'Unauthorized' }, 401);
    const client = new ApiClient();
    await expect(client.post('/api/test', {})).rejects.toThrow(ApiError);
  });

  it('[SEC4-02] warns about HTTP to non-localhost', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.CM_AUTH_TOKEN = 'test-token';
    new ApiClient({ baseUrl: 'http://192.168.1.100:3000' });
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Auth token will be sent in plaintext')
    );
    consoleSpy.mockRestore();
  });

  it('[SEC4-02] does not warn for localhost', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.CM_AUTH_TOKEN = 'test-token';
    new ApiClient({ baseUrl: 'http://localhost:3000' });
    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('plaintext')
    );
    consoleSpy.mockRestore();
  });

  it('[SEC4-02] does not warn for HTTPS', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.CM_AUTH_TOKEN = 'test-token';
    new ApiClient({ baseUrl: 'https://remote.example.com:3000' });
    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('plaintext')
    );
    consoleSpy.mockRestore();
  });
});
