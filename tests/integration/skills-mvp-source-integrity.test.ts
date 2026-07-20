/**
 * Skill MVP source-integrity regression (Issue #1242)
 *
 * @vitest-environment node
 *
 * The other MVP suites stub the download so they can exercise install
 * behaviour offline. That leaves the guards *on the wire* — allowlist, redirect
 * re-validation, content-type, size cap, checksum — untested end to end, which
 * is precisely where a supply-chain failure would enter. This suite therefore
 * runs the real `artifact-downloader` and the real `catalog-client` against a
 * stubbed `fetch`: no network, but no stubbed guard either.
 *
 * One case deliberately mirrors the redirect chain the published releases
 * actually serve (`github.com` → `release-assets.githubusercontent.com`,
 * `application/octet-stream`), so the suite fails if a future tightening of the
 * policy would break real downloads.
 */

import { createHash } from 'crypto';
import { gzipSync } from 'zlib';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  downloadSkillArtifact,
  fetchSkillSource,
  resetSkillDownloadsForTesting,
} from '@/lib/skills/artifact-downloader';
import { getSkillCatalog, resetSkillCatalogCacheForTesting } from '@/lib/skills/catalog-client';
import { isSkillFetchError, SkillFetchErrorCode } from '@/lib/skills/integrity';
import { SKILL_CATALOG_URL } from '@/config/skill-catalog-config';
import { SKILL_ARTIFACT_MAX_SIZE } from '@/lib/skills/constants';
import type { SkillCatalogVersion } from '@/types/skills';
import { buildArtifact, buildCatalog, CATALOG_REPOSITORY, MVP_SKILLS } from './skills/mvp-harness';

const SKILL = MVP_SKILLS[0];
const RELEASE_URL = `https://github.com/${CATALOG_REPOSITORY}/releases/download/${SKILL.id}-v${SKILL.version}/${SKILL.id}-${SKILL.version}.tar.gz`;
const REDIRECT_URL = `https://release-assets.githubusercontent.com/${SKILL.id}?token=redacted`;

let artifact: ReturnType<typeof buildArtifact>;
let fetchMock: ReturnType<typeof vi.fn>;

// =============================================================================
// Harness
// =============================================================================

function bodyOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function artifactResponse(
  bytes: Uint8Array,
  overrides: { contentType?: string; contentLength?: number } = {}
): Response {
  return new Response(bodyOf(bytes), {
    status: 200,
    headers: {
      'content-type': overrides.contentType ?? 'application/gzip',
      'content-length': String(overrides.contentLength ?? bytes.byteLength),
    },
  });
}

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

/** A Catalog version that binds exactly to `artifact`, unless overridden. */
function versionFor(overrides: Partial<SkillCatalogVersion['artifact']> = {}): SkillCatalogVersion {
  return {
    version: artifact.version,
    changelog: `Release ${artifact.version}`,
    published_at: '2026-07-16T09:30:00Z',
    source: {
      repository: CATALOG_REPOSITORY,
      ref: `${SKILL.id}-v${SKILL.version}`,
      commit: artifact.commit,
    },
    artifact: {
      asset_name: `${SKILL.id}-${SKILL.version}.tar.gz`,
      url: RELEASE_URL,
      sha256: artifact.sha256,
      size: artifact.size,
      content_type: 'application/gzip',
      format: 'tar.gz',
      ...overrides,
    },
    compatibility: {
      commandmate: '>=0.11.0 <1.0.0',
      agents: [{ agent: 'claude', support: 'native', evidence: 'fixture' }],
    },
    declared_risk: 'low',
  } as SkillCatalogVersion;
}

async function downloadError(version: SkillCatalogVersion): Promise<string> {
  try {
    await downloadSkillArtifact(SKILL.id, version);
  } catch (error) {
    if (isSkillFetchError(error)) return error.code;
    throw error;
  }
  throw new Error('expected the download to be refused, but it succeeded');
}

beforeEach(() => {
  artifact = buildArtifact(SKILL.id, SKILL.version);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  resetSkillDownloadsForTesting();
  resetSkillCatalogCacheForTesting();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSkillDownloadsForTesting();
  resetSkillCatalogCacheForTesting();
});

// =============================================================================
// Happy path, including the real redirect chain
// =============================================================================

