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
 * Path of the server-capability probe (Issue #1925).
 *
 * Every command that resolves an agent instance asks this first, and it is
 * infrastructure rather than part of what a command test is about: it is
 * answered here rather than being written into every sequence, so a test says
 * only what its own command does. Override it with
 * {@link setMockServerCapabilities} when the probe IS the subject.
 */
const CAPABILITIES_PATH = '/api/capabilities';

/** What the mocked server declares it can do. Matches SERVER_CAPABILITIES. */
const DEFAULT_CAPABILITIES = {
  serverVersion: '0.0.0-test',
  capabilities: ['resolve-session-target'],
};

let capabilitiesPayload: unknown = DEFAULT_CAPABILITIES;

/**
 * Point the auto-answered capability probe at a different payload.
 * Reset by {@link restoreFetch}.
 */
export function setMockServerCapabilities(payload: unknown): void {
  capabilitiesPayload = payload;
}

/**
 * Build a Response stand-in.
 *
 * Carries `headers` and `redirected` because the capability probe reads both:
 * a mock without them looks to the probe exactly like a proxy answering HTML,
 * which is the one case it must refuse rather than degrade through.
 */
function mockResponse(data: unknown, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response;
}

function isCapabilitiesRequest(input: unknown): boolean {
  return String(input).includes(CAPABILITIES_PATH);
}

/**
 * Mock global.fetch to return a successful response with given data.
 * @param data - Response body data
 * @param status - HTTP status code (default: 200)
 */
export function mockFetchResponse(data: unknown, status = 200): void {
  global.fetch = vi.fn((input: unknown) =>
    Promise.resolve(
      isCapabilitiesRequest(input)
        ? mockResponse(capabilitiesPayload, 200)
        : mockResponse(data, status)
    )
  ) as unknown as typeof fetch;
}

/**
 * Mock global.fetch to return a sequence of responses (for polling tests).
 * The capability probe is answered out of band, so it does not consume an entry.
 * @param responses - Array of { data, status } objects
 */
export function mockFetchSequence(responses: Array<{ data: unknown; status?: number }>): void {
  const queue = responses.map((resp) => mockResponse(resp.data, resp.status ?? 200));
  let index = 0;
  global.fetch = vi.fn((input: unknown) => {
    if (isCapabilitiesRequest(input)) {
      return Promise.resolve(mockResponse(capabilitiesPayload, 200));
    }
    // Past the end the mock resolves undefined, as it did before this helper
    // grew an implementation: a test that outruns its own sequence should fail
    // on the missing response, not on a silently repeated last one.
    return Promise.resolve(queue[index++]);
  }) as unknown as typeof fetch;
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
  capabilitiesPayload = DEFAULT_CAPABILITIES;
}
