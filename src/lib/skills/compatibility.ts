/**
 * CommandMate compatibility judgement and version resolution (Issue #1231)
 *
 * Pure functions: no filesystem, no network, no process state. The host version
 * is always an explicit argument so UI, API and CLI can evaluate the same
 * Catalog against the same rules and reach the same verdict.
 *
 * Every verdict carries a stable machine code *and* a human-readable message
 * (受入条件: "互換性NGの理由がmachine-readable codeとhuman-readable messageで返る").
 * Messages are built from the code, the declared range and the host version
 * only — never from a path, token or URL.
 *
 * @module lib/skills/compatibility
 */

// Sibling modules of the same package are imported directly rather than through
// the `@/lib/skills` barrel, so adding this module to the barrel later can never
// introduce an import cycle. External callers still go through the barrel.
import { AGENT_SUPPORT_LABEL_KEYS } from '@/lib/skills/constants';
import {
  compareSemVer,
  isValidSkillVersionRange,
  parseSemVer,
  satisfiesSkillVersionRange,
} from '@/lib/skills/semver';
import type {
  SkillAgentCompatibility,
  SkillAgentSupport,
  SkillCatalog,
  SkillCatalogEntry,
  SkillCatalogVersion,
} from '@/types/skills';

// =============================================================================
// Vocabulary
// =============================================================================

/**
 * Three-valued compatibility verdict.
 *
 * `unknown` is never rendered as compatible (UX-07): it means the judgement
 * could not be made, which is a different user-facing state from "will not work".
 */
export type SkillCompatibilityStatus = 'compatible' | 'incompatible' | 'unknown';

/** Stable reason codes for a CommandMate compatibility verdict. */
export const SkillCompatibilityReason = {
  /** Host version satisfies the declared range. */
  SATISFIED: 'SKILL_COMPAT_SATISFIED',
  /** Host version is valid but outside the declared range. */
  HOST_VERSION_OUT_OF_RANGE: 'SKILL_COMPAT_HOST_VERSION_OUT_OF_RANGE',
  /** The running CommandMate version could not be determined. */
  HOST_VERSION_UNKNOWN: 'SKILL_COMPAT_HOST_VERSION_UNKNOWN',
  /** The publisher's range is not expressible in the supported grammar. */
  RANGE_UNSUPPORTED: 'SKILL_COMPAT_RANGE_UNSUPPORTED',
} as const;

export type SkillCompatibilityReasonCode =
  (typeof SkillCompatibilityReason)[keyof typeof SkillCompatibilityReason];

/** i18n keys paired with each reason code, so UI and CLI share one vocabulary. */
export const SKILL_COMPATIBILITY_MESSAGE_KEYS: Record<SkillCompatibilityReasonCode, string> = {
  [SkillCompatibilityReason.SATISFIED]: 'skills.compatibility.reason.satisfied',
  [SkillCompatibilityReason.HOST_VERSION_OUT_OF_RANGE]:
    'skills.compatibility.reason.hostVersionOutOfRange',
  [SkillCompatibilityReason.HOST_VERSION_UNKNOWN]: 'skills.compatibility.reason.hostVersionUnknown',
  [SkillCompatibilityReason.RANGE_UNSUPPORTED]: 'skills.compatibility.reason.rangeUnsupported',
};

/** A CommandMate compatibility verdict with everything needed to explain it. */
export interface SkillCommandMateCompatibility {
  status: SkillCompatibilityStatus;
  reasonCode: SkillCompatibilityReasonCode;
  /** i18n key for {@link message}. */
  messageKey: string;
  /** English fallback built from code, range and host version only. */
  message: string;
  /** Range as declared by the publisher, echoed verbatim. */
  requiredRange: string;
  /** Host version the verdict was computed against; null when undeterminable. */
  currentVersion: string | null;
}

// =============================================================================
// Host version
// =============================================================================

/**
 * Sentinel `getServerVersion()` returns when it cannot read a real version.
 *
 * It is syntactically valid SemVer, so without this guard an unreadable
 * package.json would silently produce a confident "incompatible" verdict
 * instead of the honest "unknown".
 */
