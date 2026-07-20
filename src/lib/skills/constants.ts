/**
 * Agent Skills distribution contract constants (Issue #1228)
 *
 * Single source of truth for every limit, pattern and layout rule referenced by
 * docs/design/agent-skills-distribution.md. Downstream issues (#1229 catalog,
 * #1231 install, #1234 audit) must import from here rather than re-deriving
 * values, so a contract change is a one-line change.
 *
 * @module lib/skills/constants
 */

import type {
  SkillAgentSupport,
  SkillArtifactFormat,
  SkillDeclaredPermission,
  SkillFileKind,
  SkillRiskLevel,
} from '@/types/skills';

// =============================================================================
// Schema version
// =============================================================================

/** The only schema version this build understands. Anything else fails closed. */
export const SKILL_SCHEMA_VERSION = 1;

// =============================================================================
// Skill ID
// =============================================================================

/**
 * Skill ID grammar: ASCII lowercase slug.
 *
 * Anchored and ASCII-only by construction, so uppercase, Unicode homoglyphs,
 * leading/trailing hyphens and dot-prefixed names are all rejected here rather
 * than by a later, easier-to-forget check.
 */
export const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Maximum Skill ID length in characters. */
export const SKILL_ID_MAX_LENGTH = 64;

/**
 * IDs that may never be used as a Skill directory name.
 *
 * Covers Windows reserved device names (which resolve to devices regardless of
 * the directory they appear in) and names CommandMate claims for itself.
 */
export const RESERVED_SKILL_IDS: readonly string[] = [
  'commandmate',
  'system',
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
];

// =============================================================================
// Layout
// =============================================================================

/** Skill payload root inside a worktree, resolved from a registered worktree ID. */
export const SKILL_INSTALL_ROOT_PREFIX = '.agents/skills';

/** Manifest filename, placed at the Skill root next to SKILL.md. */
export const SKILL_MANIFEST_FILENAME = 'commandmate.skill.yaml';

/** Standard Agent Skills authoring file, required in every package. */
export const SKILL_MD_FILENAME = 'SKILL.md';

/**
 * Reserved private namespace for install-commit staging.
 *
 * Lives under the target `.agents/skills` so the atomic rename stays on one
 * filesystem. Excluded from Skill discovery because the leading dot is outside
 * {@link SKILL_ID_PATTERN}.
 */
export const SKILL_STAGING_DIRNAME = '.commandmate-staging';

/** Entries every valid package must contain, relative to the archive root directory. */
export const REQUIRED_PACKAGE_ENTRIES: readonly string[] = [
  SKILL_MD_FILENAME,
  SKILL_MANIFEST_FILENAME,
];

// =============================================================================
// Artifact
// =============================================================================

/** The only artifact format accepted in schema_version 1. */
export const SKILL_ARTIFACT_FORMAT: SkillArtifactFormat = 'tar.gz';

/** Required Content-Type of a release asset. */
export const SKILL_ARTIFACT_CONTENT_TYPE = 'application/gzip';

/** Maximum artifact size in bytes (16 MiB). */
export const SKILL_ARTIFACT_MAX_SIZE = 16 * 1024 * 1024;

/** Maximum size of a single payload file in bytes (4 MiB). */
export const SKILL_FILE_MAX_SIZE = 4 * 1024 * 1024;

/** Maximum number of payload files declared in a manifest. */
export const SKILL_FILES_MAX_COUNT = 500;

/** Build the required release asset name for a version. */
export function buildSkillAssetName(skillId: string, version: string): string {
  return `${skillId}-${version}.tar.gz`;
}

// =============================================================================
// Payload paths
// =============================================================================

/** Maximum length of a single path segment. */
export const SKILL_PATH_SEGMENT_MAX_LENGTH = 100;

/** Maximum number of path segments in a payload path. */
export const SKILL_PATH_MAX_DEPTH = 8;

/** Maximum total length of a payload path. */
export const SKILL_PATH_MAX_LENGTH = 255;

// =============================================================================
// Text limits
// =============================================================================

