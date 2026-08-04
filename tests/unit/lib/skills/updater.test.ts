/**
 * Issue #1244: the atomic update apply — zero-write local-change guard,
 * verified service-owned backup, the aside → publish rename sequence with one
 * commit point, crash convergence to old-complete or new-complete, and the
 * update replay predicate (#1552 contract).
 *
 * The installs under test are produced by #1235's real apply, and the updates
 * by the real updater — nothing on disk is hand-built except the anomalies
 * each guard case plants. Zero-write claims are proven by byte-for-byte tree
 * snapshots, not by absence of an error.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import childProcess from 'child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import {
  applySkillInstall,
  directoriesForSkillPayload,
  stageSkillRootPayload,
} from '@/lib/skills/install-apply';
import {
  SKILL_RECEIPT_FILENAME,
  buildSkillInstallReceipt,
  serializeSkillInstallReceipt,
} from '@/lib/skills/install-plan';
import { computeSkillTreeHash, readExistingSkillTree } from '@/lib/skills/preview-diff';
import { getSkillInstallStagingRoot } from '@/lib/skills/operation-store';
import { inspectSkillPackage } from '@/lib/skills/package-validator';
import type { SkillPackageSnapshot } from '@/lib/skills/package-validator';
import { mayReplaySkillUpdate } from '@/lib/skills/operation-replay';
import type { SkillOperationJournalEntry } from '@/lib/skills/operation-journal';
import {
  SkillUpdateErrorCode,
  applySkillUpdate,
  completeSecondarySkillUpdateRoots,
  isSkillUpdateError,
  readSkillUpdateBackupManifest,
  reconcileSkillUpdateTarget,
  skillUpdateAsideNameFor,
  skillUpdateStagingNameFor,
  type SkillUpdateApplyInput,
} from '@/lib/skills/updater';
import { buildPackage } from '../../../fixtures/skills/malicious-packages/package';
import type { PackageFileSpec } from '../../../fixtures/skills/malicious-packages/package';
import { makeCatalogVersion } from './fixtures';
import { removeTempDir } from '@tests/helpers/temp-dir';

const SKILL_ID = 'demo-skill';
const FROM_VERSION = '1.2.3';
const TO_VERSION = '1.3.0';
const WORKTREE_ID = 'wt-1';
const OPERATION_ID = '9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f';
const BOTH_ROOTS = ['.agents/skills', '.claude/skills'] as const;

const INSTALLED_FILES: PackageFileSpec[] = [
  { path: 'reference/notes.md', content: '# Notes\n\nBackground reading.\n' },
  { path: 'assets/logo.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"/>\n' },
];

/** One changed, one removed, one added, plus an executable script (mode gate). */
const CANDIDATE_FILES: PackageFileSpec[] = [
  { path: 'reference/notes.md', content: '# Notes\n\nRewritten background reading.\n' },
  { path: 'docs/extra.md', content: '# Extra\n\nNew supplementary reading.\n' },
  { path: 'scripts/run.sh', content: '#!/bin/sh\necho run\n', mode: 0o755 },
];

let worktree: string;
let stateRoot: string;

function rootAbs(prefix: string = '.agents/skills'): string {
  return path.join(worktree, prefix, SKILL_ID);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface Installed {
  snapshot: SkillPackageSnapshot;
  receiptBytes: Uint8Array;
  receiptDigest: string;
  treeHash: string;
  rootPrefixes: string[];
}

/** Install v1.2.3 the way #1235 does, so the receipt and layout are genuine. */
function install(rootPrefixes: string[] = ['.agents/skills']): Installed {
  const built = buildPackage({ files: INSTALLED_FILES });
  const snapshot = inspectSkillPackage(built.bytes, { skillId: SKILL_ID, version: FROM_VERSION });
  const receipt = buildSkillInstallReceipt({
    snapshot,
    version: makeCatalogVersion(),
    rootPrefixes,
  });
  const receiptBytes = serializeSkillInstallReceipt(receipt);
  const treeHash = computeSkillTreeHash([
    ...snapshot.files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      executable: file.executable,
    })),
    { path: SKILL_RECEIPT_FILENAME, sha256: sha256(receiptBytes), executable: false },
  ]);

  applySkillInstall({
    worktreePath: worktree,
    worktreeRealPath: realpathSync(worktree),
    skillId: SKILL_ID,
    operationId: OPERATION_ID,
    snapshot,
    receiptBytes,
    plannedTreeHash: treeHash,
    rootPrefixes,
  });
  return {
    snapshot,
    receiptBytes,
    receiptDigest: sha256(receiptBytes),
    treeHash,
    rootPrefixes,
  };
}

