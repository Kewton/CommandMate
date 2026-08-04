/**
 * Issue #1243: update availability and candidate selection.
 *
 * Every case pins one rule of the resolution: strictly-newer-only, exact
 * version output, prerelease opt-in, range filtering, and fail-closed behavior
 * for anything unparsable. The compatibility verdicts come from the real
 * evaluator, so a drift between install-time and update-time judgement would
 * surface here.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  SkillUpdateRecommendationReason,
  findSkillUpdateCandidate,
  hasSkillUpdate,
  isNewerSkillVersion,
  resolveSkillUpdateAvailability,
} from '@/lib/skills/version-resolver';
import type { SkillCatalogEntry, SkillCatalogVersion } from '@/types/skills';
import { makeCatalogVersion } from './fixtures';

const HOST = '0.11.4';

function version(v: string, overrides: Partial<SkillCatalogVersion> = {}): SkillCatalogVersion {
  return makeCatalogVersion({ version: v, ...overrides });
}

function entry(versions: SkillCatalogVersion[], latest?: string): SkillCatalogEntry {
  return {
    id: 'demo-skill',
    name: 'Demo Skill',
    summary: 'A demo Skill.',
    provider: { name: 'CommandMate' },
    license: 'MIT',
    latest: latest ?? versions[0]?.version ?? '0.0.0',
    versions,
  };
}

describe('isNewerSkillVersion / hasSkillUpdate', () => {
  it('answers strictly-newer by SemVer 2.0 precedence', () => {
    expect(isNewerSkillVersion('1.3.0', '1.2.3')).toBe(true);
    expect(isNewerSkillVersion('1.2.3', '1.2.3')).toBe(false);
    expect(isNewerSkillVersion('1.2.2', '1.2.3')).toBe(false);
    // A release outranks its own prereleases.
    expect(isNewerSkillVersion('2.0.0', '2.0.0-rc.1')).toBe(true);
  });

  it('fails closed on anything that is not strict SemVer', () => {
    expect(isNewerSkillVersion('v1.3.0', '1.2.3')).toBe(false);
    expect(isNewerSkillVersion('1.3.0', 'not-a-version')).toBe(false);
    expect(hasSkillUpdate(null, '1.3.0')).toBe(false);
    expect(hasSkillUpdate('1.2.3', null)).toBe(false);
    expect(hasSkillUpdate('garbage', '1.3.0')).toBe(false);
  });

  it('drives the update badge from the latest Catalog version', () => {
    expect(hasSkillUpdate('1.2.3', '1.3.0')).toBe(true);
    expect(hasSkillUpdate('1.3.0', '1.3.0')).toBe(false);
  });
});

describe('resolveSkillUpdateAvailability', () => {
  it('offers only strictly newer versions, newest first, resolved to exact versions', () => {
    const resolution = resolveSkillUpdateAvailability(
      entry([version('1.2.3'), version('1.3.0'), version('2.0.0'), version('1.0.0')]),
      '1.2.3',
      { currentVersion: HOST }
    );

    expect(resolution.updateAvailable).toBe(true);
    expect(resolution.candidates.map((candidate) => candidate.version.version)).toEqual([
      '2.0.0',
      '1.3.0',
    ]);
    expect(resolution.latestVersion).toBe('2.0.0');
    // The default candidate is an exact version, not the symbol "latest".
    expect(resolution.recommended?.version.version).toBe('2.0.0');
    expect(resolution.reasonCode).toBe(SkillUpdateRecommendationReason.HIGHEST_COMPATIBLE);
  });

  it('reports up-to-date when nothing newer is listed', () => {
    const resolution = resolveSkillUpdateAvailability(
      entry([version('1.2.3'), version('1.0.0')]),
      '1.2.3',
      { currentVersion: HOST }
    );

    expect(resolution.updateAvailable).toBe(false);
    expect(resolution.candidates).toEqual([]);
    expect(resolution.recommended).toBeNull();
    expect(resolution.reasonCode).toBe(SkillUpdateRecommendationReason.UP_TO_DATE);
  });

  it('excludes prereleases unless explicitly requested', () => {
    const listed = entry([version('1.2.3'), version('1.3.0-rc.1')]);

    const withoutOptIn = resolveSkillUpdateAvailability(listed, '1.2.3', {
      currentVersion: HOST,
    });
    expect(withoutOptIn.updateAvailable).toBe(false);

    const withOptIn = resolveSkillUpdateAvailability(listed, '1.2.3', {
      currentVersion: HOST,
      includePrerelease: true,
    });
    expect(withOptIn.candidates.map((candidate) => candidate.version.version)).toEqual([
      '1.3.0-rc.1',
    ]);
    expect(withOptIn.candidates[0].prerelease).toBe(true);
  });

  it('narrows candidates with a version range and fails closed on an unsupported one', () => {
    const listed = entry([version('1.2.3'), version('1.3.0'), version('2.0.0')]);

    const ranged = resolveSkillUpdateAvailability(listed, '1.2.3', {
      currentVersion: HOST,
      range: '^1.0.0',
    });
    expect(ranged.candidates.map((candidate) => candidate.version.version)).toEqual(['1.3.0']);
    expect(ranged.recommended?.version.version).toBe('1.3.0');

    const unsupported = resolveSkillUpdateAvailability(listed, '1.2.3', {
      currentVersion: HOST,
      range: '1.x || 2.x',
    });
    expect(unsupported.candidates).toEqual([]);
    expect(unsupported.reasonCode).toBe(SkillUpdateRecommendationReason.RANGE_UNSUPPORTED);
  });

  it('fails closed when the installed version is not strict SemVer', () => {
    const resolution = resolveSkillUpdateAvailability(
      entry([version('1.3.0')]),
      'not-semver',
      { currentVersion: HOST }
    );

    expect(resolution.updateAvailable).toBe(false);
    expect(resolution.reasonCode).toBe(
      SkillUpdateRecommendationReason.INSTALLED_VERSION_INVALID
    );
  });

  it('recommends the newest compatible candidate, skipping incompatible newer ones', () => {
    const resolution = resolveSkillUpdateAvailability(
      entry([
        version('1.2.3'),
        version('1.3.0'),
        version('2.0.0', { compatibility: { commandmate: '>=9.0.0', agents: [] } }),
      ]),
      '1.2.3',
      { currentVersion: HOST }
    );

    expect(resolution.candidates.map((candidate) => candidate.version.version)).toEqual([
      '2.0.0',
      '1.3.0',
    ]);
    expect(resolution.recommended?.version.version).toBe('1.3.0');
    expect(resolution.reasonCode).toBe(SkillUpdateRecommendationReason.HIGHEST_COMPATIBLE);
    expect(resolution.candidates[0].compatibility.status).toBe('incompatible');
  });

  it('lists but does not recommend when no candidate is compatible', () => {
    const resolution = resolveSkillUpdateAvailability(
      entry([
        version('1.2.3'),
        version('2.0.0', { compatibility: { commandmate: '>=9.0.0', agents: [] } }),
      ]),
      '1.2.3',
      { currentVersion: HOST }
    );

    expect(resolution.updateAvailable).toBe(true);
    expect(resolution.recommended).toBeNull();
    expect(resolution.reasonCode).toBe(SkillUpdateRecommendationReason.NONE_COMPATIBLE);
  });

  it('offers the newest candidate unverified when the host version is unknown', () => {
    const resolution = resolveSkillUpdateAvailability(
      entry([version('1.2.3'), version('1.3.0')]),
      '1.2.3',
      { currentVersion: null }
    );

    expect(resolution.recommended?.version.version).toBe('1.3.0');
    expect(resolution.reasonCode).toBe(SkillUpdateRecommendationReason.LATEST_UNVERIFIED);
    expect(resolution.recommended?.compatibility.status).toBe('unknown');
  });

  it('finds a candidate only by exact version', () => {
    const resolution = resolveSkillUpdateAvailability(
      entry([version('1.2.3'), version('1.3.0'), version('2.0.0')]),
      '1.2.3',
      { currentVersion: HOST }
    );

    expect(findSkillUpdateCandidate(resolution, '1.3.0')?.version.version).toBe('1.3.0');
    // The installed version and the symbol "latest" are not candidates.
    expect(findSkillUpdateCandidate(resolution, '1.2.3')).toBeNull();
    expect(findSkillUpdateCandidate(resolution, 'latest')).toBeNull();
  });
});
