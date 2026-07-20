/**
 * Integrity verification and failure vocabulary for Skill fetching (Issue #1229)
 *
 * Two responsibilities that belong together: deciding whether a byte stream is
 * the artifact the Catalog promised, and naming the ways that decision can fail.
 *
 * The error type is deliberately separate from `SkillContractError` (#1228):
 * that one describes a *document* that failed validation and is addressed by a
 * JSON pointer. These describe a *transfer or storage* failure and carry a
 * retryability hint instead, because that is the question the UI has to answer
 * ("can I press retry?", UX-09). Messages are derived from the code alone, so
 * no token, signed query or machine-absolute path can leak through them.
 *
 * @module lib/skills/integrity
 */

import { createHash, timingSafeEqual } from 'crypto';
import {
  GIT_COMMIT_SHA_PATTERN,
  SHA256_HEX_PATTERN,
  SKILL_ARTIFACT_CONTENT_TYPE,
  SKILL_ARTIFACT_FORMAT,
  SKILL_ARTIFACT_MAX_SIZE,
  buildSkillAssetName,
  isValidSemVer,
} from '@/lib/skills';
import type { SkillCatalogVersion } from '@/types/skills';

// =============================================================================
// Error vocabulary
// =============================================================================

/** Stable, client-safe reason codes for fetch and snapshot failures. */
export const SkillFetchErrorCode = {
  /** URL is syntactically unusable (not absolute, not HTTPS, carries userinfo, …). */
  URL_INVALID: 'SKILL_FETCH_URL_INVALID',
  /** URL points outside the official allowlist for its document kind. */
  SOURCE_NOT_ALLOWED: 'SKILL_FETCH_SOURCE_NOT_ALLOWED',
  /** A redirect response was malformed or had no usable `Location`. */
  REDIRECT_INVALID: 'SKILL_FETCH_REDIRECT_INVALID',
  /** More redirect hops than the policy permits. */
  REDIRECT_LIMIT_EXCEEDED: 'SKILL_FETCH_REDIRECT_LIMIT_EXCEEDED',
  /** Server answered with a non-success status. */
  HTTP_STATUS: 'SKILL_FETCH_HTTP_STATUS',
  /** Response media type is not the one this document kind requires. */
  CONTENT_TYPE_INVALID: 'SKILL_FETCH_CONTENT_TYPE_INVALID',
  /** Response had no readable body. */
  BODY_MISSING: 'SKILL_FETCH_BODY_MISSING',
  /** Declared or measured size exceeded the policy limit. */
  SIZE_LIMIT_EXCEEDED: 'SKILL_FETCH_SIZE_LIMIT_EXCEEDED',
  /** Transferred size did not match the size the Catalog declared. */
  SIZE_MISMATCH: 'SKILL_FETCH_SIZE_MISMATCH',
  /** SHA-256 over the received bytes did not match the Catalog digest. */
  CHECKSUM_MISMATCH: 'SKILL_FETCH_CHECKSUM_MISMATCH',
  /** Catalog version is not bound to an immutable commit and exact version. */
  BINDING_INVALID: 'SKILL_FETCH_BINDING_INVALID',
  /** Request exceeded the header or total timeout. */
  TIMEOUT: 'SKILL_FETCH_TIMEOUT',
  /** Caller aborted the operation. */
  ABORTED: 'SKILL_FETCH_ABORTED',
  /** Transport-level failure (DNS, TLS, connection reset, …). */
  NETWORK: 'SKILL_FETCH_NETWORK',
  /** Snapshot ID is unknown, already released or malformed. */
  SNAPSHOT_NOT_FOUND: 'SKILL_SNAPSHOT_NOT_FOUND',
  /** Snapshot exists but its TTL has elapsed. */
  SNAPSHOT_EXPIRED: 'SKILL_SNAPSHOT_EXPIRED',
  /** Storing the snapshot would exceed the disk or count quota. */
  QUOTA_EXCEEDED: 'SKILL_SNAPSHOT_QUOTA_EXCEEDED',
  /** Snapshot store could not read or write the service-owned data root. */
  STORE_IO: 'SKILL_SNAPSHOT_STORE_IO',
  /** Snapshot store was used before initialization. */
  STORE_UNINITIALIZED: 'SKILL_SNAPSHOT_STORE_UNINITIALIZED',
} as const;

