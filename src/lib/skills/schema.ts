/**
 * Schema validation for the Agent Skills distribution contract (Issue #1228)
 *
 * Pure functions over already-parsed values: no filesystem, no network, no YAML
 * parser. The caller parses `commandmate.skill.yaml` under
 * {@link SKILL_YAML_SAFE_PROFILE} and hands the resulting `unknown` here.
 *
 * Every validator is fail-closed and total: it returns a
 * {@link SkillValidationResult} rather than throwing, and on success returns a
 * freshly constructed object so no unvalidated property from the input
 * survives.
 *
 * @module lib/skills/schema
 */

import { isCliToolType } from '@/lib/cli-tools/types';
import {
  COMMAND_NAME_PATTERN,
  GIT_COMMIT_SHA_PATTERN,
  GIT_REF_PATTERN,
  HTTPS_URL_PREFIX,
  NETWORK_HOST_PATTERN,
  REPOSITORY_SLUG_PATTERN,
  RESERVED_SKILL_IDS,
  RFC3339_UTC_PATTERN,
  SHA256_HEX_PATTERN,
  SKILL_ARTIFACT_CONTENT_TYPE,
  SKILL_ARTIFACT_FORMAT,
  SKILL_ARTIFACT_MAX_SIZE,
  SKILL_AGENT_SUPPORT_VALUES,
  SKILL_BULLET_MAX_COUNT,
  SKILL_BULLET_MAX_LENGTH,
  SKILL_CATALOG_ENTRIES_MAX_COUNT,
  SKILL_CATALOG_VERSIONS_MAX_COUNT,
  SKILL_CHANGELOG_MAX_LENGTH,
  SKILL_COMMANDS_MAX_COUNT,
  SKILL_DECLARED_PERMISSIONS,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_EVIDENCE_MAX_LENGTH,
  SKILL_FILE_KINDS,
  SKILL_FILE_MAX_SIZE,
  SKILL_FILES_MAX_COUNT,
  SKILL_ID_MAX_LENGTH,
  SKILL_ID_PATTERN,
  SKILL_INSTALL_ROOT_PREFIX,
  SKILL_KEYWORD_MAX_LENGTH,
  SKILL_KEYWORDS_MAX_COUNT,
  SKILL_MANIFEST_FILENAME,
  SKILL_MD_FILENAME,
  SKILL_NAME_MAX_LENGTH,
  SKILL_NETWORK_HOSTS_MAX_COUNT,
  SKILL_PATH_MAX_DEPTH,
  SKILL_PATH_MAX_LENGTH,
  SKILL_PATH_SEGMENT_MAX_LENGTH,
  SKILL_RATIONALE_MAX_LENGTH,
  SKILL_RISK_LEVELS,
  SKILL_RISK_ORDER,
  SKILL_SCHEMA_VERSION,
  SKILL_SUMMARY_MAX_LENGTH,
  SPDX_LICENSE_PATTERN,
  buildSkillAssetName,
} from '@/lib/skills/constants';
import {
  SkillContractErrorCode,
  joinPath,
  skillError,
  skillFail,
  skillOk,
  type SkillContractError,
  type SkillValidationResult,
} from '@/lib/skills/errors';
import { isValidSemVer, isValidSkillVersionRange } from '@/lib/skills/semver';
import type {
  SkillAgentCompatibility,
  SkillAgentSupport,
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

// =============================================================================
// Allowed field sets (schema_version 1 is closed: unknown fields are rejected)
// =============================================================================

const MANIFEST_FIELDS = [
  'schema_version',
  'id',
  'name',
  'version',
  'summary',
  'description',
  'capabilities',
  'expected_outcomes',
  'provider',
  'license',
  'homepage',
  'keywords',
  'compatibility',
  'requirements',
  'declared_permissions',
  'declared_risk',
  'risk_rationale',
  'files',
] as const satisfies readonly (keyof SkillManifest)[];

const CATALOG_FIELDS = ['schema_version', 'entries'] as const satisfies readonly (keyof SkillCatalog)[];

const CATALOG_ENTRY_FIELDS = [
  'id',
  'name',
  'summary',
  'provider',
  'license',
  'homepage',
  'keywords',
  'latest',
  'versions',
] as const satisfies readonly (keyof SkillCatalogEntry)[];

const CATALOG_VERSION_FIELDS = [
  'version',
  'changelog',
  'published_at',
  'source',
  'artifact',
  'compatibility',
  'declared_risk',
] as const satisfies readonly (keyof SkillCatalogVersion)[];

const RECEIPT_FIELDS = [
  'schema_version',
  'skill_id',
  'version',
  'install_root',
  'source',
  'artifact',
  'files',
  'declared_risk',
  'computed_risk',
  'effective_risk',
  'declared_permissions',
  'agent_compatibility',
] as const satisfies readonly (keyof SkillInstallReceipt)[];

const PROVIDER_FIELDS = ['name', 'url', 'contact'] as const satisfies readonly (keyof SkillProvider)[];
const COMPATIBILITY_FIELDS = ['commandmate', 'agents'] as const satisfies readonly (keyof SkillCompatibility)[];
const AGENT_COMPAT_FIELDS = ['agent', 'support', 'evidence'] as const satisfies readonly (keyof SkillAgentCompatibility)[];
const REQUIREMENTS_FIELDS = ['commands', 'network_hosts'] as const satisfies readonly (keyof SkillRequirements)[];
const COMMAND_FIELDS = ['name', 'version_range'] as const satisfies readonly (keyof SkillRequirementCommand)[];
const FILE_ENTRY_FIELDS = ['path', 'sha256', 'size', 'kind', 'executable', 'script'] as const satisfies readonly (keyof SkillFileEntry)[];
const SOURCE_FIELDS = ['repository', 'ref', 'commit'] as const satisfies readonly (keyof SkillSourceRef)[];
const ARTIFACT_FIELDS = ['asset_name', 'url', 'sha256', 'size', 'content_type', 'format'] as const satisfies readonly (keyof SkillArtifactRef)[];
const RECEIPT_ARTIFACT_FIELDS = ['asset_name', 'sha256', 'size', 'format'] as const satisfies readonly (keyof SkillReceiptArtifact)[];
const INSTALLED_FILE_FIELDS = ['path', 'sha256', 'size', 'executable'] as const satisfies readonly (keyof SkillInstalledFile)[];

/**
 * Compile-time exhaustiveness: adding a field to an interface without adding it
 * to the list above makes `tsc` fail here, which keeps the JSON Schema, the
 * validators and the TypeScript types from drifting apart.
 */
type MissingFields<TType, TList extends readonly PropertyKey[]> = Exclude<
  keyof TType,
  TList[number]
>;
type AssertNoMissing<T extends never> = T;
export type _ManifestFieldsExhaustive = AssertNoMissing<MissingFields<SkillManifest, typeof MANIFEST_FIELDS>>;
export type _CatalogFieldsExhaustive = AssertNoMissing<MissingFields<SkillCatalog, typeof CATALOG_FIELDS>>;
export type _CatalogEntryFieldsExhaustive = AssertNoMissing<MissingFields<SkillCatalogEntry, typeof CATALOG_ENTRY_FIELDS>>;
export type _CatalogVersionFieldsExhaustive = AssertNoMissing<MissingFields<SkillCatalogVersion, typeof CATALOG_VERSION_FIELDS>>;
export type _ReceiptFieldsExhaustive = AssertNoMissing<MissingFields<SkillInstallReceipt, typeof RECEIPT_FIELDS>>;

/** Field name lists, exposed so schema-parity tests can compare them to the JSON Schema. */
export const SKILL_DOCUMENT_FIELDS = {
  manifest: MANIFEST_FIELDS,
  catalog: CATALOG_FIELDS,
  catalogEntry: CATALOG_ENTRY_FIELDS,
  catalogVersion: CATALOG_VERSION_FIELDS,
  receipt: RECEIPT_FIELDS,
  provider: PROVIDER_FIELDS,
  compatibility: COMPATIBILITY_FIELDS,
  agentCompatibility: AGENT_COMPAT_FIELDS,
  requirements: REQUIREMENTS_FIELDS,
  requirementCommand: COMMAND_FIELDS,
  fileEntry: FILE_ENTRY_FIELDS,
  source: SOURCE_FIELDS,
  artifact: ARTIFACT_FIELDS,
  receiptArtifact: RECEIPT_ARTIFACT_FIELDS,
  installedFile: INSTALLED_FILE_FIELDS,
} as const;

/** Optional fields per document, exposed for the same parity check. */
export const SKILL_OPTIONAL_FIELDS = {
  manifest: ['homepage', 'keywords'],
  catalog: [],
  catalogEntry: ['homepage', 'keywords'],
  catalogVersion: [],
  receipt: [],
  provider: ['url', 'contact'],
  compatibility: [],
  agentCompatibility: [],
  requirements: [],
  requirementCommand: ['version_range'],
  fileEntry: [],
  source: [],
  artifact: [],
  receiptArtifact: [],
  installedFile: [],
} as const satisfies Record<keyof typeof SKILL_DOCUMENT_FIELDS, readonly string[]>;

// =============================================================================
// Primitive readers
// =============================================================================

type Bag = SkillContractError[];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function has(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function readObject(value: unknown, path: string, errors: Bag): Record<string, unknown> | null {
  if (!isPlainObject(value)) {
    errors.push(
      skillError(SkillContractErrorCode.NOT_AN_OBJECT, path, `${path || '/'} must be an object`)
    );
    return null;
  }
  return value;
}

function checkUnknownFields(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: Bag
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      errors.push(
        skillError(
          SkillContractErrorCode.UNKNOWN_FIELD,
          joinPath(path, key),
          `unknown field is not allowed in schema_version ${SKILL_SCHEMA_VERSION}`
        )
      );
    }
  }
}

