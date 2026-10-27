/**
 * Issue #3956: `ApiClient.get` takes an optional `signal` so the settle after a
 * `hook_stop` can bound its re-reads. Without one the fetch init is as before.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiClient, ApiError } from '../../../../src/cli/utils/api-client';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function okResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
  } as unknown as Response;
}

describe('ApiClient.get signal (Issue #3956)', () => {
  it('passes the signal to fetch', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okResponse({ a: 1 })));
    global.fetch = fetchMock as unknown as typeof fetch;
    const controller = new AbortController();

    const client = new ApiClient({ baseUrl: 'http://localhost:3999' });
    await expect(client.get('/x', { signal: controller.signal })).resolves.toEqual({ a: 1 });

    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
  });

  it('without a signal, the fetch init has no signal key', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okResponse({})));
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new ApiClient({ baseUrl: 'http://localhost:3999' });
    await client.get('/x');

    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect('signal' in init).toBe(false);
  });

  it('an aborted request throws an ApiError, and the signal says it was aborted', async () => {
    global.fetch = vi.fn((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('This operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
    ) as unknown as typeof fetch;
    const controller = new AbortController();

    const client = new ApiClient({ baseUrl: 'http://localhost:3999' });
    const pending = client.get('/x', { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(ApiError);
    expect(controller.signal.aborted).toBe(true);
  });
});
