/**
 * Issue #1236: assessing whether a Skill directory is safe to remove.
 *
 * Every case here is about the *refusal*. A clean uninstall is one line of
 * behaviour; the value of this module is that it can tell a file CommandMate
 * wrote from one it did not, and stops on the difference. So each case plants
 * exactly one anomaly in an otherwise perfect install and asserts that the
 * whole plan goes non-removable — never that "most of it" is still deletable.
 *
 * The installs under test are produced by #1235's real apply, not hand-built,
 * so a drift between what install writes and what uninstall recognises surfaces
 * here rather than in a user's worktree.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
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
  isSkillPlanError,
  serializeSkillInstallReceipt,
} from '@/lib/skills/install-plan';
import { computeSkillTreeHash, readExistingSkillTree } from '@/lib/skills/preview-diff';
import { inspectSkillPackage } from '@/lib/skills/package-validator';
import type { SkillPackageSnapshot } from '@/lib/skills/package-validator';
import {
  SkillUninstallReason,
  assessSkillUninstall,
  consumeSkillUninstallPlan,
  createSkillUninstallPlan,
  getSkillUninstallPlan,
  readSkillReceiptDigest,
  resetSkillUninstallPlanCacheForTesting,
} from '@/lib/skills/uninstall-plan';
import { buildPackage } from '../../../fixtures/skills/malicious-packages/package';
import type { PackageFileSpec } from '../../../fixtures/skills/malicious-packages/package';
import { makeCatalogVersion } from './fixtures';
import type { SkillGitTargetState } from '@/lib/skills/preview-diff';
import type { SkillPlanActor } from '@/lib/skills/install-plan';

const SKILL_ID = 'demo-skill';
const VERSION = '1.2.3';
const WORKTREE_ID = 'wt-1';
const OPERATION_ID = '9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f';
const ACTOR: SkillPlanActor = { type: 'user', id: null };

const GIT: SkillGitTargetState = {
  headState: 'attached',
  branch: 'feature/demo',
  headCommit: 'f'.repeat(40),
  dirty: false,
};

let worktree: string;

function installRoot(): string {
  return path.join(worktree, '.agents', 'skills', SKILL_ID);
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
      {
        path: SKILL_RECEIPT_FILENAME,
        sha256: createHash('sha256').update(receiptBytes).digest('hex'),
        executable: false,
      },
    ]),
  });
  return snapshot;
}

function plan() {
  return createSkillUninstallPlan({
    actor: ACTOR,
    worktree: {
      id: WORKTREE_ID,
      name: 'demo-worktree',
      path: worktree,
      repositoryName: 'CommandMate',
    },
    skillId: SKILL_ID,
    installRootAbs: installRoot(),
    git: GIT,
  });
}

function observationFromDisk() {
  const existing = readExistingSkillTree(installRoot());
  return {
    branch: GIT.branch,
    headCommit: GIT.headCommit,
    currentTreeHash: computeSkillTreeHash(existing.files),
    receiptDigest: readSkillReceiptDigest(existing),
  };
}

/** Payload files are written 0600, so an edit needs the bit put back first. */
function overwrite(relative: string, content: string): void {
  const target = path.join(installRoot(), relative);
  chmodSync(target, 0o600);
  writeFileSync(target, content);
}

beforeEach(() => {
  worktree = mkdtempSync(path.join(tmpdir(), 'cm-skill-uninstall-plan-'));
  resetSkillUninstallPlanCacheForTesting();
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
});

// =============================================================================
// Assessment
// =============================================================================

