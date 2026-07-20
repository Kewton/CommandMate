/**
 * Tests for src/lib/skills/package-validator.ts
 * Issue #1230: exact manifest reconciliation and safe staging materialization
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

/**
 * Hooks into the two filesystem calls materialization depends on.
 *
 * A staging directory has a random name, so the only way to plant a symlink in
 * the window a real race would use is to act the instant the directory appears.
 * Both hooks are inert unless a test installs one.
 */
const fsHooks = vi.hoisted(() => ({
  afterMkdir: null as ((target: string) => void) | null,
  beforeWrite: null as (() => void) | null,
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: actual,
    mkdirSync: ((...args: Parameters<typeof actual.mkdirSync>) => {
      const result = actual.mkdirSync(...args);
      fsHooks.afterMkdir?.(String(args[0]));
      return result;
    }) as typeof actual.mkdirSync,
    writeSync: ((...args: Parameters<typeof actual.writeSync>) => {
      fsHooks.beforeWrite?.();
      return actual.writeSync(...args);
    }) as typeof actual.writeSync,
  };
});
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import path from 'path';
import {
  SkillPackageError,
  SkillPackageErrorCode,
  isSkillPackageError,
  readSkillPackage,
} from '@/lib/skills/package-reader';
import {
  SKILL_STAGED_EXECUTABLE_MODE,
  SKILL_STAGED_FILE_MODE,
  SKILL_STAGING_DIR_MODE,
  cleanupSkillStagingRoot,
  deriveSkillFileKind,
  inspectSkillPackage,
  isSkillScriptPayload,
  materializeSkillPackage,
  validateSkillPackage,
} from '@/lib/skills/package-validator';
import {
  MALICIOUS_PACKAGES,
  SKILL_ID,
  SKILL_VERSION,
  buildPackage,
  maliciousCase,
} from '@tests/fixtures/skills/malicious-packages';

const COORDINATES = { skillId: SKILL_ID, version: SKILL_VERSION };

/**
 * The staging root refuses system directories, and os.tmpdir() resolves under
 * /var on macOS, so test roots live in the repo-local (gitignored) temp dir.
 */
const TEST_ROOT_PARENT = path.join(process.cwd(), 'temp');

let stagingRoot: string;

function inspect(bytes: Uint8Array) {
  return inspectSkillPackage(bytes, COORDINATES);
}

function modeOf(target: string): number {
  return lstatSync(target).mode & 0o7777;
}

beforeEach(() => {
  mkdirSync(TEST_ROOT_PARENT, { recursive: true });
  stagingRoot = mkdtempSync(path.join(TEST_ROOT_PARENT, 'skill-staging-'));
});

