/**
 * Skill Catalog API serialization (Issue #1231)
 *
 * The single mapping from the internal Catalog document to the wire shape used
 * by both `/api/skills` and `/api/skills/[id]`, so UI and CLI consume one
 * contract and cannot drift apart.
 *
 * Two deliberate omissions:
 * - `artifact.url` is never serialized. Download URLs can be signed, are treated
 *   as secrets, and resolving one is the server's job at install time (#1229).
 *   A client therefore has no URL field it could echo back and have honoured.
 * - No machine-absolute path, token or raw upstream response is ever included.
 *
 * @module lib/api/skills-api
 */

import { NextResponse } from 'next/server';
import type {
  SkillCatalogSnapshot,
  SkillCatalogFailureCode,
} from '@/lib/skills/catalog-client';
import {
  describeAgentCompatibility,
  evaluateVersionCompatibility,
  resolveSkillVersions,
  type SkillAgentCompatibilityView,
  type SkillCommandMateCompatibility,
  type SkillRecommendationReasonCode,
  type SkillResolvedVersion,
} from '@/lib/skills/compatibility';
import type {
  SkillArtifactFormat,
  SkillCatalogEntry,
  SkillProvider,
  SkillRiskLevel,
} from '@/types/skills';

// =============================================================================
// Wire types
// =============================================================================

/** Freshness and provenance of the Catalog the response was built from. */
export interface SkillCatalogMetaDto {
  schemaVersion: number;
  /** RFC 3339 UTC instant the served Catalog was last validated. */
  fetchedAt: string;
  /** RFC 3339 UTC instant it was last confirmed current with the origin. */
  revalidatedAt: string;
  stale: boolean;
  offline: boolean;
  state: SkillCatalogSnapshot['state'];
  staleReason: SkillCatalogFailureCode | null;
  source: {
    repository: string;
    ref: string;
    /** Document-level revision (origin ETag), or null. */
    revision: string | null;
  };
}

/** Artifact identity without its URL. */
export interface SkillArtifactDto {
  assetName: string;
  sha256: string;
  size: number;
  format: SkillArtifactFormat;
}

/** One published version with its compatibility verdict. */
export interface SkillVersionDto {
  version: string;
  changelog: string;
  publishedAt: string;
  declaredRisk: SkillRiskLevel;
  prerelease: boolean;
  source: {
    repository: string;
    ref: string;
    /** Resolved 40-hex commit SHA — the trusted per-release coordinate. */
    commit: string;
  };
  artifact: SkillArtifactDto;
  compatibility: {
    commandmate: SkillCommandMateCompatibility;
    agents: SkillAgentCompatibilityView[];
  };
}

/** One Catalog entry as served to clients. */
export interface SkillDto {
  id: string;
  name: string;
  summary: string;
  provider: SkillProvider;
  license: string;
  homepage: string | null;
  keywords: string[];
  /** `latest` as published by the Catalog, regardless of compatibility. */
  latest: string;
  /** Version to offer by default, or null when none can be offered. */
  recommendedVersion: string | null;
  recommendedReason: SkillRecommendationReasonCode;
  /**
   * Verdict for {@link recommendedVersion} when present, otherwise for the
   * newest listed version — so an incompatible Skill still explains which
   * CommandMate version it needs (受入条件: 手動確認 2).
   */
  compatibility: SkillCommandMateCompatibility | null;
  versions: SkillVersionDto[];
}

export interface SkillListResponse {
  catalog: SkillCatalogMetaDto;
  skills: SkillDto[];
}

export interface SkillDetailResponse {
  catalog: SkillCatalogMetaDto;
  skill: SkillDto;
}

/** Error body shared by every Skill API route. */
export interface SkillApiErrorResponse {
  error: string;
  code: string;
}

// =============================================================================
// Mapping
// =============================================================================

/** Serialize the freshness metadata of a snapshot. */
export function toCatalogMetaDto(snapshot: SkillCatalogSnapshot): SkillCatalogMetaDto {
  return {
    schemaVersion: snapshot.catalog.schema_version,
    fetchedAt: snapshot.fetchedAt,
    revalidatedAt: snapshot.revalidatedAt,
    stale: snapshot.stale,
    offline: snapshot.offline,
    state: snapshot.state,
    staleReason: snapshot.staleReason,
    source: { ...snapshot.source },
  };
}

function toVersionDto(resolved: SkillResolvedVersion): SkillVersionDto {
  const { version, prerelease, compatibility } = resolved;
  return {
    version: version.version,
    changelog: version.changelog,
    publishedAt: version.published_at,
    declaredRisk: version.declared_risk,
    prerelease,
    source: {
      repository: version.source.repository,
      ref: version.source.ref,
      commit: version.source.commit,
    },
    artifact: {
      assetName: version.artifact.asset_name,
      sha256: version.artifact.sha256,
      size: version.artifact.size,
      format: version.artifact.format,
    },
    compatibility: {
      commandmate: compatibility,
      agents: describeAgentCompatibility(version.compatibility.agents),
    },
  };
}

/** Serialize one Catalog entry, resolving versions against the running CommandMate. */
export function toSkillDto(
  entry: SkillCatalogEntry,
  options: { currentVersion: string | null; includePrerelease: boolean }
): SkillDto {
  const resolution = resolveSkillVersions(entry, {
    currentVersion: options.currentVersion,
    includePrerelease: options.includePrerelease,
  });

  // When every version was filtered out (a prerelease-only entry without opt-in)
  // the client still needs a reason, so fall back to the publisher's `latest`.
  const filteredOutFallback = entry.versions.find((v) => v.version === entry.latest);
  const headline =
    resolution.recommended?.compatibility ??
    resolution.versions[0]?.compatibility ??
    (filteredOutFallback
      ? evaluateVersionCompatibility(filteredOutFallback, options.currentVersion)
      : null);

  return {
    id: entry.id,
    name: entry.name,
    summary: entry.summary,
    provider: { ...entry.provider },
    license: entry.license,
    homepage: entry.homepage ?? null,
    keywords: entry.keywords ? [...entry.keywords] : [],
    latest: entry.latest,
    recommendedVersion: resolution.recommended?.version.version ?? null,
    recommendedReason: resolution.reasonCode,
    compatibility: headline,
    versions: resolution.versions.map(toVersionDto),
  };
}

// =============================================================================
// Response helpers
// =============================================================================

/**
 * [SEC] Catalog responses must not be stored by intermediaries: freshness is
 * part of the contract, and a proxy-cached body would defeat the stale flag.
 */
export const SKILL_API_NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
} as const;

/** Build a JSON error body with a stable machine code. */
export function skillApiError(
  code: string,
  message: string,
  status: number
): NextResponse<SkillApiErrorResponse> {
  return NextResponse.json(
    { error: message, code },
    { status, headers: SKILL_API_NO_STORE_HEADERS }
  );
}

/** Read the opt-in prerelease flag. Anything other than `true` means "no". */
export function readPrereleaseFlag(url: URL): boolean {
  return url.searchParams.get('prerelease') === 'true';
}
