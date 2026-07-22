/**
 * Issue #1236: deleting exactly the files CommandMate wrote.
 *
 * Two things are being proved here, and they pull in opposite directions.
 *
 * The first is that a clean install disappears completely — files, the
 * directories they lived in, and the receipt last of all. The second is that
 * almost nothing else does: a locally edited file, a file the user added, a
 * directory swapped for a link, a path that walked out of the install root. For
 * every one of those the assertion is not "it reported an error" but "the bytes
 * are still on disk", because an error message is no consolation for a deleted
 * file.
 *
 * The low-level guards are exercised directly as well as through
 * `applySkillUninstall`. That is deliberate: the whole-operation path is
 * defended several times over, so a test that only went through the front door
 * could not tell which guard was actually load-bearing.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { applySkillInstall } from '@/lib/skills/install-apply';
import {
  SKILL_RECEIPT_FILENAME,
  buildSkillInstallReceipt,
  serializeSkillInstallReceipt,
} from '@/lib/skills/install-plan';
import { computeSkillTreeHash, readExistingSkillTree } from '@/lib/skills/preview-diff';
import { inspectSkillPackage } from '@/lib/skills/package-validator';
import type { SkillPackageSnapshot } from '@/lib/skills/package-validator';
import {
  SkillUninstallErrorCode,
  applySkillUninstall,
  hasRemovedSkillPayload,
  isSkillUninstallError,
  removeReceiptOwnedFile,
  resolveSkillUninstallTarget,
  assertSkillUninstallAncestors,
} from '@/lib/skills/uninstall-apply';
import { assessSkillUninstall, readSkillReceiptDigest } from '@/lib/skills/uninstall-plan';
import { buildPackage } from '../../../fixtures/skills/malicious-packages/package';
import type { PackageFileSpec } from '../../../fixtures/skills/malicious-packages/package';
import { makeCatalogVersion } from './fixtures';

const SKILL_ID = 'demo-skill';
const VERSION = '1.2.3';
const OPERATION_ID = '9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f';

let worktree: string;

function installRoot(): string {
  return path.join(worktree, '.agents', 'skills', SKILL_ID);
}

function sha256(content: string | Uint8Array): string {
  return createHash('sha256')
    .update(typeof content === 'string' ? Buffer.from(content, 'utf-8') : content)
    .digest('hex');
}

/** Install a real package the way #1235 does, so the receipt is genuine. */
function install(files?: PackageFileSpec[]): SkillPackageSnapshot {
  const built = buildPackage(files ? { files } : {});
  const snapshot = inspectSkillPackage(built.bytes, { skillId: SKILL_ID, version: VERSION });
  const receipt = buildSkillInstallReceipt({ snapshot, version: makeCatalogVersion() });
  const receiptBytes = serializeSkillInstallReceipt(receipt);

  applySkillInstall({
    worktreePath: worktree,
    worktreeRealPath: realpathSync(worktree),
    skillId: SKILL_ID,
    operationId: OPERATION_ID,
    snapshot,
    receiptBytes,
    plannedTreeHash: computeSkillTreeHash([
      ...snapshot.files.map((file) => ({
        path: file.path,
        sha256: file.sha256,
        executable: file.executable,
      })),
      { path: SKILL_RECEIPT_FILENAME, sha256: sha256(receiptBytes), executable: false },
    ]),
  });
  return snapshot;
}

/** The apply inputs a freshly built plan would produce. */
function currentInput(overrides: Record<string, unknown> = {}) {
  const existing = readExistingSkillTree(installRoot());
  return {
    worktreePath: worktree,
    worktreeRealPath: realpathSync(worktree),
    skillId: SKILL_ID,
    expectedReceiptDigest: readSkillReceiptDigest(existing) ?? '',
    expectedTreeHash: computeSkillTreeHash(existing.files),
    ...overrides,
  };
}

/** Payload files are written 0600, so an edit needs the bit put back first. */
function overwrite(relative: string, content: string): void {
  const target = path.join(installRoot(), relative);
  chmodSync(target, 0o600);
  writeFileSync(target, content);
}

/** Assert a rejection carries the expected code. */
function expectRejection(run: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(isSkillUninstallError(thrown)).toBe(true);
  expect((thrown as { code: string }).code).toBe(code);
}

beforeEach(() => {
  worktree = mkdtempSync(path.join(tmpdir(), 'cm-skill-uninstall-'));
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
});

// =============================================================================
// The clean case
// =============================================================================