export const UNKNOWN_HOST_VERSION_SENTINEL = '0.0.0';

/**
 * Normalize a raw CommandMate version into a strict SemVer 2.0 string.
 *
 * @returns The version, or null when it is absent, the unknown sentinel, or not
 *   strict SemVer 2.0 (the Skill contract rejects the `v` prefix).
 */
export function normalizeHostVersion(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === UNKNOWN_HOST_VERSION_SENTINEL) return null;
  return parseSemVer(trimmed) === null ? null : trimmed;
}

// =============================================================================
// Compatibility
// =============================================================================

function buildMessage(
  reasonCode: SkillCompatibilityReasonCode,
  requiredRange: string,
  currentVersion: string | null
): string {
  switch (reasonCode) {
    case SkillCompatibilityReason.SATISFIED:
      return `CommandMate ${currentVersion} satisfies the required range "${requiredRange}".`;
    case SkillCompatibilityReason.HOST_VERSION_OUT_OF_RANGE:
      return `This Skill requires CommandMate "${requiredRange}", but CommandMate ${currentVersion} is running.`;
    case SkillCompatibilityReason.HOST_VERSION_UNKNOWN:
      return `The running CommandMate version could not be determined, so compatibility with "${requiredRange}" is unverified.`;
    case SkillCompatibilityReason.RANGE_UNSUPPORTED:
      return `This Skill declares the unsupported CommandMate version range "${requiredRange}", so compatibility is unverified.`;
  }
}

function verdict(
  status: SkillCompatibilityStatus,
  reasonCode: SkillCompatibilityReasonCode,
  requiredRange: string,
  currentVersion: string | null
): SkillCommandMateCompatibility {
  return {
    status,
    reasonCode,
    messageKey: SKILL_COMPATIBILITY_MESSAGE_KEYS[reasonCode],
    message: buildMessage(reasonCode, requiredRange, currentVersion),
    requiredRange,
    currentVersion,
  };
}

/**
 * Judge whether the running CommandMate satisfies a declared version range.
 *
 * Fails closed in both directions: an unparsable range and an undeterminable
 * host version both yield `unknown`, never `compatible`.
 *
 * @param requiredRange - Range declared in `compatibility.commandmate`
 * @param currentVersion - Host version, already passed through {@link normalizeHostVersion}
 */
export function evaluateCommandMateCompatibility(
  requiredRange: string,
  currentVersion: string | null
): SkillCommandMateCompatibility {
  const range = typeof requiredRange === 'string' ? requiredRange : '';

  if (!isValidSkillVersionRange(range)) {
    return verdict(
      'unknown',
      SkillCompatibilityReason.RANGE_UNSUPPORTED,
      range,
      currentVersion ?? null
    );
  }
  if (currentVersion === null) {
    return verdict('unknown', SkillCompatibilityReason.HOST_VERSION_UNKNOWN, range, null);
  }
  if (!satisfiesSkillVersionRange(currentVersion, range)) {
    return verdict(
      'incompatible',
      SkillCompatibilityReason.HOST_VERSION_OUT_OF_RANGE,
      range,
      currentVersion
    );
  }
  return verdict('compatible', SkillCompatibilityReason.SATISFIED, range, currentVersion);
}

/** Judge one Catalog version against the running CommandMate. */
export function evaluateVersionCompatibility(
  version: SkillCatalogVersion,
  currentVersion: string | null
): SkillCommandMateCompatibility {
  return evaluateCommandMateCompatibility(version.compatibility.commandmate, currentVersion);
}

// =============================================================================
// Agent compatibility
// =============================================================================

/** Agent support claim enriched with its shared label key (UX-05). */
export interface SkillAgentCompatibilityView {
  agent: SkillAgentCompatibility['agent'];
  support: SkillAgentSupport;
  labelKey: string;
  evidence: string;
}

/** Attach the shared i18n label key to each Agent support claim. */
export function describeAgentCompatibility(
  agents: readonly SkillAgentCompatibility[]
): SkillAgentCompatibilityView[] {
  return agents.map((entry) => ({
    agent: entry.agent,
    support: entry.support,
    labelKey: AGENT_SUPPORT_LABEL_KEYS[entry.support],
    evidence: entry.evidence,
  }));
}