interface StringOptions {
  optional?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  patternName?: string;
  formatCode?: (typeof SkillContractErrorCode)[keyof typeof SkillContractErrorCode];
}

function readString(
  obj: Record<string, unknown>,
  key: string,
  parent: string,
  errors: Bag,
  options: StringOptions = {}
): string | undefined {
  const path = joinPath(parent, key);
  if (!has(obj, key) || obj[key] === undefined) {
    if (!options.optional) {
      errors.push(
        skillError(SkillContractErrorCode.MISSING_FIELD, path, `${key} is required`)
      );
    }
    return undefined;
  }
  const value = obj[key];
  if (typeof value !== 'string') {
    errors.push(skillError(SkillContractErrorCode.INVALID_TYPE, path, `${key} must be a string`));
    return undefined;
  }
  // A field with a domain-specific error code reports that code for every
  // violation, so a truncated digest reads as "invalid digest" rather than as a
  // generic length problem.
  const lengthCode = options.formatCode ?? SkillContractErrorCode.LIMIT_EXCEEDED;
  const min = options.minLength ?? 1;
  if (value.length < min) {
    errors.push(
      skillError(lengthCode, path, `${key} is shorter than the minimum`, { minLength: min })
    );
    return undefined;
  }
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    errors.push(
      skillError(lengthCode, path, `${key} exceeds the maximum length`, {
        maxLength: options.maxLength,
      })
    );
    return undefined;
  }
  if (options.pattern && !options.pattern.test(value)) {
    errors.push(
      skillError(
        options.formatCode ?? SkillContractErrorCode.INVALID_FORMAT,
        path,
        `${key} does not match the required format`,
        options.patternName ? { format: options.patternName } : undefined
      )
    );
    return undefined;
  }
  return value;
}

function readInteger(
  obj: Record<string, unknown>,
  key: string,
  parent: string,
  errors: Bag,
  bounds: { min: number; max: number }
): number | undefined {
  const path = joinPath(parent, key);
  if (!has(obj, key) || obj[key] === undefined) {
    errors.push(skillError(SkillContractErrorCode.MISSING_FIELD, path, `${key} is required`));
    return undefined;
  }
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    errors.push(skillError(SkillContractErrorCode.INVALID_TYPE, path, `${key} must be an integer`));
    return undefined;
  }
  if (value < bounds.min || value > bounds.max) {
    errors.push(
      skillError(SkillContractErrorCode.LIMIT_EXCEEDED, path, `${key} is out of range`, bounds)
    );
    return undefined;
  }
  return value;
}

function readBoolean(
  obj: Record<string, unknown>,
  key: string,
  parent: string,
  errors: Bag
): boolean | undefined {
  const path = joinPath(parent, key);
  if (!has(obj, key) || obj[key] === undefined) {
    errors.push(skillError(SkillContractErrorCode.MISSING_FIELD, path, `${key} is required`));
    return undefined;
  }
  const value = obj[key];
  if (typeof value !== 'boolean') {
    errors.push(skillError(SkillContractErrorCode.INVALID_TYPE, path, `${key} must be a boolean`));
    return undefined;
  }
  return value;
}

function readArray(
  obj: Record<string, unknown>,
  key: string,
  parent: string,
  errors: Bag,
  options: { maxItems: number; optional?: boolean }
): unknown[] | undefined {
  const path = joinPath(parent, key);
  if (!has(obj, key) || obj[key] === undefined) {
    if (!options.optional) {
      errors.push(skillError(SkillContractErrorCode.MISSING_FIELD, path, `${key} is required`));
    }
    return undefined;
  }
  const value = obj[key];
  if (!Array.isArray(value)) {
    errors.push(skillError(SkillContractErrorCode.INVALID_TYPE, path, `${key} must be an array`));
    return undefined;
  }
  if (value.length > options.maxItems) {
    errors.push(
      skillError(SkillContractErrorCode.LIMIT_EXCEEDED, path, `${key} has too many items`, {
        maxItems: options.maxItems,
      })
    );
    return undefined;
  }
  return value;
}

function readEnum<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  parent: string,
  errors: Bag,
  allowed: readonly T[]
): T | undefined {
  const path = joinPath(parent, key);
  if (!has(obj, key) || obj[key] === undefined) {
    errors.push(skillError(SkillContractErrorCode.MISSING_FIELD, path, `${key} is required`));
    return undefined;
  }
  const value = obj[key];
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    errors.push(
      skillError(SkillContractErrorCode.INVALID_ENUM, path, `${key} is not an allowed value`, {
        allowed: allowed.join('|'),
      })
    );
    return undefined;
  }
  return value as T;
}

