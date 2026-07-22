/**
 * Tests for src/lib/skills/artifact-downloader.ts
 * Issue #1229: allowlisted, redirect-guarded, size- and digest-verified fetching
 *
 * The official Skills repository is private and has no published assets, so
 * every test drives a mocked fetch. Nothing here touches the network.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SKILL_FETCH_MAX_REDIRECTS, SKILL_SOURCE_POLICIES } from '@/config/skill-security-config';
import {
  assertAllowedSkillUrl,
  downloadSkillArtifact,
  fetchSkillSource,
  resetSkillDownloadsForTesting,
  stripCredentialHeaders,
} from '@/lib/skills/artifact-downloader';
import { SkillFetchError, SkillFetchErrorCode } from '@/lib/skills/integrity';
import {
  ARTIFACT_BYTES,
  ARTIFACT_SHA256,
  ARTIFACT_URL,
  CDN_URL,
  SKILL_ID,
  artifactResponse,
  bodyStream,
  makeCatalogVersion,
  redirectResponse,
} from './fixtures';

const fetchMock = vi.fn();

/** Assert a rejection is a SkillFetchError with the expected code. */
async function expectFetchError(promise: Promise<unknown>, code: string): Promise<SkillFetchError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SkillFetchError);
    expect((error as SkillFetchError).code).toBe(code);
    return error as SkillFetchError;
  }
  throw new Error(`expected rejection with ${code}`);
}

/** Assert a synchronous throw is a SkillFetchError with the expected code. */
function expectSyncFetchError(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SkillFetchError);
    expect((error as SkillFetchError).code).toBe(code);
    return;
  }
  throw new Error(`expected throw with ${code}`);
}

function headersOfCall(index: number): Record<string, string> {
  return (fetchMock.mock.calls[index][1] as RequestInit).headers as Record<string, string>;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  resetSkillDownloadsForTesting();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSkillDownloadsForTesting();
});

describe('assertAllowedSkillUrl', () => {
  const artifactRules = SKILL_SOURCE_POLICIES.artifact.entryHosts;

  it('accepts an official release download URL', () => {
    expect(assertAllowedSkillUrl(ARTIFACT_URL, artifactRules).hostname).toBe('github.com');
  });

  it.each([
    ['http scheme', 'http://github.com/Kewton/commandmate-skills/releases/download/a/b.tar.gz'],
    ['file scheme', 'file:///etc/passwd'],
    ['embedded credentials', 'https://tok:en@github.com/Kewton/commandmate-skills/releases/download/a/b.tar.gz'],
    ['explicit port', 'https://github.com:8443/Kewton/commandmate-skills/releases/download/a/b.tar.gz'],
    ['not a url', 'Kewton/commandmate-skills'],
  ])('rejects %s as an invalid URL', (_label, url) => {
    expectSyncFetchError(
      () => assertAllowedSkillUrl(url, artifactRules),
      SkillFetchErrorCode.URL_INVALID
    );
  });

  it.each([
    ['a foreign host', 'https://evil.example.com/Kewton/commandmate-skills/releases/download/a/b.tar.gz'],
    ['a lookalike host', 'https://github.com.evil.example/Kewton/commandmate-skills/releases/download/a.tar.gz'],
    ['an internal address', 'https://169.254.169.254/latest/meta-data'],
    ['another repository on an allowed host', 'https://github.com/attacker/skills/releases/download/a/b.tar.gz'],
    ['a non-release path on an allowed host', 'https://github.com/Kewton/commandmate-skills/archive/main.tar.gz'],
    ['traversal that normalizes out of the release path', 'https://github.com/Kewton/commandmate-skills/releases/download/../../x.tar.gz'],
    ['percent-encoded traversal', 'https://github.com/Kewton/commandmate-skills/releases/download/%2e%2e/%2e%2e/x.tar.gz'],
  ])('rejects %s as a disallowed source', (_label, url) => {
    expectSyncFetchError(
      () => assertAllowedSkillUrl(url, artifactRules),
      SkillFetchErrorCode.SOURCE_NOT_ALLOWED
    );
  });

  it('does not accept the CDN host as an entry point', () => {
    expectSyncFetchError(
      () => assertAllowedSkillUrl(CDN_URL, artifactRules),
      SkillFetchErrorCode.SOURCE_NOT_ALLOWED
    );
    expect(() =>
      assertAllowedSkillUrl(CDN_URL, SKILL_SOURCE_POLICIES.artifact.redirectHosts)
    ).not.toThrow();
  });

  it('does not accept an artifact URL under the catalog policy', () => {
    expectSyncFetchError(
      () => assertAllowedSkillUrl(ARTIFACT_URL, SKILL_SOURCE_POLICIES.catalog.entryHosts),
      SkillFetchErrorCode.SOURCE_NOT_ALLOWED
    );
  });
});

