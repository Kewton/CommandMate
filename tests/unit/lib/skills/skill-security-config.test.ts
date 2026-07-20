/**
 * Tests for src/config/skill-security-config.ts
 * Issue #1229: official source allowlist and snapshot limits
 */

import { describe, it, expect } from 'vitest';
import {
  SKILL_CREDENTIAL_HEADERS,
  SKILL_FETCH_MAX_REDIRECTS,
  SKILL_OFFICIAL_REPOSITORY,
  SKILL_SNAPSHOT_DIR_MODE,
  SKILL_SNAPSHOT_FILE_MODE,
  SKILL_SOURCE_POLICIES,
  buildSkillCatalogUrl,
} from '@/config/skill-security-config';
import { SKILL_ARTIFACT_CONTENT_TYPE, SKILL_ARTIFACT_MAX_SIZE } from '@/lib/skills';

const COMMIT = 'a'.repeat(40);

describe('buildSkillCatalogUrl', () => {
  it('pins the catalog to the official repository at an immutable commit', () => {
    expect(buildSkillCatalogUrl(COMMIT)).toBe(
      `https://raw.githubusercontent.com/${SKILL_OFFICIAL_REPOSITORY}/${COMMIT}/catalog.json`
    );
  });

  it('rejects a branch name', () => {
    expect(() => buildSkillCatalogUrl('main')).toThrow(/40-hex commit/);
  });

  it('rejects an abbreviated commit', () => {
    expect(() => buildSkillCatalogUrl('a'.repeat(7))).toThrow(/40-hex commit/);
  });

  it('rejects an uppercase commit so digests compare byte-wise', () => {
    expect(() => buildSkillCatalogUrl('A'.repeat(40))).toThrow(/40-hex commit/);
  });
});

describe('SKILL_SOURCE_POLICIES', () => {
  it('keeps catalog and artifact origins disjoint', () => {
    const catalogHosts = SKILL_SOURCE_POLICIES.catalog.redirectHosts.map((rule) => rule.host);
    const artifactHosts = SKILL_SOURCE_POLICIES.artifact.redirectHosts.map((rule) => rule.host);
    expect(catalogHosts.some((host) => artifactHosts.includes(host))).toBe(false);
  });

  it('narrows every entry host to the official repository path', () => {
    for (const policy of Object.values(SKILL_SOURCE_POLICIES)) {
      for (const rule of policy.entryHosts) {
        expect(rule.pathPrefix).toContain(SKILL_OFFICIAL_REPOSITORY);
      }
    }
  });

  it('allows redirect-only CDN hosts without a path prefix, guarded by the digest', () => {
    const cdnHosts = SKILL_SOURCE_POLICIES.artifact.redirectHosts.filter(
      (rule) => rule.pathPrefix === undefined
    );
    expect(cdnHosts.length).toBeGreaterThan(0);
    expect(cdnHosts.every((rule) => rule.host.endsWith('.githubusercontent.com'))).toBe(true);
  });

  it('caps the artifact body at the contract limit and accepts only its media type', () => {
    expect(SKILL_SOURCE_POLICIES.artifact.maxBytes).toBe(SKILL_ARTIFACT_MAX_SIZE);
    expect(SKILL_SOURCE_POLICIES.artifact.contentTypes).toContain(SKILL_ARTIFACT_CONTENT_TYPE);
    expect(SKILL_SOURCE_POLICIES.artifact.contentTypes).not.toContain('text/html');
  });

  it('does not accept the artifact media type for catalog responses', () => {
    expect(SKILL_SOURCE_POLICIES.catalog.contentTypes).not.toContain(SKILL_ARTIFACT_CONTENT_TYPE);
  });
});

describe('transport and storage limits', () => {
  it('bounds redirects', () => {
    expect(SKILL_FETCH_MAX_REDIRECTS).toBeGreaterThan(0);
    expect(SKILL_FETCH_MAX_REDIRECTS).toBeLessThanOrEqual(10);
  });

  it('lists the credential headers that must not cross an origin', () => {
    expect(SKILL_CREDENTIAL_HEADERS).toContain('authorization');
    expect(SKILL_CREDENTIAL_HEADERS).toContain('cookie');
    expect(SKILL_CREDENTIAL_HEADERS.every((name) => name === name.toLowerCase())).toBe(true);
  });

  it('keeps the snapshot root service-owned and its files read-only', () => {
    expect(SKILL_SNAPSHOT_DIR_MODE).toBe(0o700);
    expect(SKILL_SNAPSHOT_FILE_MODE & 0o222).toBe(0);
  });
});
