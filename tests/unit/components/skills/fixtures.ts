/**
 * Catalog API fixtures for the Skill Catalog UI tests (Issue #1232)
 *
 * Shaped from `lib/api/skills-api` so the tests break if the #1231 wire
 * contract changes rather than passing against a stale hand-written shape.
 */

import type {
  SkillCatalogMetaDto,
  SkillDto,
  SkillVersionDto,
} from '@/components/skills/types';

export function makeCatalogMeta(overrides: Partial<SkillCatalogMetaDto> = {}): SkillCatalogMetaDto {
  return {
    schemaVersion: 1,
    fetchedAt: '2026-07-20T00:00:00Z',
    revalidatedAt: '2026-07-20T00:05:00Z',
    stale: false,
    offline: false,
    state: 'fresh',
    staleReason: null,
    source: { repository: 'Kewton/commandmate-skills', ref: 'main', revision: 'etag-1' },
    ...overrides,
  };
}

export function makeVersion(overrides: Partial<SkillVersionDto> = {}): SkillVersionDto {
  return {
    version: '1.2.0',
    changelog: 'Adds the release checklist step.',
    publishedAt: '2026-07-01T00:00:00Z',
    declaredRisk: 'low',
    prerelease: false,
    source: {
      repository: 'Kewton/commandmate-skills',
      ref: 'v1.2.0',
      commit: 'a'.repeat(40),
    },
    artifact: {
      assetName: 'release-helper-1.2.0.tar.gz',
      sha256: 'b'.repeat(64),
      size: 20480,
      format: 'tar.gz',
    },
    compatibility: {
      commandmate: {
        status: 'compatible',
        reasonCode: 'SKILL_COMPAT_SATISFIED',
        messageKey: 'skills.compatibility.reason.satisfied',
        message: 'CommandMate 0.11.4 satisfies the required range ">=0.11.0".',
        requiredRange: '>=0.11.0',
        currentVersion: '0.11.4',
      },
      agents: [
        {
          agent: 'claude',
          support: 'native',
          labelKey: 'skills.compatibility.native',
          evidence: 'Verified against the Agent Skills specification.',
        },
      ],
    },
    ...overrides,
  };
}

export function makeSkill(overrides: Partial<SkillDto> = {}): SkillDto {
  const versions = overrides.versions ?? [makeVersion()];
  return {
    id: 'release-helper',
    name: 'Release Helper',
    summary: 'Walks an agent through the release checklist.',
    provider: { name: 'CommandMate', url: 'https://example.invalid/publisher' },
    license: 'MIT',
    homepage: 'https://example.invalid/release-helper',
    keywords: ['release', 'checklist'],
    latest: '1.2.0',
    recommendedVersion: '1.2.0',
    recommendedReason: 'SKILL_RECOMMEND_HIGHEST_COMPATIBLE',
    compatibility: versions[0]?.compatibility.commandmate ?? null,
    ...overrides,
    versions,
  };
}

/** An entry whose only version is out of range for the running CommandMate. */
export function makeIncompatibleSkill(): SkillDto {
  const version = makeVersion({
    version: '2.0.0',
    declaredRisk: 'high',
    compatibility: {
      commandmate: {
        status: 'incompatible',
        reasonCode: 'SKILL_COMPAT_HOST_VERSION_OUT_OF_RANGE',
        messageKey: 'skills.compatibility.reason.hostVersionOutOfRange',
        message: 'This Skill requires CommandMate ">=9.0.0", but CommandMate 0.11.4 is running.',
        requiredRange: '>=9.0.0',
        currentVersion: '0.11.4',
      },
      agents: [
        {
          agent: 'codex',
          support: 'unknown',
          labelKey: 'skills.compatibility.unknown',
          evidence: 'Not verified.',
        },
      ],
    },
  });
  return makeSkill({
    id: 'future-skill',
    name: 'Future Skill',
    summary: 'Needs a CommandMate that is not released yet.',
    latest: '2.0.0',
    recommendedVersion: null,
    recommendedReason: 'SKILL_RECOMMEND_NONE_COMPATIBLE',
    compatibility: version.compatibility.commandmate,
    versions: [version],
  });
}

/** An entry CommandMate could not judge at all. */
export function makeUnknownSkill(): SkillDto {
  const version = makeVersion({
    version: '0.9.0',
    declaredRisk: 'moderate',
    compatibility: {
      commandmate: {
        status: 'unknown',
        reasonCode: 'SKILL_COMPAT_RANGE_UNSUPPORTED',
        messageKey: 'skills.compatibility.reason.rangeUnsupported',
        message: 'This Skill declares the unsupported CommandMate version range "latest".',
        requiredRange: 'latest',
        currentVersion: '0.11.4',
      },
      agents: [],
    },
  });
  return makeSkill({
    id: 'mystery-skill',
    name: 'Mystery Skill',
    summary: 'Declares a range CommandMate cannot interpret.',
    keywords: ['mystery'],
    latest: '0.9.0',
    recommendedVersion: '0.9.0',
    recommendedReason: 'SKILL_RECOMMEND_LATEST_UNVERIFIED',
    compatibility: version.compatibility.commandmate,
    versions: [version],
  });
}