describe('assessSkillUninstall — a clean managed install', () => {
  it('marks every payload file and the receipt removable', () => {
    const snapshot = install();

    const assessment = assessSkillUninstall(installRoot(), SKILL_ID);

    expect(assessment.removable).toBe(true);
    expect(assessment.blockers).toEqual([]);
    expect(assessment.stats).toMatchObject({
      removable: snapshot.files.length + 1,
      modified: 0,
      missing: 0,
      unknown: 0,
      irregular: 0,
    });
    // The receipt does not list itself, so it must be folded in explicitly or
    // it would read as an unmanaged file and block its own removal.
    const receiptEntry = assessment.entries.find((entry) => entry.generated);
    expect(receiptEntry).toMatchObject({
      relativePath: SKILL_RECEIPT_FILENAME,
      disposition: 'remove',
    });
  });

  it('reports the receipt digest, which identifies this install specifically', () => {
    install();

    const assessment = assessSkillUninstall(installRoot(), SKILL_ID);

    expect(assessment.receiptDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(assessment.receipt?.version).toBe(VERSION);
  });
});

describe('assessSkillUninstall — one anomaly blocks the whole directory', () => {
  it('refuses when a payload file was edited locally', () => {
    install();
    overwrite('reference/notes.md', '# Notes\n\nMy own additions.\n');

    const assessment = assessSkillUninstall(installRoot(), SKILL_ID);

    expect(assessment.removable).toBe(false);
    expect(assessment.blockers).toContainEqual(
      expect.objectContaining({
        code: SkillUninstallReason.LOCAL_MODIFICATION,
        path: `.agents/skills/${SKILL_ID}/reference/notes.md`,
      })
    );
    // The untouched siblings are still classified as removable — the refusal is
    // a property of the plan, not of every individual file.
    expect(assessment.stats.removable).toBeGreaterThan(0);
  });

  it('refuses when a payload file only changed its mode', () => {
    install();
    chmodSync(path.join(installRoot(), 'reference/notes.md'), 0o700);

    const assessment = assessSkillUninstall(installRoot(), SKILL_ID);

    expect(assessment.removable).toBe(false);
    expect(assessment.blockers.map((entry) => entry.code)).toContain(
      SkillUninstallReason.LOCAL_MODIFICATION
    );
  });

  it('refuses when the user left a file of their own in the directory', () => {
    install();
    writeFileSync(path.join(installRoot(), 'my-notes.md'), 'do not delete this\n');

    const assessment = assessSkillUninstall(installRoot(), SKILL_ID);

    expect(assessment.removable).toBe(false);
    expect(assessment.blockers).toContainEqual(
      expect.objectContaining({
        code: SkillUninstallReason.UNMANAGED_FILE,
        path: `.agents/skills/${SKILL_ID}/my-notes.md`,
      })
    );
  });

  it('refuses when a recorded file has gone missing', () => {
    install();
    rmSync(path.join(installRoot(), 'assets/logo.svg'));

    const assessment = assessSkillUninstall(installRoot(), SKILL_ID);

    expect(assessment.removable).toBe(false);
    expect(assessment.blockers.map((entry) => entry.code)).toContain(
      SkillUninstallReason.RECEIPT_ORPHAN
    );
  });

  it('refuses when a payload path became a symlink', () => {
    install();
    const outside = path.join(worktree, 'outside.txt');
    writeFileSync(outside, 'victim\n');
    rmSync(path.join(installRoot(), 'reference/notes.md'));
    symlinkSync(outside, path.join(installRoot(), 'reference/notes.md'));

    const assessment = assessSkillUninstall(installRoot(), SKILL_ID);

    expect(assessment.removable).toBe(false);
    expect(assessment.blockers.map((entry) => entry.code)).toContain(
      SkillUninstallReason.NOT_A_REGULAR_FILE
    );
  });

  it('refuses a directory with no receipt at all', () => {
    mkdirSync(path.join(worktree, '.agents', 'skills', SKILL_ID), { recursive: true });
    writeFileSync(path.join(installRoot(), 'SKILL.md'), '# hand-made\n');

    const assessment = assessSkillUninstall(installRoot(), SKILL_ID);

    expect(assessment.removable).toBe(false);
    expect(assessment.receipt).toBeNull();
    expect(assessment.blockers.map((entry) => entry.code)).toContain(
      SkillUninstallReason.RECEIPT_MISSING
    );
  });

  it('refuses an unreadable receipt rather than guessing at ownership', () => {
    install();
    overwrite(SKILL_RECEIPT_FILENAME, 'not json at all');

    const assessment = assessSkillUninstall(installRoot(), SKILL_ID);

    expect(assessment.removable).toBe(false);
    expect(assessment.blockers.map((entry) => entry.code)).toContain(
      SkillUninstallReason.RECEIPT_UNREADABLE
    );
  });

  it('refuses a receipt that describes a different Skill', () => {
    install();
    overwrite(SKILL_RECEIPT_FILENAME, JSON.stringify({ skill_id: 'other-skill', files: [] }));

    const assessment = assessSkillUninstall(installRoot(), SKILL_ID);

    expect(assessment.removable).toBe(false);
    expect(assessment.blockers.map((entry) => entry.code)).toContain(
      SkillUninstallReason.RECEIPT_FOREIGN
    );
  });

  it('reports nothing installed when the directory does not exist', () => {
    const assessment = assessSkillUninstall(installRoot(), SKILL_ID);

    expect(assessment.present).toBe(false);
    expect(assessment.removable).toBe(false);
    expect(assessment.blockers.map((entry) => entry.code)).toEqual([
      SkillUninstallReason.NOT_INSTALLED,
    ]);
  });

  it('refuses when the directory walk could not complete', () => {
    install();

    const assessment = assessSkillUninstall(installRoot(), SKILL_ID, {
      existing: { ...readExistingSkillTree(installRoot()), truncated: true },
    });

    expect(assessment.removable).toBe(false);
    expect(assessment.blockers.map((entry) => entry.code)).toContain(
      SkillUninstallReason.TREE_SCAN_TRUNCATED
    );
  });
});

// =============================================================================
// Plan and token contract
// =============================================================================

describe('createSkillUninstallPlan', () => {
  it('splits the directory into what goes and what stays, with reasons', () => {
    install();
    writeFileSync(path.join(installRoot(), 'my-notes.md'), 'keep me\n');

    const record = plan();

    expect(record.dto.removable).toBe(false);
    expect(record.dto.nextActionKey).toBe('skills.uninstall.nextAction.blocked');
    expect(record.dto.retained.map((entry) => entry.path)).toContain(
      `.agents/skills/${SKILL_ID}/my-notes.md`
    );
    expect(record.dto.blockers[0].messageKey).toMatch(/^skills\.uninstall\.reason\./);
  });

  it('describes the install from its receipt, not from the Catalog', () => {
    install();

    const record = plan();

    expect(record.dto.removable).toBe(true);
    expect(record.dto.skill).toMatchObject({
      id: SKILL_ID,
      version: VERSION,
      source: { repository: 'Kewton/commandmate-skills' },
    });
    expect(record.dto.target.installRoot).toBe(`.agents/skills/${SKILL_ID}`);
  });

  it('refuses to plan when nothing is installed', () => {
    let thrown: unknown;
    try {
      plan();
    } catch (error) {
      thrown = error;
    }
    expect(isSkillPlanError(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe('SKILL_PLAN_NOT_FOUND');
  });
});

describe('consumeSkillUninstallPlan — the token contract', () => {
  it('spends a token exactly once', () => {
    install();
    const record = plan();

    consumeSkillUninstallPlan(
      record.token,
      { actor: ACTOR, worktreeId: WORKTREE_ID, skillId: SKILL_ID },
      observationFromDisk()
    );

    expect(() =>
      consumeSkillUninstallPlan(
        record.token,
        { actor: ACTOR, worktreeId: WORKTREE_ID, skillId: SKILL_ID },
        observationFromDisk()
      )
    ).toThrowError(/SKILL_PLAN_CONSUMED/);
  });

  it('refuses a token presented by a different channel', () => {
    install();
    const record = plan();

    expect(() =>
      consumeSkillUninstallPlan(
        record.token,
        { actor: { type: 'cli', id: null }, worktreeId: WORKTREE_ID, skillId: SKILL_ID },
        observationFromDisk()
      )
    ).toThrowError(/SKILL_PLAN_BINDING_MISMATCH/);
  });

  it('refuses a token bound to another worktree', () => {
    install();
    const record = plan();

    expect(() =>
      consumeSkillUninstallPlan(
        record.token,
        { actor: ACTOR, worktreeId: 'wt-other', skillId: SKILL_ID },
        observationFromDisk()
      )
    ).toThrowError(/SKILL_PLAN_BINDING_MISMATCH/);
  });

  it('expires a token rather than letting a stale preview be applied', () => {
    install();
    const record = plan();

    expect(() =>
      getSkillUninstallPlan(record.token, { now: record.expiresAt + 1 })
    ).toThrowError(/SKILL_PLAN_EXPIRED/);
  });

  it('refuses once a file under the install root has changed', () => {
    install();
    const record = plan();
    overwrite('reference/notes.md', '# Notes\n\nedited after planning\n');

    expect(() =>
      consumeSkillUninstallPlan(
        record.token,
        { actor: ACTOR, worktreeId: WORKTREE_ID, skillId: SKILL_ID },
        observationFromDisk()
      )
    ).toThrowError(/SKILL_PLAN_STALE/);
  });

  it('refuses once the branch has moved', () => {
    install();
    const record = plan();

    expect(() =>
      consumeSkillUninstallPlan(
        record.token,
        { actor: ACTOR, worktreeId: WORKTREE_ID, skillId: SKILL_ID },
        { ...observationFromDisk(), branch: 'main' }
      )
    ).toThrowError(/SKILL_PLAN_STALE/);
  });

  it('refuses a plan that was never removable in the first place', () => {
    install();
    writeFileSync(path.join(installRoot(), 'my-notes.md'), 'keep me\n');
    const record = plan();

    expect(() =>
      consumeSkillUninstallPlan(
        record.token,
        { actor: ACTOR, worktreeId: WORKTREE_ID, skillId: SKILL_ID },
        observationFromDisk()
      )
    ).toThrowError(/SKILL_PLAN_NOT_INSTALLABLE/);
  });
});