interface Candidate {
  snapshot: SkillPackageSnapshot;
  receiptBytes: Uint8Array;
  receiptDigest: string;
  plannedTreeHash: string;
}

/** The v1.3.0 candidate, with its plan-fixed receipt bytes and tree hash. */
function candidate(rootPrefixes: string[] = ['.agents/skills']): Candidate {
  const built = buildPackage({ version: TO_VERSION, files: CANDIDATE_FILES });
  const snapshot = inspectSkillPackage(built.bytes, { skillId: SKILL_ID, version: TO_VERSION });
  const receipt = buildSkillInstallReceipt({
    snapshot,
    version: makeCatalogVersion({ version: TO_VERSION }),
    rootPrefixes,
  });
  const receiptBytes = serializeSkillInstallReceipt(receipt);
  const plannedTreeHash = computeSkillTreeHash([
    ...snapshot.files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      executable: file.executable,
    })),
    { path: SKILL_RECEIPT_FILENAME, sha256: sha256(receiptBytes), executable: false },
  ]);
  return { snapshot, receiptBytes, receiptDigest: sha256(receiptBytes), plannedTreeHash };
}

function applyInput(
  installed: Installed,
  cand: Candidate,
  overrides: Partial<SkillUpdateApplyInput> = {}
): SkillUpdateApplyInput {
  return {
    worktreePath: worktree,
    worktreeRealPath: realpathSync(worktree),
    worktreeId: WORKTREE_ID,
    skillId: SKILL_ID,
    operationId: OPERATION_ID,
    snapshot: cand.snapshot,
    receiptBytes: cand.receiptBytes,
    plannedTreeHash: cand.plannedTreeHash,
    expectedReceiptDigest: installed.receiptDigest,
    expectedTreeHash: installed.treeHash,
    rootPrefixes: installed.rootPrefixes,
    stateRoot,
    ...overrides,
  };
}

/** Every regular file under `dir`, keyed by relative path → sha256+mode. */
function snapshotTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (current: string, prefix: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      if (prefix === '' && entry === '.git') continue;
      const absolute = path.join(current, entry);
      const relative = prefix === '' ? entry : `${prefix}/${entry}`;
      const stats = lstatSync(absolute);
      if (stats.isDirectory()) walk(absolute, relative);
      else if (stats.isFile()) {
        out.set(relative, `${sha256(readFileSync(absolute))}:${stats.mode & 0o777}`);
      } else out.set(relative, `irregular:${stats.mode}`);
    }
  };
  walk(dir, '');
  return out;
}

function updateErrorCode(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    if (isSkillUpdateError(error)) return error.code;
    throw error;
  }
}

beforeEach(() => {
  worktree = mkdtempSync(path.join(tmpdir(), 'skill-updater-wt-'));
  stateRoot = mkdtempSync(path.join(tmpdir(), 'skill-updater-state-'));
});

afterEach(() => {
  removeTempDir(worktree);
  removeTempDir(stateRoot);
});

// =============================================================================
// Clean update
// =============================================================================

