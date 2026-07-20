/**
 * Agent Skills distribution contract types (Issue #1228)
 *
 * Canonical TypeScript shapes for the four documents of the distribution
 * contract. See docs/design/agent-skills-distribution.md for the ADR that
 * fixes the semantics of every field below.
 *
 * Ownership of each display field (Issue #1232):
 * - manifest  : capability, expected outcome, provider, license, permissions
 * - catalog   : version, changelog, resolved commit SHA, artifact info
 * - inspection: scripts / executables / computed risk
 * - receipt   : what actually landed in the worktree
 *
 * @module types/skills
 */

import type { CLIToolType } from '@/lib/cli-tools/types';

// =============================================================================
// Shared vocabulary
// =============================================================================

/**
 * How an Agent can run a Skill.
 *
 * - `native`: the Agent itself discovers and executes the Skill.
 * - `commandmate_runtime`: only runnable through the CommandMate Skill Runtime.
 * - `unsupported`: known not to work.
 * - `unknown`: not verified. Never rendered as "supported".
 */
export type SkillAgentSupport = 'native' | 'commandmate_runtime' | 'unsupported' | 'unknown';

/** Agent support claim together with the evidence it is based on. */
export interface SkillAgentCompatibility {
  agent: CLIToolType;
  support: SkillAgentSupport;
  /** Why this claim holds (doc reference, verification run, …). Never a machine path. */
  evidence: string;
}

/** Risk vocabulary shared by publisher declaration, computation and effective value. */
export type SkillRiskLevel = 'low' | 'moderate' | 'high';

/**
 * Capability a Skill declares it needs.
 *
 * These are *declarations by the publisher*, not sandbox enforcement. The field
 * and type names carry the `declared` prefix so no caller can read them as an
 * authorization decision.
 */
export type SkillDeclaredPermission =
  | 'filesystem_read'
  | 'filesystem_write'
  | 'network_access'
  | 'process_execution'
  | 'environment_read'
  | 'credential_access';

/** Role of a payload file inside a Skill package. */
export type SkillFileKind = 'skill_md' | 'instruction' | 'script' | 'asset';

/** Distribution artifact format. MVP fixes this to a single value. */
export type SkillArtifactFormat = 'tar.gz';

// =============================================================================
// Manifest (commandmate.skill.yaml)
// =============================================================================

/** Publisher of a Skill. Identity is self-declared; no PKI in schema_version 1. */
export interface SkillProvider {
  name: string;
  url?: string;
  contact?: string;
}

/** External command a Skill needs at runtime. */
export interface SkillRequirementCommand {
  name: string;
  /** Range in the grammar of {@link satisfiesSkillVersionRange}. Absent means "any version". */
  version_range?: string;
}

/** Runtime requirements declared by the publisher. */
export interface SkillRequirements {
  commands: SkillRequirementCommand[];
  /** Explicit allow-list of hosts. Empty array means "declares no network access". */
  network_hosts: string[];
}

/** Compatibility claims for CommandMate itself and for each Agent. */
export interface SkillCompatibility {
  /** Required CommandMate version range. */
  commandmate: string;
  agents: SkillAgentCompatibility[];
}

/** One payload file with its digest, as declared by the publisher. */
export interface SkillFileEntry {
  /** POSIX relative path inside the Skill root. */
  path: string;
  /** Lowercase hex SHA-256 of the file bytes. */
  sha256: string;
  size: number;
  kind: SkillFileKind;
  /** File is expected to carry the executable bit. */
  executable: boolean;
  /** File is a script (interpreted payload) regardless of its mode. */
  script: boolean;
}

/**
 * CommandMate distribution manifest, authored as `commandmate.skill.yaml`
 * next to the standard `SKILL.md`.
 */
