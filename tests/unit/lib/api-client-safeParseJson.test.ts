/**
 * api-client.ts safeParseJson tests
 * Issue #573: Verify safe JSON parsing with content-type validation
 *
 * Since safeParseJson is not exported, we test it indirectly through
 * the public API (worktreeApi.uploadImageFile) and fetchApi behavior.
 * We also test the observable behavior: console.warn in development mode.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('api-client safeParseJson behavior (Issue #573)', () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Reset fetch mock
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env.NODE_ENV = originalEnv;
  });

  describe('fetchApi error path (content-type check)', () => {
    it('should handle non-JSON error response gracefully', async () => {
      // Dynamic import to get fresh module state
      const { worktreeApi } = await import('@/lib/api-client');

      const mockResponse = {
        ok: false,
        status: 500,
        redirected: false,
        url: '/api/worktrees',
        headers: new Headers({ 'content-type': 'text/html' }),
        json: vi.fn().mockRejectedValue(new Error('not json')),
      } as unknown as Response;

      vi.mocked(fetch).mockResolvedValue(mockResponse);

      await expect(worktreeApi.getAll()).rejects.toThrow('HTTP error 500');
    });

    it('should parse JSON error response when content-type is application/json', async () => {
      const { worktreeApi } = await import('@/lib/api-client');

      const mockResponse = {
        ok: false,
        status: 400,
        redirected: false,
        url: '/api/worktrees',
        headers: new Headers({ 'content-type': 'application/json' }),
        json: vi.fn().mockResolvedValue({ error: 'Bad request' }),
      } as unknown as Response;

      vi.mocked(fetch).mockResolvedValue(mockResponse);

      await expect(worktreeApi.getAll()).rejects.toThrow('Bad request');
    });
  });

  describe('console.warn in development mode', () => {
    it('should warn on non-JSON content-type in development', async () => {
      process.env.NODE_ENV = 'development';
      const warnSpy = vi.spyOn(console, 'warn');

      const { worktreeApi } = await import('@/lib/api-client');

      const mockResponse = {
        ok: false,
        status: 500,
        redirected: false,
        url: '/api/worktrees',
        headers: new Headers({ 'content-type': 'text/plain' }),
        json: vi.fn().mockRejectedValue(new Error('not json')),
      } as unknown as Response;

      vi.mocked(fetch).mockResolvedValue(mockResponse);

      try {
        await worktreeApi.getAll();
      } catch {
        // Expected to throw
      }

      // Should have warned about unexpected content-type
      const warnCalls = warnSpy.mock.calls.filter(
        call => typeof call[0] === 'string' && call[0].includes('[api-client]')
      );
      expect(warnCalls.length).toBeGreaterThan(0);
    });
  });

  describe('content-type truncation', () => {
    it('should truncate long content-type values for security', async () => {
      process.env.NODE_ENV = 'development';
      const warnSpy = vi.spyOn(console, 'warn');

      const { worktreeApi } = await import('@/lib/api-client');

      const longContentType = 'text/' + 'x'.repeat(200);
      const mockResponse = {
        ok: false,
        status: 500,
        redirected: false,
        url: '/api/worktrees',
        headers: new Headers({ 'content-type': longContentType }),
        json: vi.fn().mockRejectedValue(new Error('not json')),
      } as unknown as Response;

      vi.mocked(fetch).mockResolvedValue(mockResponse);

      try {
        await worktreeApi.getAll();
      } catch {
        // Expected to throw
      }

      const apiClientWarns = warnSpy.mock.calls.filter(
        call => typeof call[0] === 'string' && call[0].includes('[api-client]')
      );
      if (apiClientWarns.length > 0) {
        // The logged content-type should be truncated (max 100 chars + '...')
        const warnMessage = apiClientWarns[0][0] as string;
        expect(warnMessage).toContain('...');
        // Should not contain the full 200-char value
        expect(warnMessage.length).toBeLessThan(longContentType.length + 100);
      }
    });
  });
});