function readStringList(
  obj: Record<string, unknown>,
  key: string,
  parent: string,
  errors: Bag,
  options: { maxItems: number; maxLength: number; optional?: boolean; pattern?: RegExp }
): string[] | undefined {
  const raw = readArray(obj, key, parent, errors, {
    maxItems: options.maxItems,
    optional: options.optional,
  });
  if (raw === undefined) return undefined;

  const out: string[] = [];
  let failed = false;
  raw.forEach((item, index) => {
    const path = joinPath(joinPath(parent, key), index);
    if (typeof item !== 'string' || item.length === 0 || item.length > options.maxLength) {
      errors.push(
        skillError(SkillContractErrorCode.INVALID_TYPE, path, 'item must be a bounded string', {
          maxLength: options.maxLength,
        })
      );
      failed = true;
      return;
    }
    if (options.pattern && !options.pattern.test(item)) {
      errors.push(
        skillError(SkillContractErrorCode.INVALID_FORMAT, path, 'item does not match the required format')
      );
      failed = true;
      return;
    }
    out.push(item);
  });
  return failed ? undefined : out;
}

function readHttpsUrl(
  obj: Record<string, unknown>,
  key: string,
  parent: string,
  errors: Bag,
  options: { optional?: boolean } = {}
): string | undefined {
  const value = readString(obj, key, parent, errors, { optional: options.optional, maxLength: 512 });
  if (value === undefined) return undefined;
  if (!value.startsWith(HTTPS_URL_PREFIX)) {
    errors.push(
      skillError(
        SkillContractErrorCode.INVALID_FORMAT,
        joinPath(parent, key),
        `${key} must be an https URL`
      )
    );
    return undefined;
  }
  return value;
}

function readSchemaVersion(obj: Record<string, unknown>, errors: Bag): number | undefined {
  const path = '/schema_version';
  const value = obj['schema_version'];
  if (value === undefined) {
    errors.push(
      skillError(SkillContractErrorCode.SCHEMA_VERSION_UNSUPPORTED, path, 'schema_version is required')
    );
    return undefined;
  }
  if (value !== SKILL_SCHEMA_VERSION) {
    // Fail closed: a future schema_version is rejected, never best-effort parsed.
    errors.push(
      skillError(
        SkillContractErrorCode.SCHEMA_VERSION_UNSUPPORTED,
        path,
        'schema_version is not supported by this build',
        { supported: SKILL_SCHEMA_VERSION }
      )
    );
    return undefined;
  }
  return SKILL_SCHEMA_VERSION;
}

// =============================================================================
// Skill ID
// =============================================================================

/**
 * Fold a name for collision detection.
 *
 * Case folding plus NFKC catches directory names that differ only by case or by
 * a compatibility-equivalent Unicode form but collide on a case-insensitive or
 * normalizing filesystem.
 */
export function foldSkillIdForCollision(name: string): string {
  return name.normalize('NFKC').toLowerCase();
}

/** Validate a Skill ID against the slug grammar and the reserved list. */
export function validateSkillId(
  id: unknown,
  path = '/id'
): SkillValidationResult<string> {
  if (typeof id !== 'string' || id.length === 0) {
    return skillFail([skillError(SkillContractErrorCode.ID_INVALID, path, 'id must be a non-empty string')]);
  }
  if (id.length > SKILL_ID_MAX_LENGTH) {
    return skillFail([
      skillError(SkillContractErrorCode.ID_INVALID, path, 'id exceeds the maximum length', {
        maxLength: SKILL_ID_MAX_LENGTH,
      }),
    ]);
  }
  if (!SKILL_ID_PATTERN.test(id)) {
    return skillFail([
      skillError(SkillContractErrorCode.ID_INVALID, path, 'id must be a lowercase ASCII slug', {
        format: 'lowercase-slug',
      }),
    ]);
  }
  if (RESERVED_SKILL_IDS.includes(id)) {
    return skillFail([skillError(SkillContractErrorCode.ID_RESERVED, path, 'id is reserved')]);
  }
  return skillOk(id);
}

/**
 * Detect a case/Unicode collision between a new ID and existing directory names.
 *
 * @returns the colliding existing name, or null when the ID is free.
 */
export function detectSkillIdCollision(id: string, existingNames: readonly string[]): string | null {
  const folded = foldSkillIdForCollision(id);
  for (const name of existingNames) {
    if (name === id) continue;
    if (foldSkillIdForCollision(name) === folded) return name;
  }
  return null;
}

/**
 * Check that the directory name, the SKILL.md frontmatter name and the manifest
 * agree, which is what stops a package from installing under a name the user
 * never reviewed.
 */
export function validateSkillIdentityConsistency(input: {
  directoryName: string;
  skillMdName: string;
  manifestId: string;
  manifestName: string;
}): SkillValidationResult<string> {
  const idResult = validateSkillId(input.manifestId);
  if (!idResult.ok) return idResult;

  const errors: Bag = [];
  if (input.directoryName !== input.manifestId) {
    errors.push(
      skillError(
        SkillContractErrorCode.ID_MISMATCH,
        '/id',
        'directory name does not match the manifest id'
      )
    );
  }
  if (input.skillMdName !== input.manifestName) {
    errors.push(
      skillError(
        SkillContractErrorCode.ID_MISMATCH,
        '/name',
        'SKILL.md name does not match the manifest name'
      )
    );
  }
  return errors.length > 0 ? skillFail(errors) : skillOk(input.manifestId);
}

// =============================================================================
// Payload paths
// =============================================================================

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:/;