describe('applySkillUninstall — a clean managed install', () => {
  it('removes every file, the directories they lived in, and the root', () => {
    install();

    const result = applySkillUninstall(currentInput());

    expect(result.fullyRemoved).toBe(true);
    expect(result.receiptRemoved).toBe(true);
    expect(result.retained).toEqual([]);
    expect(existsSync(installRoot())).toBe(false);
    expect(result.removedFiles.map((file) => file.path)).toContain(
      `.agents/skills/${SKILL_ID}/${SKILL_RECEIPT_FILENAME}`
    );
    expect(result.removedDirectories.sort()).toEqual([
      `.agents/skills/${SKILL_ID}/assets`,
      `.agents/skills/${SKILL_ID}/reference`,
    ]);
  });

  it('leaves the rest of the worktree, and other Skills, alone', () => {
    install();
    const sibling = path.join(worktree, '.agents', 'skills', 'other-skill');
    mkdirSync(sibling, { recursive: true });
    writeFileSync(path.join(sibling, 'SKILL.md'), '# other\n');
    writeFileSync(path.join(worktree, 'README.md'), '# repo\n');

    applySkillUninstall(currentInput());

    expect(existsSync(path.join(sibling, 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(worktree, 'README.md'))).toBe(true);
    expect(readdirSync(path.join(worktree, '.agents', 'skills'))).toEqual(['other-skill']);
  });

  it('reports its commit point once, before anything is deleted', () => {
    install();
    const observed: boolean[] = [];

    applySkillUninstall(
      currentInput({
        onCommitPoint: () => observed.push(existsSync(path.join(installRoot(), 'SKILL.md'))),
      })
    );

    expect(observed).toEqual([true]);
  });

  it('does not report a commit point when the plan is refused', () => {
    install();
    writeFileSync(path.join(installRoot(), 'my-notes.md'), 'keep me\n');
    let committed = false;

    expectRejection(
      () => applySkillUninstall(currentInput({ onCommitPoint: () => (committed = true) })),
      SkillUninstallErrorCode.BLOCKED
    );

    expect(committed).toBe(false);
  });

  it('answers the reconciler once the payload is gone', () => {
    install();
    const digest = readSkillReceiptDigest(readExistingSkillTree(installRoot()));

    expect(hasRemovedSkillPayload(worktree, SKILL_ID, digest)).toBe(false);
    applySkillUninstall(currentInput());
    expect(hasRemovedSkillPayload(worktree, SKILL_ID, digest)).toBe(true);
  });
});

// =============================================================================
// Zero-delete
// =============================================================================

describe('applySkillUninstall — nothing is deleted when anything is ambiguous', () => {
  it('keeps every file when one of them was edited locally', () => {
    install();
    const input = currentInput();
    overwrite('reference/notes.md', '# Notes\n\nmine now\n');

    expectRejection(() => applySkillUninstall(input), SkillUninstallErrorCode.BLOCKED);

    expect(existsSync(path.join(installRoot(), 'reference/notes.md'))).toBe(true);
    expect(existsSync(path.join(installRoot(), 'assets/logo.svg'))).toBe(true);
    expect(existsSync(path.join(installRoot(), SKILL_RECEIPT_FILENAME))).toBe(true);
  });

  it('keeps every file when the user added one of their own', () => {
    install();
    const input = currentInput();
    writeFileSync(path.join(installRoot(), 'my-notes.md'), 'keep me\n');

    expectRejection(() => applySkillUninstall(input), SkillUninstallErrorCode.BLOCKED);

    expect(readFileSync(path.join(installRoot(), 'my-notes.md'), 'utf-8')).toBe('keep me\n');
    expect(existsSync(path.join(installRoot(), 'assets/logo.svg'))).toBe(true);
  });

  it('keeps every file when a recorded one has already gone', () => {
    install();
    const input = currentInput();
    rmSync(path.join(installRoot(), 'assets/logo.svg'));

    expectRejection(() => applySkillUninstall(input), SkillUninstallErrorCode.BLOCKED);

    expect(existsSync(path.join(installRoot(), 'reference/notes.md'))).toBe(true);
    expect(existsSync(path.join(installRoot(), SKILL_RECEIPT_FILENAME))).toBe(true);
  });

  it('keeps every file when a payload path was swapped for a symlink after planning', () => {
    install();
    const input = currentInput();
    const outside = path.join(worktree, 'outside.txt');
    writeFileSync(outside, 'victim\n');
    rmSync(path.join(installRoot(), 'reference/notes.md'));
    symlinkSync(outside, path.join(installRoot(), 'reference/notes.md'));

    expectRejection(() => applySkillUninstall(input), SkillUninstallErrorCode.BLOCKED);

    expect(readFileSync(outside, 'utf-8')).toBe('victim\n');
    expect(existsSync(path.join(installRoot(), 'assets/logo.svg'))).toBe(true);
  });

  it('keeps every file when the tree the plan fixed no longer matches', () => {
    install();

    expectRejection(
      () => applySkillUninstall(currentInput({ expectedTreeHash: '0'.repeat(64) })),
      SkillUninstallErrorCode.DRIFT
    );

    expect(existsSync(path.join(installRoot(), 'assets/logo.svg'))).toBe(true);
    expect(existsSync(path.join(installRoot(), SKILL_RECEIPT_FILENAME))).toBe(true);
  });

  it('keeps every file when the receipt is no longer the one that was planned', () => {
    install();

    expectRejection(
      () => applySkillUninstall(currentInput({ expectedReceiptDigest: 'a'.repeat(64) })),
      SkillUninstallErrorCode.DRIFT
    );

    expect(existsSync(path.join(installRoot(), SKILL_RECEIPT_FILENAME))).toBe(true);
  });

  it('reports nothing installed rather than succeeding vacuously', () => {
    expectRejection(
      () =>
        applySkillUninstall({
          worktreePath: worktree,
          worktreeRealPath: realpathSync(worktree),
          skillId: SKILL_ID,
          expectedReceiptDigest: 'b'.repeat(64),
          expectedTreeHash: computeSkillTreeHash([]),
        }),
      SkillUninstallErrorCode.NOT_INSTALLED
    );
  });
});

// =============================================================================
// Directories
// =============================================================================

describe('applySkillUninstall — directories', () => {
  it('leaves a directory the install did not create, and says what stayed', () => {
    install();
    const input = currentInput();
    // Empty directories are invisible to the file scan, so this one cannot make
    // the plan non-removable — it must survive the delete instead.
    mkdirSync(path.join(installRoot(), 'scratch'));

    const result = applySkillUninstall(input);

    expect(existsSync(path.join(installRoot(), 'scratch'))).toBe(true);
    expect(result.fullyRemoved).toBe(false);
    expect(result.retained).toEqual([
      expect.objectContaining({
        path: `.agents/skills/${SKILL_ID}/scratch`,
        messageKey: 'skills.uninstall.reason.unmanagedFile',
      }),
    ]);
  });

  it('leaves a payload directory that gained an unrelated file mid-delete', () => {
    install();
    const input = currentInput({
      onCommitPoint: () => writeFileSync(path.join(installRoot(), 'assets', 'late.txt'), 'late\n'),
    });

    const result = applySkillUninstall(input);

    expect(existsSync(path.join(installRoot(), 'assets', 'late.txt'))).toBe(true);
    expect(result.removedDirectories).toEqual([`.agents/skills/${SKILL_ID}/reference`]);
    expect(result.fullyRemoved).toBe(false);
  });
});

// =============================================================================
// Partial failure
// =============================================================================

describe('applySkillUninstall — a failure part-way through', () => {
  it('leaves the receipt and the undeleted files in place for diagnosis', () => {
    install();
    const input = currentInput();
    // Deletion needs write permission on the *parent* directory, so this makes
    // `reference/notes.md` undeletable while leaving it perfectly readable.
    chmodSync(path.join(installRoot(), 'reference'), 0o500);

    try {
      expectRejection(() => applySkillUninstall(input), SkillUninstallErrorCode.DELETE_FAILED);

      // The earlier file went; the receipt that explains the directory did not.
      expect(existsSync(path.join(installRoot(), 'assets/logo.svg'))).toBe(false);
      expect(existsSync(path.join(installRoot(), 'reference/notes.md'))).toBe(true);
      expect(existsSync(path.join(installRoot(), SKILL_RECEIPT_FILENAME))).toBe(true);
      expect(assessSkillUninstall(installRoot(), SKILL_ID).receipt?.version).toBe(VERSION);
    } finally {
      chmodSync(path.join(installRoot(), 'reference'), 0o700);
    }
  });
});

// =============================================================================
// Guards, exercised directly
// =============================================================================

describe('removeReceiptOwnedFile — the per-file guards', () => {
  it('refuses a file whose bytes no longer match the receipt', () => {
    install();
    const original = readFileSync(path.join(installRoot(), 'reference/notes.md'));
    overwrite('reference/notes.md', 'edited\n');

    expectRejection(
      () =>
        removeReceiptOwnedFile(installRoot(), 'reference/notes.md', {
          sha256: sha256(original),
          executable: false,
        }),
      SkillUninstallErrorCode.FILE_CHANGED
    );

    expect(existsSync(path.join(installRoot(), 'reference/notes.md'))).toBe(true);
  });

  it('refuses a file whose mode no longer matches the receipt', () => {
    install();
    const bytes = readFileSync(path.join(installRoot(), 'reference/notes.md'));
    chmodSync(path.join(installRoot(), 'reference/notes.md'), 0o700);

    expectRejection(
      () =>
        removeReceiptOwnedFile(installRoot(), 'reference/notes.md', {
          sha256: sha256(bytes),
          executable: false,
        }),
      SkillUninstallErrorCode.FILE_CHANGED
    );

    expect(existsSync(path.join(installRoot(), 'reference/notes.md'))).toBe(true);
  });

  it('refuses to delete through a directory that became a symlink', () => {
    install();
    const outside = mkdtempSync(path.join(tmpdir(), 'cm-uninstall-outside-'));
    const victim = path.join(outside, 'notes.md');
    writeFileSync(victim, 'not yours\n');
    rmSync(path.join(installRoot(), 'reference'), { recursive: true });
    symlinkSync(outside, path.join(installRoot(), 'reference'));

    try {
      // The digest is the *victim's*, so only the link guard can stop this.
      expectRejection(
        () =>
          removeReceiptOwnedFile(installRoot(), 'reference/notes.md', {
            sha256: sha256('not yours\n'),
            executable: false,
          }),
        SkillUninstallErrorCode.PATH_UNSAFE
      );

      expect(existsSync(victim)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses to delete a symlink standing where a payload file should be', () => {
    install();
    const outside = path.join(worktree, 'outside.txt');
    writeFileSync(outside, 'victim\n');
    rmSync(path.join(installRoot(), 'reference/notes.md'));
    symlinkSync(outside, path.join(installRoot(), 'reference/notes.md'));

    expectRejection(
      () =>
        removeReceiptOwnedFile(installRoot(), 'reference/notes.md', {
          sha256: sha256('victim\n'),
          executable: false,
        }),
      SkillUninstallErrorCode.PATH_UNSAFE
    );

    expect(existsSync(outside)).toBe(true);
  });

  it('refuses a path that walks out of the install root', () => {
    install();
    writeFileSync(path.join(worktree, 'outside.txt'), 'victim\n');

    for (const relative of ['../outside.txt', '../../outside.txt', '/etc/hosts', '']) {
      expectRejection(
        () =>
          removeReceiptOwnedFile(installRoot(), relative, {
            sha256: sha256('victim\n'),
            executable: false,
          }),
        SkillUninstallErrorCode.PATH_UNSAFE
      );
    }

    expect(existsSync(path.join(worktree, 'outside.txt'))).toBe(true);
  });

  it('refuses a file that is hard-linked from outside the install root', () => {
    install();
    const bytes = readFileSync(path.join(installRoot(), 'reference/notes.md'));
    linkSync(path.join(installRoot(), 'reference/notes.md'), path.join(worktree, 'alias.md'));

    expectRejection(
      () =>
        removeReceiptOwnedFile(installRoot(), 'reference/notes.md', {
          sha256: sha256(bytes),
          executable: false,
        }),
      SkillUninstallErrorCode.PATH_UNSAFE
    );

    expect(existsSync(path.join(installRoot(), 'reference/notes.md'))).toBe(true);
  });
});

describe('path derivation', () => {
  it('rejects a Skill ID that is not a plain slug', () => {
    for (const skillId of ['../escape', '.hidden', 'UPPER', 'a'.repeat(65)]) {
      expectRejection(
        () => resolveSkillUninstallTarget(worktree, skillId),
        SkillUninstallErrorCode.TARGET_UNSAFE
      );
    }
  });

  it('derives the same root the install wrote to', () => {
    install();

    expect(resolveSkillUninstallTarget(worktree, SKILL_ID)).toBe(installRoot());
  });

  it('refuses when an ancestor of the install root is a symlink', () => {
    const elsewhere = path.join(worktree, 'elsewhere');
    mkdirSync(path.join(elsewhere, 'skills'), { recursive: true });
    symlinkSync(elsewhere, path.join(worktree, '.agents'));

    expectRejection(
      () => assertSkillUninstallAncestors(realpathSync(worktree), worktree),
      SkillUninstallErrorCode.ANCESTOR_UNSAFE
    );
  });

  it('refuses when the worktree is no longer the directory that was resolved', () => {
    expectRejection(
      () => assertSkillUninstallAncestors(path.join(worktree, 'moved'), worktree),
      SkillUninstallErrorCode.ANCESTOR_UNSAFE
    );
  });
});
