/**
 * Unit tests for the official Skill Catalog client (Issue #1231)
 *
 * Every test mocks `fetch`. The commandmate-skills repository is private and
 * publishes no Catalog yet, so a test that reached the network would assert
 * nothing useful and would fail in CI.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  })),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

import {
  SkillCatalogStaleReason,
  getSkillCatalog,
  resetSkillCatalogCacheForTesting,
} from '@/lib/skills/catalog-client';
import {
  SKILL_CATALOG_CACHE_TTL_MS,
  SKILL_CATALOG_MAX_BYTES,
  SKILL_CATALOG_REPOSITORY,
  SKILL_CATALOG_URL,
  isAllowedSkillCatalogUrl,
} from '@/config/skill-catalog-config';

const VALID_CATALOG_JSON = readFileSync(
  join(process.cwd(), 'tests/fixtures/skills/contract/catalog/valid/catalog.json'),
  'utf-8'
);

interface ResponseOptions {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

/** Minimal Response stand-in: the client only uses status, headers and the body. */
function makeResponse({ status = 200, headers = {}, body = '' }: ResponseOptions): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    body: null,
    text: async () => body,
  } as unknown as Response;
}

function okCatalogResponse(etag = '"rev-1"'): Response {
  return makeResponse({ headers: { ETag: etag }, body: VALID_CATALOG_JSON });
}

const fetchMock = vi.fn<(input: unknown, init?: unknown) => Promise<Response>>();