export type SkillFetchErrorCodeType =
  (typeof SkillFetchErrorCode)[keyof typeof SkillFetchErrorCode];

/** Bounded, non-sensitive context attached to a failure. */
export type SkillFetchErrorDetail = Record<string, string | number | boolean>;

/**
 * Codes worth retrying without user intervention.
 *
 * A checksum mismatch or a disallowed source is *not* here on purpose: retrying
 * either one would just re-download bytes we already decided not to trust.
 */
const RETRYABLE_CODES: ReadonlySet<string> = new Set<string>([
  SkillFetchErrorCode.TIMEOUT,
  SkillFetchErrorCode.NETWORK,
  SkillFetchErrorCode.HTTP_STATUS,
  SkillFetchErrorCode.STORE_IO,
]);

/** Human-readable text per code. Contains no interpolated runtime value. */
const MESSAGES: Record<SkillFetchErrorCodeType, string> = {
  [SkillFetchErrorCode.URL_INVALID]: 'Skill source URL is not a usable HTTPS URL',
  [SkillFetchErrorCode.SOURCE_NOT_ALLOWED]: 'Skill source is not on the official allowlist',
  [SkillFetchErrorCode.REDIRECT_INVALID]: 'Skill source redirect was malformed',
  [SkillFetchErrorCode.REDIRECT_LIMIT_EXCEEDED]: 'Skill source exceeded the redirect limit',
  [SkillFetchErrorCode.HTTP_STATUS]: 'Skill source responded with an error status',
  [SkillFetchErrorCode.CONTENT_TYPE_INVALID]: 'Skill source returned an unexpected media type',
  [SkillFetchErrorCode.BODY_MISSING]: 'Skill source response had no body',
  [SkillFetchErrorCode.SIZE_LIMIT_EXCEEDED]: 'Skill source response exceeded the size limit',
  [SkillFetchErrorCode.SIZE_MISMATCH]: 'Skill artifact size did not match the catalog',
  [SkillFetchErrorCode.CHECKSUM_MISMATCH]: 'Skill artifact checksum did not match the catalog',
  [SkillFetchErrorCode.BINDING_INVALID]: 'Skill catalog version is not bound to an immutable source',
  [SkillFetchErrorCode.TIMEOUT]: 'Skill source request timed out',
  [SkillFetchErrorCode.ABORTED]: 'Skill source request was aborted',
  [SkillFetchErrorCode.NETWORK]: 'Skill source could not be reached',
  [SkillFetchErrorCode.SNAPSHOT_NOT_FOUND]: 'Skill snapshot is unknown or already released',
  [SkillFetchErrorCode.SNAPSHOT_EXPIRED]: 'Skill snapshot has expired',
  [SkillFetchErrorCode.QUOTA_EXCEEDED]: 'Skill snapshot store quota exceeded',
  [SkillFetchErrorCode.STORE_IO]: 'Skill snapshot store could not be accessed',
  [SkillFetchErrorCode.STORE_UNINITIALIZED]: 'Skill snapshot store is not initialized',
};

/** A fetch or snapshot failure, safe to surface to API clients and logs. */
export class SkillFetchError extends Error {
  readonly code: SkillFetchErrorCodeType;
  /** Whether a plain retry could plausibly succeed. */
  readonly retryable: boolean;
  readonly detail?: SkillFetchErrorDetail;

  constructor(code: SkillFetchErrorCodeType, detail?: SkillFetchErrorDetail) {
    super(MESSAGES[code]);
    this.name = 'SkillFetchError';
    this.code = code;
    this.retryable = RETRYABLE_CODES.has(code);
    if (detail) this.detail = detail;
  }
}

/** Narrow an unknown thrown value to a {@link SkillFetchError}. */
export function isSkillFetchError(value: unknown): value is SkillFetchError {
  return value instanceof SkillFetchError;
}