describe('stripCredentialHeaders', () => {
  it('removes credential headers regardless of case and keeps the rest', () => {
    expect(
      stripCredentialHeaders({
        Authorization: 'Bearer token',
        cookie: 'session=1',
        'proxy-authorization': 'Basic x',
        accept: 'application/gzip',
      })
    ).toEqual({ accept: 'application/gzip' });
  });
});

describe('downloadSkillArtifact', () => {
  it('returns verified bytes bound to the catalog coordinates', async () => {
    fetchMock.mockResolvedValueOnce(artifactResponse());

    const result = await downloadSkillArtifact(SKILL_ID, makeCatalogVersion());

    expect(Buffer.from(result.bytes).equals(ARTIFACT_BYTES)).toBe(true);
    expect(result.sha256).toBe(ARTIFACT_SHA256);
    expect(result.size).toBe(ARTIFACT_BYTES.byteLength);
    expect(result.skillId).toBe(SKILL_ID);
    expect(result.version).toBe('1.2.3');
    expect(result.commit).toBe(makeCatalogVersion().source.commit);
  });

  it('never sends a credential header and disables redirect following', async () => {
    fetchMock.mockResolvedValueOnce(artifactResponse());
    await downloadSkillArtifact(SKILL_ID, makeCatalogVersion());

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.redirect).toBe('manual');
    expect(Object.keys(headersOfCall(0)).sort()).toEqual(['accept', 'user-agent']);
  });

  it('refuses a catalog entry whose artifact URL is off the allowlist without any request', async () => {
    const version = makeCatalogVersion();
    version.artifact.url = 'https://evil.example.com/demo-skill-1.2.3.tar.gz';

    await expectFetchError(
      downloadSkillArtifact(SKILL_ID, version),
      SkillFetchErrorCode.SOURCE_NOT_ALLOWED
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an entry that is not bound to a resolved commit without any request', async () => {
    const version = makeCatalogVersion({
      source: { repository: 'Kewton/commandmate-skills', ref: 'main', commit: 'abc1234' },
    });

    const error = await expectFetchError(
      downloadSkillArtifact(SKILL_ID, version),
      SkillFetchErrorCode.BINDING_INVALID
    );
    expect(error.retryable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('follows a redirect to the release CDN and re-validates the hop', async () => {
    fetchMock
      .mockResolvedValueOnce(redirectResponse(CDN_URL))
      .mockResolvedValueOnce(artifactResponse());

    const result = await downloadSkillArtifact(SKILL_ID, makeCatalogVersion());

    expect(result.sha256).toBe(ARTIFACT_SHA256);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(CDN_URL);
    expect(headersOfCall(1)).not.toHaveProperty('authorization');
    expect(headersOfCall(1)).not.toHaveProperty('cookie');
  });

  it('rejects a redirect that leaves the allowlist', async () => {
    fetchMock.mockResolvedValueOnce(redirectResponse('https://evil.example.com/payload.tar.gz'));

    await expectFetchError(
      downloadSkillArtifact(SKILL_ID, makeCatalogVersion()),
      SkillFetchErrorCode.SOURCE_NOT_ALLOWED
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a redirect without a Location header', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302 }));

    await expectFetchError(
      downloadSkillArtifact(SKILL_ID, makeCatalogVersion()),
      SkillFetchErrorCode.REDIRECT_INVALID
    );
  });

  it('stops at the redirect limit instead of looping', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(redirectResponse(CDN_URL)));

    await expectFetchError(
      downloadSkillArtifact(SKILL_ID, makeCatalogVersion()),
      SkillFetchErrorCode.REDIRECT_LIMIT_EXCEEDED
    );
    expect(fetchMock).toHaveBeenCalledTimes(SKILL_FETCH_MAX_REDIRECTS + 1);
  });

  it('rejects a non-success status as retryable', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }));

    const error = await expectFetchError(
      downloadSkillArtifact(SKILL_ID, makeCatalogVersion()),
      SkillFetchErrorCode.HTTP_STATUS
    );
    expect(error.retryable).toBe(true);
    expect(error.detail).toEqual({ status: 404 });
  });

  it('rejects an HTML error page served with a 200', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(bodyStream(Buffer.from('<html></html>')), {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    );

    await expectFetchError(
      downloadSkillArtifact(SKILL_ID, makeCatalogVersion()),
      SkillFetchErrorCode.CONTENT_TYPE_INVALID
    );
  });

  it('rejects a Content-Length that disagrees with the catalog before reading the body', async () => {
    fetchMock.mockResolvedValueOnce(
      artifactResponse(ARTIFACT_BYTES, { 'content-length': String(ARTIFACT_BYTES.byteLength + 1) })
    );

    const error = await expectFetchError(
      downloadSkillArtifact(SKILL_ID, makeCatalogVersion()),
      SkillFetchErrorCode.SIZE_MISMATCH
    );
    expect(error.detail).toMatchObject({ expected: ARTIFACT_BYTES.byteLength });
  });

  it('rejects a body whose digest does not match the catalog', async () => {
    fetchMock.mockResolvedValueOnce(
      artifactResponse(Buffer.from('tampered payload bytes tampered!!'), {
        'content-length': String(ARTIFACT_BYTES.byteLength),
      })
    );

    const error = await expectFetchError(
      downloadSkillArtifact(SKILL_ID, makeCatalogVersion()),
      SkillFetchErrorCode.CHECKSUM_MISMATCH
    );
    expect(error.retryable).toBe(false);
  });

  it('rejects a body that is shorter than the catalog declared', async () => {
    fetchMock.mockResolvedValueOnce(
      artifactResponse(ARTIFACT_BYTES.subarray(0, 10), { 'content-length': '' })
    );

    await expectFetchError(
      downloadSkillArtifact(SKILL_ID, makeCatalogVersion()),
      SkillFetchErrorCode.SIZE_MISMATCH
    );
  });

  it('shares one transfer between concurrent callers', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(artifactResponse()));

    const [first, second] = await Promise.all([
      downloadSkillArtifact(SKILL_ID, makeCatalogVersion()),
      downloadSkillArtifact(SKILL_ID, makeCatalogVersion()),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.sha256).toBe(second.sha256);
  });

  it('lets a later caller start a fresh transfer once the shared one settled', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(artifactResponse()));

    await downloadSkillArtifact(SKILL_ID, makeCatalogVersion());
    await downloadSkillArtifact(SKILL_ID, makeCatalogVersion());

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('detaches an aborting caller without cancelling the shared transfer', async () => {
    let release: ((response: Response) => void) | undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );

    const controller = new AbortController();
    const aborted = downloadSkillArtifact(SKILL_ID, makeCatalogVersion(), {
      signal: controller.signal,
    });
    const survivor = downloadSkillArtifact(SKILL_ID, makeCatalogVersion());

    controller.abort();
    await expectFetchError(aborted, SkillFetchErrorCode.ABORTED);

    release?.(artifactResponse());
    await expect(survivor).resolves.toMatchObject({ sha256: ARTIFACT_SHA256 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects immediately when the caller signal is already aborted', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(artifactResponse()));

    await expectFetchError(
      downloadSkillArtifact(SKILL_ID, makeCatalogVersion(), {
        signal: AbortSignal.abort(),
      }),
      SkillFetchErrorCode.ABORTED
    );
  });

  it('reports a transport failure as retryable', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    const error = await expectFetchError(
      downloadSkillArtifact(SKILL_ID, makeCatalogVersion()),
      SkillFetchErrorCode.NETWORK
    );
    expect(error.retryable).toBe(true);
  });
});

