/**
 * Update availability and candidate selection (Issue #1243)
 *
 * Given the exact version a receipt records and the versions a Catalog entry
 * lists, decide whether an update exists and which candidates may be offered.
 * Pure by design — no filesystem, no network, no clock — so the API route, the
 * CLI and the browser evaluate the same facts with the same rules and reach the
 * same verdict, exactly as `compatibility.ts` (#1231) does for installs.
 *
 * Three rules the resolution never bends:
 * - A candidate is only ever *strictly newer* than the installed version by
 *   SemVer 2.0 precedence. Same-version reinstalls and downgrades are not
 *   updates and are not offered.
 * - Every candidate resolves to one exact published version. "latest" is an
 *   input to the search, never an output: the default candidate is named by its
 *   exact version so what the user approves is what apply would pin.
 * - Fail closed. An installed version that is not strict SemVer, or a range
 *   that is not expressible in the supported grammar, yields no candidates
 *   rather than a guess.
 *
 * @module lib/skills/version-resolver
 */

import {
  evaluateVersionCompatibility,
  type SkillCommandMateCompatibility,
} from '@/lib/skills/compatibility';
import { compareSemVer, isValidSkillVersionRange, parseSemVer, satisfiesSkillVersionRange } from '@/lib/skills/semver';
import type { SkillCatalogEntry, SkillCatalogVersion } from '@/types/skills';

// =============================================================================
// Vocabulary
// =============================================================================

/** Why a candidate was recommended, or why none could be. Stable machine codes. */
export const SkillUpdateRecommendationReason = {
  /** No listed version is newer than the installed one. */
  UP_TO_DATE: 'SKILL_UPDATE_UP_TO_DATE',
  /** Newest newer version that is compatible with the running CommandMate. */
  HIGHEST_COMPATIBLE: 'SKILL_UPDATE_RECOMMEND_HIGHEST_COMPATIBLE',
  /** Host version unknown, so the newest candidate is offered unverified. */
  LATEST_UNVERIFIED: 'SKILL_UPDATE_RECOMMEND_LATEST_UNVERIFIED',
  /** Newer versions exist but none is compatible with the running CommandMate. */
  NONE_COMPATIBLE: 'SKILL_UPDATE_RECOMMEND_NONE_COMPATIBLE',
  /** The receipt's version is not strict SemVer, so "newer" is undecidable. */
  INSTALLED_VERSION_INVALID: 'SKILL_UPDATE_INSTALLED_VERSION_INVALID',
  /** The caller's range filter is not expressible in the supported grammar. */
  RANGE_UNSUPPORTED: 'SKILL_UPDATE_RANGE_UNSUPPORTED',
} as const;

export type SkillUpdateRecommendationReasonCode =
  (typeof SkillUpdateRecommendationReason)[keyof typeof SkillUpdateRecommendationReason];

/** i18n key per reason code, so UI and CLI explain the verdict alike. */
export const SKILL_UPDATE_RECOMMENDATION_MESSAGE_KEYS: Record<
  SkillUpdateRecommendationReasonCode,
  string
> = {
  [SkillUpdateRecommendationReason.UP_TO_DATE]: 'skills.update.reason.upToDate',
  [SkillUpdateRecommendationReason.HIGHEST_COMPATIBLE]:
    'skills.update.reason.highestCompatible',
  [SkillUpdateRecommendationReason.LATEST_UNVERIFIED]: 'skills.update.reason.latestUnverified',
  [SkillUpdateRecommendationReason.NONE_COMPATIBLE]: 'skills.update.reason.noneCompatible',
  [SkillUpdateRecommendationReason.INSTALLED_VERSION_INVALID]:
    'skills.update.reason.installedVersionInvalid',
  [SkillUpdateRecommendationReason.RANGE_UNSUPPORTED]: 'skills.update.reason.rangeUnsupported',
};

// =============================================================================
// Shapes
// =============================================================================

/** One version that could be updated to, with its compatibility verdict. */
export interface SkillUpdateCandidate {
  version: SkillCatalogVersion;
  prerelease: boolean;
  compatibility: SkillCommandMateCompatibility;
}

/** Outcome of resolving update availability for one installed Skill. */
export interface SkillUpdateAvailability {
  /** Exact version the receipt records, echoed verbatim. */
  installedVersion: string;
  /** At least one candidate exists. */
  updateAvailable: boolean;
  /** Newest candidate's exact version, or null when there is none. */
  latestVersion: string | null;
  /** Strictly newer versions, newest first by SemVer 2.0 precedence. */
  candidates: SkillUpdateCandidate[];
  /** The candidate to offer by default, always an exact version; null when none. */
  recommended: SkillUpdateCandidate | null;
  reasonCode: SkillUpdateRecommendationReasonCode;
}

