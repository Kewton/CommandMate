/* eslint-disable no-restricted-syntax -- `description` here is JSON Schema documentation
   published to Skill authors and validators, not UI copy: it must stay in the schema's own
   language and is never rendered through t(). */
/**
 * JSON Schema documents for the Skills distribution contract (Issue #1228)
 *
 * These are the publishable, language-neutral form of the contract: a Skill
 * author or a CI job outside CommandMate can validate a manifest without
 * running TypeScript. Inside CommandMate the authority is
 * `src/lib/skills/schema.ts`; the parity test in
 * `tests/unit/lib/skills/json-schema-parity.test.ts` keeps the two from
 * drifting.
 *
 * @module lib/skills/json-schema
 */

import {
  GIT_COMMIT_SHA_PATTERN,
  GIT_REF_PATTERN,
  NETWORK_HOST_PATTERN,
  REPOSITORY_SLUG_PATTERN,
  RFC3339_UTC_PATTERN,
  SHA256_HEX_PATTERN,
  SKILL_AGENT_SUPPORT_VALUES,
  SKILL_ARTIFACT_CONTENT_TYPE,
  SKILL_ARTIFACT_FORMAT,
  SKILL_ARTIFACT_MAX_SIZE,
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
  SKILL_KEYWORD_MAX_LENGTH,
  SKILL_KEYWORDS_MAX_COUNT,
  SKILL_NAME_MAX_LENGTH,
  SKILL_NETWORK_HOSTS_MAX_COUNT,
  SKILL_PATH_MAX_LENGTH,
  SKILL_RATIONALE_MAX_LENGTH,
  SKILL_RISK_LEVELS,
  SKILL_SCHEMA_VERSION,
  SKILL_SUMMARY_MAX_LENGTH,
  SPDX_LICENSE_PATTERN,
} from '@/lib/skills/constants';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';
import { SEMVER_2_PATTERN } from '@/lib/skills/semver';

/** Shape shared by all three published schema documents. */
export interface SkillJsonSchemaDocument {
  $schema: string;
  $id: string;
  title: string;
  type: 'object';
  additionalProperties: false;
  required: readonly string[];
  properties: Record<string, unknown>;
  $defs?: Record<string, unknown>;
}

const DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const BASE_ID = 'https://commandmate.dev/schemas/skills';

const source = (pattern: RegExp): string => pattern.source;

const schemaVersionProperty = {
  const: SKILL_SCHEMA_VERSION,
  description: 'Contract version. Consumers reject any other value.',
};

const providerDef = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: SKILL_NAME_MAX_LENGTH },
    url: { type: 'string', format: 'uri', pattern: '^https://' },
    contact: { type: 'string', minLength: 1, maxLength: 200 },
  },
};

const agentCompatibilityDef = {
  type: 'object',
  additionalProperties: false,
  required: ['agent', 'support', 'evidence'],
  properties: {
    agent: { type: 'string', enum: [...CLI_TOOL_IDS] },
    support: { type: 'string', enum: [...SKILL_AGENT_SUPPORT_VALUES] },
    evidence: { type: 'string', minLength: 1, maxLength: SKILL_EVIDENCE_MAX_LENGTH },
  },
};

const compatibilityDef = {
  type: 'object',
  additionalProperties: false,
  required: ['commandmate', 'agents'],
  properties: {
    commandmate: {
      type: 'string',
      minLength: 1,
      maxLength: 100,
      description: 'AND-combined comparator list, e.g. ">=0.11.0 <1.0.0".',
    },
    agents: { type: 'array', maxItems: 20, items: { $ref: '#/$defs/agentCompatibility' } },
  },
};

const sourceRefDef = {
  type: 'object',
  additionalProperties: false,
  required: ['repository', 'ref', 'commit'],
  properties: {
    repository: { type: 'string', pattern: source(REPOSITORY_SLUG_PATTERN) },
    ref: { type: 'string', pattern: source(GIT_REF_PATTERN) },
    commit: {
      type: 'string',
      pattern: source(GIT_COMMIT_SHA_PATTERN),
      description: 'Resolved commit SHA. The trusted source coordinate.',
    },
  },
};

const sha256Property = {
  type: 'string',
  pattern: source(SHA256_HEX_PATTERN),
  description: 'Lowercase hex SHA-256.',
};

const declaredPermissionsProperty = {
  type: 'array',
  maxItems: SKILL_DECLARED_PERMISSIONS.length,
  uniqueItems: true,
  items: { type: 'string', enum: [...SKILL_DECLARED_PERMISSIONS] },
  description: 'Publisher declaration only. Not an enforcement boundary.',
};

const riskProperty = { type: 'string', enum: [...SKILL_RISK_LEVELS] };