describe('applySkillUpdate — clean update', () => {
  it('switches the root to exactly the planned bytes, receipt included', () => {
    const installed = install();
    const cand = candidate();
    let commitPointSeen = false;

    const result = applySkillUpdate(
      applyInput(installed, cand, { onCommitPoint: () => (commitPointSeen = true) })
    );

    expect(commitPointSeen).toBe(true);
    expect(result.reconciling).toBe(false);
    expect(result.fromVersion).toBe(FROM_VERSION);
    expect(result.toVersion).toBe(TO_VERSION);
    expect(result.committedRoots).toEqual([`.agents/skills/${SKILL_ID}`]);
    expect(result.pendingRoots).toEqual([]);

    // Preview/actual byte parity: every file on disk is a file of the plan's
    // candidate inventory with identical bytes and mode, plus the exact
    // plan-fixed receipt — and nothing else.
    const disk = readExistingSkillTree(rootAbs());
    const byPath = new Map(disk.files.map((file) => [file.path, file]));
    expect([...byPath.keys()].sort()).toEqual(
      [...cand.snapshot.files.map((file) => file.path), SKILL_RECEIPT_FILENAME].sort()
    );
    for (const file of cand.snapshot.files) {
      expect(byPath.get(file.path)?.sha256).toBe(file.sha256);
      expect(byPath.get(file.path)?.executable).toBe(file.executable);
    }
    expect(Buffer.from(byPath.get(SKILL_RECEIPT_FILENAME)!.bytes)).toEqual(
      Buffer.from(cand.receiptBytes)
    );
    expect(computeSkillTreeHash(disk.files)).toBe(cand.plannedTreeHash);

    // The removed file of the old version is gone; no mixture survives.
    expect(existsSync(path.join(rootAbs(), 'assets/logo.svg'))).toBe(false);
    // The staging namespace is fully collected.
    expect(existsSync(getSkillInstallStagingRoot(worktree))).toBe(false);
  });

  it('writes a digest-verified service-owned backup of the old payload', () => {
    const installed = install();
    const result = applySkillUpdate(applyInput(installed, candidate()));

    expect(result.backup).toMatchObject({
      backupId: OPERATION_ID,
      fromVersion: FROM_VERSION,
      verified: true,
    });
    const manifest = readSkillUpdateBackupManifest(OPERATION_ID, { root: stateRoot });
    expect(manifest).not.toBeNull();
    expect(manifest!).toMatchObject({
      skillId: SKILL_ID,
      worktreeId: WORKTREE_ID,
      fromVersion: FROM_VERSION,
      toVersion: TO_VERSION,
      receiptDigest: installed.receiptDigest,
      treeHash: installed.treeHash,
    });
    // Every backed-up byte re-reads to the digest the manifest records.
    for (const file of manifest!.files) {
      const bytes = readFileSync(
        path.join(stateRoot, 'backups', OPERATION_ID, 'payload', file.path)
      );
      expect(sha256(bytes)).toBe(file.sha256);
    }
    // The old payload files are all there, receipt included.
    expect(manifest!.files.map((file) => file.path).sort()).toEqual(
      [...installed.snapshot.files.map((file) => file.path), SKILL_RECEIPT_FILENAME].sort()
    );
  });

  it('executes nothing from the package, even when it ships scripts', () => {
    const spies = [
      vi.spyOn(childProcess, 'exec'),
      vi.spyOn(childProcess, 'execSync'),
      vi.spyOn(childProcess, 'execFile'),
      vi.spyOn(childProcess, 'execFileSync'),
      vi.spyOn(childProcess, 'spawn'),
      vi.spyOn(childProcess, 'spawnSync'),
    ];
    try {
      const installed = install();
      applySkillUpdate(applyInput(installed, candidate()));
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();

      // The script landed as bytes with the declared mode — nothing more.
      const stats = lstatSync(path.join(rootAbs(), 'scripts/run.sh'));
      expect(stats.mode & 0o777).toBe(0o700);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('switches every recorded root under the one operation (#1460)', () => {
    const installed = install([...BOTH_ROOTS]);
    const cand = candidate([...BOTH_ROOTS]);
    const result = applySkillUpdate(applyInput(installed, cand));

    expect(result.reconciling).toBe(false);
    expect(result.committedRoots).toEqual([
      `.agents/skills/${SKILL_ID}`,
      `.claude/skills/${SKILL_ID}`,
    ]);
    for (const prefix of BOTH_ROOTS) {
      const disk = readExistingSkillTree(rootAbs(prefix));
      expect(computeSkillTreeHash(disk.files)).toBe(cand.plannedTreeHash);
    }
  });
});

// =============================================================================
// Zero-write guards
// =============================================================================

describe('applySkillUpdate — zero-write refusals', () => {
  it.each([
    [
      'locally modified file',
      (): void => writeFileSync(path.join(rootAbs(), 'reference/notes.md'), 'edited\n'),
    ],
    [
      'unknown file',
      (): void => writeFileSync(path.join(rootAbs(), 'rogue.txt'), 'not managed\n'),
    ],
    [
      'missing recorded file',
      (): void => rmSync(path.join(rootAbs(), 'assets/logo.svg')),
    ],
  ])('refuses with LOCAL_CHANGES and writes nothing: %s', (_label, plant) => {
    const installed = install();
    plant();
    const before = snapshotTree(worktree);

    expect(updateErrorCode(() => applySkillUpdate(applyInput(installed, candidate())))).toBe(
      SkillUpdateErrorCode.LOCAL_CHANGES
    );
    expect(snapshotTree(worktree)).toEqual(before);
    expect(readSkillUpdateBackupManifest(OPERATION_ID, { root: stateRoot })).toBeNull();
  });

  it('refuses with DRIFT when the receipt is not the one the plan bound', () => {
    const installed = install();
    const before = snapshotTree(worktree);

    expect(
      updateErrorCode(() =>
        applySkillUpdate(
          applyInput(installed, candidate(), { expectedReceiptDigest: 'f'.repeat(64) })
        )
      )
    ).toBe(SkillUpdateErrorCode.DRIFT);
    expect(snapshotTree(worktree)).toEqual(before);
  });

  it('refuses with NOT_INSTALLED when a recorded root is gone entirely', () => {
    const installed = install();
    rmSync(rootAbs(), { recursive: true });
    expect(updateErrorCode(() => applySkillUpdate(applyInput(installed, candidate())))).toBe(
      SkillUpdateErrorCode.NOT_INSTALLED
    );
  });

  it('aborts with zero writes when staging cannot be created', () => {
    const installed = install();
    // Occupy the staging name: the non-recursive mkdir must refuse to adopt it.
    const stagingRoot = getSkillInstallStagingRoot(worktree);
    mkdirSync(path.join(stagingRoot, skillUpdateStagingNameFor(OPERATION_ID)), {
      recursive: true,
    });
    const before = snapshotTree(rootAbs());

    expect(updateErrorCode(() => applySkillUpdate(applyInput(installed, candidate())))).toBe(
      SkillUpdateErrorCode.STAGING_IO
    );
    expect(snapshotTree(rootAbs())).toEqual(before);
  });

  it('restores the old directory when the publish rename fails (crash injection)', () => {
    const installed = install();
    const before = snapshotTree(worktree);

    expect(
      updateErrorCode(() =>
        applySkillUpdate(
          applyInput(installed, candidate(), {
            hooks: {
              beforePublish: () => {
                throw new Error('injected publish failure');
              },
            },
          })
        )
      )
    ).toBe(SkillUpdateErrorCode.COMMIT_FAILED);
    // The aside rename already ran; the worktree must still be byte-for-byte
    // what it was, staging included (zero-write from the caller's view).
    expect(snapshotTree(worktree)).toEqual(before);
  });
});

// =============================================================================
// Secondary-root failure and forward convergence
// =============================================================================

describe('applySkillUpdate — committed, reconciling', () => {
  it('reports pending roots when a secondary switch fails after the primary commit', () => {
    const installed = install([...BOTH_ROOTS]);
    const cand = candidate([...BOTH_ROOTS]);
    let commitPointSeen = false;

    const result = applySkillUpdate(
      applyInput(installed, cand, {
        onCommitPoint: () => (commitPointSeen = true),
        hooks: {
          beforeAside: (rootPrefix) => {
            if (rootPrefix === '.claude/skills') throw new Error('injected secondary crash');
          },
        },
      })
    );

    expect(commitPointSeen).toBe(true);
    expect(result.reconciling).toBe(true);
    expect(result.committedRoots).toEqual([`.agents/skills/${SKILL_ID}`]);
    expect(result.pendingRoots).toEqual([`.claude/skills/${SKILL_ID}`]);

    // No mixture: primary is completely new, secondary completely old.
    expect(
      computeSkillTreeHash(readExistingSkillTree(rootAbs('.agents/skills')).files)
    ).toBe(cand.plannedTreeHash);
    expect(
      computeSkillTreeHash(readExistingSkillTree(rootAbs('.claude/skills')).files)
    ).toBe(installed.treeHash);

    // Forward convergence switches the clean old secondary to the new payload.
    const converged = completeSecondarySkillUpdateRoots(
      worktree,
      realpathSync(worktree),
      SKILL_ID
    );
    expect(converged.completed).toEqual([`.claude/skills/${SKILL_ID}`]);
    expect(converged.skipped).toEqual([]);
    expect(
      computeSkillTreeHash(readExistingSkillTree(rootAbs('.claude/skills')).files)
    ).toBe(cand.plannedTreeHash);
  });

  it('never overwrites a secondary root with local changes during convergence', () => {
    const installed = install([...BOTH_ROOTS]);
    const cand = candidate([...BOTH_ROOTS]);
    applySkillUpdate(
      applyInput(installed, cand, {
        hooks: {
          beforeAside: (rootPrefix) => {
            if (rootPrefix === '.claude/skills') throw new Error('injected secondary crash');
          },
        },
      })
    );
    // The user edits the still-old secondary before reconciliation runs.
    writeFileSync(path.join(rootAbs('.claude/skills'), 'reference/notes.md'), 'edited\n');
    const before = snapshotTree(rootAbs('.claude/skills'));

    const converged = completeSecondarySkillUpdateRoots(
      worktree,
      realpathSync(worktree),
      SKILL_ID
    );
    expect(converged.completed).toEqual([]);
    expect(converged.skipped).toEqual([`.claude/skills/${SKILL_ID}`]);
    expect(snapshotTree(rootAbs('.claude/skills'))).toEqual(before);
  });
});

// =============================================================================
// Crash convergence at the primary root
// =============================================================================

describe('reconcileSkillUpdateTarget', () => {
  function claim(receiptDigest: string | null) {
    return { operationId: OPERATION_ID, toVersion: TO_VERSION, receiptDigest };
  }

  /** Stage the candidate exactly as apply would, without publishing it. */
  function stageCandidate(cand: Candidate): string {
    const staged = stageSkillRootPayload({
      worktreePath: worktree,
      worktreeRealPath: realpathSync(worktree),
      rootPrefix: '.agents/skills',
      skillId: SKILL_ID,
      stagingName: skillUpdateStagingNameFor(OPERATION_ID),
      payload: cand.snapshot.files.map((file) => ({
        relativePath: file.path,
        bytes: cand.snapshot.readFile(file.path),
        executable: file.executable,
      })),
      directories: directoriesForSkillPayload(
        cand.snapshot.files.map((file) => file.path),
        cand.snapshot.directories
      ),
      receiptBytes: cand.receiptBytes,
      plannedTreeHash: cand.plannedTreeHash,
    });
    return staged.stagingDir;
  }

  it('answers rolled_back and collects staging when the old root never moved', () => {
    const installed = install();
    const cand = candidate();
    stageCandidate(cand);

    const outcome = reconcileSkillUpdateTarget(worktree, SKILL_ID, claim(cand.receiptDigest));
    expect(outcome).toEqual({ committed: false, action: 'rolled_back' });
    expect(computeSkillTreeHash(readExistingSkillTree(rootAbs()).files)).toBe(installed.treeHash);
    expect(existsSync(getSkillInstallStagingRoot(worktree))).toBe(false);
  });

  it('restores the aside directory when the crash hit between the two renames', () => {
    const installed = install();
    const cand = candidate();
    const stagedDir = stageCandidate(cand);
    const stagingRoot = path.dirname(stagedDir);
    // Manufacture the exact crash shape: old moved aside, new never published.
    renameSync(rootAbs(), path.join(stagingRoot, skillUpdateAsideNameFor(OPERATION_ID)));
    expect(existsSync(rootAbs())).toBe(false);

    const outcome = reconcileSkillUpdateTarget(worktree, SKILL_ID, claim(cand.receiptDigest));
    expect(outcome).toEqual({ committed: false, action: 'restored_old' });
    expect(computeSkillTreeHash(readExistingSkillTree(rootAbs()).files)).toBe(installed.treeHash);
    expect(existsSync(getSkillInstallStagingRoot(worktree))).toBe(false);
  });

  it('adopts a fully verified staged payload when the old directory is gone', () => {
    install();
    const cand = candidate();
    const stagedDir = stageCandidate(cand);
    void stagedDir;
    // Old directory removed with no aside: only the staged new payload is left.
    rmSync(rootAbs(), { recursive: true });

    const outcome = reconcileSkillUpdateTarget(worktree, SKILL_ID, claim(cand.receiptDigest));
    expect(outcome).toEqual({ committed: true, action: 'adopted_new' });
    expect(computeSkillTreeHash(readExistingSkillTree(rootAbs()).files)).toBe(
      cand.plannedTreeHash
    );
  });

  it('removes rather than adopts a staged payload that fails verification', () => {
    install();
    const cand = candidate();
    const stagedDir = stageCandidate(cand);
    rmSync(rootAbs(), { recursive: true });
    // One drifted staged byte disqualifies the whole adoption.
    rmSync(path.join(stagedDir, 'reference/notes.md'));
    writeFileSync(path.join(stagedDir, 'reference/notes.md'), 'tampered\n');

    const outcome = reconcileSkillUpdateTarget(worktree, SKILL_ID, claim(cand.receiptDigest));
    expect(outcome.committed).toBe(false);
    expect(outcome.action).toBe('unrecoverable');
    expect(existsSync(stagedDir)).toBe(false);
    expect(existsSync(rootAbs())).toBe(false);
  });

  it('answers committed once the new receipt is at the root', () => {
    const installed = install();
    const cand = candidate();
    applySkillUpdate(applyInput(installed, cand));

    const outcome = reconcileSkillUpdateTarget(worktree, SKILL_ID, claim(cand.receiptDigest));
    expect(outcome).toEqual({ committed: true, action: 'committed' });
  });

  it('does not mistake the old receipt for the new one on a version match', () => {
    install();
    // No digest recorded (PREPARING crash): the version discriminates, because
    // the plan only ever offers strictly newer versions.
    const outcome = reconcileSkillUpdateTarget(worktree, SKILL_ID, claim(null));
    expect(outcome.committed).toBe(false);
  });
});

// =============================================================================
// Replay predicate (#1552 contract for `update`)
// =============================================================================

describe('mayReplaySkillUpdate', () => {
  function entryWith(overrides: Partial<SkillOperationJournalEntry>): SkillOperationJournalEntry {
    return {
      fsCommittedAt: null,
      receiptDigest: null,
      ...overrides,
    } as SkillOperationJournalEntry;
  }

  it('always replays an entry that never claimed a filesystem commit', () => {
    expect(mayReplaySkillUpdate(entryWith({}), worktree, SKILL_ID)).toBe(true);
  });

  it('replays a committed update only while its new receipt is on disk', () => {
    const installed = install();
    const cand = candidate();
    applySkillUpdate(applyInput(installed, cand));

    const entry = entryWith({ fsCommittedAt: 1, receiptDigest: cand.receiptDigest });
    expect(mayReplaySkillUpdate(entry, worktree, SKILL_ID)).toBe(true);

    // A different receipt in place means the claim describes an earlier state.
    const foreign = entryWith({ fsCommittedAt: 1, receiptDigest: 'f'.repeat(64) });
    expect(mayReplaySkillUpdate(foreign, worktree, SKILL_ID)).toBe(false);

    rmSync(rootAbs(), { recursive: true });
    expect(mayReplaySkillUpdate(entry, worktree, SKILL_ID)).toBe(false);
  });
});