describe('Skill MVP source integrity: accepted sources', () => {
  it('downloads a release asset that matches its declared digest and size', async () => {
    fetchMock.mockResolvedValueOnce(artifactResponse(artifact.bytes));

    const download = await downloadSkillArtifact(SKILL.id, versionFor());
    expect(download.sha256).toBe(artifact.sha256);
    expect(download.size).toBe(artifact.size);
    expect(Buffer.from(download.bytes)).toEqual(artifact.bytes);
  });

  /**
   * The published releases really do redirect to
   * `release-assets.githubusercontent.com` and really do answer
   * `application/octet-stream`. If this case ever fails, the policy tightened
   * in a way that breaks every real install.
   */
  it('follows the github.com → release-assets redirect and accepts octet-stream', async () => {
    fetchMock
      .mockResolvedValueOnce(redirectTo(REDIRECT_URL))
      .mockResolvedValueOnce(
        artifactResponse(artifact.bytes, { contentType: 'application/octet-stream' })
      );

    const download = await downloadSkillArtifact(SKILL.id, versionFor());
    expect(download.sha256).toBe(artifact.sha256);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Each hop is fetched with redirects disabled, so every hop is re-validated
    // by the allowlist rather than followed blindly by the runtime.
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).redirect).toBe('manual');
    }
  });
});

// =============================================================================
// Refused sources
// =============================================================================