const payloadPathProperty = {
  type: 'string',
  minLength: 1,
  maxLength: SKILL_PATH_MAX_LENGTH,
  description: 'POSIX relative path inside the Skill root. No "..", no absolute path.',
};

/** JSON Schema for `commandmate.skill.yaml`. */
export const SKILL_MANIFEST_JSON_SCHEMA: SkillJsonSchemaDocument = {
  $schema: DRAFT,
  $id: `${BASE_ID}/manifest-v${SKILL_SCHEMA_VERSION}.json`,
  title: 'CommandMate Skill manifest',
  type: 'object',
  additionalProperties: false,
  required: [
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
    'compatibility',
    'requirements',
    'declared_permissions',
    'declared_risk',
    'risk_rationale',
    'files',
  ],
  properties: {
    schema_version: schemaVersionProperty,
    id: { type: 'string', pattern: source(SKILL_ID_PATTERN), maxLength: SKILL_ID_MAX_LENGTH },
    name: { type: 'string', minLength: 1, maxLength: SKILL_NAME_MAX_LENGTH },
    version: { type: 'string', pattern: source(SEMVER_2_PATTERN) },
    summary: { type: 'string', minLength: 1, maxLength: SKILL_SUMMARY_MAX_LENGTH },
    description: { type: 'string', minLength: 1, maxLength: SKILL_DESCRIPTION_MAX_LENGTH },
    capabilities: {
      type: 'array',
      minItems: 1,
      maxItems: SKILL_BULLET_MAX_COUNT,
      items: { type: 'string', minLength: 1, maxLength: SKILL_BULLET_MAX_LENGTH },
    },
    expected_outcomes: {
      type: 'array',
      minItems: 1,
      maxItems: SKILL_BULLET_MAX_COUNT,
      items: { type: 'string', minLength: 1, maxLength: SKILL_BULLET_MAX_LENGTH },
    },
    provider: { $ref: '#/$defs/provider' },
    license: { type: 'string', pattern: source(SPDX_LICENSE_PATTERN) },
    homepage: { type: 'string', pattern: '^https://' },
    keywords: {
      type: 'array',
      maxItems: SKILL_KEYWORDS_MAX_COUNT,
      items: { type: 'string', minLength: 1, maxLength: SKILL_KEYWORD_MAX_LENGTH },
    },
    compatibility: { $ref: '#/$defs/compatibility' },
    requirements: {
      type: 'object',
      additionalProperties: false,
      required: ['commands', 'network_hosts'],
      properties: {
        commands: {
          type: 'array',
          maxItems: SKILL_COMMANDS_MAX_COUNT,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name'],
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 64 },
              version_range: { type: 'string', minLength: 1, maxLength: 100 },
            },
          },
        },
        network_hosts: {
          type: 'array',
          maxItems: SKILL_NETWORK_HOSTS_MAX_COUNT,
          items: { type: 'string', pattern: source(NETWORK_HOST_PATTERN) },
        },
      },
    },
    declared_permissions: declaredPermissionsProperty,
    declared_risk: riskProperty,
    risk_rationale: { type: 'string', minLength: 1, maxLength: SKILL_RATIONALE_MAX_LENGTH },
    files: {
      type: 'array',
      maxItems: SKILL_FILES_MAX_COUNT,
      description: 'Payload files excluding commandmate.skill.yaml itself and directory entries.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'sha256', 'size', 'kind', 'executable', 'script'],
        properties: {
          path: payloadPathProperty,
          sha256: sha256Property,
          size: { type: 'integer', minimum: 0, maximum: SKILL_FILE_MAX_SIZE },
          kind: { type: 'string', enum: [...SKILL_FILE_KINDS] },
          executable: { type: 'boolean' },
          script: { type: 'boolean' },
        },
      },
    },
  },
  $defs: {
    provider: providerDef,
    compatibility: compatibilityDef,
    agentCompatibility: agentCompatibilityDef,
  },
};

