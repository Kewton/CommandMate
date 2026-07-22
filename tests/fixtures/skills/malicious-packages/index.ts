/**
 * Malicious Skill package corpus (Issue #1230)
 *
 * One case per attack the threat model names. Each is the benign baseline with
 * a single property changed, and each is pinned to the error code the pipeline
 * must fail closed with — so a guard that stops working shows up as a case that
 * stopped rejecting, not as a silently weaker check.
 */

import { gzipSync } from 'zlib';
import { SkillPackageErrorCode, type SkillPackageErrorCodeType } from '@/lib/skills/package-reader';
import { SKILL_ID, buildPackage } from './package';
import { TarType, buildTarGz, type TarEntryInput } from './tar';

export { SKILL_ID, SKILL_VERSION, buildPackage, renderManifestYaml } from './package';
export * from './tar';

/** One corpus case: what it is, what it contains and how it must be refused. */
export interface MaliciousPackageCase {
  name: string;
  /** The attack this case stands for. */
  threat: string;
  /** Built on demand: some cases allocate tens of megabytes. */
  build: () => Uint8Array;
  expectedCode: SkillPackageErrorCodeType;
}

const ROOT = `${SKILL_ID}/`;

function baselineYaml(): string {
  return buildPackage().manifestYaml;
}

/** Baseline manifest with one line rewritten, to build YAML-level attacks. */
function manifestWith(replace: (yaml: string) => string): string {
  return replace(baselineYaml());
}

function specialFile(name: string, type: TarEntryInput['type'], linkname?: string): Uint8Array {
  return buildPackage({
    extraEntries: [{ name: `${ROOT}${name}`, type, ...(linkname ? { linkname } : {}) }],
  }).bytes;
}

function zeroFilePackage(size: number): Uint8Array {
  return buildTarGz([
    { name: ROOT, type: TarType.DIRECTORY },
    { name: `${ROOT}payload.bin`, content: new Uint8Array(size) },
  ]);
}

function manyEntries(count: number): Uint8Array {
  const entries: TarEntryInput[] = [{ name: ROOT, type: TarType.DIRECTORY }];
  for (let i = 0; i < count; i++) {
    entries.push({ name: `${ROOT}f${i}.txt`, content: `${i}\n` });
  }
  return buildTarGz(entries);
}

// =============================================================================
// Corpus
// =============================================================================

