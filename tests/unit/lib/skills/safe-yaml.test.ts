/**
 * Tests for src/lib/skills/safe-yaml.ts
 * Issue #1230: manifest YAML parsed under SKILL_YAML_SAFE_PROFILE
 */

import { describe, it, expect } from 'vitest';
import { SKILL_YAML_SAFE_PROFILE } from '@/lib/skills';
import {
  SkillYamlError,
  SkillYamlErrorCode,
  isSkillYamlError,
  parseSkillFrontmatter,
  parseSkillYaml,
  type SkillYamlProfile,
} from '@/lib/skills/safe-yaml';

function expectRejection(yaml: string | Uint8Array, code: string, profile?: SkillYamlProfile): void {
  try {
    parseSkillYaml(yaml, profile);
    throw new Error(`expected a rejection with ${code}`);
  } catch (error) {
    if (!isSkillYamlError(error)) throw error;
    expect(error.code).toBe(code);
  }
}

describe('parseSkillYaml — supported subset', () => {
  it('parses nested mappings and sequences', () => {
    const parsed = parseSkillYaml(
      [
        'schema_version: 1',
        'id: demo-skill',
        'provider:',
        '  name: CommandMate',
        '  url: https://example.test/a',
        'files:',
        '  - path: SKILL.md',
        '    size: 12',
        '    executable: false',
        '  - path: run.sh',
        '    size: 34',
        '    executable: true',
      ].join('\n')
    ) as Record<string, unknown>;

    expect(parsed['schema_version']).toBe(1);
    expect(parsed['id']).toBe('demo-skill');
    expect(parsed['provider']).toMatchObject({
      name: 'CommandMate',
      url: 'https://example.test/a',
    });
    expect(parsed['files']).toEqual([
      { path: 'SKILL.md', size: 12, executable: false },
      { path: 'run.sh', size: 34, executable: true },
    ]);
  });

  it('accepts a sequence indented at the same level as its key', () => {
    const parsed = parseSkillYaml('keywords:\n- alpha\n- beta\n') as Record<string, unknown>;
    expect(parsed['keywords']).toEqual(['alpha', 'beta']);
  });

  it('resolves plain scalars to the JSON core types only', () => {
    const parsed = parseSkillYaml(
      [
        'a: true',
        'b: false',
        'c: null',
        'd: ~',
        'e: 42',
        'f: -1.5',
        'g: 1.2.3',
        'h: yes',
        'i: 0755',
      ].join('\n')
    ) as Record<string, unknown>;

    expect(parsed).toMatchObject({ a: true, b: false, c: null, d: null, e: 42, f: -1.5 });
    // A version, a YAML 1.1 boolean and a leading-zero number all stay strings:
    // guessing at them is how `version: 1.0` silently becomes a float.
    expect(parsed['g']).toBe('1.2.3');
    expect(parsed['h']).toBe('yes');
    expect(parsed['i']).toBe('0755');
  });

  it('keeps a hash inside quotes and drops a trailing comment', () => {
    const parsed = parseSkillYaml('a: "keep # this"  # drop this\nb: plain # gone\n') as Record<
      string,
      unknown
    >;
    expect(parsed['a']).toBe('keep # this');
    expect(parsed['b']).toBe('plain');
  });

  it('reads literal and folded block scalars with chomping', () => {
    const parsed = parseSkillYaml(
      ['literal: |', '  line one', '  line two', 'folded: >-', '  a', '  b', 'tail: 1'].join('\n')
    ) as Record<string, unknown>;
    expect(parsed['literal']).toBe('line one\nline two\n');
    expect(parsed['folded']).toBe('a b');
    expect(parsed['tail']).toBe(1);
  });

  it('unescapes double-quoted and single-quoted scalars', () => {
    const parsed = parseSkillYaml(
      ['a: "tab\\there"', 'b: "quote\\"inside"', "c: 'it''s fine'"].join('\n')
    ) as Record<string, unknown>;
    expect(parsed['a']).toBe('tab\there');
    expect(parsed['b']).toBe('quote"inside');
    expect(parsed['c']).toBe("it's fine");
  });

  it('accepts empty flow collections, which the manifest needs for empty lists', () => {
    const parsed = parseSkillYaml('commands: []\nextras: {}\n') as Record<string, unknown>;
    expect(parsed['commands']).toEqual([]);
    expect(parsed['extras']).toEqual({});
  });

  it('skips comments, blank lines and the document start marker', () => {
    const parsed = parseSkillYaml('---\n# leading\n\na: 1\n\n# trailing\n') as Record<
      string,
      unknown
    >;
    expect(parsed).toEqual({ a: 1 });
  });

  it('produces mappings with a null prototype', () => {
    const parsed = parseSkillYaml('a:\n  b: 1\n') as Record<string, Record<string, unknown>>;
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(Object.getPrototypeOf(parsed['a'])).toBeNull();
  });
});

