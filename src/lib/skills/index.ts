/**
 * Public API of the Agent Skills distribution contract (Issue #1228)
 *
 * This barrel is the *contract* surface only: schema, types, constants, error
 * codes, and SemVer. It is isomorphic — it pulls in no Node builtin — so client
 * components can import from it safely.
 *
 * Deliberately NOT re-exported here (import the concrete module instead):
 *
 * | module | why it stays out of the barrel |
 * | --- | --- |
 * | `artifact-downloader`, `snapshot-store`, `integrity` (#1229) | `fs` / `crypto`, transitively `version-checker` (`fs`, `path`) |
 * | `package-reader`, `package-validator` (#1230) | `zlib` / `fs` |
 * | `operation-lock`, `operation-journal`, `operation-store`, `operation-audit`, `operation-reconciler` (#1234) | `fs` / `os`, service-owned state root |
 * | `catalog-client`, `compatibility` (#1231) | server-side cache ownership; `compatibility` is pure but is paired with the client |
 * | `safe-yaml` (#1230) | pure, but only meaningful together with `package-reader` |
 *
 * Re-exporting those would drag `fs` / `zlib` into any consumer of
 * `@/lib/skills`, including the `use client` components under
 * `src/components/skills/`. Keep server-only modules concrete:
 * `import { … } from '@/lib/skills/snapshot-store'`.
 *
 * @module lib/skills
 */

export {
  AGENT_SUPPORT_LABEL_KEYS,
  GIT_COMMIT_SHA_PATTERN,
  GIT_REF_PATTERN,
  PERMISSION_DECLARATION_NOTICE_KEY,
  REPOSITORY_SLUG_PATTERN,
  RESERVED_SKILL_IDS,
  RFC3339_UTC_PATTERN,
  SHA256_HEX_PATTERN,
  SKILL_AGENT_SUPPORT_VALUES,
  SKILL_ARTIFACT_CONTENT_TYPE,
  SKILL_ARTIFACT_FORMAT,
  SKILL_ARTIFACT_MAX_SIZE,
  SKILL_DECLARED_PERMISSIONS,
  SKILL_FILE_KINDS,
  SKILL_FILE_MAX_SIZE,
  SKILL_FILES_MAX_COUNT,
  SKILL_ID_MAX_LENGTH,
  SKILL_ID_PATTERN,
  SKILL_INSTALL_ROOT_PREFIX,
  SKILL_MANIFEST_FILENAME,
  SKILL_MD_FILENAME,
  SKILL_RISK_LEVELS,
  SKILL_RISK_ORDER,
  SKILL_SCHEMA_VERSION,
  SKILL_STAGING_DIRNAME,
  SKILL_YAML_SAFE_PROFILE,
  REQUIRED_PACKAGE_ENTRIES,
  buildSkillAssetName,
} from '@/lib/skills/constants';

export {
  SkillContractErrorCode,
  joinPath as joinSkillErrorPath,
  skillError,
  skillFail,
  skillOk,
  type SkillContractError,
  type SkillContractErrorCodeType,
  type SkillValidationResult,
} from '@/lib/skills/errors';

export {
  SEMVER_2_PATTERN,
  compareParsedSemVer,
  compareSemVer,
  isValidSemVer,
  isValidSkillVersionRange,
  parseSemVer,
  parseSkillVersionRange,
  satisfiesSkillVersionRange,
  type ParsedSemVer,
  type SkillVersionComparator,
  type SkillVersionOperator,
} from '@/lib/skills/semver';

export {
  SKILL_DOCUMENT_FIELDS,
  SKILL_OPTIONAL_FIELDS,
  canonicalizeSkillReceipt,
  computeSkillRisk,
  detectSkillIdCollision,
  foldSkillIdForCollision,
  resolveEffectiveSkillRisk,
  validateManifestFileSet,
  validateSkillCatalog,
  validateSkillId,
  validateSkillIdentityConsistency,
  validateSkillInstallReceipt,
  validateSkillManifest,
  validateSkillPayloadPath,
} from '@/lib/skills/schema';

export {
  SKILL_CATALOG_JSON_SCHEMA,
  SKILL_MANIFEST_JSON_SCHEMA,
  SKILL_RECEIPT_JSON_SCHEMA,
  type SkillJsonSchemaDocument,
} from '@/lib/skills/json-schema';

export type {
  SkillAgentCompatibility,
  SkillAgentSupport,
  SkillArtifactFormat,
  SkillArtifactRef,
  SkillCatalog,
  SkillCatalogEntry,
  SkillCatalogVersion,
  SkillCompatibility,
  SkillDeclaredPermission,
  SkillFileEntry,
  SkillFileKind,
  SkillInstallReceipt,
  SkillInstalledFile,
  SkillManifest,
  SkillPackageInspection,
  SkillProvider,
  SkillReceiptArtifact,
  SkillRequirementCommand,
  SkillRequirements,
  SkillRiskLevel,
  SkillSourceRef,
} from '@/types/skills';