export const MALICIOUS_PACKAGES: readonly MaliciousPackageCase[] = [
  // --- Path escape -----------------------------------------------------------
  {
    name: 'zip-slip-parent-traversal',
    threat: 'Zip Slip: an entry walks out of the package root with `..`',
    build: () => buildPackage({ extraEntries: [{ name: `${ROOT}../../etc/evil`, content: 'x' }] }).bytes,
    expectedCode: SkillPackageErrorCode.ENTRY_PATH_UNSAFE,
  },
  {
    name: 'absolute-path',
    threat: 'Absolute path writes outside any root',
    build: () => buildPackage({ extraEntries: [{ name: '/etc/evil', content: 'x' }] }).bytes,
    expectedCode: SkillPackageErrorCode.ENTRY_PATH_UNSAFE,
  },
  {
    name: 'windows-drive-path',
    threat: 'Drive-qualified path escapes on Windows hosts',
    build: () => buildPackage({ extraEntries: [{ name: 'C:/Windows/evil', content: 'x' }] }).bytes,
    expectedCode: SkillPackageErrorCode.ENTRY_PATH_UNSAFE,
  },
  {
    name: 'backslash-separator',
    threat: 'Backslash separator is a directory separator on Windows only',
    build: () => buildPackage({ extraEntries: [{ name: `${ROOT}..\\evil`, content: 'x' }] }).bytes,
    expectedCode: SkillPackageErrorCode.ENTRY_PATH_UNSAFE,
  },
  {
    name: 'nul-truncated-name',
    threat: 'NUL in the name field makes two parsers read two different paths',
    build: () => buildPackage({ extraEntries: [{ name: `${ROOT}ok.md\0../../evil`, content: 'x' }] })
      .bytes,
    expectedCode: SkillPackageErrorCode.ARCHIVE_FORMAT,
  },
  {
    name: 'path-too-deep',
    threat: 'Unbounded nesting defeats path-length assumptions downstream',
    build: () => buildPackage({ extraEntries: [{ name: `${ROOT}a/b/c/d/e/f/g/h/i.md`, content: 'x' }] })
      .bytes,
    expectedCode: SkillPackageErrorCode.ENTRY_PATH_UNSAFE,
  },
  {
    name: 'path-segment-too-long',
    threat: 'Over-long segment overflows filesystem name limits',
    build: () =>
      buildPackage({
        extraEntries: [
          { name: 'x.md', prefix: `${SKILL_ID}/${'a'.repeat(101)}`, content: 'x' },
        ],
      }).bytes,
    expectedCode: SkillPackageErrorCode.ENTRY_PATH_UNSAFE,
  },
  {
    name: 'root-directory-mismatch',
    threat: 'Package installs itself under a name the Catalog never published',
    build: () => buildPackage({ rootDir: 'totally-other-skill' }).bytes,
    expectedCode: SkillPackageErrorCode.LAYOUT_INVALID,
  },

  // --- Special files ---------------------------------------------------------
  {
    name: 'symlink-entry',
    threat: 'Symlink escape: a link points at a path outside the package',
    build: () => specialFile('link', TarType.SYMLINK, '../../../etc/passwd'),
    expectedCode: SkillPackageErrorCode.ENTRY_TYPE_FORBIDDEN,
  },
  {
    name: 'symlink-entry-without-target',
    threat: 'Symlink typeflag with an empty link field, which a link-name check alone misses',
    build: () => specialFile('link', TarType.SYMLINK),
    expectedCode: SkillPackageErrorCode.ENTRY_TYPE_FORBIDDEN,
  },
  {
    name: 'hardlink-entry',
    threat: 'Hardlink escape: a link aliases a file outside the package',
    build: () => specialFile('link', TarType.HARDLINK, 'SKILL.md'),
    expectedCode: SkillPackageErrorCode.ENTRY_TYPE_FORBIDDEN,
  },
  {
    name: 'character-device-entry',
    threat: 'Device node materialized into the worktree',
    build: () => specialFile('tty', TarType.CHAR_DEVICE),
    expectedCode: SkillPackageErrorCode.ENTRY_TYPE_FORBIDDEN,
  },
  {
    name: 'block-device-entry',
    threat: 'Block device node materialized into the worktree',
    build: () => specialFile('disk', TarType.BLOCK_DEVICE),
    expectedCode: SkillPackageErrorCode.ENTRY_TYPE_FORBIDDEN,
  },
  {
    name: 'fifo-entry',
    threat: 'FIFO blocks a reader forever',
    build: () => specialFile('pipe', TarType.FIFO),
    expectedCode: SkillPackageErrorCode.ENTRY_TYPE_FORBIDDEN,
  },
  {
    name: 'contiguous-file-entry',
    threat: 'Non-regular file type smuggled past a type check that only lists two',
    build: () => specialFile('sparse', TarType.CONTIGUOUS),
    expectedCode: SkillPackageErrorCode.ENTRY_TYPE_FORBIDDEN,
  },
  {
    name: 'pax-extended-header',
    threat: 'pax record overrides the name of the entry that follows it',
    build: () => specialFile('PaxHeaders/0', TarType.PAX_EXTENDED),
    expectedCode: SkillPackageErrorCode.ENTRY_TYPE_FORBIDDEN,
  },
  {
    name: 'gnu-longname-header',
    threat: 'GNU long-name record supplies a second, unchecked name',
    build: () => specialFile('././@LongLink', TarType.GNU_LONGNAME),
    expectedCode: SkillPackageErrorCode.ENTRY_TYPE_FORBIDDEN,
  },

  // --- Mode metadata ---------------------------------------------------------
  {
    name: 'setuid-bit',
    threat: 'setuid binary lands with elevated privileges',
    build: () => buildPackage({
      extraEntries: [{ name: `${ROOT}tool`, content: 'x', mode: 0o4755 }],
    }).bytes,
    expectedCode: SkillPackageErrorCode.ENTRY_MODE_FORBIDDEN,
  },
  {
    name: 'setgid-bit',
    threat: 'setgid binary lands with elevated group privileges',
    build: () => buildPackage({
      extraEntries: [{ name: `${ROOT}tool`, content: 'x', mode: 0o2755 }],
    }).bytes,
    expectedCode: SkillPackageErrorCode.ENTRY_MODE_FORBIDDEN,
  },
  {
    name: 'sticky-bit',
    threat: 'Sticky bit carried over from the publisher machine',
    build: () => buildPackage({
      extraEntries: [{ name: `${ROOT}tool`, content: 'x', mode: 0o1755 }],
    }).bytes,
    expectedCode: SkillPackageErrorCode.ENTRY_MODE_FORBIDDEN,
  },

  // --- Duplicates and collisions --------------------------------------------
  {
    name: 'duplicate-entry',
    threat: 'Same path twice: the reviewed copy is overwritten by the second',
    build: () => buildPackage({
      extraEntries: [{ name: `${ROOT}reference/notes.md`, content: 'malicious replacement\n' }],
    }).bytes,
    expectedCode: SkillPackageErrorCode.ENTRY_DUPLICATE,
  },
  {
    name: 'case-collision',
    threat: 'Case-insensitive filesystem collapses two entries into one',
    build: () => buildPackage({
      extraEntries: [{ name: `${ROOT}reference/NOTES.md`, content: 'shadow\n' }],
    }).bytes,
    expectedCode: SkillPackageErrorCode.ENTRY_COLLISION,
  },
  {
    name: 'unicode-collision',
    threat: 'NFKC-equivalent name collides on a normalizing filesystem',
    build: () => buildPackage({
      extraEntries: [{ name: `${ROOT}reference/ﬁle.md`, content: 'shadow\n' }],
      files: [{ path: 'reference/file.md', content: '# File\n' }],
    }).bytes,
    expectedCode: SkillPackageErrorCode.ENTRY_COLLISION,
  },
  {
    name: 'directory-shadows-file',
    threat: 'A path is both a file and the parent of another file',
    build: () => buildPackage({
      files: [
        { path: 'reference', content: 'not a directory\n' },
        { path: 'reference/notes.md', content: '# Notes\n' },
      ],
    }).bytes,
    expectedCode: SkillPackageErrorCode.ENTRY_PATH_UNSAFE,
  },

  // --- Size and compression --------------------------------------------------
  {
    name: 'compression-ratio-bomb',
    threat: 'Small artifact expands far beyond its compressed size',
    build: () => zeroFilePackage(8 * 1024 * 1024),
    expectedCode: SkillPackageErrorCode.COMPRESSION_RATIO_EXCEEDED,
  },
  {
    name: 'decompressed-size-bomb',
    threat: 'Artifact expands past the absolute decompression cap',
    build: () => zeroFilePackage(68 * 1024 * 1024),
    expectedCode: SkillPackageErrorCode.SIZE_LIMIT_EXCEEDED,
  },
  {
    name: 'entry-count-flood',
    threat: 'Entry flood exhausts inodes and review attention alike',
    build: () => manyEntries(1200),
    expectedCode: SkillPackageErrorCode.ENTRY_LIMIT_EXCEEDED,
  },

  // --- Archive framing -------------------------------------------------------
  {
    name: 'not-gzip',
    threat: 'Format confusion: something other than the declared tar.gz',
    build: () => Buffer.from('PK not a gzip stream'),
    expectedCode: SkillPackageErrorCode.ARCHIVE_FORMAT,
  },
  {
    name: 'broken-header-checksum',
    threat: 'Header rewritten in place after the archive was built',
    build: () => buildPackage({
      extraEntries: [{ name: `${ROOT}tampered.md`, content: 'x', breakChecksum: true }],
    }).bytes,
    expectedCode: SkillPackageErrorCode.ARCHIVE_FORMAT,
  },
  {
    name: 'foreign-archive-magic',
    threat: 'Non-ustar variant parsed by a lenient extractor with other rules',
    build: () => buildPackage({
      extraEntries: [{ name: `${ROOT}other.md`, content: 'x', magic: 'xstar' }],
    }).bytes,
    expectedCode: SkillPackageErrorCode.ARCHIVE_FORMAT,
  },
  {
    name: 'base256-size-field',
    threat: 'GNU base-256 numeric field bypasses an octal-only size check',
    build: () => buildPackage({
      extraEntries: [{ name: `${ROOT}big.md`, content: 'x', base256Size: true }],
    }).bytes,
    expectedCode: SkillPackageErrorCode.ARCHIVE_FORMAT,
  },
  {
    name: 'missing-trailer',
    threat: 'Truncated archive leaves the last entry half-read',
    build: () => buildPackage({ tarOptions: { omitTrailer: true } }).bytes,
    expectedCode: SkillPackageErrorCode.ARCHIVE_TRUNCATED,
  },
  {
    name: 'appended-after-trailer',
    threat: 'Data past the end-of-archive marker is invisible to some readers',
    build: () => buildPackage({
      tarOptions: { trailingGarbage: Buffer.alloc(512, 0x41) },
    }).bytes,
    expectedCode: SkillPackageErrorCode.ARCHIVE_FORMAT,
  },

  // --- YAML ------------------------------------------------------------------
  {
    name: 'yaml-anchor',
    threat: 'Anchor/alias expansion is the classic YAML billion-laughs lever',
    build: () => buildPackage({
      manifestYaml: manifestWith((yaml) => yaml.replace('license: "MIT"', 'license: &lic "MIT"')),
    }).bytes,
    expectedCode: SkillPackageErrorCode.MANIFEST_INVALID,
  },
  {
    name: 'yaml-merge-key',
    threat: 'Merge key pulls fields in from a node the reviewer never read',
    build: () => buildPackage({
      manifestYaml: manifestWith((yaml) => yaml.replace('provider:\n', 'provider:\n  <<: *base\n')),
    }).bytes,
    expectedCode: SkillPackageErrorCode.MANIFEST_INVALID,
  },
  {
    name: 'yaml-custom-tag',
    threat: 'Custom tag reaches a type constructor in a permissive parser',
    build: () => buildPackage({
      manifestYaml: manifestWith((yaml) => yaml.replace('license: "MIT"', 'license: !!python/object x')),
    }).bytes,
    expectedCode: SkillPackageErrorCode.MANIFEST_INVALID,
  },
  {
    name: 'yaml-duplicate-key',
    threat: 'Duplicate key: reviewer reads the first, parser keeps the second',
    build: () => buildPackage({
      manifestYaml: manifestWith((yaml) => `${yaml}declared_risk: "low"\n`),
    }).bytes,
    expectedCode: SkillPackageErrorCode.MANIFEST_INVALID,
  },
  {
    name: 'yaml-prototype-key',
    threat: 'Prototype pollution through a parsed mapping key',
    build: () => buildPackage({
      manifestYaml: manifestWith((yaml) => `${yaml}__proto__: "polluted"\n`),
    }).bytes,
    expectedCode: SkillPackageErrorCode.MANIFEST_INVALID,
  },
  {
    name: 'yaml-deep-nesting',
    threat: 'Deep nesting exhausts the parser stack',
    build: () => buildPackage({
      manifestYaml: Array.from({ length: 40 }, (_, i) => `${'  '.repeat(i)}k${i}:`).join('\n'),
    }).bytes,
    expectedCode: SkillPackageErrorCode.MANIFEST_INVALID,
  },
  {
    name: 'yaml-oversized-scalar',
    threat: 'Single huge scalar drives allocation before any field check runs',
    build: () => buildPackage({
      manifestYaml: manifestWith((yaml) =>
        yaml.replace(/^summary: .*$/m, `summary: "${'a'.repeat(9000)}"`)
      ),
    }).bytes,
    expectedCode: SkillPackageErrorCode.MANIFEST_INVALID,
  },
  {
    name: 'yaml-node-flood',
    threat: 'Node flood turns a small document into a long parse',
    build: () => buildPackage({
      manifestYaml: `keywords:\n${Array.from({ length: 6000 }, (_, i) => `  - "k${i}"`).join('\n')}\n`,
    }).bytes,
    expectedCode: SkillPackageErrorCode.MANIFEST_INVALID,
  },
  {
    name: 'yaml-oversized-document',
    threat: 'Manifest larger than the parser is allowed to read',
    build: () => buildPackage({
      manifestYaml: `# ${'p'.repeat(70 * 1024)}\nschema_version: 1\n`,
    }).bytes,
    expectedCode: SkillPackageErrorCode.MANIFEST_INVALID,
  },

  // --- Manifest reconciliation ----------------------------------------------
  {
    name: 'undeclared-executable',
    threat: 'Executable bit on a file the manifest presents as inert data',
    build: () => buildPackage({
      files: [{ path: 'tools/helper', content: 'binary-ish\n', mode: 0o755, executable: false }],
    }).bytes,
    expectedCode: SkillPackageErrorCode.UNDECLARED_EXECUTABLE,
  },
  {
    name: 'undeclared-script',
    threat: 'Script presented as an asset so it never appears in the plan',
    build: () => buildPackage({
      files: [{ path: 'tools/run.sh', content: '#!/bin/sh\necho hi\n', kind: 'asset', script: false }],
    }).bytes,
    expectedCode: SkillPackageErrorCode.UNDECLARED_SCRIPT,
  },
  {
    name: 'shebang-without-extension',
    threat: 'Interpreted payload hidden behind a data-looking filename',
    build: () => buildPackage({
      files: [{ path: 'assets/data', content: '#!/bin/sh\ncurl evil\n', kind: 'asset', script: false }],
    }).bytes,
    expectedCode: SkillPackageErrorCode.UNDECLARED_SCRIPT,
  },
  {
    name: 'undeclared-file',
    threat: 'Extra payload file absent from the reviewed manifest',
    build: () => buildPackage({
      files: [{ path: 'reference/notes.md', content: '# Notes\n', undeclared: true }],
    }).bytes,
    expectedCode: SkillPackageErrorCode.MANIFEST_MISMATCH,
  },
  {
    name: 'declared-but-missing-file',
    threat: 'Manifest advertises a file the archive does not carry',
    build: () => buildPackage({
      extraDeclarations: [
        {
          path: 'reference/ghost.md',
          sha256: 'a'.repeat(64),
          size: 10,
          kind: 'instruction',
          executable: false,
          script: false,
        },
      ],
    }).bytes,
    expectedCode: SkillPackageErrorCode.MANIFEST_MISMATCH,
  },
  {
    name: 'digest-mismatch',
    threat: 'File content swapped after the digest was published',
    build: () => buildPackage({
      files: [{ path: 'reference/notes.md', content: '# Notes\n', declaredSha256: 'b'.repeat(64) }],
    }).bytes,
    expectedCode: SkillPackageErrorCode.DIGEST_MISMATCH,
  },
  {
    name: 'size-mismatch',
    threat: 'Declared size disagrees with the bytes actually shipped',
    build: () => buildPackage({
      files: [{ path: 'reference/notes.md', content: '# Notes\n', declaredSize: 99 }],
    }).bytes,
    expectedCode: SkillPackageErrorCode.SIZE_MISMATCH,
  },
  {
    name: 'manifest-smuggling-nested',
    threat: 'Second manifest in a subdirectory, read by a looser consumer',
    build: () => buildPackage({
      files: [
        { path: 'reference/notes.md', content: '# Notes\n' },
        { path: 'reference/commandmate.skill.yaml', content: 'schema_version: 1\n' },
      ],
    }).bytes,
    expectedCode: SkillPackageErrorCode.LAYOUT_INVALID,
  },
  {
    name: 'manifest-declares-itself',
    threat: 'Manifest lists its own digest so a self-check appears to pass',
    build: () => buildPackage({
      manifestPatch: (manifest) => {
        manifest.files.push({
          path: 'commandmate.skill.yaml',
          sha256: 'c'.repeat(64),
          size: 1,
          kind: 'asset',
          executable: false,
          script: false,
        });
      },
    }).bytes,
    expectedCode: SkillPackageErrorCode.MANIFEST_INVALID,
  },
  {
    name: 'manifest-id-mismatch',
    threat: 'Package claims an identity the Catalog did not publish',
    build: () => buildPackage({ manifestPatch: (manifest) => void (manifest.id = 'other-skill') }).bytes,
    expectedCode: SkillPackageErrorCode.MANIFEST_MISMATCH,
  },
  {
    name: 'manifest-version-mismatch',
    threat: 'Package ships a different version than the one being installed',
    build: () => buildPackage({ manifestPatch: (manifest) => void (manifest.version = '9.9.9') }).bytes,
    expectedCode: SkillPackageErrorCode.MANIFEST_MISMATCH,
  },
  {
    name: 'skill-md-name-mismatch',
    threat: 'SKILL.md advertises a different Skill than the manifest',
    build: () => buildPackage({
      skillMd: '---\nname: Something Else\ndescription: mismatched\n---\n\n# Nope\n',
    }).bytes,
    expectedCode: SkillPackageErrorCode.SKILL_MD_INVALID,
  },
  {
    name: 'skill-md-without-frontmatter',
    threat: 'No frontmatter means no identity to cross-check',
    build: () => buildPackage({ skillMd: '# Demo Skill\n\nNo frontmatter here.\n' }).bytes,
    expectedCode: SkillPackageErrorCode.SKILL_MD_INVALID,
  },
  {
    name: 'missing-skill-md',
    threat: 'Package without the standard authoring file',
    build: () => buildPackage({ skillMd: null }).bytes,
    expectedCode: SkillPackageErrorCode.LAYOUT_INVALID,
  },
  {
    name: 'missing-manifest',
    threat: 'Package with no distribution manifest at all',
    build: () => buildPackage({ omitManifest: true }).bytes,
    expectedCode: SkillPackageErrorCode.LAYOUT_INVALID,
  },
  {
    name: 'manifest-not-yaml',
    threat: 'Manifest bytes are not the document the contract describes',
    build: () => buildPackage({ manifestYaml: gzipSync(Buffer.from('x')).toString('binary') }).bytes,
    expectedCode: SkillPackageErrorCode.MANIFEST_INVALID,
  },
];

/** Look a case up by name, for tests that assert on one specific attack. */
export function maliciousCase(name: string): MaliciousPackageCase {
  const found = MALICIOUS_PACKAGES.find((entry) => entry.name === name);
  if (!found) throw new Error(`unknown malicious package case: ${name}`);
  return found;
}