describe('fetchSkillSource', () => {
  const CATALOG_URL = `https://raw.githubusercontent.com/Kewton/commandmate-skills/${'a'.repeat(40)}/catalog.json`;

  it('accepts the text/plain media type raw.githubusercontent.com serves JSON with', async () => {
    const body = Buffer.from('{"schema_version":1,"entries":[]}');
    fetchMock.mockResolvedValueOnce(
      new Response(bodyStream(body), {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    );

    const payload = await fetchSkillSource(CATALOG_URL, 'catalog');
    expect(Buffer.from(payload.bytes).toString()).toBe(body.toString());
  });

  it('aborts a body that grows past the policy limit instead of buffering it', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let pulled = 0;
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled += 1;
            controller.enqueue(chunk);
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const error = await expectFetchError(
      fetchSkillSource(CATALOG_URL, 'catalog'),
      SkillFetchErrorCode.SIZE_LIMIT_EXCEEDED
    );
    expect(error.detail).toEqual({ limit: SKILL_SOURCE_POLICIES.catalog.maxBytes });
    expect(pulled).toBeLessThanOrEqual(SKILL_SOURCE_POLICIES.catalog.maxBytes / chunk.byteLength + 2);
  });

  it('rejects a declared Content-Length beyond the policy limit before reading', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(bodyStream(Buffer.from('{}')), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': String(SKILL_SOURCE_POLICIES.catalog.maxBytes + 1),
        },
      })
    );

    await expectFetchError(
      fetchSkillSource(CATALOG_URL, 'catalog'),
      SkillFetchErrorCode.SIZE_LIMIT_EXCEEDED
    );
  });

  it('does not follow a catalog redirect onto the artifact CDN', async () => {
    fetchMock.mockResolvedValueOnce(redirectResponse(CDN_URL));

    await expectFetchError(
      fetchSkillSource(CATALOG_URL, 'catalog'),
      SkillFetchErrorCode.SOURCE_NOT_ALLOWED
    );
  });
});