afterEach(() => {
  fsHooks.afterMkdir = null;
  fsHooks.beforeWrite = null;
  rmSync(stagingRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// =============================================================================
// Classification
// =============================================================================

describe('script classification', () => {
  it('treats known extensions and shebangs as scripts', () => {
    expect(isSkillScriptPayload('tools/run.sh', new Uint8Array())).toBe(true);
    expect(isSkillScriptPayload('tools/run.PY', new Uint8Array())).toBe(true);
    expect(isSkillScriptPayload('assets/data', Buffer.from('#!/bin/sh\n'))).toBe(true);
    expect(isSkillScriptPayload('assets/logo.svg', Buffer.from('<svg/>'))).toBe(false);
  });

  it('derives a kind independent of what the manifest claims', () => {
    expect(deriveSkillFileKind('SKILL.md', Buffer.from('# x'))).toBe('skill_md');
    expect(deriveSkillFileKind('tools/run.sh', Buffer.from(''))).toBe('script');
    expect(deriveSkillFileKind('reference/notes.md', Buffer.from('# x'))).toBe('instruction');
    expect(deriveSkillFileKind('assets/logo.svg', Buffer.from('<svg/>'))).toBe('asset');
  });
});

// =============================================================================
// Reconciliation
// =============================================================================

describe('validateSkillPackage — accepted packages', () => {
  it('returns an immutable snapshot of everything the package contains', () => {
    const snapshot = inspect(buildPackage().bytes);

    expect(snapshot.skillId).toBe(SKILL_ID);
    expect(snapshot.version).toBe(SKILL_VERSION);
    expect(snapshot.manifest.name).toBe('Demo Skill');
    expect(snapshot.files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'assets/logo.svg',
      'commandmate.skill.yaml',
      'reference/notes.md',
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('hands out copies, so a consumer cannot mutate the reviewed bytes', () => {
    const snapshot = inspect(buildPackage().bytes);
    const first = snapshot.readFile('SKILL.md');
    first[0] = 0;
    expect(snapshot.readFile('SKILL.md')[0]).not.toBe(0);
  });

  it('refuses to read a path the package does not contain', () => {
    const snapshot = inspect(buildPackage().bytes);
    expect(() => snapshot.readFile('../escape')).toThrow(SkillPackageError);
  });

  it('computes risk from the package, not from the publisher claim', () => {
    const inert = inspect(buildPackage().bytes);
    expect(inert.computedRisk).toBe('low');
    expect(inert.effectiveRisk).toBe('low');

    const scripted = inspect(
      buildPackage({ files: [{ path: 'tools/run.sh', content: '#!/bin/sh\necho hi\n' }] }).bytes
    );
    expect(scripted.declaredRisk).toBe('low');
    expect(scripted.computedRisk).toBe('moderate');
    expect(scripted.effectiveRisk).toBe('moderate');

    const executable = inspect(
      buildPackage({
        files: [{ path: 'tools/run.sh', content: '#!/bin/sh\necho hi\n', mode: 0o755 }],
      }).bytes
    );
    expect(executable.computedRisk).toBe('high');
    expect(executable.effectiveRisk).toBe('high');
  });

  it('returns an inventory a plan can list every file and script from (UX-09)', () => {
    const snapshot = inspect(
      buildPackage({
        files: [
          { path: 'tools/run.sh', content: '#!/bin/sh\necho hi\n', mode: 0o755 },
          { path: 'reference/notes.md', content: '# Notes\n' },
        ],
      }).bytes
    );
    expect(snapshot.inspection.executable_paths).toEqual(['tools/run.sh']);
    expect(snapshot.inspection.script_paths).toEqual(['tools/run.sh']);
    expect(snapshot.inspection.declared_permissions).toEqual(['filesystem_read']);
  });
});

describe('validateSkillPackage — fail-closed rejections', () => {
  it.each(MALICIOUS_PACKAGES.map((entry) => [entry.name] as const))(
    'rejects the whole package for %s',
    (name) => {
      const entry = maliciousCase(name);
      try {
        inspect(entry.build());
        throw new Error(`${entry.name} was accepted: ${entry.threat}`);
      } catch (error) {
        expect(isSkillPackageError(error)).toBe(true);
        expect((error as SkillPackageError).code).toBe(entry.expectedCode);
      }
    }
  );

  it('rejects a package whose archive carries no entries at all', () => {
    const table = readSkillPackage(buildPackage({ omitManifest: true, skillMd: null }).bytes, COORDINATES);
    expect(() => validateSkillPackage(table, COORDINATES)).toThrow(SkillPackageError);
  });
});

// =============================================================================
// Materialization
// =============================================================================

describe('materializeSkillPackage', () => {
  it('writes the package into a private staging directory with fixed modes', () => {
    const snapshot = inspect(
      buildPackage({
        files: [
          { path: 'tools/run.sh', content: '#!/bin/sh\necho hi\n', mode: 0o755 },
          { path: 'reference/notes.md', content: '# Notes\n' },
        ],
      }).bytes
    );
    const staged = materializeSkillPackage(snapshot, { stagingRoot });

    expect(modeOf(staged.stagingDir)).toBe(SKILL_STAGING_DIR_MODE);
    expect(modeOf(path.join(staged.stagingDir, 'tools'))).toBe(SKILL_STAGING_DIR_MODE);
    expect(modeOf(path.join(staged.stagingDir, 'tools/run.sh'))).toBe(
      SKILL_STAGED_EXECUTABLE_MODE
    );
    expect(modeOf(path.join(staged.stagingDir, 'reference/notes.md'))).toBe(
      SKILL_STAGED_FILE_MODE
    );
    expect(readFileSync(path.join(staged.stagingDir, 'reference/notes.md'), 'utf8')).toBe(
      '# Notes\n'
    );
    expect(staged.inventory.map((file) => file.path)).toEqual(
      snapshot.files.map((file) => file.path)
    );
    staged.dispose();
  });

  it('never sets an execute bit on a file the manifest did not declare executable', () => {
    const snapshot = inspect(
      buildPackage({ files: [{ path: 'tools/run.sh', content: '#!/bin/sh\necho hi\n' }] }).bytes
    );
    const staged = materializeSkillPackage(snapshot, { stagingRoot });

    for (const file of staged.inventory) {
      expect(modeOf(path.join(staged.stagingDir, file.path)) & 0o111).toBe(0);
    }
    staged.dispose();
  });

  it('gives concurrent materializations of the same package separate directories', () => {
    const snapshot = inspect(buildPackage().bytes);
    const first = materializeSkillPackage(snapshot, { stagingRoot });
    const second = materializeSkillPackage(snapshot, { stagingRoot });

    expect(first.stagingDir).not.toBe(second.stagingDir);
    expect(readdirSync(stagingRoot)).toHaveLength(2);
    first.dispose();
    second.dispose();
  });

  it('removes the staging directory on dispose, and tolerates a second call', () => {
    const staged = materializeSkillPackage(inspect(buildPackage().bytes), { stagingRoot });
    staged.dispose();
    staged.dispose();
    expect(existsSync(staged.stagingDir)).toBe(false);
  });

  it('publishes nothing when the caller aborts', () => {
    const snapshot = inspect(buildPackage().bytes);
    const controller = new AbortController();
    controller.abort();

    try {
      materializeSkillPackage(snapshot, { stagingRoot, signal: controller.signal });
      throw new Error('expected an abort');
    } catch (error) {
      expect(isSkillPackageError(error)).toBe(true);
      expect((error as SkillPackageError).code).toBe(SkillPackageErrorCode.ABORTED);
    }
    expect(readdirSync(stagingRoot)).toEqual([]);
  });

  it('leaves no partial package behind when a write fails midway', () => {
    const snapshot = inspect(buildPackage().bytes);
    let writes = 0;
    fsHooks.beforeWrite = () => {
      writes += 1;
      if (writes > 1) throw new Error('disk full');
    };

    expect(() => materializeSkillPackage(snapshot, { stagingRoot })).toThrow(SkillPackageError);
    expect(readdirSync(stagingRoot)).toEqual([]);
  });

  it('refuses a staging root that is a system directory', () => {
    expect(() => materializeSkillPackage(inspect(buildPackage().bytes), { stagingRoot: '/' })).toThrow(
      SkillPackageError
    );
  });

  it('does not write through a symlink planted at a target path', () => {
    const snapshot = inspect(buildPackage().bytes);
    const decoy = path.join(stagingRoot, 'decoy.txt');
    writeFileSync(decoy, 'original\n');

    fsHooks.afterMkdir = (target) => {
      if (path.basename(target).startsWith('pkg-')) {
        symlinkSync(decoy, path.join(target, 'SKILL.md'));
      }
    };

    expect(() => materializeSkillPackage(snapshot, { stagingRoot })).toThrow(SkillPackageError);
    expect(readFileSync(decoy, 'utf8')).toBe('original\n');
  });
});

describe('cleanupSkillStagingRoot', () => {
  it('removes orphaned staging directories and nothing else', () => {
    const staged = materializeSkillPackage(inspect(buildPackage().bytes), { stagingRoot });
    const keeper = path.join(stagingRoot, 'not-a-staging-dir');
    writeFileSync(keeper, 'keep me\n');

    expect(cleanupSkillStagingRoot(stagingRoot)).toBe(1);
    expect(existsSync(staged.stagingDir)).toBe(false);
    expect(existsSync(keeper)).toBe(true);
  });

  it('is a no-op for a root that does not exist', () => {
    expect(cleanupSkillStagingRoot(path.join(stagingRoot, 'missing'))).toBe(0);
  });
});