describe('parseSkillYaml — profile enforcement', () => {
  it('rejects anchors and aliases', () => {
    expectRejection('a: &anchor 1\n', SkillYamlErrorCode.ALIAS_FORBIDDEN);
    expectRejection('a: *alias\n', SkillYamlErrorCode.ALIAS_FORBIDDEN);
    expectRejection('&anchor a: 1\n', SkillYamlErrorCode.ALIAS_FORBIDDEN);
  });

  it('rejects merge keys', () => {
    expectRejection('a:\n  <<: *base\n  b: 1\n', SkillYamlErrorCode.MERGE_KEY_FORBIDDEN);
  });

  it('rejects explicit tags', () => {
    expectRejection('a: !!str 1\n', SkillYamlErrorCode.TAG_FORBIDDEN);
    expectRejection('!tag a: 1\n', SkillYamlErrorCode.TAG_FORBIDDEN);
  });

  it('rejects duplicate keys', () => {
    expectRejection('a: 1\na: 2\n', SkillYamlErrorCode.DUPLICATE_KEY);
  });

  it('rejects every forbidden prototype key', () => {
    for (const key of SKILL_YAML_SAFE_PROFILE.forbiddenKeys) {
      expectRejection(`${key}: 1\n`, SkillYamlErrorCode.FORBIDDEN_KEY);
    }
  });

  it('rejects a second document', () => {
    expectRejection('a: 1\n---\nb: 2\n', SkillYamlErrorCode.MULTIPLE_DOCUMENTS);
    expectRejection('a: 1\n...\nb: 2\n', SkillYamlErrorCode.MULTIPLE_DOCUMENTS);
  });

  it('rejects non-empty flow collections and complex keys', () => {
    expectRejection('a: [1, 2]\n', SkillYamlErrorCode.UNSUPPORTED);
    expectRejection('a: {b: 1}\n', SkillYamlErrorCode.UNSUPPORTED);
    expectRejection('? a\n: 1\n', SkillYamlErrorCode.UNSUPPORTED);
  });

  it('rejects a document over the byte budget', () => {
    expectRejection(`a: "${'x'.repeat(SKILL_YAML_SAFE_PROFILE.maxBytes)}"\n`, SkillYamlErrorCode.BYTES_LIMIT);
  });

  it('rejects nesting past the depth limit', () => {
    const deep = Array.from(
      { length: SKILL_YAML_SAFE_PROFILE.maxDepth + 4 },
      (_, i) => `${'  '.repeat(i)}k${i}:`
    ).join('\n');
    expectRejection(deep, SkillYamlErrorCode.DEPTH_LIMIT);
  });

  it('rejects more nodes than the profile allows', () => {
    const flood = `a:\n${Array.from({ length: SKILL_YAML_SAFE_PROFILE.maxNodes + 10 }, (_, i) => `  - ${i}`).join('\n')}`;
    expectRejection(flood, SkillYamlErrorCode.NODE_LIMIT);
  });

  it('rejects an oversized scalar', () => {
    const long = 'x'.repeat(SKILL_YAML_SAFE_PROFILE.maxScalarLength + 1);
    expectRejection(`a: "${long}"\n`, SkillYamlErrorCode.SCALAR_LIMIT);
    expectRejection(`a: |\n  ${long}\n`, SkillYamlErrorCode.SCALAR_LIMIT);
  });

  it('rejects text that is not plain UTF-8', () => {
    expectRejection(Uint8Array.from([0xff, 0xfe, 0x41]), SkillYamlErrorCode.ENCODING);
    expectRejection('\uFEFFa: 1\n', SkillYamlErrorCode.ENCODING);
    expectRejection('a: 1\rb: 2\n', SkillYamlErrorCode.ENCODING);
    expectRejection('a: \u0000\n', SkillYamlErrorCode.ENCODING);
  });

  it('rejects tab indentation and malformed lines', () => {
    expectRejection('a:\n\tb: 1\n', SkillYamlErrorCode.SYNTAX);
    expectRejection('not a mapping\n', SkillYamlErrorCode.SYNTAX);
    expectRejection('a: "unterminated\n', SkillYamlErrorCode.SYNTAX);
  });

  it('refuses a profile that would relax the parser it cannot relax', () => {
    const relaxed = { ...SKILL_YAML_SAFE_PROFILE, allowAliases: true };
    expectRejection('a: 1\n', SkillYamlErrorCode.UNSUPPORTED, relaxed);
  });

  it('reports the offending line without echoing its content', () => {
    try {
      parseSkillYaml('a: 1\nb: &secret-anchor 2\n');
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(SkillYamlError);
      const yamlError = error as SkillYamlError;
      expect(yamlError.line).toBe(2);
      expect(yamlError.message).not.toContain('secret-anchor');
    }
  });
});

describe('parseSkillFrontmatter', () => {
  it('parses the frontmatter block of a Markdown document', () => {
    const parsed = parseSkillFrontmatter('---\nname: Demo Skill\n---\n\n# Body\n') as Record<
      string,
      unknown
    >;
    expect(parsed['name']).toBe('Demo Skill');
  });

  it('returns null when there is no frontmatter', () => {
    expect(parseSkillFrontmatter('# Body only\n')).toBeNull();
    expect(parseSkillFrontmatter('---\nname: unterminated\n')).toBeNull();
  });

  it('applies the same profile as the manifest', () => {
    expect(() => parseSkillFrontmatter('---\nname: &a Demo\n---\n')).toThrow(SkillYamlError);
  });
});