// =============================================================================
// Redaction
// =============================================================================

/**
 * Reduce a URL to its origin for logging.
 *
 * Release asset URLs carry signed query parameters that are credentials in
 * everything but name, and the path can identify a private repository. Only the
 * origin is ever safe to record.
 */
export function redactUrlForLog(rawUrl: string): string {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return '<invalid-url>';
  }
}

// =============================================================================
// Digests
// =============================================================================

/** Incremental SHA-256 over a stream, so nothing has to be buffered twice. */
export interface Sha256Accumulator {
  update(chunk: Uint8Array): void;
  /** Lowercase hex digest. Calling twice is not supported. */
  hex(): string;
}

/** Create an incremental SHA-256 accumulator. */
export function createSha256Accumulator(): Sha256Accumulator {
  const hash = createHash('sha256');
  return {
    update(chunk: Uint8Array): void {
      hash.update(chunk);
    },
    hex(): string {
      return hash.digest('hex');
    },
  };
}

/** Lowercase hex SHA-256 of a complete buffer. */
export function computeSha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Compare two lowercase hex SHA-256 digests without leaking timing.
 *
 * Malformed input is a mismatch rather than a throw, so no caller can turn a
 * bad digest into an accepted artifact by catching the wrong exception.
 */
export function digestMatches(expected: string, actual: string): boolean {
  if (!SHA256_HEX_PATTERN.test(expected) || !SHA256_HEX_PATTERN.test(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

// =============================================================================
// Catalog binding
// =============================================================================

/**
 * Assert that a Catalog version identifies one immutable artifact.
 *
 * `validateSkillCatalog` (#1228) already proves the document is well-formed.
 * This is the separate question of whether the entry pins its bytes: an exact
 * SemVer, a resolved 40-hex commit, the conventional asset name, and the one
 * artifact format and media type this build accepts.
 *
 * @throws SkillFetchError with `BINDING_INVALID`
 */
export function assertArtifactBinding(skillId: string, version: SkillCatalogVersion): void {
  const fail = (field: string): never => {
    throw new SkillFetchError(SkillFetchErrorCode.BINDING_INVALID, { field });
  };

  if (!isValidSemVer(version.version)) fail('version');
  if (!GIT_COMMIT_SHA_PATTERN.test(version.source.commit)) fail('source.commit');
  if (version.artifact.asset_name !== buildSkillAssetName(skillId, version.version)) {
    fail('artifact.asset_name');
  }
  if (version.artifact.format !== SKILL_ARTIFACT_FORMAT) fail('artifact.format');
  if (version.artifact.content_type !== SKILL_ARTIFACT_CONTENT_TYPE) fail('artifact.content_type');
  if (!SHA256_HEX_PATTERN.test(version.artifact.sha256)) fail('artifact.sha256');
  if (
    !Number.isSafeInteger(version.artifact.size) ||
    version.artifact.size <= 0 ||
    version.artifact.size > SKILL_ARTIFACT_MAX_SIZE
  ) {
    fail('artifact.size');
  }
}

/** What a transfer claimed to be, checked against what the Catalog promised. */
export interface ArtifactIntegrityInput {
  expectedSha256: string;
  expectedSize: number;
  actualSha256: string;
  actualSize: number;
}

/**
 * Verify transferred bytes against the Catalog record.
 *
 * Size is checked first so a truncated transfer reports the useful reason
 * rather than the digest mismatch it also causes.
 *
 * @throws SkillFetchError with `SIZE_MISMATCH` or `CHECKSUM_MISMATCH`
 */
export function verifyArtifactIntegrity(input: ArtifactIntegrityInput): void {
  if (input.actualSize !== input.expectedSize) {
    throw new SkillFetchError(SkillFetchErrorCode.SIZE_MISMATCH, {
      expected: input.expectedSize,
      actual: input.actualSize,
    });
  }
  if (!digestMatches(input.expectedSha256, input.actualSha256)) {
    throw new SkillFetchError(SkillFetchErrorCode.CHECKSUM_MISMATCH);
  }
}
