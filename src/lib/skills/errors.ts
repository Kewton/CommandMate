/**
 * Typed errors for the Agent Skills distribution contract (Issue #1228)
 *
 * Every rejection carries a stable machine code plus a JSON-Pointer-like path,
 * so callers can branch on the reason and localize the message without parsing
 * prose. Messages are built from the code and the document path only: they
 * never embed a token, signed URL, secret or machine-absolute path.
 *
 * @module lib/skills/errors
 */

/** Stable, client-safe reason codes for contract validation failures. */
export const SkillContractErrorCode = {
  /** Document is not a plain object. */
  NOT_AN_OBJECT: 'SKILL_NOT_AN_OBJECT',
  /** `schema_version` is missing, malformed, or newer than this build supports. */
  SCHEMA_VERSION_UNSUPPORTED: 'SKILL_SCHEMA_VERSION_UNSUPPORTED',
  /** A required field is absent. */
  MISSING_FIELD: 'SKILL_MISSING_FIELD',
  /** A field exists but has the wrong JSON type. */
  INVALID_TYPE: 'SKILL_INVALID_TYPE',
  /** A field carries a value outside its enumeration. */
  INVALID_ENUM: 'SKILL_INVALID_ENUM',
  /** A field is syntactically wrong (pattern mismatch). */
  INVALID_FORMAT: 'SKILL_INVALID_FORMAT',
  /** A numeric or length bound was exceeded. */
  LIMIT_EXCEEDED: 'SKILL_LIMIT_EXCEEDED',
  /** An unspecified field is present; schema_version 1 is closed. */
  UNKNOWN_FIELD: 'SKILL_UNKNOWN_FIELD',
  /** Skill ID does not match the slug grammar. */
  ID_INVALID: 'SKILL_ID_INVALID',
  /** Skill ID is reserved by CommandMate or by the host filesystem. */
  ID_RESERVED: 'SKILL_ID_RESERVED',
  /** Skill ID collides with an existing name under case/Unicode folding. */
  ID_COLLISION: 'SKILL_ID_COLLISION',
  /** Directory name, SKILL.md name and manifest id disagree. */
  ID_MISMATCH: 'SKILL_ID_MISMATCH',
  /** Version is not valid SemVer 2.0. */
  VERSION_INVALID: 'SKILL_VERSION_INVALID',
  /** Version range is not expressible in the supported range grammar. */
  VERSION_RANGE_INVALID: 'SKILL_VERSION_RANGE_INVALID',
  /** Digest is not lowercase hex SHA-256. */
  DIGEST_INVALID: 'SKILL_DIGEST_INVALID',
  /** Payload path escapes the Skill root or is otherwise unsafe. */
  FILE_PATH_UNSAFE: 'SKILL_FILE_PATH_UNSAFE',
  /** Two entries declare the same payload path (possibly after folding). */
  FILE_PATH_DUPLICATE: 'SKILL_FILE_PATH_DUPLICATE',
  /** Declared file set does not match the package's payload file set. */
  FILE_SET_MISMATCH: 'SKILL_FILE_SET_MISMATCH',
  /** Artifact name, format or Content-Type violates the packaging rule. */
  ARTIFACT_INVALID: 'SKILL_ARTIFACT_INVALID',
  /** Source ref is present but the resolved commit SHA is missing or malformed. */
  SOURCE_COMMIT_INVALID: 'SKILL_SOURCE_COMMIT_INVALID',
  /** Catalog `latest` does not resolve to a listed version. */
  CATALOG_LATEST_UNRESOLVED: 'SKILL_CATALOG_LATEST_UNRESOLVED',
  /** The same identity is declared twice within one document. */
  DUPLICATE_ENTRY: 'SKILL_DUPLICATE_ENTRY',
  /** Two fields that must agree do not. */
  INCONSISTENT_VALUE: 'SKILL_INCONSISTENT_VALUE',
} as const;

export type SkillContractErrorCodeType =
  (typeof SkillContractErrorCode)[keyof typeof SkillContractErrorCode];

/** One validation failure, addressed at a specific location in the document. */
export interface SkillContractError {
  code: SkillContractErrorCodeType;
  /** JSON-Pointer-like location, e.g. `/files/2/sha256`. Empty string for the root. */
  path: string;
  /** Client-safe description built from code and path only. */
  message: string;
  /** Bounded, non-sensitive context (expected pattern, limit, …). */
  detail?: Record<string, string | number | boolean>;
}

/** Result of validating one contract document. */
export type SkillValidationResult<T> =
  | { ok: true; value: T; errors: readonly [] }
  | { ok: false; value: null; errors: readonly SkillContractError[] };

/** Build a validation failure. */
export function skillError(
  code: SkillContractErrorCodeType,
  path: string,
  message: string,
  detail?: Record<string, string | number | boolean>
): SkillContractError {
  return detail ? { code, path, message, detail } : { code, path, message };
}

/** Wrap a validated document as a success result. */
export function skillOk<T>(value: T): SkillValidationResult<T> {
  return { ok: true, value, errors: [] };
}

/** Wrap one or more failures as a failure result. */
export function skillFail<T>(errors: readonly SkillContractError[]): SkillValidationResult<T> {
  return { ok: false, value: null, errors };
}

/** Append a segment to a JSON-Pointer-like path. */
export function joinPath(base: string, segment: string | number): string {
  return `${base}/${segment}`;
}
