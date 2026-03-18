/**
 * Fetch Mock Helpers for CLI Command Tests
 * Issue #518: [IA3-05] global.fetch restore mechanism
 *
 * Usage:
 *   import { mockFetchResponse, restoreFetch } from '../helpers/mock-api';
 *   afterEach(() => { restoreFetch(); });
 */

import { vi } from 'vitest';

const originalFetch = global.fetch;

/**
 * Mock global.fetch to return a successful response with given data.
 * @param data - Response body data
 * @param status - HTTP status code (default: 200)
 */
export function mockFetchResponse(data: unknown, status = 200): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

/**
 * Mock global.fetch to return a sequence of responses (for polling tests).
 * @param responses - Array of { data, status } objects
 */
export function mockFetchSequence(responses: Array<{ data: unknown; status?: number }>): void {
  const mockFn = vi.fn();
  responses.forEach((resp, index) => {
    const status = resp.status ?? 200;
    mockFn.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(resp.data),
      text: () => Promise.resolve(JSON.stringify(resp.data)),
    });
  });
  global.fetch = mockFn;
}

/**
 * Mock global.fetch to reject with an error.
 * @param error - Error message or Error object
 */
export function mockFetchError(error: string | Error): void {
  const err = typeof error === 'string' ? new Error(error) : error;
  global.fetch = vi.fn().mockRejectedValue(err);
}

/**
 * Restore global.fetch to its original implementation.
 * Call in afterEach() to prevent test interference.
 */
export function restoreFetch(): void {
  global.fetch = originalFetch;
}