/** Options for {@link resolveSkillUpdateAvailability}. */
export interface SkillUpdateResolutionOptions {
  /** Host version, already passed through `normalizeHostVersion`. */
  currentVersion: string | null;
  /** Include prerelease candidates. Off by default: prereleases require opt-in. */
  includePrerelease?: boolean;
  /**
   * Optional range every candidate must satisfy, in the grammar of
   * `satisfiesSkillVersionRange`. An unsupported range fails closed: no
   * candidates, reason {@link SkillUpdateRecommendationReason.RANGE_UNSUPPORTED}.
   */
  range?: string;
}

// =============================================================================
// Resolution
// =============================================================================

/**
 * True when `candidate` is strictly newer than `installed`.
 *
 * Fails closed: any input that is not strict SemVer 2.0 answers false, so an
 * unparsable version can never produce an update badge.
 */
export function isNewerSkillVersion(candidate: string, installed: string): boolean {
  const order = compareSemVer(candidate, installed);
  return order !== null && order > 0;
}

/**
 * True when the Catalog's newest version is newer than the installed one.
 *
 * The one comparison behind every "update available" badge, shared with the
 * dashboard's scanner semantics (#1248) via the same `compareSemVer`.
 */
export function hasSkillUpdate(
  installedVersion: string | null,
  latestVersion: string | null
): boolean {
  if (installedVersion === null || latestVersion === null) return false;
  return isNewerSkillVersion(latestVersion, installedVersion);
}

function withReason(
  installedVersion: string,
  reasonCode: SkillUpdateRecommendationReasonCode
): SkillUpdateAvailability {
  return {
    installedVersion,
    updateAvailable: false,
    latestVersion: null,
    candidates: [],
    recommended: null,
    reasonCode,
  };
}

/**
 * Resolve which published versions are offerable as updates.
 *
 * Candidates are the listed versions strictly newer than the installed one,
 * after the prerelease and range filters. The recommended candidate is the
 * newest compatible one; when the host version cannot be determined the newest
 * candidate is offered with an explicit unverified reason rather than hidden,
 * mirroring `resolveSkillVersions` (#1231).
 */
export function resolveSkillUpdateAvailability(
  entry: SkillCatalogEntry,
  installedVersion: string,
  options: SkillUpdateResolutionOptions
): SkillUpdateAvailability {
  const { currentVersion, includePrerelease = false, range } = options;

  if (parseSemVer(installedVersion) === null) {
    return withReason(
      installedVersion,
      SkillUpdateRecommendationReason.INSTALLED_VERSION_INVALID
    );
  }
  if (range !== undefined && !isValidSkillVersionRange(range)) {
    return withReason(installedVersion, SkillUpdateRecommendationReason.RANGE_UNSUPPORTED);
  }

  const candidates: SkillUpdateCandidate[] = entry.versions
    .filter((version) => isNewerSkillVersion(version.version, installedVersion))
    .map((version) => ({
      version,
      prerelease: (parseSemVer(version.version)?.prerelease.length ?? 0) > 0,
      compatibility: evaluateVersionCompatibility(version, currentVersion),
    }))
    .filter((candidate) => includePrerelease || !candidate.prerelease)
    .filter(
      (candidate) =>
        range === undefined || satisfiesSkillVersionRange(candidate.version.version, range)
    )
    .sort((a, b) => compareSemVer(b.version.version, a.version.version) ?? 0);

  if (candidates.length === 0) {
    return withReason(installedVersion, SkillUpdateRecommendationReason.UP_TO_DATE);
  }

  const latestVersion = candidates[0].version.version;
  const compatible = candidates.find(
    (candidate) => candidate.compatibility.status === 'compatible'
  );
  if (compatible) {
    return {
      installedVersion,
      updateAvailable: true,
      latestVersion,
      candidates,
      recommended: compatible,
      reasonCode: SkillUpdateRecommendationReason.HIGHEST_COMPATIBLE,
    };
  }

  // Host version unknown: nothing can be *proven* compatible, so the newest
  // candidate is offered with an explicit unverified reason rather than hidden.
  if (currentVersion === null) {
    return {
      installedVersion,
      updateAvailable: true,
      latestVersion,
      candidates,
      recommended: candidates[0],
      reasonCode: SkillUpdateRecommendationReason.LATEST_UNVERIFIED,
    };
  }

  return {
    installedVersion,
    updateAvailable: true,
    latestVersion,
    candidates,
    recommended: null,
    reasonCode: SkillUpdateRecommendationReason.NONE_COMPATIBLE,
  };
}

/** Find one candidate by exact version. Returns null when it is not offerable. */
export function findSkillUpdateCandidate(
  availability: SkillUpdateAvailability,
  version: string
): SkillUpdateCandidate | null {
  return (
    availability.candidates.find((candidate) => candidate.version.version === version) ?? null
  );
}