beforeEach(() => {
  resetSkillCatalogCacheForTesting();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('Catalog endpoint allow-list', () => {
  it('accepts only the hardcoded URL', () => {
    expect(isAllowedSkillCatalogUrl(SKILL_CATALOG_URL)).toBe(true);
  });

  it('rejects look-alike origins that a prefix check would admit', () => {
    expect(isAllowedSkillCatalogUrl('https://raw.githubusercontent.com.evil.test/x.json')).toBe(
      false
    );
    expect(isAllowedSkillCatalogUrl(`${SKILL_CATALOG_URL}?x=1`)).toBe(false);
    expect(isAllowedSkillCatalogUrl('http://raw.githubusercontent.com/x.json')).toBe(false);
  });
});

describe('getSkillCatalog - successful fetch', () => {
  it('fetches, validates and reports a fresh snapshot', async () => {
    fetchMock.mockResolvedValue(okCatalogResponse());

    const result = await getSkillCatalog({ hostVersion: '0.11.4' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.state).toBe('fresh');
    expect(result.snapshot.stale).toBe(false);
    expect(result.snapshot.offline).toBe(false);
    expect(result.snapshot.staleReason).toBeNull();
    expect(result.snapshot.catalog.entries[0].id).toBe('release-notes');
    expect(result.snapshot.source.repository).toBe(SKILL_CATALOG_REPOSITORY);
    expect(result.snapshot.source.revision).toBe('"rev-1"');
    expect(result.snapshot.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('requests only the hardcoded URL and identifies itself', async () => {
    fetchMock.mockResolvedValue(okCatalogResponse());

    await getSkillCatalog({ hostVersion: '0.11.4' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(SKILL_CATALOG_URL);
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers['User-Agent']).toBe('CommandMate/0.11.4');
    expect(headers['If-None-Match']).toBeUndefined();
  });
});

describe('getSkillCatalog - caching', () => {
  it('serves from cache within the TTL without a second request', async () => {
    fetchMock.mockResolvedValue(okCatalogResponse());

    await getSkillCatalog();
    const second = await getSkillCatalog();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.snapshot.state).toBe('cached');
    expect(second.snapshot.stale).toBe(false);
  });

  it('revalidates with If-None-Match once the TTL lapses and treats 304 as current', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T00:00:00Z'));

    fetchMock.mockResolvedValueOnce(okCatalogResponse('"rev-1"'));
    await getSkillCatalog();

    vi.setSystemTime(new Date(Date.now() + SKILL_CATALOG_CACHE_TTL_MS + 1000));
    fetchMock.mockResolvedValueOnce(makeResponse({ status: 304 }));

    const result = await getSkillCatalog();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const headers = (fetchMock.mock.calls[1][1] as { headers: Record<string, string> }).headers;
    expect(headers['If-None-Match']).toBe('"rev-1"');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.state).toBe('revalidated');
    expect(result.snapshot.stale).toBe(false);
  });

  it('shares one origin request between concurrent callers', async () => {
    fetchMock.mockResolvedValue(okCatalogResponse());

    const [a, b] = await Promise.all([getSkillCatalog(), getSkillCatalog()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a.ok && b.ok).toBe(true);
  });
});

describe('getSkillCatalog - degraded paths', () => {
  async function primeCache(): Promise<void> {
    fetchMock.mockResolvedValueOnce(okCatalogResponse());
    await getSkillCatalog();
    fetchMock.mockReset();
  }

  const failures: Array<[string, () => void, string]> = [
    [
      'network error',
      () => fetchMock.mockRejectedValue(new Error('ECONNREFUSED')),
      SkillCatalogStaleReason.FETCH_FAILED,
    ],
    [
      'non-OK status',
      () => fetchMock.mockResolvedValue(makeResponse({ status: 500 })),
      SkillCatalogStaleReason.FETCH_FAILED,
    ],
    [
      'malformed JSON',
      () => fetchMock.mockResolvedValue(makeResponse({ body: 'not json' })),
      SkillCatalogStaleReason.MALFORMED,
    ],
    [
      'schema violation',
      () =>
        fetchMock.mockResolvedValue(
          makeResponse({ body: JSON.stringify({ schema_version: 1, entries: [{ id: 'x' }] }) })
        ),
      SkillCatalogStaleReason.INVALID_SCHEMA,
    ],
    [
      'unknown schema_version',
      () =>
        fetchMock.mockResolvedValue(
          makeResponse({ body: JSON.stringify({ schema_version: 2, entries: [] }) })
        ),
      SkillCatalogStaleReason.INVALID_SCHEMA,
    ],
    [
      'oversized declared length',
      () =>
        fetchMock.mockResolvedValue(
          makeResponse({
            headers: { 'Content-Length': String(SKILL_CATALOG_MAX_BYTES + 1) },
            body: VALID_CATALOG_JSON,
          })
        ),
      SkillCatalogStaleReason.OVERSIZED,
    ],
    [
      'oversized undeclared body',
      () => fetchMock.mockResolvedValue(makeResponse({ body: 'x'.repeat(SKILL_CATALOG_MAX_BYTES + 1) })),
      SkillCatalogStaleReason.OVERSIZED,
    ],
  ];

  for (const [label, arrange, expectedCode] of failures) {
    it(`fails closed with no cache: ${label}`, async () => {
      arrange();

      const result = await getSkillCatalog();

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.code).toBe(expectedCode);
      expect(result.failure.message.length).toBeGreaterThan(0);
    });

    it(`serves last known good marked stale: ${label}`, async () => {
      await primeCache();
      arrange();

      const result = await getSkillCatalog({ forceRevalidate: true });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.snapshot.stale).toBe(true);
      expect(result.snapshot.offline).toBe(true);
      expect(result.snapshot.staleReason).toBe(expectedCode);
      expect(result.snapshot.catalog.entries[0].id).toBe('release-notes');
    });
  }

  it('never replaces the cached document with an unvalidated one', async () => {
    await primeCache();
    fetchMock.mockResolvedValue(
      makeResponse({ body: JSON.stringify({ schema_version: 1, entries: [{ id: 'evil' }] }) })
    );

    const stale = await getSkillCatalog({ forceRevalidate: true });
    expect(stale.ok).toBe(true);
    if (!stale.ok) return;
    expect(stale.snapshot.catalog.entries.map((e) => e.id)).toEqual(['release-notes']);

    // The next successful fetch is what replaces it.
    fetchMock.mockResolvedValue(okCatalogResponse('"rev-2"'));
    const fresh = await getSkillCatalog({ forceRevalidate: true });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.snapshot.state).toBe('fresh');
  });

  it('reports schema errors so a caller can explain the rejection', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({ body: JSON.stringify({ schema_version: 2, entries: [] }) })
    );

    const result = await getSkillCatalog();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.errors.length).toBeGreaterThan(0);
    expect(result.failure.errors[0].code).toBe('SKILL_SCHEMA_VERSION_UNSUPPORTED');
  });
});