// =============================================================================
// Version resolution
// =============================================================================

/** Why a particular version was recommended, or why none was. */
export const SkillRecommendationReason = {
  /** Highest listed version that is compatible with the running CommandMate. */
  HIGHEST_COMPATIBLE: 'SKILL_RECOMMEND_HIGHEST_COMPATIBLE',
  /** Host version is unknown, so the publisher's `latest` is offered unverified. */
  LATEST_UNVERIFIED: 'SKILL_RECOMMEND_LATEST_UNVERIFIED',
  /** Every listed version is incompatible with the running CommandMate. */
  NONE_COMPATIBLE: 'SKILL_RECOMMEND_NONE_COMPATIBLE',
  /** No version survived filtering (e.g. prerelease-only entry without opt-in). */
  NO_VERSIONS: 'SKILL_RECOMMEND_NO_VERSIONS',
} as const;

export type SkillRecommendationReasonCode =
  (typeof SkillRecommendationReason)[keyof typeof SkillRecommendationReason];

/** One listed version paired with its compatibility verdict. */
export interface SkillResolvedVersion {
  version: SkillCatalogVersion;
  prerelease: boolean;
  compatibility: SkillCommandMateCompatibility;
}

/** Outcome of resolving the version list of one Catalog entry. */
export interface SkillVersionResolution {
  /** Listed versions, newest first by SemVer 2.0 precedence. */
  versions: SkillResolvedVersion[];
  /** The version to offer by default, or null when nothing can be offered. */
  recommended: SkillResolvedVersion | null;
  reasonCode: SkillRecommendationReasonCode;
}

/** Options for {@link resolveSkillVersions}. */
export interface SkillVersionResolutionOptions {
  /** Host version, already passed through {@link normalizeHostVersion}. */
  currentVersion: string | null;
  /** Include prerelease versions. Off by default: prereleases require opt-in. */
  includePrerelease?: boolean;
}

function isPrerelease(version: string): boolean {
  const parsed = parseSemVer(version);
  return parsed !== null && parsed.prerelease.length > 0;
}

/**
 * Sort, filter and pick a default version for one Catalog entry.
 *
 * Prereleases are excluded unless explicitly requested. Versions the Catalog
 * validator already accepted are strict SemVer 2.0, so ordering is total.
 */
export function resolveSkillVersions(
  entry: SkillCatalogEntry,
  options: SkillVersionResolutionOptions
): SkillVersionResolution {
  const { currentVersion, includePrerelease = false } = options;

  const versions: SkillResolvedVersion[] = entry.versions
    .map((version) => ({
      version,
      prerelease: isPrerelease(version.version),
      compatibility: evaluateVersionCompatibility(version, currentVersion),
    }))
    .filter((candidate) => includePrerelease || !candidate.prerelease)
    .sort((a, b) => (compareSemVer(b.version.version, a.version.version) ?? 0));

  if (versions.length === 0) {
    return { versions, recommended: null, reasonCode: SkillRecommendationReason.NO_VERSIONS };
  }

  const compatible = versions.find((candidate) => candidate.compatibility.status === 'compatible');
  if (compatible) {
    return {
      versions,
      recommended: compatible,
      reasonCode: SkillRecommendationReason.HIGHEST_COMPATIBLE,
    };
  }

  // Host version unknown: nothing can be *proven* compatible, so the publisher's
  // `latest` is offered with an explicit unverified reason rather than hidden.
  if (currentVersion === null) {
    const latest =
      versions.find((candidate) => candidate.version.version === entry.latest) ?? versions[0];
    return {
      versions,
      recommended: latest,
      reasonCode: SkillRecommendationReason.LATEST_UNVERIFIED,
    };
  }

  return { versions, recommended: null, reasonCode: SkillRecommendationReason.NONE_COMPATIBLE };
}

/** Find one entry by exact Skill ID. Returns null when absent. */
export function findSkillCatalogEntry(catalog: SkillCatalog, id: string): SkillCatalogEntry | null {
  return catalog.entries.find((entry) => entry.id === id) ?? null;
}
