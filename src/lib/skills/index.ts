/**
 * Public API of the Agent Skills distribution contract (Issue #1228)
 *
 * Downstream issues (#1229 catalog fetch, #1231 install, #1234 audit, #1232 UI)
 * import from `@/lib/skills` only. Anything not re-exported here is an internal
 * detail and may change without a contract revision.
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
