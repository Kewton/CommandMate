/**
 * Tests for src/lib/skills/integrity.ts
 * Issue #1229: artifact integrity verification and failure vocabulary
 */

import { describe, it, expect } from 'vitest';
import {
  SkillFetchError,
  SkillFetchErrorCode,
  assertArtifactBinding,
  computeSha256Hex,
  createSha256Accumulator,
  digestMatches,
  isSkillFetchError,
  redactUrlForLog,
  verifyArtifactIntegrity,
} from '@/lib/skills/integrity';
import { ARTIFACT_BYTES, ARTIFACT_SHA256, CDN_URL, SKILL_ID, makeCatalogVersion } from './fixtures';

describe('SkillFetchError', () => {
  it('builds its message from the code alone', () => {
    const error = new SkillFetchError(SkillFetchErrorCode.CHECKSUM_MISMATCH);
    expect(error.message).not.toContain('http');
    expect(error.message).not.toContain('/');
    expect(error.detail).toBeUndefined();
  });

  it('marks transport failures retryable and trust failures not', () => {
    expect(new SkillFetchError(SkillFetchErrorCode.TIMEOUT).retryable).toBe(true);
    expect(new SkillFetchError(SkillFetchErrorCode.NETWORK).retryable).toBe(true);
    expect(new SkillFetchError(SkillFetchErrorCode.CHECKSUM_MISMATCH).retryable).toBe(false);
    expect(new SkillFetchError(SkillFetchErrorCode.SOURCE_NOT_ALLOWED).retryable).toBe(false);
  });

  it('is narrowable from an unknown catch binding', () => {
    expect(isSkillFetchError(new SkillFetchError(SkillFetchErrorCode.NETWORK))).toBe(true);
    expect(isSkillFetchError(new Error('boom'))).toBe(false);
  });
});

describe('redactUrlForLog', () => {
  it('drops the signed query and path of a CDN URL', () => {
    const redacted = redactUrlForLog(CDN_URL);
    expect(redacted).toBe('https://objects.githubusercontent.com');
    expect(redacted).not.toContain('X-Amz-Signature');
  });

  it('drops embedded credentials', () => {
    expect(redactUrlForLog('https://user:secret@github.com/a/b')).toBe('https://github.com');
  });

  it('does not echo an unparsable value back', () => {
    expect(redactUrlForLog('not a url')).toBe('<invalid-url>');
  });
});

describe('digests', () => {
  it('hashes a buffer and a stream to the same value', () => {
    const accumulator = createSha256Accumulator();
    accumulator.update(ARTIFACT_BYTES.subarray(0, 5));
    accumulator.update(ARTIFACT_BYTES.subarray(5));
    expect(accumulator.hex()).toBe(ARTIFACT_SHA256);
    expect(computeSha256Hex(ARTIFACT_BYTES)).toBe(ARTIFACT_SHA256);
  });

  it('matches identical digests', () => {
    expect(digestMatches(ARTIFACT_SHA256, ARTIFACT_SHA256)).toBe(true);
  });

  it('rejects a differing digest', () => {
    expect(digestMatches(ARTIFACT_SHA256, 'b'.repeat(64))).toBe(false);
  });

  it('treats an uppercase or malformed digest as a mismatch rather than throwing', () => {
    expect(digestMatches(ARTIFACT_SHA256, ARTIFACT_SHA256.toUpperCase())).toBe(false);
    expect(digestMatches(ARTIFACT_SHA256, 'short')).toBe(false);
    expect(digestMatches('', '')).toBe(false);
  });
});

describe('assertArtifactBinding', () => {
  it('accepts a version pinned to an exact SemVer and a resolved commit', () => {
    expect(() => assertArtifactBinding(SKILL_ID, makeCatalogVersion())).not.toThrow();
  });

  const cases: Array<[string, ReturnType<typeof makeCatalogVersion>]> = [
    ['version', makeCatalogVersion({ version: '1.2' })],
    [
      'source.commit',
      makeCatalogVersion({
        source: { repository: 'Kewton/commandmate-skills', ref: 'main', commit: 'a1b2c3d' },
      }),
    ],
    [
      'artifact.asset_name',
      makeCatalogVersion({
        artifact: { ...makeCatalogVersion().artifact, asset_name: 'other-1.2.3.tar.gz' },
      }),
    ],
    [
      'artifact.content_type',
      makeCatalogVersion({
        artifact: { ...makeCatalogVersion().artifact, content_type: 'application/zip' },
      }),
    ],
    [
      'artifact.sha256',
      makeCatalogVersion({
        artifact: { ...makeCatalogVersion().artifact, sha256: 'A'.repeat(64) },
      }),
    ],
    [
      'artifact.size',
      makeCatalogVersion({ artifact: { ...makeCatalogVersion().artifact, size: 0 } }),
    ],
    [
      'artifact.size',
      makeCatalogVersion({
        artifact: { ...makeCatalogVersion().artifact, size: 64 * 1024 * 1024 },
      }),
    ],
  ];

  it.each(cases)('rejects an unbound %s', (field, version) => {
    try {
      assertArtifactBinding(SKILL_ID, version);
      throw new Error('expected assertArtifactBinding to throw');
    } catch (error) {
      expect(isSkillFetchError(error)).toBe(true);
      const fetchError = error as SkillFetchError;
      expect(fetchError.code).toBe(SkillFetchErrorCode.BINDING_INVALID);
      expect(fetchError.detail).toEqual({ field });
    }
  });
});

describe('verifyArtifactIntegrity', () => {
  const base = {
    expectedSha256: ARTIFACT_SHA256,
    expectedSize: ARTIFACT_BYTES.byteLength,
    actualSha256: ARTIFACT_SHA256,
    actualSize: ARTIFACT_BYTES.byteLength,
  };

  it('accepts matching size and digest', () => {
    expect(() => verifyArtifactIntegrity(base)).not.toThrow();
  });

  it('reports a truncated transfer as a size mismatch, not a checksum mismatch', () => {
    try {
      verifyArtifactIntegrity({ ...base, actualSize: 4, actualSha256: 'c'.repeat(64) });
      throw new Error('expected verifyArtifactIntegrity to throw');
    } catch (error) {
      expect((error as SkillFetchError).code).toBe(SkillFetchErrorCode.SIZE_MISMATCH);
    }
  });

  it('rejects same-length bytes with a different digest', () => {
    try {
      verifyArtifactIntegrity({ ...base, actualSha256: 'c'.repeat(64) });
      throw new Error('expected verifyArtifactIntegrity to throw');
    } catch (error) {
      expect((error as SkillFetchError).code).toBe(SkillFetchErrorCode.CHECKSUM_MISMATCH);
    }
  });
});