/** JSON Schema for the Catalog document. */
export const SKILL_CATALOG_JSON_SCHEMA: SkillJsonSchemaDocument = {
  $schema: DRAFT,
  $id: `${BASE_ID}/catalog-v${SKILL_SCHEMA_VERSION}.json`,
  title: 'CommandMate Skill catalog',
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'entries'],
  properties: {
    schema_version: schemaVersionProperty,
    entries: {
      type: 'array',
      maxItems: SKILL_CATALOG_ENTRIES_MAX_COUNT,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'summary', 'provider', 'license', 'latest', 'versions'],
        properties: {
          id: { type: 'string', pattern: source(SKILL_ID_PATTERN), maxLength: SKILL_ID_MAX_LENGTH },
          name: { type: 'string', minLength: 1, maxLength: SKILL_NAME_MAX_LENGTH },
          summary: { type: 'string', minLength: 1, maxLength: SKILL_SUMMARY_MAX_LENGTH },
          provider: { $ref: '#/$defs/provider' },
          license: { type: 'string', pattern: source(SPDX_LICENSE_PATTERN) },
          homepage: { type: 'string', pattern: '^https://' },
          keywords: {
            type: 'array',
            maxItems: SKILL_KEYWORDS_MAX_COUNT,
            items: { type: 'string', minLength: 1, maxLength: SKILL_KEYWORD_MAX_LENGTH },
          },
          latest: { type: 'string', pattern: source(SEMVER_2_PATTERN) },
          versions: {
            type: 'array',
            minItems: 1,
            maxItems: SKILL_CATALOG_VERSIONS_MAX_COUNT,
            items: {
              type: 'object',
              additionalProperties: false,
              required: [
                'version',
                'changelog',
                'published_at',
                'source',
                'artifact',
                'compatibility',
                'declared_risk',
              ],
              properties: {
                version: { type: 'string', pattern: source(SEMVER_2_PATTERN) },
                changelog: { type: 'string', minLength: 1, maxLength: SKILL_CHANGELOG_MAX_LENGTH },
                published_at: { type: 'string', pattern: source(RFC3339_UTC_PATTERN) },
                source: { $ref: '#/$defs/sourceRef' },
                artifact: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['asset_name', 'url', 'sha256', 'size', 'content_type', 'format'],
                  properties: {
                    asset_name: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 200,
                      description: '<skill-id>-<version>.tar.gz',
                    },
                    url: { type: 'string', pattern: '^https://' },
                    sha256: sha256Property,
                    size: { type: 'integer', minimum: 1, maximum: SKILL_ARTIFACT_MAX_SIZE },
                    content_type: { const: SKILL_ARTIFACT_CONTENT_TYPE },
                    format: { const: SKILL_ARTIFACT_FORMAT },
                  },
                },
                compatibility: { $ref: '#/$defs/compatibility' },
                declared_risk: riskProperty,
              },
            },
          },
        },
      },
    },
  },
  $defs: {
    provider: providerDef,
    compatibility: compatibilityDef,
    agentCompatibility: agentCompatibilityDef,
    sourceRef: sourceRefDef,
  },
};

/** JSON Schema for the deterministic install receipt. */
export const SKILL_RECEIPT_JSON_SCHEMA: SkillJsonSchemaDocument = {
  $schema: DRAFT,
  $id: `${BASE_ID}/receipt-v${SKILL_SCHEMA_VERSION}.json`,
  title: 'CommandMate Skill install receipt',
  type: 'object',
  additionalProperties: false,
  required: [
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
  ],
  properties: {
    schema_version: schemaVersionProperty,
    skill_id: { type: 'string', pattern: source(SKILL_ID_PATTERN), maxLength: SKILL_ID_MAX_LENGTH },
    version: { type: 'string', pattern: source(SEMVER_2_PATTERN) },
    install_root: {
      type: 'string',
      description: 'Repository-relative .agents/skills/<skill-id>. Never a machine-absolute path.',
    },
    source: { $ref: '#/$defs/sourceRef' },
    artifact: {
      type: 'object',
      additionalProperties: false,
      required: ['asset_name', 'sha256', 'size', 'format'],
      description: 'No url: download URLs may be signed and are treated as secrets.',
      properties: {
        asset_name: { type: 'string', minLength: 1, maxLength: 200 },
        sha256: sha256Property,
        size: { type: 'integer', minimum: 1, maximum: SKILL_ARTIFACT_MAX_SIZE },
        format: { const: SKILL_ARTIFACT_FORMAT },
      },
    },
    files: {
      type: 'array',
      maxItems: SKILL_FILES_MAX_COUNT,
      description: 'Sorted by path ascending so receipts are byte-reproducible.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'sha256', 'size', 'executable'],
        properties: {
          path: payloadPathProperty,
          sha256: sha256Property,
          size: { type: 'integer', minimum: 0, maximum: SKILL_FILE_MAX_SIZE },
          executable: { type: 'boolean' },
        },
      },
    },
    declared_risk: riskProperty,
    computed_risk: riskProperty,
    effective_risk: { ...riskProperty, description: 'max(declared_risk, computed_risk).' },
    declared_permissions: declaredPermissionsProperty,
    agent_compatibility: {
      type: 'array',
      maxItems: 20,
      items: { $ref: '#/$defs/agentCompatibility' },
    },
  },
  $defs: {
    sourceRef: sourceRefDef,
    agentCompatibility: agentCompatibilityDef,
  },
};