describe('getSkillCatalog - rate limiting', () => {
  it('backs off after 429 without issuing another request', async () => {
    fetchMock.mockResolvedValue(makeResponse({ status: 429, headers: { 'Retry-After': '120' } }));

    const first = await getSkillCatalog();
    const second = await getSkillCatalog();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.failure.code).toBe(SkillCatalogStaleReason.RATE_LIMITED);
  });

  it('serves last known good while rate limited', async () => {
    fetchMock.mockResolvedValueOnce(okCatalogResponse());
    await getSkillCatalog();

    fetchMock.mockResolvedValue(makeResponse({ status: 403, headers: { 'Retry-After': '120' } }));
    const limited = await getSkillCatalog({ forceRevalidate: true });

    expect(limited.ok).toBe(true);
    if (!limited.ok) return;
    expect(limited.snapshot.stale).toBe(true);
    expect(limited.snapshot.staleReason).toBe(SkillCatalogStaleReason.RATE_LIMITED);
  });

  it('resumes requesting once the back-off window elapses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T00:00:00Z'));

    fetchMock.mockResolvedValueOnce(makeResponse({ status: 429, headers: { 'Retry-After': '60' } }));
    await getSkillCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(Date.now() + 61_000));
    fetchMock.mockResolvedValueOnce(okCatalogResponse());
    const result = await getSkillCatalog();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });

  it('clamps a hostile reset hint so the client cannot be pinned offline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T00:00:00Z'));

    fetchMock.mockResolvedValueOnce(
      makeResponse({ status: 403, headers: { 'X-RateLimit-Reset': '99999999999' } })
    );
    await getSkillCatalog();

    // Past the 24h clamp, requests resume even though the header asked for years.
    vi.setSystemTime(new Date(Date.now() + 25 * 60 * 60 * 1000));
    fetchMock.mockResolvedValueOnce(okCatalogResponse());
    const result = await getSkillCatalog();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });
});

describe('getSkillCatalog - streaming body cap', () => {
  it('cuts off a streamed body that exceeds the cap', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(64 * 1024));
    let emitted = 0;
    const response = {
      status: 200,
      ok: true,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => {
            emitted += 1;
            return emitted > 1000 ? { done: true, value: undefined } : { done: false, value: chunk };
          },
          cancel: async () => undefined,
        }),
      },
      text: async () => '',
    } as unknown as Response;

    fetchMock.mockResolvedValue(response);

    const result = await getSkillCatalog();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe(SkillCatalogStaleReason.OVERSIZED);
  });

  it('decodes a streamed body that fits the cap', async () => {
    const bytes = new TextEncoder().encode(VALID_CATALOG_JSON);
    let done = false;
    const response = {
      status: 200,
      ok: true,
      headers: new Headers({ ETag: '"rev-stream"' }),
      body: {
        getReader: () => ({
          read: async () => {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: bytes };
          },
          cancel: async () => undefined,
        }),
      },
      text: async () => {
        throw new Error('text() must not be used when a stream is available');
      },
    } as unknown as Response;

    fetchMock.mockResolvedValue(response);

    const result = await getSkillCatalog();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.catalog.entries[0].id).toBe('release-notes');
  });
});
