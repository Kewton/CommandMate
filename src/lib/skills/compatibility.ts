/**
 * CommandMate compatibility judgement and version resolution (Issue #1231)
 *
 * Pure functions: no filesystem, no network, no process state. The host version
 * and the current instant are always explicit arguments so UI, API and CLI can
 * evaluate the same Catalog against the same rules and reach the same verdict.
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
import {
  deriveMatrixAgentSupport,
  evidenceAgeInDays,
  findSkillAgentMatrixEntry,
  isAgentMeasured,
  isEvidenceStale,
  AGENT_AXIS_LABEL_KEYS,
  AGENT_RELOAD_MESSAGE_KEYS,
  type SkillAgentAxis,
  type SkillAgentAxisEvidence,
  type SkillAgentAxisOutcome,
  type SkillAgentMatrixEntry,
  type SkillEvidenceKind,
} from '@/lib/skills/compatibility-matrix';
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

/**
 * How the publisher's declaration stands up against what CommandMate measured
 * (Issue #1246).
 */
export const SkillAgentVerification = {
  /** Declaration and measurement agree. */
  CONFIRMED: 'SKILL_AGENT_EVIDENCE_CONFIRMED',
  /** Measurement is weaker than the declaration, so the declaration is capped. */
  RESTRICTED: 'SKILL_AGENT_EVIDENCE_RESTRICTED',
  /** Measurement is stronger than the declaration; the manifest has fallen behind. */
  STALE_DECLARATION: 'SKILL_AGENT_EVIDENCE_STALE_DECLARATION',
  /** CommandMate has never measured this Agent. */
  UNVERIFIED: 'SKILL_AGENT_EVIDENCE_UNVERIFIED',
} as const;

export type SkillAgentVerificationCode =
  (typeof SkillAgentVerification)[keyof typeof SkillAgentVerification];

export const SKILL_AGENT_VERIFICATION_MESSAGE_KEYS: Record<SkillAgentVerificationCode, string> = {
  [SkillAgentVerification.CONFIRMED]: 'skills.compatibility.verification.confirmed',
  [SkillAgentVerification.RESTRICTED]: 'skills.compatibility.verification.restricted',
  [SkillAgentVerification.STALE_DECLARATION]: 'skills.compatibility.verification.staleDeclaration',
  [SkillAgentVerification.UNVERIFIED]: 'skills.compatibility.verification.unverified',
};

/**
 * Ordering used to cap a declaration by a measurement. Higher is stronger.
 *
 * `unknown` outranks `unsupported` because "we could not tell" leaves more room
 * than "we established it does not work".
 */
const AGENT_SUPPORT_RANK: Record<SkillAgentSupport, number> = {
  unsupported: 0,
  unknown: 1,
  commandmate_runtime: 2,
  native: 3,
};

/** What the reconciler decided and why. */
export interface SkillAgentSupportReconciliation {
  support: SkillAgentSupport;
  verification: SkillAgentVerificationCode;
}

/**
 * Cap a publisher's declaration by what CommandMate measured.
 *
 * Downward only. A weaker measurement wins, which is what keeps an
 * evidence-free `native` off the screen. A stronger one does not: raising a
 * package's own claim is the publisher's call, so the mismatch is reported as
 * a declaration that has fallen behind.
 */
export function capSupportByMeasurement(
  declared: SkillAgentSupport,
  measured: SkillAgentSupport
): SkillAgentSupportReconciliation {
  const declaredRank = AGENT_SUPPORT_RANK[declared];
  const measuredRank = AGENT_SUPPORT_RANK[measured];

  if (measuredRank < declaredRank) {
    return { support: measured, verification: SkillAgentVerification.RESTRICTED };
  }
  if (measuredRank > declaredRank) {
    return { support: declared, verification: SkillAgentVerification.STALE_DECLARATION };
  }
  return { support: declared, verification: SkillAgentVerification.CONFIRMED };
}

/** One measured axis, ready to render. */
export interface SkillAgentAxisView {
  axis: SkillAgentAxis;
  axisKey: string;
  outcome: SkillAgentAxisOutcome;
  outcomeKey: string;
  evidenceKind: SkillEvidenceKind;
  evidenceKindKey: string;
  /** i18n key for a known limitation of this outcome, or null. */
  limitationKey: string | null;
}

/** What CommandMate measured for one Agent, with the age of that measurement. */
export interface SkillAgentMeasuredView {
  discovery: SkillAgentAxisView;
  invocation: SkillAgentAxisView;
  /** Install root prefixes the Agent was measured to read. */
  discoveryRoots: string[];
  testedVersion: string | null;
  testedDate: string | null;
  evidenceSource: string | null;
  /** Whole days since the measurement, or null when it cannot be computed. */
  ageDays: number | null;
  stale: boolean;
}