/** NUL and other control bytes are rejected by code point, not by a control regex. */
function hasControlCharOrBackslash(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

/**
 * Validate a payload path declared in a manifest or receipt.
 *
 * String-level only: it rejects everything that could escape the Skill root
 * before any filesystem call happens. Real-path/symlink checks stay with the
 * installer (#1231), which owns the filesystem.
 */
export function validateSkillPayloadPath(
  value: unknown,
  path: string
): SkillValidationResult<string> {
  const fail = (message: string, detail?: Record<string, string | number | boolean>) =>
    skillFail<string>([skillError(SkillContractErrorCode.FILE_PATH_UNSAFE, path, message, detail)]);

  if (typeof value !== 'string' || value.length === 0) return fail('path must be a non-empty string');
  if (value.length > SKILL_PATH_MAX_LENGTH) {
    return fail('path exceeds the maximum length', { maxLength: SKILL_PATH_MAX_LENGTH });
  }
  if (hasControlCharOrBackslash(value)) return fail('path contains a control character or a backslash');
  if (value.startsWith('/') || WINDOWS_DRIVE_PATH.test(value)) return fail('path must be relative');
  if (value !== value.normalize('NFC')) return fail('path must be NFC-normalized');
  if (value.includes('//')) return fail('path must not contain empty segments');
  if (value.endsWith('/')) return fail('path must not be a directory entry');

  const segments = value.split('/');
  if (segments.length > SKILL_PATH_MAX_DEPTH) {
    return fail('path is nested too deeply', { maxDepth: SKILL_PATH_MAX_DEPTH });
  }
  for (const segment of segments) {
    if (segment === '.' || segment === '..') return fail('path must not contain "." or ".." segments');
    if (segment.length > SKILL_PATH_SEGMENT_MAX_LENGTH) {
      return fail('path segment is too long', { maxLength: SKILL_PATH_SEGMENT_MAX_LENGTH });
    }
    if (segment !== segment.trim()) return fail('path segment must not be padded with whitespace');
  }
  return skillOk(value);
}

// =============================================================================
// Shared sub-object validators
// =============================================================================

function readProvider(
  parentObj: Record<string, unknown>,
  parent: string,
  errors: Bag
): SkillProvider | undefined {
  const path = joinPath(parent, 'provider');
  const raw = parentObj['provider'];
  if (raw === undefined) {
    errors.push(skillError(SkillContractErrorCode.MISSING_FIELD, path, 'provider is required'));
    return undefined;
  }
  const obj = readObject(raw, path, errors);
  if (!obj) return undefined;
  checkUnknownFields(obj, PROVIDER_FIELDS, path, errors);

  const name = readString(obj, 'name', path, errors, { maxLength: SKILL_NAME_MAX_LENGTH });
  const url = readHttpsUrl(obj, 'url', path, errors, { optional: true });
  const contact = readString(obj, 'contact', path, errors, { optional: true, maxLength: 200 });
  if (name === undefined) return undefined;
  return { name, ...(url !== undefined ? { url } : {}), ...(contact !== undefined ? { contact } : {}) };
}

function readAgentCompatibility(
  raw: unknown,
  path: string,
  errors: Bag
): SkillAgentCompatibility | undefined {
  const obj = readObject(raw, path, errors);
  if (!obj) return undefined;
  checkUnknownFields(obj, AGENT_COMPAT_FIELDS, path, errors);

  const agent = readString(obj, 'agent', path, errors, { maxLength: 40 });
  if (agent !== undefined && !isCliToolType(agent)) {
    errors.push(
      skillError(SkillContractErrorCode.INVALID_ENUM, joinPath(path, 'agent'), 'agent is not a known CLI tool')
    );
    return undefined;
  }
  const support = readEnum<SkillAgentSupport>(obj, 'support', path, errors, SKILL_AGENT_SUPPORT_VALUES);
  const evidence = readString(obj, 'evidence', path, errors, { maxLength: SKILL_EVIDENCE_MAX_LENGTH });
  if (agent === undefined || support === undefined || evidence === undefined) return undefined;
  return { agent, support, evidence };
}

function readCompatibility(
  parentObj: Record<string, unknown>,
  parent: string,
  errors: Bag
): SkillCompatibility | undefined {
  const path = joinPath(parent, 'compatibility');
  const raw = parentObj['compatibility'];
  if (raw === undefined) {
    errors.push(skillError(SkillContractErrorCode.MISSING_FIELD, path, 'compatibility is required'));
    return undefined;
  }
  const obj = readObject(raw, path, errors);
  if (!obj) return undefined;
  checkUnknownFields(obj, COMPATIBILITY_FIELDS, path, errors);

  const commandmate = readString(obj, 'commandmate', path, errors, { maxLength: 100 });
  if (commandmate !== undefined && !isValidSkillVersionRange(commandmate)) {
    errors.push(
      skillError(
        SkillContractErrorCode.VERSION_RANGE_INVALID,
        joinPath(path, 'commandmate'),
        'commandmate is not a supported version range'
      )
    );
    return undefined;
  }

  const rawAgents = readArray(obj, 'agents', path, errors, { maxItems: 20 });
  if (commandmate === undefined || rawAgents === undefined) return undefined;

  const agents: SkillAgentCompatibility[] = [];
  const seen = new Set<string>();
  let failed = false;
  rawAgents.forEach((item, index) => {
    const itemPath = joinPath(joinPath(path, 'agents'), index);
    const parsed = readAgentCompatibility(item, itemPath, errors);
    if (!parsed) {
      failed = true;
      return;
    }
    if (seen.has(parsed.agent)) {
      errors.push(
        skillError(SkillContractErrorCode.DUPLICATE_ENTRY, itemPath, 'agent is declared more than once')
      );
      failed = true;
      return;
    }
    seen.add(parsed.agent);
    agents.push(parsed);
  });
  return failed ? undefined : { commandmate, agents };
}

function readRequirements(
  parentObj: Record<string, unknown>,
  parent: string,
  errors: Bag
): SkillRequirements | undefined {
  const path = joinPath(parent, 'requirements');
  const raw = parentObj['requirements'];
  if (raw === undefined) {
    errors.push(skillError(SkillContractErrorCode.MISSING_FIELD, path, 'requirements is required'));
    return undefined;
  }
  const obj = readObject(raw, path, errors);
  if (!obj) return undefined;
  checkUnknownFields(obj, REQUIREMENTS_FIELDS, path, errors);

  const rawCommands = readArray(obj, 'commands', path, errors, { maxItems: SKILL_COMMANDS_MAX_COUNT });
  const networkHosts = readStringList(obj, 'network_hosts', path, errors, {
    maxItems: SKILL_NETWORK_HOSTS_MAX_COUNT,
    maxLength: 253,
    pattern: NETWORK_HOST_PATTERN,
  });
  if (rawCommands === undefined || networkHosts === undefined) return undefined;

  const commands: SkillRequirementCommand[] = [];
  let failed = false;
  rawCommands.forEach((item, index) => {
    const itemPath = joinPath(joinPath(path, 'commands'), index);
    const cmdObj = readObject(item, itemPath, errors);
    if (!cmdObj) {
      failed = true;
      return;
    }
    checkUnknownFields(cmdObj, COMMAND_FIELDS, itemPath, errors);
    const name = readString(cmdObj, 'name', itemPath, errors, {
      maxLength: 64,
      pattern: COMMAND_NAME_PATTERN,
      patternName: 'command-name',
    });
    const range = readString(cmdObj, 'version_range', itemPath, errors, {
      optional: true,
      maxLength: 100,
    });
    if (range !== undefined && !isValidSkillVersionRange(range)) {
      errors.push(
        skillError(
          SkillContractErrorCode.VERSION_RANGE_INVALID,
          joinPath(itemPath, 'version_range'),
          'version_range is not a supported version range'
        )
      );
      failed = true;
      return;
    }
    if (name === undefined) {
      failed = true;
      return;
    }
    commands.push({ name, ...(range !== undefined ? { version_range: range } : {}) });
  });
  return failed ? undefined : { commands, network_hosts: networkHosts };
}

function readSource(
  parentObj: Record<string, unknown>,
  parent: string,
  errors: Bag
): SkillSourceRef | undefined {
  const path = joinPath(parent, 'source');
  const raw = parentObj['source'];
  if (raw === undefined) {
    errors.push(skillError(SkillContractErrorCode.MISSING_FIELD, path, 'source is required'));
    return undefined;
  }
  const obj = readObject(raw, path, errors);
  if (!obj) return undefined;
  checkUnknownFields(obj, SOURCE_FIELDS, path, errors);

  const repository = readString(obj, 'repository', path, errors, {
    maxLength: 140,
    pattern: REPOSITORY_SLUG_PATTERN,
    patternName: 'owner/name',
  });
  const ref = readString(obj, 'ref', path, errors, {
    maxLength: 100,
    pattern: GIT_REF_PATTERN,
    patternName: 'git-ref',
  });
  if (ref !== undefined && ref.includes('..')) {
    errors.push(
      skillError(SkillContractErrorCode.INVALID_FORMAT, joinPath(path, 'ref'), 'ref must not contain ".."')
    );
    return undefined;
  }
  const commit = readString(obj, 'commit', path, errors, {
    maxLength: 40,
    minLength: 40,
    pattern: GIT_COMMIT_SHA_PATTERN,
    patternName: 'sha1-40-hex',
    formatCode: SkillContractErrorCode.SOURCE_COMMIT_INVALID,
  });
  if (repository === undefined || ref === undefined || commit === undefined) return undefined;
  return { repository, ref, commit };
}

function readArtifact(
  parentObj: Record<string, unknown>,
  parent: string,
  errors: Bag
): SkillArtifactRef | undefined {
  const path = joinPath(parent, 'artifact');
  const raw = parentObj['artifact'];
  if (raw === undefined) {
    errors.push(skillError(SkillContractErrorCode.MISSING_FIELD, path, 'artifact is required'));
    return undefined;
  }
  const obj = readObject(raw, path, errors);
  if (!obj) return undefined;
  checkUnknownFields(obj, ARTIFACT_FIELDS, path, errors);

  const assetName = readString(obj, 'asset_name', path, errors, { maxLength: 200 });
  const url = readHttpsUrl(obj, 'url', path, errors);
  const sha256 = readString(obj, 'sha256', path, errors, {
    minLength: 64,
    maxLength: 64,
    pattern: SHA256_HEX_PATTERN,
    patternName: 'sha256-lowercase-hex',
    formatCode: SkillContractErrorCode.DIGEST_INVALID,
  });
  const size = readInteger(obj, 'size', path, errors, { min: 1, max: SKILL_ARTIFACT_MAX_SIZE });
  const contentType = readString(obj, 'content_type', path, errors, { maxLength: 100 });
  const format = readEnum(obj, 'format', path, errors, [SKILL_ARTIFACT_FORMAT] as const);

  if (contentType !== undefined && contentType !== SKILL_ARTIFACT_CONTENT_TYPE) {
    errors.push(
      skillError(
        SkillContractErrorCode.ARTIFACT_INVALID,
        joinPath(path, 'content_type'),
        'content_type must be the fixed artifact media type',
        { expected: SKILL_ARTIFACT_CONTENT_TYPE }
      )
    );
    return undefined;
  }
  if (
    assetName === undefined ||
    url === undefined ||
    sha256 === undefined ||
    size === undefined ||
    contentType === undefined ||
    format === undefined
  ) {
    return undefined;
  }
  return { asset_name: assetName, url, sha256, size, content_type: contentType, format };
}

// =============================================================================
// Manifest
// =============================================================================

function readFileEntries(
  parentObj: Record<string, unknown>,
  parent: string,
  errors: Bag
): SkillFileEntry[] | undefined {
  const path = joinPath(parent, 'files');
  const raw = readArray(parentObj, 'files', parent, errors, { maxItems: SKILL_FILES_MAX_COUNT });
  if (raw === undefined) return undefined;

  const entries: SkillFileEntry[] = [];
  const seenFolded = new Set<string>();
  let failed = false;

  raw.forEach((item, index) => {
    const itemPath = joinPath(path, index);
    const obj = readObject(item, itemPath, errors);
    if (!obj) {
      failed = true;
      return;
    }
    checkUnknownFields(obj, FILE_ENTRY_FIELDS, itemPath, errors);

    const pathResult = validateSkillPayloadPath(obj['path'], joinPath(itemPath, 'path'));
    const sha256 = readString(obj, 'sha256', itemPath, errors, {
      minLength: 64,
      maxLength: 64,
      pattern: SHA256_HEX_PATTERN,
      patternName: 'sha256-lowercase-hex',
      formatCode: SkillContractErrorCode.DIGEST_INVALID,
    });
    const size = readInteger(obj, 'size', itemPath, errors, { min: 0, max: SKILL_FILE_MAX_SIZE });
    const kind = readEnum<SkillFileKind>(obj, 'kind', itemPath, errors, SKILL_FILE_KINDS);
    const executable = readBoolean(obj, 'executable', itemPath, errors);
    const script = readBoolean(obj, 'script', itemPath, errors);

    if (!pathResult.ok) {
      errors.push(...pathResult.errors);
      failed = true;
      return;
    }
    if (
      sha256 === undefined ||
      size === undefined ||
      kind === undefined ||
      executable === undefined ||
      script === undefined
    ) {
      failed = true;
      return;
    }

    const filePath = pathResult.value;
    if (filePath === SKILL_MANIFEST_FILENAME) {
      errors.push(
        skillError(
          SkillContractErrorCode.FILE_SET_MISMATCH,
          joinPath(itemPath, 'path'),
          'the manifest must not declare a digest for itself'
        )
      );
      failed = true;
      return;
    }
    const folded = foldSkillIdForCollision(filePath);
    if (seenFolded.has(folded)) {
      errors.push(
        skillError(
          SkillContractErrorCode.FILE_PATH_DUPLICATE,
          joinPath(itemPath, 'path'),
          'path collides with another declared file'
        )
      );
      failed = true;
      return;
    }
    seenFolded.add(folded);
    entries.push({ path: filePath, sha256, size, kind, executable, script });
  });

  if (failed) return undefined;

  const skillMd = entries.filter((e) => e.path === SKILL_MD_FILENAME);
  if (skillMd.length !== 1) {
    errors.push(
      skillError(SkillContractErrorCode.FILE_SET_MISMATCH, path, `files must declare exactly one ${SKILL_MD_FILENAME}`)
    );
    return undefined;
  }
  if (skillMd[0].kind !== 'skill_md') {
    errors.push(
      skillError(
        SkillContractErrorCode.INCONSISTENT_VALUE,
        path,
        `${SKILL_MD_FILENAME} must be declared with kind "skill_md"`
      )
    );
    return undefined;
  }
  return entries;
}

/** Validate a parsed `commandmate.skill.yaml` document. */
export function validateSkillManifest(input: unknown): SkillValidationResult<SkillManifest> {
  const errors: Bag = [];
  const obj = readObject(input, '', errors);
  if (!obj) return skillFail(errors);

  const schemaVersion = readSchemaVersion(obj, errors);
  if (schemaVersion === undefined) return skillFail(errors);

  checkUnknownFields(obj, MANIFEST_FIELDS, '', errors);

  const idResult = validateSkillId(obj['id']);
  if (!idResult.ok) errors.push(...idResult.errors);

  const name = readString(obj, 'name', '', errors, { maxLength: SKILL_NAME_MAX_LENGTH });
  const version = readString(obj, 'version', '', errors, { maxLength: 64 });
  if (version !== undefined && !isValidSemVer(version)) {
    errors.push(
      skillError(SkillContractErrorCode.VERSION_INVALID, '/version', 'version must be SemVer 2.0 without a "v" prefix')
    );
  }
  const summary = readString(obj, 'summary', '', errors, { maxLength: SKILL_SUMMARY_MAX_LENGTH });
  const description = readString(obj, 'description', '', errors, {
    maxLength: SKILL_DESCRIPTION_MAX_LENGTH,
  });
  const capabilities = readStringList(obj, 'capabilities', '', errors, {
    maxItems: SKILL_BULLET_MAX_COUNT,
    maxLength: SKILL_BULLET_MAX_LENGTH,
  });
  const expectedOutcomes = readStringList(obj, 'expected_outcomes', '', errors, {
    maxItems: SKILL_BULLET_MAX_COUNT,
    maxLength: SKILL_BULLET_MAX_LENGTH,
  });
  const provider = readProvider(obj, '', errors);
  const license = readString(obj, 'license', '', errors, {
    maxLength: 64,
    pattern: SPDX_LICENSE_PATTERN,
    patternName: 'spdx-license-id',
  });
  const homepage = readHttpsUrl(obj, 'homepage', '', errors, { optional: true });
  const keywords = readStringList(obj, 'keywords', '', errors, {
    maxItems: SKILL_KEYWORDS_MAX_COUNT,
    maxLength: SKILL_KEYWORD_MAX_LENGTH,
    optional: true,
  });
  const compatibility = readCompatibility(obj, '', errors);
  const requirements = readRequirements(obj, '', errors);
  const declaredPermissions = readStringList(obj, 'declared_permissions', '', errors, {
    maxItems: SKILL_DECLARED_PERMISSIONS.length,
    maxLength: 40,
  });
  if (declaredPermissions) {
    for (const [index, permission] of declaredPermissions.entries()) {
      if (!(SKILL_DECLARED_PERMISSIONS as readonly string[]).includes(permission)) {
        errors.push(
          skillError(
            SkillContractErrorCode.INVALID_ENUM,
            joinPath('/declared_permissions', index),
            'declared permission is not an allowed value'
          )
        );
      }
    }
  }
  const declaredRisk = readEnum<SkillRiskLevel>(obj, 'declared_risk', '', errors, SKILL_RISK_LEVELS);
  const riskRationale = readString(obj, 'risk_rationale', '', errors, {
    maxLength: SKILL_RATIONALE_MAX_LENGTH,
  });
  const files = readFileEntries(obj, '', errors);

  // Capabilities and expected outcomes are what the install dialog shows (UX-01),
  // so an empty list is a contract violation rather than an acceptable default.
  if (capabilities && capabilities.length === 0) {
    errors.push(skillError(SkillContractErrorCode.MISSING_FIELD, '/capabilities', 'capabilities must not be empty'));
  }
  if (expectedOutcomes && expectedOutcomes.length === 0) {
    errors.push(
      skillError(SkillContractErrorCode.MISSING_FIELD, '/expected_outcomes', 'expected_outcomes must not be empty')
    );
  }

  if (
    errors.length > 0 ||
    !idResult.ok ||
    name === undefined ||
    version === undefined ||
    summary === undefined ||
    description === undefined ||
    capabilities === undefined ||
    expectedOutcomes === undefined ||
    provider === undefined ||
    license === undefined ||
    compatibility === undefined ||
    requirements === undefined ||
    declaredPermissions === undefined ||
    declaredRisk === undefined ||
    riskRationale === undefined ||
    files === undefined
  ) {
    return skillFail(
      errors.length > 0
        ? errors
        : [skillError(SkillContractErrorCode.MISSING_FIELD, '', 'manifest is incomplete')]
    );
  }

  return skillOk({
    schema_version: schemaVersion,
    id: idResult.value,
    name,
    version,
    summary,
    description,
    capabilities,
    expected_outcomes: expectedOutcomes,
    provider,
    license,
    ...(homepage !== undefined ? { homepage } : {}),
    ...(keywords !== undefined ? { keywords } : {}),
    compatibility,
    requirements,
    declared_permissions: declaredPermissions as SkillDeclaredPermission[],
    declared_risk: declaredRisk,
    risk_rationale: riskRationale,
    files,
  });
}

// =============================================================================
// Catalog
// =============================================================================

function readCatalogVersion(
  raw: unknown,
  path: string,
  skillId: string,
  errors: Bag
): SkillCatalogVersion | undefined {
  const obj = readObject(raw, path, errors);
  if (!obj) return undefined;
  checkUnknownFields(obj, CATALOG_VERSION_FIELDS, path, errors);

  const version = readString(obj, 'version', path, errors, { maxLength: 64 });
  if (version !== undefined && !isValidSemVer(version)) {
    errors.push(
      skillError(SkillContractErrorCode.VERSION_INVALID, joinPath(path, 'version'), 'version must be SemVer 2.0')
    );
    return undefined;
  }
  const changelog = readString(obj, 'changelog', path, errors, { maxLength: SKILL_CHANGELOG_MAX_LENGTH });
  const publishedAt = readString(obj, 'published_at', path, errors, {
    maxLength: 30,
    pattern: RFC3339_UTC_PATTERN,
    patternName: 'rfc3339-utc',
  });
  const source = readSource(obj, path, errors);
  const artifact = readArtifact(obj, path, errors);
  const compatibility = readCompatibility(obj, path, errors);
  const declaredRisk = readEnum<SkillRiskLevel>(obj, 'declared_risk', path, errors, SKILL_RISK_LEVELS);

  if (
    version === undefined ||
    changelog === undefined ||
    publishedAt === undefined ||
    source === undefined ||
    artifact === undefined ||
    compatibility === undefined ||
    declaredRisk === undefined
  ) {
    return undefined;
  }

  const expectedAsset = buildSkillAssetName(skillId, version);
  if (artifact.asset_name !== expectedAsset) {
    errors.push(
      skillError(
        SkillContractErrorCode.ARTIFACT_INVALID,
        joinPath(joinPath(path, 'artifact'), 'asset_name'),
        'asset_name must follow the <skill-id>-<version>.tar.gz convention',
        { expected: expectedAsset }
      )
    );
    return undefined;
  }

  return {
    version,
    changelog,
    published_at: publishedAt,
    source,
    artifact,
    compatibility,
    declared_risk: declaredRisk,
  };
}

function readCatalogEntry(raw: unknown, path: string, errors: Bag): SkillCatalogEntry | undefined {
  const obj = readObject(raw, path, errors);
  if (!obj) return undefined;
  checkUnknownFields(obj, CATALOG_ENTRY_FIELDS, path, errors);

  const idResult = validateSkillId(obj['id'], joinPath(path, 'id'));
  if (!idResult.ok) {
    errors.push(...idResult.errors);
    return undefined;
  }
  const id = idResult.value;

  const name = readString(obj, 'name', path, errors, { maxLength: SKILL_NAME_MAX_LENGTH });
  const summary = readString(obj, 'summary', path, errors, { maxLength: SKILL_SUMMARY_MAX_LENGTH });
  const provider = readProvider(obj, path, errors);
  const license = readString(obj, 'license', path, errors, {
    maxLength: 64,
    pattern: SPDX_LICENSE_PATTERN,
    patternName: 'spdx-license-id',
  });
  const homepage = readHttpsUrl(obj, 'homepage', path, errors, { optional: true });
  const keywords = readStringList(obj, 'keywords', path, errors, {
    maxItems: SKILL_KEYWORDS_MAX_COUNT,
    maxLength: SKILL_KEYWORD_MAX_LENGTH,
    optional: true,
  });
  const latest = readString(obj, 'latest', path, errors, { maxLength: 64 });
  const rawVersions = readArray(obj, 'versions', path, errors, {
    maxItems: SKILL_CATALOG_VERSIONS_MAX_COUNT,
  });

  if (
    name === undefined ||
    summary === undefined ||
    provider === undefined ||
    license === undefined ||
    latest === undefined ||
    rawVersions === undefined
  ) {
    return undefined;
  }

  if (rawVersions.length === 0) {
    errors.push(
      skillError(SkillContractErrorCode.MISSING_FIELD, joinPath(path, 'versions'), 'versions must not be empty')
    );
    return undefined;
  }

  const versions: SkillCatalogVersion[] = [];
  const seenVersions = new Set<string>();
  let failed = false;
  rawVersions.forEach((item, index) => {
    const itemPath = joinPath(joinPath(path, 'versions'), index);
    const parsed = readCatalogVersion(item, itemPath, id, errors);
    if (!parsed) {
      failed = true;
      return;
    }
    if (seenVersions.has(parsed.version)) {
      errors.push(
        skillError(SkillContractErrorCode.DUPLICATE_ENTRY, itemPath, 'version is listed more than once')
      );
      failed = true;
      return;
    }
    seenVersions.add(parsed.version);
    versions.push(parsed);
  });
  if (failed) return undefined;

  if (!seenVersions.has(latest)) {
    errors.push(
      skillError(
        SkillContractErrorCode.CATALOG_LATEST_UNRESOLVED,
        joinPath(path, 'latest'),
        'latest must reference a listed version'
      )
    );
    return undefined;
  }

  return {
    id,
    name,
    summary,
    provider,
    license,
    ...(homepage !== undefined ? { homepage } : {}),
    ...(keywords !== undefined ? { keywords } : {}),
    latest,
    versions,
  };
}

/** Validate a parsed Catalog document. */
export function validateSkillCatalog(input: unknown): SkillValidationResult<SkillCatalog> {
  const errors: Bag = [];
  const obj = readObject(input, '', errors);
  if (!obj) return skillFail(errors);

  const schemaVersion = readSchemaVersion(obj, errors);
  if (schemaVersion === undefined) return skillFail(errors);

  checkUnknownFields(obj, CATALOG_FIELDS, '', errors);

  const rawEntries = readArray(obj, 'entries', '', errors, {
    maxItems: SKILL_CATALOG_ENTRIES_MAX_COUNT,
  });
  if (rawEntries === undefined) return skillFail(errors);

  const entries: SkillCatalogEntry[] = [];
  const seenIds = new Set<string>();
  rawEntries.forEach((item, index) => {
    const itemPath = joinPath('/entries', index);
    const parsed = readCatalogEntry(item, itemPath, errors);
    if (!parsed) return;
    const folded = foldSkillIdForCollision(parsed.id);
    if (seenIds.has(folded)) {
      errors.push(
        skillError(SkillContractErrorCode.ID_COLLISION, itemPath, 'entry id collides with another entry')
      );
      return;
    }
    seenIds.add(folded);
    entries.push(parsed);
  });

  if (errors.length > 0) return skillFail(errors);
  return skillOk({ schema_version: schemaVersion, entries });
}

// =============================================================================
// Receipt
// =============================================================================

function readReceiptArtifact(
  parentObj: Record<string, unknown>,
  parent: string,
  errors: Bag
): SkillReceiptArtifact | undefined {
  const path = joinPath(parent, 'artifact');
  const raw = parentObj['artifact'];
  if (raw === undefined) {
    errors.push(skillError(SkillContractErrorCode.MISSING_FIELD, path, 'artifact is required'));
    return undefined;
  }
  const obj = readObject(raw, path, errors);
  if (!obj) return undefined;
  checkUnknownFields(obj, RECEIPT_ARTIFACT_FIELDS, path, errors);

  const assetName = readString(obj, 'asset_name', path, errors, { maxLength: 200 });
  const sha256 = readString(obj, 'sha256', path, errors, {
    minLength: 64,
    maxLength: 64,
    pattern: SHA256_HEX_PATTERN,
    patternName: 'sha256-lowercase-hex',
    formatCode: SkillContractErrorCode.DIGEST_INVALID,
  });
  const size = readInteger(obj, 'size', path, errors, { min: 1, max: SKILL_ARTIFACT_MAX_SIZE });
  const format = readEnum(obj, 'format', path, errors, [SKILL_ARTIFACT_FORMAT] as const);
  if (assetName === undefined || sha256 === undefined || size === undefined || format === undefined) {
    return undefined;
  }
  return { asset_name: assetName, sha256, size, format };
}

function readInstalledFiles(
  parentObj: Record<string, unknown>,
  parent: string,
  errors: Bag
): SkillInstalledFile[] | undefined {
  const path = joinPath(parent, 'files');
  const raw = readArray(parentObj, 'files', parent, errors, { maxItems: SKILL_FILES_MAX_COUNT });
  if (raw === undefined) return undefined;

  const files: SkillInstalledFile[] = [];
  let failed = false;
  raw.forEach((item, index) => {
    const itemPath = joinPath(path, index);
    const obj = readObject(item, itemPath, errors);
    if (!obj) {
      failed = true;
      return;
    }
    checkUnknownFields(obj, INSTALLED_FILE_FIELDS, itemPath, errors);
    const pathResult = validateSkillPayloadPath(obj['path'], joinPath(itemPath, 'path'));
    const sha256 = readString(obj, 'sha256', itemPath, errors, {
      minLength: 64,
      maxLength: 64,
      pattern: SHA256_HEX_PATTERN,
      patternName: 'sha256-lowercase-hex',
      formatCode: SkillContractErrorCode.DIGEST_INVALID,
    });
    const size = readInteger(obj, 'size', itemPath, errors, { min: 0, max: SKILL_FILE_MAX_SIZE });
    const executable = readBoolean(obj, 'executable', itemPath, errors);
    if (!pathResult.ok) {
      errors.push(...pathResult.errors);
      failed = true;
      return;
    }
    if (sha256 === undefined || size === undefined || executable === undefined) {
      failed = true;
      return;
    }
    files.push({ path: pathResult.value, sha256, size, executable });
  });
  if (failed) return undefined;

  // Receipts must be byte-reproducible, so the file list has one canonical order.
  for (let i = 1; i < files.length; i++) {
    if (files[i - 1].path >= files[i].path) {
      errors.push(
        skillError(
          SkillContractErrorCode.INCONSISTENT_VALUE,
          path,
          'files must be sorted by path in ascending order without duplicates'
        )
      );
      return undefined;
    }
  }
  return files;
}

/** Validate a parsed install receipt. */
export function validateSkillInstallReceipt(
  input: unknown
): SkillValidationResult<SkillInstallReceipt> {
  const errors: Bag = [];
  const obj = readObject(input, '', errors);
  if (!obj) return skillFail(errors);

  const schemaVersion = readSchemaVersion(obj, errors);
  if (schemaVersion === undefined) return skillFail(errors);

  checkUnknownFields(obj, RECEIPT_FIELDS, '', errors);

  const idResult = validateSkillId(obj['skill_id'], '/skill_id');
  if (!idResult.ok) errors.push(...idResult.errors);

  const version = readString(obj, 'version', '', errors, { maxLength: 64 });
  if (version !== undefined && !isValidSemVer(version)) {
    errors.push(skillError(SkillContractErrorCode.VERSION_INVALID, '/version', 'version must be SemVer 2.0'));
  }
  const installRoot = readString(obj, 'install_root', '', errors, { maxLength: 200 });
  const source = readSource(obj, '', errors);
  const artifact = readReceiptArtifact(obj, '', errors);
  const files = readInstalledFiles(obj, '', errors);
  const declaredRisk = readEnum<SkillRiskLevel>(obj, 'declared_risk', '', errors, SKILL_RISK_LEVELS);
  const computedRisk = readEnum<SkillRiskLevel>(obj, 'computed_risk', '', errors, SKILL_RISK_LEVELS);
  const effectiveRisk = readEnum<SkillRiskLevel>(obj, 'effective_risk', '', errors, SKILL_RISK_LEVELS);
  const declaredPermissions = readStringList(obj, 'declared_permissions', '', errors, {
    maxItems: SKILL_DECLARED_PERMISSIONS.length,
    maxLength: 40,
  });
  if (declaredPermissions) {
    for (const [index, permission] of declaredPermissions.entries()) {
      if (!(SKILL_DECLARED_PERMISSIONS as readonly string[]).includes(permission)) {
        errors.push(
          skillError(
            SkillContractErrorCode.INVALID_ENUM,
            joinPath('/declared_permissions', index),
            'declared permission is not an allowed value'
          )
        );
      }
    }
  }

  const rawAgents = readArray(obj, 'agent_compatibility', '', errors, { maxItems: 20 });
  const agentCompatibility: SkillAgentCompatibility[] = [];
  if (rawAgents) {
    rawAgents.forEach((item, index) => {
      const parsed = readAgentCompatibility(item, joinPath('/agent_compatibility', index), errors);
      if (parsed) agentCompatibility.push(parsed);
    });
  }

  if (idResult.ok && installRoot !== undefined) {
    const expectedRoot = `${SKILL_INSTALL_ROOT_PREFIX}/${idResult.value}`;
    if (installRoot !== expectedRoot) {
      errors.push(
        skillError(
          SkillContractErrorCode.INCONSISTENT_VALUE,
          '/install_root',
          'install_root must be the repository-relative skill root',
          { expected: expectedRoot }
        )
      );
    }
  }

  if (idResult.ok && version !== undefined && artifact !== undefined) {
    const expectedAsset = buildSkillAssetName(idResult.value, version);
    if (artifact.asset_name !== expectedAsset) {
      errors.push(
        skillError(
          SkillContractErrorCode.ARTIFACT_INVALID,
          '/artifact/asset_name',
          'asset_name must follow the <skill-id>-<version>.tar.gz convention',
          { expected: expectedAsset }
        )
      );
    }
  }

  if (declaredRisk !== undefined && computedRisk !== undefined && effectiveRisk !== undefined) {
    const expected = resolveEffectiveSkillRisk(declaredRisk, computedRisk);
    if (effectiveRisk !== expected) {
      errors.push(
        skillError(
          SkillContractErrorCode.INCONSISTENT_VALUE,
          '/effective_risk',
          'effective_risk must be the higher of declared_risk and computed_risk',
          { expected }
        )
      );
    }
  }

  if (
    errors.length > 0 ||
    !idResult.ok ||
    version === undefined ||
    installRoot === undefined ||
    source === undefined ||
    artifact === undefined ||
    files === undefined ||
    declaredRisk === undefined ||
    computedRisk === undefined ||
    effectiveRisk === undefined ||
    declaredPermissions === undefined ||
    rawAgents === undefined
  ) {
    return skillFail(
      errors.length > 0
        ? errors
        : [skillError(SkillContractErrorCode.MISSING_FIELD, '', 'receipt is incomplete')]
    );
  }

  return skillOk({
    schema_version: schemaVersion,
    skill_id: idResult.value,
    version,
    install_root: installRoot,
    source,
    artifact,
    files,
    declared_risk: declaredRisk,
    computed_risk: computedRisk,
    effective_risk: effectiveRisk,
    declared_permissions: declaredPermissions as SkillDeclaredPermission[],
    agent_compatibility: agentCompatibility,
  });
}

// =============================================================================
// Cross-document rules
// =============================================================================

/**
 * Compare the manifest's declared file set with the package's payload set.
 *
 * The comparison set is every regular payload file in the archive minus the
 * manifest itself and minus directory entries; the manifest's own integrity is
 * covered by the Catalog artifact digest, so it declares no self-digest.
 */
export function validateManifestFileSet(
  manifest: SkillManifest,
  payloadPaths: readonly string[]
): SkillValidationResult<readonly string[]> {
  const declared = new Set(manifest.files.map((f) => f.path));
  const actual = new Set(payloadPaths.filter((p) => p !== SKILL_MANIFEST_FILENAME));

  const errors: Bag = [];
  for (const path of declared) {
    if (!actual.has(path)) {
      errors.push(
        skillError(SkillContractErrorCode.FILE_SET_MISMATCH, '/files', 'declared file is absent from the package', {
          path,
        })
      );
    }
  }
  for (const path of actual) {
    if (!declared.has(path)) {
      errors.push(
        skillError(SkillContractErrorCode.FILE_SET_MISMATCH, '/files', 'package contains an undeclared file', {
          path,
        })
      );
    }
  }
  return errors.length > 0 ? skillFail(errors) : skillOk([...declared].sort());
}

/** Resolve the effective risk shown to the user: the higher of the two inputs. */
export function resolveEffectiveSkillRisk(
  declared: SkillRiskLevel,
  computed: SkillRiskLevel
): SkillRiskLevel {
  return SKILL_RISK_ORDER[computed] > SKILL_RISK_ORDER[declared] ? computed : declared;
}

/**
 * Derive the risk level CommandMate computes from inspection facts.
 *
 * Deterministic and independent of the publisher's own claim, so a package
 * cannot talk its way down to `low`.
 */
export function computeSkillRisk(inspection: SkillPackageInspection): SkillRiskLevel {
  if (
    inspection.executable_paths.length > 0 ||
    inspection.declared_permissions.includes('credential_access')
  ) {
    return 'high';
  }
  if (
    inspection.script_paths.length > 0 ||
    inspection.network_hosts.length > 0 ||
    inspection.declared_permissions.includes('process_execution') ||
    inspection.declared_permissions.includes('filesystem_write')
  ) {
    return 'moderate';
  }
  return 'low';
}

// =============================================================================
// Canonicalization
// =============================================================================

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * Serialize a receipt deterministically: keys sorted, no insignificant
 * whitespace, no undefined members. Two installs of the same version from the
 * same commit produce byte-identical output, which is what makes a receipt
 * diffable and hashable.
 */
export function canonicalizeSkillReceipt(receipt: SkillInstallReceipt): string {
  return JSON.stringify(canonicalize(receipt));
}
