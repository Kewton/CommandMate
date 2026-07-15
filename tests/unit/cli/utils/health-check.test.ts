/**
 * Health Check Tests
 * Issue #1194: update-specific readiness probe (D-5 / D-12 / S3-001)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitForReady } from '../../../../src/cli/utils/health-check';

/** Fast polling so tests do not wait on real timers */
const FAST = { intervalMs: 1, timeoutMs: 20 };

/**
 * Build a minimal Response-like object.
 */
function makeResponse(options: {
  status: number;
  contentType?: string | null;
  body?: unknown;
  jsonThrows?: boolean;
}): Response {
  return {
    status: options.status,
    headers: {
      get: (name: string): string | null =>
        name.toLowerCase() === 'content-type' ? options.contentType ?? null : null,
    },
    json: async (): Promise<unknown> => {
      if (options.jsonThrows) {
        throw new SyntaxError('Unexpected token < in JSON');
      }
      return options.body;
    },
  } as unknown as Response;
}

const readyResponse = (): Response =>
  makeResponse({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: { success: true, data: [] },
  });

describe('waitForReady', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('request shape', () => {
    it('should poll <baseUrl>/api/repositories', async () => {
      mockFetch.mockResolvedValue(readyResponse());

      await waitForReady('https://127.0.0.1:3443', FAST);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://127.0.0.1:3443/api/repositories',
        expect.anything()
      );
    });

    it('should use redirect: manual (S3-001 - never follow)', async () => {
      mockFetch.mockResolvedValue(readyResponse());

      await waitForReady('http://127.0.0.1:3000', FAST);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ redirect: 'manual' })
      );
      const init = mockFetch.mock.calls[0][1] as RequestInit;
      expect(init.redirect).not.toBe('follow');
    });

    it('should send Authorization: Bearer when a token is provided', async () => {
      mockFetch.mockResolvedValue(readyResponse());

      await waitForReady('http://127.0.0.1:3000', { ...FAST, token: 'secret-token' });

      const init = mockFetch.mock.calls[0][1] as RequestInit;
      expect(init.headers).toMatchObject({ Authorization: 'Bearer secret-token' });
    });

    it('should not send Authorization when no token is provided', async () => {
      mockFetch.mockResolvedValue(readyResponse());

      await waitForReady('http://127.0.0.1:3000', FAST);

      const init = mockFetch.mock.calls[0][1] as RequestInit;
      expect(init.headers).not.toHaveProperty('Authorization');
    });

    it('should not duplicate slashes when baseUrl has a trailing slash', async () => {
      mockFetch.mockResolvedValue(readyResponse());

      await waitForReady('http://127.0.0.1:3000/', FAST);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:3000/api/repositories',
        expect.anything()
      );
    });
  });

  describe('ready', () => {
    it('should return ready for 200 + JSON + success:true', async () => {
      mockFetch.mockResolvedValue(readyResponse());

      await expect(waitForReady('http://127.0.0.1:3000', FAST)).resolves.toBe('ready');
    });

    it('should return ready once the server becomes reachable', async () => {
      const refused = Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' });
      mockFetch
        .mockRejectedValueOnce(refused)
        .mockRejectedValueOnce(refused)
        .mockResolvedValue(readyResponse());

      await expect(
        waitForReady('http://127.0.0.1:3000', { intervalMs: 1, timeoutMs: 5000 })
      ).resolves.toBe('ready');
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe('degraded (D-12)', () => {
    it('should return degraded for a 307 redirect to /login (S3-001)', async () => {
      mockFetch.mockResolvedValue(makeResponse({ status: 307, contentType: null }));

      await expect(waitForReady('http://127.0.0.1:3000', FAST)).resolves.toBe('degraded');
    });

    it('should return degraded for 302', async () => {
      mockFetch.mockResolvedValue(makeResponse({ status: 302, contentType: null }));

      await expect(waitForReady('http://127.0.0.1:3000', FAST)).resolves.toBe('degraded');
    });

    it('should return degraded for 401', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({ status: 401, contentType: 'application/json', body: { error: 'x' } })
      );

      await expect(waitForReady('http://127.0.0.1:3000', FAST)).resolves.toBe('degraded');
    });

    it('should return degraded for 403', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({ status: 403, contentType: 'application/json', body: { error: 'x' } })
      );

      await expect(waitForReady('http://127.0.0.1:3000', FAST)).resolves.toBe('degraded');
    });

    it('should return degraded on TLS certificate errors', async () => {
      const tlsError = Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('self signed certificate'), {
          code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
        }),
      });
      mockFetch.mockRejectedValue(tlsError);

      await expect(waitForReady('https://127.0.0.1:3443', FAST)).resolves.toBe('degraded');
    });

    it('should return degraded for an expired certificate', async () => {
      const tlsError = Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }),
      });
      mockFetch.mockRejectedValue(tlsError);

      await expect(waitForReady('https://127.0.0.1:3443', FAST)).resolves.toBe('degraded');
    });

    it('should return degraded immediately without extra polling', async () => {
      mockFetch.mockResolvedValue(makeResponse({ status: 307, contentType: null }));

      await waitForReady('http://127.0.0.1:3000', { intervalMs: 1, timeoutMs: 5000 });

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('keeps polling (not ready, not degraded)', () => {
    it('should not treat 200 HTML as ready', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({ status: 200, contentType: 'text/html; charset=utf-8', jsonThrows: true })
      );

      await expect(waitForReady('http://127.0.0.1:3000', FAST)).resolves.toBe('timeout');
    });

    it('should not treat 200 JSON with success:false as ready', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({ status: 200, contentType: 'application/json', body: { success: false } })
      );

      await expect(waitForReady('http://127.0.0.1:3000', FAST)).resolves.toBe('timeout');
    });

    it('should keep polling on 500 until timeout', async () => {
      mockFetch.mockResolvedValue(
        makeResponse({ status: 500, contentType: 'application/json', body: { success: false } })
      );

      await expect(waitForReady('http://127.0.0.1:3000', FAST)).resolves.toBe('timeout');
      expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
    });

    it('should keep polling on ECONNREFUSED until timeout', async () => {
      mockFetch.mockRejectedValue(
        Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        })
      );

      await expect(waitForReady('http://127.0.0.1:3000', FAST)).resolves.toBe('timeout');
      expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
    });

    it('should probe at least once even with a zero timeout', async () => {
      mockFetch.mockResolvedValue(readyResponse());

      await expect(
        waitForReady('http://127.0.0.1:3000', { intervalMs: 1, timeoutMs: 0 })
      ).resolves.toBe('ready');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
