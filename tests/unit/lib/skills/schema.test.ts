/**
 * Tests for src/lib/skills/schema.ts
 * Issue #1228: Skill manifest / Catalog / receipt contract validation
 *
 * The invalid fixtures are self-describing envelopes
 * (`{ case, expectedErrorCode, expectedPath, document }`), so every rejection
 * asserts both the machine code and the location it points at.
 */

import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import {
  SKILL_INSTALL_ROOT_PREFIX,
  SKILL_MANIFEST_FILENAME,
} from '@/lib/skills/constants';
import { SkillContractErrorCode } from '@/lib/skills/errors';
import {
  canonicalizeSkillReceipt,
  computeSkillRisk,
  detectSkillIdCollision,
  resolveEffectiveSkillRisk,
  validateManifestFileSet,
  validateSkillCatalog,
  validateSkillId,
  validateSkillIdentityConsistency,
  validateSkillInstallReceipt,
  validateSkillManifest,
  validateSkillPayloadPath,
} from '@/lib/skills/schema';
import type { SkillCatalog, SkillInstallReceipt, SkillManifest } from '@/types/skills';

const FIXTURE_ROOT = path.join(process.cwd(), 'tests/fixtures/skills/contract');

interface InvalidFixture {
  case: string;
  expectedErrorCode: string;
  expectedPath: string;
  document: unknown;
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function loadValid(kind: string): Array<[string, unknown]> {
  const dir = path.join(FIXTURE_ROOT, kind, 'valid');
  return fs
    .readdirSync(dir)
    .sort()
    .map((name) => [name, readJson(path.join(dir, name))]);
}

function loadValidNamed(kind: string, name: string): unknown {
  return readJson(path.join(FIXTURE_ROOT, kind, 'valid', name));
}

function loadInvalid(kind: string): Array<[string, InvalidFixture]> {
  const dir = path.join(FIXTURE_ROOT, kind, 'invalid');
  return fs
    .readdirSync(dir)
    .sort()
    .map((name) => [name, readJson(path.join(dir, name)) as InvalidFixture]);
}

// ===========================================================================
// Fixture-driven acceptance and rejection
// ===========================================================================

describe.each([
  ['manifest', validateSkillManifest],
  ['catalog', validateSkillCatalog],
  ['receipt', validateSkillInstallReceipt],
] as const)('%s fixtures', (kind, validate) => {
  it.each(loadValid(kind))('accepts %s', (_name, document) => {
    const result = validate(document as never);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it.each(loadInvalid(kind))('rejects %s', (_name, fixture) => {
    const result = validate(fixture.document as never);
    expect(result.ok).toBe(false);
    const match = result.errors.find(
      (e) => e.code === fixture.expectedErrorCode && e.path === fixture.expectedPath
    );
    expect(
      match,
      `${fixture.case}: expected ${fixture.expectedErrorCode} at ${fixture.expectedPath}, got ${JSON.stringify(result.errors)}`
    ).toBeDefined();
  });
});

// ===========================================================================
// Returned value is reconstructed, not the input object
// ===========================================================================

describe('validateSkillManifest', () => {
  const validManifest = loadValidNamed('manifest', 'release-notes.json');

  it('returns a value that carries no prototype pollution from the input', () => {
    const result = validateSkillManifest(validManifest);
    expect(result.ok).toBe(true);
    const value = result.value as SkillManifest;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('drops an optional field rather than materializing it as undefined', () => {
    const result = validateSkillManifest(loadValidNamed('manifest', 'minimal.json'));
    expect(result.ok).toBe(true);
    expect(Object.keys(result.value as SkillManifest)).not.toContain('homepage');
  });

  it('reports every problem in one pass rather than stopping at the first', () => {
    const result = validateSkillManifest({
      ...(validManifest as Record<string, unknown>),
      id: 'Bad-Id',
      version: 'v1.0.0',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toEqual(
      expect.arrayContaining([
        SkillContractErrorCode.ID_INVALID,
        SkillContractErrorCode.VERSION_INVALID,
      ])
    );
  });

  it('rejects a non-object document', () => {
    for (const input of ['a string', 42, null, [], undefined]) {
      const result = validateSkillManifest(input);
      expect(result.ok).toBe(false);
      expect(result.errors[0].code).toBe(SkillContractErrorCode.NOT_AN_OBJECT);
    }
  });
});

// ===========================================================================
// Skill ID
// ===========================================================================

describe('validateSkillId', () => {
  it.each(['release-notes', 'a', 'skill-2', 'a'.repeat(64)])('accepts %s', (id) => {
    expect(validateSkillId(id).ok).toBe(true);
  });

  it.each([
    ['Release-Notes', SkillContractErrorCode.ID_INVALID],
    ['release_notes', SkillContractErrorCode.ID_INVALID],
    ['-release', SkillContractErrorCode.ID_INVALID],
    ['release-', SkillContractErrorCode.ID_INVALID],
    ['release--notes', SkillContractErrorCode.ID_INVALID],
    ['.hidden', SkillContractErrorCode.ID_INVALID],
    ['..', SkillContractErrorCode.ID_INVALID],
    ['.commandmate-staging', SkillContractErrorCode.ID_INVALID],
    ['a'.repeat(65), SkillContractErrorCode.ID_INVALID],
    ['', SkillContractErrorCode.ID_INVALID],
    ['commandmate', SkillContractErrorCode.ID_RESERVED],
    ['con', SkillContractErrorCode.ID_RESERVED],
    ['lpt1', SkillContractErrorCode.ID_RESERVED],
  ])('rejects %s with %s', (id, code) => {
    const result = validateSkillId(id);
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe(code);
  });
});

describe('detectSkillIdCollision', () => {
  it('flags a directory that differs only by case', () => {
    expect(detectSkillIdCollision('release-notes', ['Release-Notes'])).toBe('Release-Notes');
  });

  it('flags a directory that differs only by Unicode compatibility form', () => {
    expect(detectSkillIdCollision('release-notes', ['ｒelease-notes'])).toBe('ｒelease-notes');
  });

  it('ignores the identical name so re-validating an installed skill is not a collision', () => {
    expect(detectSkillIdCollision('release-notes', ['release-notes'])).toBeNull();
  });

  it('returns null when nothing collides', () => {
    expect(detectSkillIdCollision('release-notes', ['commit-lint'])).toBeNull();
  });
});

describe('validateSkillIdentityConsistency', () => {
  const base = {
    directoryName: 'release-notes',
    skillMdName: 'release-notes',
    manifestId: 'release-notes',
    manifestName: 'release-notes',
  };

  it('accepts a package whose three names agree', () => {
    expect(validateSkillIdentityConsistency(base).ok).toBe(true);
  });

  it('rejects a directory name that differs from the manifest id', () => {
    const result = validateSkillIdentityConsistency({ ...base, directoryName: 'other' });
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe(SkillContractErrorCode.ID_MISMATCH);
    expect(result.errors[0].path).toBe('/id');
  });

  it('rejects a SKILL.md name that differs from the manifest name', () => {
    const result = validateSkillIdentityConsistency({ ...base, skillMdName: 'Release Notes' });
    expect(result.ok).toBe(false);
    expect(result.errors[0].path).toBe('/name');
  });
});

// ===========================================================================
// Payload paths
// ===========================================================================

describe('validateSkillPayloadPath', () => {
  it.each(['SKILL.md', 'references/format.md', 'assets/img/logo.png'])('accepts %s', (p) => {
    expect(validateSkillPayloadPath(p, '/files/0/path').ok).toBe(true);
  });

  it.each([
    '../escape.md',
    'nested/../../escape.md',
    '/absolute.md',
    'C:/windows.md',
    'back\\slash.md',
    'trailing/',
    'double//slash.md',
    './relative.md',
    'with nul.md',
    'padded /file.md',
    'a/b/c/d/e/f/g/h/i.md',
  ])('rejects %s', (p) => {
    const result = validateSkillPayloadPath(p, '/files/0/path');
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe(SkillContractErrorCode.FILE_PATH_UNSAFE);
  });

  it('rejects a path that is not NFC-normalized', () => {
    // "é" written as e + combining acute; NFC would collapse it to one code point.
    expect(validateSkillPayloadPath('café.md', '/files/0/path').ok).toBe(false);
  });
});

// ===========================================================================
// Cross-document rules
// ===========================================================================

describe('validateManifestFileSet', () => {
  const manifest = validateSkillManifest(loadValidNamed('manifest', 'release-notes.json'))
    .value as SkillManifest;

  it('accepts the archive payload set that matches the declaration', () => {
    const payload = [...manifest.files.map((f) => f.path), SKILL_MANIFEST_FILENAME];
    expect(validateManifestFileSet(manifest, payload).ok).toBe(true);
  });

  it('rejects an undeclared file smuggled into the archive', () => {
    const payload = [
      ...manifest.files.map((f) => f.path),
      SKILL_MANIFEST_FILENAME,
      'scripts/backdoor.sh',
    ];
    const result = validateManifestFileSet(manifest, payload);
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe(SkillContractErrorCode.FILE_SET_MISMATCH);
    expect(result.errors[0].detail?.path).toBe('scripts/backdoor.sh');
  });

  it('rejects a declared file that is absent from the archive', () => {
    const result = validateManifestFileSet(manifest, ['SKILL.md', SKILL_MANIFEST_FILENAME]);
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe(SkillContractErrorCode.FILE_SET_MISMATCH);
  });
});

describe('risk resolution', () => {
  it.each([
    ['low', 'low', 'low'],
    ['low', 'high', 'high'],
    ['high', 'low', 'high'],
    ['moderate', 'high', 'high'],
    ['high', 'moderate', 'high'],
  ] as const)('declared %s + computed %s = %s', (declared, computed, expected) => {
    expect(resolveEffectiveSkillRisk(declared, computed)).toBe(expected);
  });

  it('computes high risk for an executable payload', () => {
    expect(
      computeSkillRisk({
        executable_paths: ['scripts/collect.sh'],
        script_paths: ['scripts/collect.sh'],
        network_hosts: [],
        declared_permissions: [],
      })
    ).toBe('high');
  });

  it('computes high risk when credential access is declared', () => {
    expect(
      computeSkillRisk({
        executable_paths: [],
        script_paths: [],
        network_hosts: [],
        declared_permissions: ['credential_access'],
      })
    ).toBe('high');
  });

  it('computes moderate risk for a non-executable script or a network target', () => {
    expect(
      computeSkillRisk({
        executable_paths: [],
        script_paths: ['scripts/collect.js'],
        network_hosts: [],
        declared_permissions: [],
      })
    ).toBe('moderate');
    expect(
      computeSkillRisk({
        executable_paths: [],
        script_paths: [],
        network_hosts: ['registry.npmjs.org'],
        declared_permissions: [],
      })
    ).toBe('moderate');
  });

  it('computes low risk for a read-only instruction-only package', () => {
    expect(
      computeSkillRisk({
        executable_paths: [],
        script_paths: [],
        network_hosts: [],
        declared_permissions: ['filesystem_read'],
      })
    ).toBe('low');
  });
});

// ===========================================================================
// Catalog and receipt specifics
// ===========================================================================

describe('validateSkillCatalog', () => {
  it('rejects two entries whose ids collide under case folding', () => {
    const catalog = validateSkillCatalog(loadValidNamed('catalog', 'catalog.json')).value as SkillCatalog;
    const raw = JSON.parse(JSON.stringify(catalog)) as SkillCatalog;
    raw.entries.push(JSON.parse(JSON.stringify(raw.entries[0])));
    const result = validateSkillCatalog(raw);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === SkillContractErrorCode.ID_COLLISION)).toBe(true);
  });
});

describe('validateSkillInstallReceipt', () => {
  const receipt = validateSkillInstallReceipt(loadValidNamed('receipt', 'release-notes.json'))
    .value as SkillInstallReceipt;

  it('anchors install_root under the worktree skills directory', () => {
    expect(receipt.install_root).toBe(`${SKILL_INSTALL_ROOT_PREFIX}/${receipt.skill_id}`);
  });

  it('serializes deterministically regardless of key insertion order', () => {
    const shuffled = Object.fromEntries(
      Object.entries(receipt as unknown as Record<string, unknown>).reverse()
    ) as unknown as SkillInstallReceipt;
    expect(canonicalizeSkillReceipt(shuffled)).toBe(canonicalizeSkillReceipt(receipt));
  });

  it('carries no timestamp, actor or absolute path', () => {
    const serialized = canonicalizeSkillReceipt(receipt);
    expect(serialized).not.toContain('installed_at');
    expect(serialized).not.toContain('installed_by');
    expect(serialized).not.toContain('/Users/');
    expect(serialized).not.toContain('http');
  });
});