export interface SkillManifest {
  schema_version: number;
  id: string;
  /** Must equal the `name` in the sibling SKILL.md frontmatter. */
  name: string;
  version: string;
  /** One-line "what you get". */
  summary: string;
  description: string;
  /** What the user can do after installing (UX-01). */
  capabilities: string[];
  /** Expected effect of using the Skill (UX-01). */
  expected_outcomes: string[];
  provider: SkillProvider;
  /** SPDX license identifier. */
  license: string;
  homepage?: string;
  keywords?: string[];
  compatibility: SkillCompatibility;
  requirements: SkillRequirements;
  declared_permissions: SkillDeclaredPermission[];
  declared_risk: SkillRiskLevel;
  risk_rationale: string;
  /** Payload files excluding `commandmate.skill.yaml` itself and directory entries. */
  files: SkillFileEntry[];
}

// =============================================================================
// Catalog
// =============================================================================

/** Immutable source coordinates of a published version. */
export interface SkillSourceRef {
  /** `owner/name` of the source repository. */
  repository: string;
  /** Human-facing ref (tag or branch). Never trusted on its own. */
  ref: string;
  /** Resolved 40-hex commit SHA. This is the trusted coordinate. */
  commit: string;
}

/** Release artifact coordinates published in the Catalog. */
export interface SkillArtifactRef {
  asset_name: string;
  url: string;
  /** Lowercase hex SHA-256 over the whole artifact byte stream. */
  sha256: string;
  size: number;
  content_type: string;
  format: SkillArtifactFormat;
}

/** One published version of a Skill. */
export interface SkillCatalogVersion {
  version: string;
  changelog: string;
  /** RFC 3339 UTC instant with `Z` suffix. */
  published_at: string;
  source: SkillSourceRef;
  artifact: SkillArtifactRef;
  compatibility: SkillCompatibility;
  declared_risk: SkillRiskLevel;
}

/** Catalog record for one Skill. */
export interface SkillCatalogEntry {
  id: string;
  name: string;
  summary: string;
  provider: SkillProvider;
  license: string;
  homepage?: string;
  keywords?: string[];
  /** Must be present in {@link versions}. */
  latest: string;
  versions: SkillCatalogVersion[];
}

/** Top-level Catalog document. */
export interface SkillCatalog {
  schema_version: number;
  entries: SkillCatalogEntry[];
}

// =============================================================================
// Inspection (computed by CommandMate, never authored)
// =============================================================================

/** Facts CommandMate derives from an extracted package, before install. */
export interface SkillPackageInspection {
  /** Paths carrying the executable bit. */
  executable_paths: string[];
  /** Paths classified as scripts. */
  script_paths: string[];
  /** Hosts declared by the manifest that inspection confirmed as reachable targets. */
  network_hosts: string[];
  declared_permissions: SkillDeclaredPermission[];
}

// =============================================================================
// Install receipt
// =============================================================================

/**
 * Artifact identity kept in a receipt.
 *
 * Deliberately has no `url`: download URLs can be signed and are treated as
 * secrets, so they never reach a receipt.
 */
export interface SkillReceiptArtifact {
  asset_name: string;
  sha256: string;
  size: number;
  format: SkillArtifactFormat;
}

/** One file as it landed in the worktree. */
export interface SkillInstalledFile {
  path: string;
  sha256: string;
  size: number;
  executable: boolean;
}

/**
 * Deterministic record of an install.
 *
 * Contains no timestamp, no actor and no machine-absolute path: identical
 * inputs must produce byte-identical receipts. Time and actor belong to the
 * operation audit log (#1234).
 */
export interface SkillInstallReceipt {
  schema_version: number;
  skill_id: string;
  version: string;
  /** Repository-relative install root, always `.agents/skills/<skill-id>`. */
  install_root: string;
  source: SkillSourceRef;
  artifact: SkillReceiptArtifact;
  files: SkillInstalledFile[];
  declared_risk: SkillRiskLevel;
  computed_risk: SkillRiskLevel;
  /** The higher of declared and computed risk. */
  effective_risk: SkillRiskLevel;
  declared_permissions: SkillDeclaredPermission[];
  agent_compatibility: SkillAgentCompatibility[];
}