/** Agent support claim enriched with its shared label key (UX-05) and evidence. */
export interface SkillAgentCompatibilityView {
  agent: SkillAgentCompatibility['agent'];
  /**
   * The support level CommandMate is willing to show, never above what evidence
   * carries. Equal to {@link declaredSupport} unless a measurement caps it.
   */
  support: SkillAgentSupport;
  labelKey: string;
  evidence: string;
  /** The publisher's own claim, kept so a capped verdict can still be explained. */
  declaredSupport: SkillAgentSupport;
  declaredLabelKey: string;
  verification: SkillAgentVerificationCode;
  verificationKey: string;
  /** CommandMate's measurement, or null when this Agent has never been measured. */
  measured: SkillAgentMeasuredView | null;
  /** i18n key for why no measurement exists; null when measured. */
  skipReasonKey: string | null;
  /** i18n key for how to make the Agent pick up the installed Skill. */
  reloadKey: string;
}

function toAxisView(axis: SkillAgentAxis, evidence: SkillAgentAxisEvidence): SkillAgentAxisView {
  return {
    axis,
    axisKey: AGENT_AXIS_LABEL_KEYS[axis],
    outcome: evidence.outcome,
    outcomeKey: evidence.labelKey,
    evidenceKind: evidence.evidenceKind,
    evidenceKindKey: evidence.evidenceKindKey,
    limitationKey: evidence.limitationKey,
  };
}

function toMeasuredView(entry: SkillAgentMatrixEntry, now: Date): SkillAgentMeasuredView {
  return {
    discovery: toAxisView('discovery', entry.discovery),
    invocation: toAxisView('invocation', entry.invocation),
    discoveryRoots: [...entry.discoveryRoots],
    testedVersion: entry.testedVersion,
    testedDate: entry.testedDate,
    evidenceSource: entry.evidenceSource,
    ageDays: evidenceAgeInDays(entry, now),
    stale: isEvidenceStale(entry, now),
  };
}

/**
 * Reconcile one declared Agent claim with the measured discovery matrix.
 *
 * The declaration is never rewritten upward: a measurement stronger than the
 * manifest is reported as a stale declaration, not silently promoted, because
 * the publisher is the one who decides what their package claims to support.
 * It *is* capped downward, which is what keeps "evidence-free native" off the
 * screen when a manifest asserts an Agent CommandMate measured as unsupported.
 */
export function reconcileAgentSupport(
  declared: SkillAgentCompatibility,
  now: Date
): SkillAgentCompatibilityView {
  const entry = findSkillAgentMatrixEntry(declared.agent);
  const base = {
    agent: declared.agent,
    evidence: declared.evidence,
    declaredSupport: declared.support,
    declaredLabelKey: AGENT_SUPPORT_LABEL_KEYS[declared.support],
  };

  if (entry === null || !isAgentMeasured(entry)) {
    return {
      ...base,
      support: declared.support,
      labelKey: AGENT_SUPPORT_LABEL_KEYS[declared.support],
      verification: SkillAgentVerification.UNVERIFIED,
      verificationKey:
        SKILL_AGENT_VERIFICATION_MESSAGE_KEYS[SkillAgentVerification.UNVERIFIED],
      measured: null,
      skipReasonKey: entry?.skipReasonKey ?? null,
      reloadKey: entry?.reloadKey ?? AGENT_RELOAD_MESSAGE_KEYS.UNKNOWN,
    };
  }

  const { support, verification } = capSupportByMeasurement(
    declared.support,
    deriveMatrixAgentSupport(entry)
  );

  return {
    ...base,
    support,
    labelKey: AGENT_SUPPORT_LABEL_KEYS[support],
    verification,
    verificationKey: SKILL_AGENT_VERIFICATION_MESSAGE_KEYS[verification],
    measured: toMeasuredView(entry, now),
    skipReasonKey: null,
    reloadKey: entry.reloadKey,
  };
}

/**
 * Attach the shared i18n label key and the measured evidence to each claim.
 *
 * @param now - Evaluated against for evidence staleness. Passed explicitly by
 *   tests so a verdict never depends on when the suite runs.
 */
export function describeAgentCompatibility(
  agents: readonly SkillAgentCompatibility[],
  now: Date = new Date()
): SkillAgentCompatibilityView[] {
  return agents.map((entry) => reconcileAgentSupport(entry, now));
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
