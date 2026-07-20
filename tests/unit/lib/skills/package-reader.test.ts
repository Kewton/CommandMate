/**
 * Tests for src/lib/skills/package-reader.ts
 * Issue #1230: strict tar.gz table parsing with fail-closed entry rules
 */

import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'crypto';
import {
  SKILL_PACKAGE_MAX_COMPRESSION_RATIO,
  SkillPackageError,
  encodeEntryPathForError,
  isSkillPackageError,
  readSkillPackage,
} from '@/lib/skills/package-reader';
import {
  MALICIOUS_PACKAGES,
  SKILL_ID,
  SKILL_VERSION,
  TarType,
  buildPackage,
  buildTarGz,
  maliciousCase,
} from '@tests/fixtures/skills/malicious-packages';

const COORDINATES = { skillId: SKILL_ID, version: SKILL_VERSION };

function read(bytes: Uint8Array) {
  return readSkillPackage(bytes, COORDINATES);
}

describe('readSkillPackage — well-formed packages', () => {
  it('strips the conventional top-level directory and reports every entry', () => {
    const table = read(buildPackage().bytes);

    expect(table.rootName).toBe(SKILL_ID);
    expect(table.files.map((file) => file.path).sort()).toEqual([
      'SKILL.md',
      'assets/logo.svg',
      'commandmate.skill.yaml',
      'reference/notes.md',
    ]);
    expect(table.compressedSize).toBeGreaterThan(0);
    expect(table.decompressedSize % 512).toBe(0);
  });

  it('accepts `<skill-id>-<version>` as the root directory too', () => {
    const table = read(buildPackage({ rootDir: `${SKILL_ID}-${SKILL_VERSION}` }).bytes);
    expect(table.rootName).toBe(`${SKILL_ID}-${SKILL_VERSION}`);
    expect(table.files.some((file) => file.path === 'SKILL.md')).toBe(true);
  });

  it('accepts a package with no root directory at all', () => {
    const table = read(buildPackage({ rootDir: null }).bytes);
    expect(table.rootName).toBeNull();
    expect(table.files.some((file) => file.path === 'SKILL.md')).toBe(true);
  });

  it('digests every file and reports the archive executable bit', () => {
    const content = '#!/bin/sh\necho hi\n';
    const table = read(
      buildPackage({ files: [{ path: 'tools/run.sh', content, mode: 0o755 }] }).bytes
    );

    const script = table.files.find((file) => file.path === 'tools/run.sh');
    expect(script?.executable).toBe(true);
    expect(script?.sha256).toBe(createHash('sha256').update(content).digest('hex'));
    expect(table.files.find((file) => file.path === 'SKILL.md')?.executable).toBe(false);
  });

  it('records directory entries separately from files', () => {
    const table = read(buildPackage({ directories: ['reference'] }).bytes);
    expect(table.directories).toContain('reference');
    expect(table.files.some((file) => file.path === 'reference')).toBe(false);
  });

  it('reads a large but incompressible payload, which the ratio guard must allow', () => {
    // The acceptance side of the check the compression-bomb case rejects: past
    // the ratio floor, real content still has to get through.
    const table = read(
      buildTarGz([
        { name: `${SKILL_ID}/`, type: TarType.DIRECTORY },
        { name: `${SKILL_ID}/payload.bin`, content: randomBytes(2 * 1024 * 1024) },
      ])
    );
    expect(table.decompressedSize / table.compressedSize).toBeLessThan(
      SKILL_PACKAGE_MAX_COMPRESSION_RATIO
    );
  });
});

describe('readSkillPackage — fail-closed rejections', () => {
  it.each([
    ['zip-slip-parent-traversal'],
    ['absolute-path'],
    ['windows-drive-path'],
    ['backslash-separator'],
    ['nul-truncated-name'],
    ['path-too-deep'],
    ['path-segment-too-long'],
    ['symlink-entry'],
    ['symlink-entry-without-target'],
    ['hardlink-entry'],
    ['character-device-entry'],
    ['block-device-entry'],
    ['fifo-entry'],
    ['contiguous-file-entry'],
    ['pax-extended-header'],
    ['gnu-longname-header'],
    ['setuid-bit'],
    ['setgid-bit'],
    ['sticky-bit'],
    ['duplicate-entry'],
    ['case-collision'],
    ['unicode-collision'],
    ['directory-shadows-file'],
    ['compression-ratio-bomb'],
    ['decompressed-size-bomb'],
    ['entry-count-flood'],
    ['not-gzip'],
    ['broken-header-checksum'],
    ['foreign-archive-magic'],
    ['base256-size-field'],
    ['missing-trailer'],
    ['appended-after-trailer'],
    ['root-directory-mismatch'],
  ])('rejects %s at the archive layer', (name) => {
    const entry = maliciousCase(name);
    try {
      read(entry.build());
      throw new Error(`${entry.name} was accepted: ${entry.threat}`);
    } catch (error) {
      expect(isSkillPackageError(error)).toBe(true);
      expect((error as SkillPackageError).code).toBe(entry.expectedCode);
    }
  });

  it('never leaks a machine path or raw entry name in a rejection message', () => {
    for (const entry of MALICIOUS_PACKAGES) {
      let error: unknown;
      try {
        read(entry.build());
        continue;
      } catch (caught) {
        error = caught;
      }
      if (!isSkillPackageError(error)) continue;
      expect(error.message).not.toContain('/Users');
      expect(error.message).not.toMatch(/\.\./);
      for (const value of Object.values(error.detail ?? {})) {
        expect(String(value)).not.toContain('\n');
      }
    }
  });

  it('classifies every rejection into a category the UI can branch on', () => {
    const categories = new Set<string>();
    for (const entry of MALICIOUS_PACKAGES) {
      try {
        read(entry.build());
      } catch (error) {
        if (isSkillPackageError(error)) categories.add(error.category);
      }
    }
    expect([...categories].sort()).toEqual(['archive', 'limit', 'manifest', 'path']);
  });
});

describe('encodeEntryPathForError', () => {
  it('percent-encodes anything that could reshape a log line', () => {
    expect(encodeEntryPathForError('a/b.md')).toBe('a/b.md');
    expect(encodeEntryPathForError('a\nb')).toBe('a%0Ab');
    expect(encodeEntryPathForError('<script>')).toBe('%3Cscript%3E');
  });

  it('truncates an over-long name', () => {
    expect(encodeEntryPathForError('a'.repeat(500))).toHaveLength(121);
  });
});