describe('Skill MVP source integrity: refused sources', () => {
  it('refuses a host outside the allowlist without opening a connection', async () => {
    const code = await downloadError(
      versionFor({ url: `https://evil.test/${SKILL.id}-${SKILL.version}.tar.gz` })
    );
    expect(code).toBe(SkillFetchErrorCode.SOURCE_NOT_ALLOWED);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a look-alike host that merely prefixes the allowlisted one', async () => {
    for (const host of [
      'github.com.evil.test',
      'notgithub.com',
      'raw.githubusercontent.com.evil.test',
    ]) {
      const code = await downloadError(
        versionFor({ url: `https://${host}/${CATALOG_REPOSITORY}/releases/download/x/y.tar.gz` })
      );
      expect(code, host).toBe(SkillFetchErrorCode.SOURCE_NOT_ALLOWED);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an allowlisted host reached under a different repository path', async () => {
    const code = await downloadError(
      versionFor({ url: 'https://github.com/attacker/other-repo/releases/download/v1/x.tar.gz' })
    );
    expect(code).toBe(SkillFetchErrorCode.SOURCE_NOT_ALLOWED);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses plaintext http, embedded credentials and an explicit port', async () => {
    const base = `${CATALOG_REPOSITORY}/releases/download/${SKILL.id}-v${SKILL.version}/${SKILL.id}-${SKILL.version}.tar.gz`;
    for (const url of [
      `http://github.com/${base}`,
      `https://user:pass@github.com/${base}`,
      `https://github.com:8443/${base}`,
    ]) {
      const code = await downloadError(versionFor({ url }));
      expect(code, url).toBe(SkillFetchErrorCode.URL_INVALID);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-validates every redirect hop and refuses one that leaves the allowlist', async () => {
    fetchMock.mockResolvedValueOnce(redirectTo('https://evil.test/payload.tar.gz'));

    const code = await downloadError(versionFor());
    expect(code).toBe(SkillFetchErrorCode.SOURCE_NOT_ALLOWED);
    // The refusal happened before the second hop was ever requested.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// Refused payloads
// =============================================================================

describe('Skill MVP source integrity: refused payloads', () => {
  it('refuses bytes whose digest does not match the Catalog declaration', async () => {
    const tampered = Buffer.concat([artifact.bytes, Buffer.from('tamper')]);
    fetchMock.mockResolvedValueOnce(
      artifactResponse(tampered, { contentLength: artifact.size })
    );

    // The declared size still matches, so only the digest can catch this.
    const code = await downloadError(versionFor());
    expect([SkillFetchErrorCode.CHECKSUM_MISMATCH, SkillFetchErrorCode.SIZE_MISMATCH]).toContain(
      code
    );
  });

  it('refuses bytes that match the size but not the digest', async () => {
    const sameSize = Buffer.from(artifact.bytes);
    sameSize[sameSize.length - 1] ^= 0xff;
    expect(createHash('sha256').update(sameSize).digest('hex')).not.toBe(artifact.sha256);

    fetchMock.mockResolvedValueOnce(artifactResponse(sameSize));
    expect(await downloadError(versionFor())).toBe(SkillFetchErrorCode.CHECKSUM_MISMATCH);
  });

  it('refuses a declared Content-Length above the artifact size cap', async () => {
    fetchMock.mockResolvedValueOnce(
      artifactResponse(artifact.bytes, { contentLength: SKILL_ARTIFACT_MAX_SIZE + 1 })
    );

    const code = await downloadError(versionFor());
    expect([
      SkillFetchErrorCode.SIZE_LIMIT_EXCEEDED,
      SkillFetchErrorCode.SIZE_MISMATCH,
    ]).toContain(code);
  });

  it('aborts a body that grows past the cap mid-stream', async () => {
    const oversized = gzipSync(Buffer.alloc(SKILL_ARTIFACT_MAX_SIZE + 1024, 0));
    // No content-length: the only remaining defence is the running total.
    fetchMock.mockResolvedValueOnce(
      new Response(bodyOf(Buffer.alloc(SKILL_ARTIFACT_MAX_SIZE + 1024)), {
        status: 200,
        headers: { 'content-type': 'application/gzip' },
      })
    );

    const code = await downloadError(
      versionFor({ sha256: createHash('sha256').update(oversized).digest('hex'), size: oversized.byteLength })
    );
    expect([
      SkillFetchErrorCode.SIZE_LIMIT_EXCEEDED,
      SkillFetchErrorCode.SIZE_MISMATCH,
    ]).toContain(code);
  });

  it('refuses a Content-Type the artifact policy does not name', async () => {
    fetchMock.mockResolvedValueOnce(
      artifactResponse(artifact.bytes, { contentType: 'text/html' })
    );
    expect(await downloadError(versionFor())).toBe(SkillFetchErrorCode.CONTENT_TYPE_INVALID);
  });

  it('refuses a Catalog entry whose asset name does not follow the contract', async () => {
    expect(await downloadError(versionFor({ asset_name: 'anything.tar.gz' }))).toBe(
      SkillFetchErrorCode.BINDING_INVALID
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces an HTTP error status as a retryable fetch failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 503 }));
    expect(await downloadError(versionFor())).toBe(SkillFetchErrorCode.HTTP_STATUS);
  });
});

// =============================================================================
// Catalog availability
// =============================================================================

describe('Skill MVP source integrity: Catalog availability', () => {
  function catalogResponse(body: unknown, contentType = 'text/plain'): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': contentType },
    });
  }

  it('fetches the Catalog only from the hardcoded endpoint', async () => {
    fetchMock.mockResolvedValueOnce(catalogResponse(buildCatalog([artifact])));

    const result = await getSkillCatalog({ hostVersion: '0.11.4' });
    expect(result.ok).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toBe(SKILL_CATALOG_URL);
  });

  it('serves the last known good Catalog when a later fetch fails, flagged stale', async () => {
    fetchMock.mockResolvedValueOnce(catalogResponse(buildCatalog([artifact])));
    const fresh = await getSkillCatalog({ hostVersion: '0.11.4' });
    expect(fresh.ok).toBe(true);

    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const stale = await getSkillCatalog({ hostVersion: '0.11.4', forceRevalidate: true });

    expect(stale.ok).toBe(true);
    if (!stale.ok) return;
    expect(stale.snapshot.stale).toBe(true);
    expect(stale.snapshot.staleReason).toBe('SKILL_CATALOG_FETCH_FAILED');
    expect(stale.snapshot.catalog.entries).toHaveLength(1);
  });

  it('fails closed with no cache to fall back on', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));

    const result = await getSkillCatalog({ hostVersion: '0.11.4' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('SKILL_CATALOG_FETCH_FAILED');
  });

  it('rejects a malformed Catalog rather than caching it', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{ not json', { status: 200, headers: { 'content-type': 'text/plain' } })
    );

    const result = await getSkillCatalog({ hostVersion: '0.11.4' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('SKILL_CATALOG_MALFORMED');
  });

  it('rejects a schema-invalid Catalog rather than caching it', async () => {
    fetchMock.mockResolvedValueOnce(
      catalogResponse({ schema_version: 1, entries: [{ id: 'NOT-A-VALID-ID' }] })
    );

    const result = await getSkillCatalog({ hostVersion: '0.11.4' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('SKILL_CATALOG_INVALID_SCHEMA');
  });

  it('refuses to fetch a Catalog from any host but the allowlisted one', async () => {
    for (const url of [
      'https://evil.test/catalog.json',
      'https://raw.githubusercontent.com/attacker/repo/main/catalog.json',
      'http://raw.githubusercontent.com/Kewton/commandmate-skills/main/catalog/v1/catalog.json',
    ]) {
      let code: string | null = null;
      try {
        await fetchSkillSource(url, 'catalog');
      } catch (error) {
        if (isSkillFetchError(error)) code = error.code;
        else throw error;
      }
      expect(
        [SkillFetchErrorCode.SOURCE_NOT_ALLOWED, SkillFetchErrorCode.URL_INVALID],
        url
      ).toContain(code);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