export const SKILL_NAME_MAX_LENGTH = 100;
export const SKILL_SUMMARY_MAX_LENGTH = 200;
export const SKILL_DESCRIPTION_MAX_LENGTH = 2000;
export const SKILL_BULLET_MAX_LENGTH = 200;
export const SKILL_BULLET_MAX_COUNT = 10;
export const SKILL_KEYWORDS_MAX_COUNT = 20;
export const SKILL_KEYWORD_MAX_LENGTH = 40;
export const SKILL_CHANGELOG_MAX_LENGTH = 4000;
export const SKILL_EVIDENCE_MAX_LENGTH = 300;
export const SKILL_RATIONALE_MAX_LENGTH = 500;
export const SKILL_COMMANDS_MAX_COUNT = 20;
export const SKILL_NETWORK_HOSTS_MAX_COUNT = 20;
export const SKILL_CATALOG_ENTRIES_MAX_COUNT = 500;
export const SKILL_CATALOG_VERSIONS_MAX_COUNT = 100;

// =============================================================================
// Safe YAML parse profile
// =============================================================================

/**
 * Limits any manifest YAML parser must enforce.
 *
 * The contract (not the parser) lives here: #1229/#1231 pick an implementation
 * but must reject aliases, anchors, merge keys, custom tags, duplicate keys and
 * prototype-polluting keys, and must apply these bounds.
 */
export const SKILL_YAML_SAFE_PROFILE = {
  maxBytes: 64 * 1024,
  maxDepth: 16,
  maxNodes: 5000,
  maxScalarLength: 8192,
  allowAliases: false,
  allowCustomTags: false,
  allowDuplicateKeys: false,
  /** Keys rejected outright to prevent prototype pollution through parsed objects. */
  forbiddenKeys: ['__proto__', 'constructor', 'prototype'],
} as const;

// =============================================================================
// Enumerations
// =============================================================================

export const SKILL_AGENT_SUPPORT_VALUES: readonly SkillAgentSupport[] = [
  'native',
  'commandmate_runtime',
  'unsupported',
  'unknown',
];

export const SKILL_RISK_LEVELS: readonly SkillRiskLevel[] = ['low', 'moderate', 'high'];

/** Ordering used to resolve the effective risk. Higher index wins. */
export const SKILL_RISK_ORDER: Record<SkillRiskLevel, number> = {
  low: 0,
  moderate: 1,
  high: 2,
};

export const SKILL_DECLARED_PERMISSIONS: readonly SkillDeclaredPermission[] = [
  'filesystem_read',
  'filesystem_write',
  'network_access',
  'process_execution',
  'environment_read',
  'credential_access',
];

export const SKILL_FILE_KINDS: readonly SkillFileKind[] = [
  'skill_md',
  'instruction',
  'script',
  'asset',
];

// =============================================================================
// Formats
// =============================================================================

/** Lowercase hex SHA-256. Uppercase is rejected so digests compare byte-wise. */
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** Resolved git commit SHA-1, full 40 hex digits. Abbreviations are rejected. */
export const GIT_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** `owner/name` source repository coordinate. */
export const REPOSITORY_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Human-facing git ref (tag or branch). `..` is rejected separately. */
export const GIT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

/** RFC 3339 UTC instant, `Z` suffix only, so published_at compares lexicographically. */
export const RFC3339_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** SPDX license identifier shape (expressions are out of scope for schema_version 1). */
export const SPDX_LICENSE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/;

/** External command name a Skill may require. */
export const COMMAND_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/** Network host: DNS hostname, optionally a leading `*.` wildcard label. */
export const NETWORK_HOST_PATTERN =
  /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Artifact and homepage URLs must be HTTPS. */
export const HTTPS_URL_PREFIX = 'https://';

// =============================================================================
// UI vocabulary
// =============================================================================

/**
 * Wording that must accompany any permission display.
 *
 * Prevents the declaration from being read as enforcement (see the ADR's
 * "declaration is not enforcement" decision).
 */
export const PERMISSION_DECLARATION_NOTICE_KEY = 'skills.permissions.declarationOnlyNotice';

/**
 * Labels for {@link SkillAgentSupport}, so UI and CLI use one vocabulary (UX-05).
 * Values are i18n message keys, not user-visible strings.
 */
export const AGENT_SUPPORT_LABEL_KEYS: Record<SkillAgentSupport, string> = {
  native: 'skills.compatibility.native',
  commandmate_runtime: 'skills.compatibility.commandmateRuntime',
  unsupported: 'skills.compatibility.unsupported',
  unknown: 'skills.compatibility.unknown',
};
