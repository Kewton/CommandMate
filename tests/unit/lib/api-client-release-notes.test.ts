/**
 * @vitest-environment node
 */

/**
 * `appApi.getReleaseNotes` talks to GET /api/app/release-notes (Issue #2651).
 *
 * The What's-new dialog is the only caller, and the only thing it can get wrong
 * without any type complaining is the wire shape: the endpoint takes `from` and
 * `to` as query parameters, so a swapped pair or a missing `URLSearchParams`
 * encoding would still typecheck and still return notes — the wrong ones. These
 * tests pin the exact URL and method, and pin that a rejected request surfaces
 * as an `ApiError` with the server's status, because the dialog distinguishes
 * "failed, retry on the next mount" from "empty" by exactly that.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { appApi, ApiError } from '@/lib/api-client';
import type { ReleaseNote } from '@/lib/app-update/release-notes';

const NOTES: ReleaseNote[] = [
  {
    version: '0.39.0',
    date: '2026-09-18',
    highlight: { ja: 'ハイライト', en: 'Highlight' },
    added: [{ ja: '新機能', en: 'Added' }],
    improved: [],
    fixed: [],
  },
];

function stubFetch(
  body: unknown,
  init: { ok: boolean; status: number }
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() =>
    Promise.resolve({
      ok: init.ok,
      status: init.status,
      redirected: false,
      url: 'http://localhost/api/app/release-notes',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(body),
    } as unknown as Response)
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[#2651] appApi.getReleaseNotes', () => {
  it('GETs /api/app/release-notes with from and to, and returns the body as-is', async () => {
    const fetchMock = stubFetch({ notes: NOTES }, { ok: true, status: 200 });

    const result = await appApi.getReleaseNotes('0.38.0', '0.39.0');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/app/release-notes?from=0.38.0&to=0.39.0');
    expect(options.method).toBe('GET');
    expect(result).toEqual({ notes: NOTES });
  });

  it('rejects with an ApiError carrying the status when the server answers 400', async () => {
    stubFetch({ error: 'from and to must be X.Y.Z versions' }, { ok: false, status: 400 });

    const error = await appApi.getReleaseNotes('garbage', '0.39.0').then(
      (value) => value as unknown,
      (reason: unknown) => reason
    );

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
  });
});
