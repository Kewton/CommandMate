/**
 * Tests for src/lib/skills/json-schema.ts
 * Issue #1228: the published JSON Schema must describe the same contract as the
 * TypeScript types and the runtime validators.
 *
 * Acceptance criterion "every required field defined by the Schema matches the
 * TypeScript type" is enforced here at runtime and by the `satisfies` guards in
 * schema.ts at compile time.
 */

import { describe, it, expect } from 'vitest';
import { SKILL_SCHEMA_VERSION } from '@/lib/skills/constants';
import {
  SKILL_CATALOG_JSON_SCHEMA,
  SKILL_MANIFEST_JSON_SCHEMA,
  SKILL_RECEIPT_JSON_SCHEMA,
  type SkillJsonSchemaDocument,
} from '@/lib/skills/json-schema';
import { SKILL_DOCUMENT_FIELDS, SKILL_OPTIONAL_FIELDS } from '@/lib/skills/schema';

type ObjectSchema = {
  type?: string;
  additionalProperties?: boolean;
  required?: string[];
  properties?: Record<string, ObjectSchema>;
  items?: ObjectSchema;
  $defs?: Record<string, ObjectSchema>;
};

const DOCUMENTS: Array<[string, SkillJsonSchemaDocument, keyof typeof SKILL_DOCUMENT_FIELDS]> = [
  ['manifest', SKILL_MANIFEST_JSON_SCHEMA, 'manifest'],
  ['catalog', SKILL_CATALOG_JSON_SCHEMA, 'catalog'],
  ['receipt', SKILL_RECEIPT_JSON_SCHEMA, 'receipt'],
];

describe.each(DOCUMENTS)('%s JSON Schema', (_name, schema, fieldKey) => {
  it('declares the same property set as the TypeScript type', () => {
    expect(Object.keys(schema.properties).sort()).toEqual(
      [...SKILL_DOCUMENT_FIELDS[fieldKey]].sort()
    );
  });

  it('requires exactly the non-optional fields', () => {
    const optional = new Set<string>(SKILL_OPTIONAL_FIELDS[fieldKey]);
    const expected = SKILL_DOCUMENT_FIELDS[fieldKey].filter((f) => !optional.has(f)).sort();
    expect([...schema.required].sort()).toEqual(expected);
  });

  it('is closed to unknown fields at the top level', () => {
    expect(schema.additionalProperties).toBe(false);
  });

  it('pins schema_version to the supported value', () => {
    const property = schema.properties['schema_version'] as { const?: number };
    expect(property.const).toBe(SKILL_SCHEMA_VERSION);
  });
});

describe('nested object schemas', () => {
  function collectObjectSchemas(node: ObjectSchema, trail: string, out: Array<[string, ObjectSchema]>): void {
    if (node.type === 'object' && node.properties) out.push([trail, node]);
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      collectObjectSchemas(child, `${trail}/${key}`, out);
    }
    if (node.items) collectObjectSchemas(node.items, `${trail}[]`, out);
    for (const [key, child] of Object.entries(node.$defs ?? {})) {
      collectObjectSchemas(child, `${trail}/$defs/${key}`, out);
    }
  }

  it.each(DOCUMENTS)('%s closes every nested object to unknown fields', (name, schema) => {
    const found: Array<[string, ObjectSchema]> = [];
    collectObjectSchemas(schema as unknown as ObjectSchema, name, found);
    const open = found.filter(([, node]) => node.additionalProperties !== false).map(([trail]) => trail);
    expect(open).toEqual([]);
  });
});

describe('nested schema parity with the TypeScript types', () => {
  it.each([
    ['provider', SKILL_MANIFEST_JSON_SCHEMA.$defs?.provider],
    ['compatibility', SKILL_MANIFEST_JSON_SCHEMA.$defs?.compatibility],
    ['agentCompatibility', SKILL_MANIFEST_JSON_SCHEMA.$defs?.agentCompatibility],
    ['sourceRef', SKILL_CATALOG_JSON_SCHEMA.$defs?.sourceRef],
  ] as const)('%s declares the same property set as the type', (key, def) => {
    const fieldKey = key === 'sourceRef' ? 'source' : key;
    const properties = Object.keys((def as ObjectSchema).properties ?? {}).sort();
    expect(properties).toEqual(
      [...SKILL_DOCUMENT_FIELDS[fieldKey as keyof typeof SKILL_DOCUMENT_FIELDS]].sort()
    );
  });

  it('declares the manifest file entry fields', () => {
    const files = SKILL_MANIFEST_JSON_SCHEMA.properties['files'] as ObjectSchema;
    expect(Object.keys(files.items?.properties ?? {}).sort()).toEqual(
      [...SKILL_DOCUMENT_FIELDS.fileEntry].sort()
    );
  });

  it('declares the receipt artifact without a url so signed URLs cannot be persisted', () => {
    const artifact = SKILL_RECEIPT_JSON_SCHEMA.properties['artifact'] as ObjectSchema;
    expect(Object.keys(artifact.properties ?? {}).sort()).toEqual(
      [...SKILL_DOCUMENT_FIELDS.receiptArtifact].sort()
    );
    expect(Object.keys(artifact.properties ?? {})).not.toContain('url');
  });
});
