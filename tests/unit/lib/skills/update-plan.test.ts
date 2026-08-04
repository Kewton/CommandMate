/**
 * Issue #1243: the Update Plan — 3-way inventory, local-change guard, security
 * diff and the drift-refusing token contract.
 *
 * The installs under test are produced by #1235's real apply, not hand-built,
 * so a drift between what install writes and what the update plan recognises
 * surfaces here rather than in a user's worktree. Each guard case plants
 * exactly one anomaly in an otherwise perfect install and asserts the whole
 * plan goes non-updatable (`LOCAL_CHANGES` fail-closed rule) — never that
 * "most of it" could still be updated.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { applySkillInstall } from '@/lib/skills/install-apply';
import {
  SKILL_RECEIPT_FILENAME,
  SkillPlanErrorCode,
  buildSkillInstallReceipt,
  isSkillPlanError,
  serializeSkillInstallReceipt,
} from '@/lib/skills/install-plan';
import { computeSkillTreeHash, readExistingSkillTree } from '@/lib/skills/preview-diff';
import { inspectSkillPackage } from '@/lib/skills/package-validator';
import type { SkillPackageSnapshot } from '@/lib/skills/package-validator';
import { evaluateCommandMateCompatibility } from '@/lib/skills/compatibility';
import { SkillUpdateRecommendationReason } from '@/lib/skills/version-resolver';
import { readSkillReceiptDigest, SkillUninstallReason } from '@/lib/skills/uninstall-plan';
import {
  SkillUpdateBlockedReason,
  consumeSkillUpdatePlan,
  createSkillUpdatePlan,
  getSkillUpdatePlan,
  getSkillUpdatePlanCount,
  readInstalledSkillReceipt,
  resetSkillUpdatePlanCacheForTesting,
  type CreateSkillUpdatePlanInput,
  type SkillUpdateObservation,
} from '@/lib/skills/update-plan';
import { buildPackage } from '../../../fixtures/skills/malicious-packages/package';
import type { PackageFileSpec } from '../../../fixtures/skills/malicious-packages/package';
import { makeCatalogVersion } from './fixtures';
import type { SkillGitTargetState } from '@/lib/skills/preview-diff';
import type { SkillPlanActor } from '@/lib/skills/install-plan';
import type { SkillCatalogEntry, SkillCatalogVersion } from '@/types/skills';
import { removeTempDir } from '@tests/helpers/temp-dir';

const SKILL_ID = 'demo-skill';
const FROM_VERSION = '1.2.3';
const TO_VERSION = '1.3.0';
const WORKTREE_ID = 'wt-1';
const OPERATION_ID = '9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f';
const ACTOR: SkillPlanActor = { type: 'user', id: null };
const HOST = '0.11.4';

const GIT: SkillGitTargetState = {
  headState: 'attached',
  branch: 'feature/demo',
  headCommit: 'f'.repeat(40),
  dirty: false,
};

/** v1.2.3 payload as installed. */
const INSTALLED_FILES: PackageFileSpec[] = [
  { path: 'reference/notes.md', content: '# Notes\n\nBackground reading.\n' },
  { path: 'assets/logo.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"/>\n' },
];

/**
 * v1.3.0 payload: one file changed, one removed, one added, SKILL.md untouched
 * — every branch of the version diff in a single candidate. Deliberately free
 * of scripts and executables so the baseline stays low-risk; the risk cases
 * add those explicitly.
 */
const CANDIDATE_FILES: PackageFileSpec[] = [
  { path: 'reference/notes.md', content: '# Notes\n\nRewritten background reading.\n' },
  { path: 'docs/extra.md', content: '# Extra\n\nNew supplementary reading.\n' },
];

/** A candidate that additionally ships an executable helper script. */
const SCRIPT_CANDIDATE_FILES: PackageFileSpec[] = [
  ...CANDIDATE_FILES,
  { path: 'scripts/run.sh', content: '#!/bin/sh\necho run\n', mode: 0o755 },
];

let worktree: string;

function installRoot(): string {
  return path.join(worktree, '.agents', 'skills', SKILL_ID);
}

/** Install v1.2.3 the way #1235 does, so the receipt is genuine. */
function install(): SkillPackageSnapshot {
  const built = buildPackage({ files: INSTALLED_FILES });
  const snapshot = inspectSkillPackage(built.bytes, { skillId: SKILL_ID, version: FROM_VERSION });
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

interface CandidateOptions {
  files?: PackageFileSpec[];
  declaredRisk?: 'low' | 'moderate' | 'high';
  permissions?: string[];
}

function candidateSnapshot(options: CandidateOptions = {}): SkillPackageSnapshot {
  const built = buildPackage({
    version: TO_VERSION,
    files: options.files ?? CANDIDATE_FILES,
    manifestPatch: (manifest) => {
      if (options.declaredRisk) manifest.declared_risk = options.declaredRisk;
      if (options.permissions) {
        manifest.declared_permissions =
          options.permissions as typeof manifest.declared_permissions;
      }
    },
  });
  return inspectSkillPackage(built.bytes, { skillId: SKILL_ID, version: TO_VERSION });
}

function candidateVersion(overrides: Partial<SkillCatalogVersion> = {}): SkillCatalogVersion {
  return makeCatalogVersion({
    version: TO_VERSION,
    changelog: 'Adds a helper script and rewrites the notes.',
    ...overrides,
  });
}

function catalogEntry(versions: SkillCatalogVersion[]): SkillCatalogEntry {
  return {
    id: SKILL_ID,
    name: 'Demo Skill',
    summary: 'A demo Skill.',
    provider: { name: 'CommandMate' },
    license: 'MIT',
    latest: TO_VERSION,
    versions,
  };
}

function plan(overrides: Partial<CreateSkillUpdatePlanInput> = {}) {
  const version = overrides.version ?? candidateVersion();
  return createSkillUpdatePlan({
    actor: ACTOR,
    worktree: {
      id: WORKTREE_ID,
      name: 'demo-worktree',
      path: worktree,
      repositoryName: 'CommandMate',
    },
    skillId: SKILL_ID,
    fromVersion: FROM_VERSION,
    snapshot: overrides.snapshot ?? candidateSnapshot(),
    version,
    snapshotId: 'snap-test',
    compatibility: evaluateCommandMateCompatibility('>=0.11.0', HOST),
    catalogEntry: catalogEntry([makeCatalogVersion(), version]),
    latestVersion: TO_VERSION,
    reasonCode: SkillUpdateRecommendationReason.HIGHEST_COMPATIBLE,
    prerelease: false,
    git: GIT,
    ...overrides,
  });
}

function observationFromDisk(): SkillUpdateObservation {
  const existing = readExistingSkillTree(installRoot());
  return {
    branch: GIT.branch,
    headCommit: GIT.headCommit,
    currentTreeHash: computeSkillTreeHash(existing.files),
    receiptDigest: readSkillReceiptDigest(existing),
  };
}

function planErrorCode(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    if (isSkillPlanError(error)) return error.code;
    throw error;
  }
}

beforeEach(() => {
  worktree = mkdtempSync(path.join(tmpdir(), 'skill-update-plan-'));
  resetSkillUpdatePlanCacheForTesting();
});

afterEach(() => {
  resetSkillUpdatePlanCacheForTesting();
  removeTempDir(worktree);
});

describe('readInstalledSkillReceipt', () => {
  it('reads the version off the on-disk receipt', () => {
    install();
    const read = readInstalledSkillReceipt(worktree, SKILL_ID, '.agents/skills');
    expect(read.state).toBe('ok');
    if (read.state === 'ok') {
      expect(read.receipt.version).toBe(FROM_VERSION);
      expect(read.receiptDigest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('distinguishes not-installed from a broken receipt', () => {
    expect(readInstalledSkillReceipt(worktree, SKILL_ID, '.agents/skills').state).toBe(
      'not_installed'
    );

    install();
    writeFileSync(path.join(installRoot(), SKILL_RECEIPT_FILENAME), 'not json');
    expect(readInstalledSkillReceipt(worktree, SKILL_ID, '.agents/skills').state).toBe(
      'receipt_unreadable'
    );
  });
});

describe('createSkillUpdatePlan — version diff', () => {
  it('classifies add/update/remove/unchanged against the receipt, receipt included', () => {
    install();
    const record = plan();
    const dto = record.dto;

    expect(dto.updatable).toBe(true);
    expect(dto.blockers).toEqual([]);
    expect(dto.update).toMatchObject({ fromVersion: FROM_VERSION, toVersion: TO_VERSION });

    const byPath = new Map(dto.files.map((entry) => [entry.relativePath, entry]));
    expect(byPath.get('reference/notes.md')?.change).toBe('update');
    expect(byPath.get('assets/logo.svg')?.change).toBe('remove');
    expect(byPath.get('docs/extra.md')?.change).toBe('add');
    expect(byPath.get('SKILL.md')?.change).toBe('unchanged');
    // The generated receipt changes version, so it is part of the previewed diff.
    expect(byPath.get(SKILL_RECEIPT_FILENAME)?.change).toBe('update');
    expect(byPath.get(SKILL_RECEIPT_FILENAME)?.generated).toBe(true);

    // The changed file diffs from the bytes actually on disk (which match the
    // receipt) to the candidate's bytes.
    const notes = byPath.get('reference/notes.md');
    expect(notes?.localState).toBe('match');
    expect(notes?.diff).toContain('-Background reading.');
    expect(notes?.diff).toContain('+Rewritten background reading.');

    expect(dto.stats).toMatchObject({ added: 1, removed: 1 });
    expect(dto.stats.updated).toBeGreaterThanOrEqual(2); // notes + manifest + receipt
    expect(dto.stats.localModified + dto.stats.localMissing + dto.stats.localUnknown).toBe(0);
  });

  it('pins the binding to the exact candidate artifact and the current tree', () => {
    install();
    const record = plan();

    expect(record.binding).toMatchObject({
      operation: 'update',
      skillId: SKILL_ID,
      fromVersion: FROM_VERSION,
      toVersion: TO_VERSION,
      artifactSha256: candidateVersion().artifact.sha256,
    });
    expect(record.binding.currentReceiptDigest).toMatch(/^[0-9a-f]{64}$/);
    // The planned tree is exactly the candidate inventory plus its receipt.
    expect(record.binding.plannedTreeHash).toBe(
      computeSkillTreeHash([
        ...record.receipt.files.map((file) => ({
          path: file.path,
          sha256: file.sha256,
          executable: file.executable,
        })),
        {
          path: SKILL_RECEIPT_FILENAME,
          sha256: createHash('sha256').update(record.receiptBytes).digest('hex'),
          executable: false,
        },
      ])
    );
  });

  it('collects the changelogs of every version in (installed, candidate]', () => {
    install();
    const record = plan();
    expect(record.dto.securityDiff.changelogs).toEqual([
      { version: TO_VERSION, changelog: 'Adds a helper script and rewrites the notes.' },
    ]);
  });

  it('reports permission differences without inventing a risk change', () => {
    install();
    const record = plan({
      snapshot: candidateSnapshot({ permissions: ['filesystem_read', 'network_access'] }),
    });
    const diff = record.dto.securityDiff;

    expect(diff.permissions.added).toEqual(['network_access']);
    expect(diff.permissions.removed).toEqual([]);
    expect(diff.permissions.unchanged).toEqual(['filesystem_read']);
    expect(diff.risk.increased).toBe(false);
    expect(record.dto.riskIncreased).toBe(false);
  });

  it('reports new scripts and executables, and the risk rise they compute to', () => {
    install();
    const record = plan({ snapshot: candidateSnapshot({ files: SCRIPT_CANDIDATE_FILES }) });
    const diff = record.dto.securityDiff;

    expect(diff.scripts.added).toContain('scripts/run.sh');
    expect(diff.executables.added).toContain('scripts/run.sh');
    // An executable payload computes to high risk (#1230), so the update is a
    // risk increase over the script-free install — flagged, not smoothed over.
    expect(diff.risk.to.effective).toBe('high');
    expect(record.dto.riskIncreased).toBe(true);
    expect(record.dto.requiresRiskAcknowledgement).toBe(true);
  });

  it('flags a risk increase and demands both acknowledgements at consume time', () => {
    install();
    const record = plan({ snapshot: candidateSnapshot({ declaredRisk: 'high' }) });

    expect(record.dto.securityDiff.risk.from.effective).toBe('low');
    expect(record.dto.securityDiff.risk.to.effective).toBe('high');
    expect(record.dto.riskIncreased).toBe(true);
    expect(record.dto.riskIncreaseMessageKey).toBe('skills.update.riskIncreaseAcknowledgement');
    expect(record.dto.requiresRiskAcknowledgement).toBe(true);

    const expected = {
      actor: ACTOR,
      worktreeId: WORKTREE_ID,
      skillId: SKILL_ID,
      toVersion: TO_VERSION,
    };
    expect(
      planErrorCode(() =>
        consumeSkillUpdatePlan(
          record.token,
          { ...expected, riskAcknowledged: false, riskIncreaseAcknowledged: false },
          observationFromDisk()
        )
      )
    ).toBe(SkillPlanErrorCode.RISK_NOT_ACKNOWLEDGED);
    // The high-risk acknowledgement alone does not carry the risk *increase*.
    expect(
      planErrorCode(() =>
        consumeSkillUpdatePlan(
          record.token,
          { ...expected, riskAcknowledged: true, riskIncreaseAcknowledged: false },
          observationFromDisk()
        )
      )
    ).toBe(SkillPlanErrorCode.RISK_NOT_ACKNOWLEDGED);

    const consumed = consumeSkillUpdatePlan(
      record.token,
      { ...expected, riskAcknowledged: true, riskIncreaseAcknowledged: true },
      observationFromDisk()
    );
    expect(consumed.consumedAt).not.toBeNull();
  });
});

describe('createSkillUpdatePlan — local change guard (fail closed)', () => {
  it('refuses when nothing is installed', () => {
    expect(planErrorCode(() => plan())).toBe(SkillPlanErrorCode.NOT_FOUND);
  });

  it('answers STALE when the receipt no longer matches the version the route read', () => {
    install();
    expect(planErrorCode(() => plan({ fromVersion: '9.9.9' }))).toBe(SkillPlanErrorCode.STALE);
  });

  it('blocks on a locally modified file', () => {
    install();
    writeFileSync(path.join(installRoot(), 'reference', 'notes.md'), 'edited by hand\n');

    const dto = plan().dto;
    expect(dto.updatable).toBe(false);
    const found = dto.blockers.find((entry) => entry.path?.endsWith('reference/notes.md'));
    expect(found?.code).toBe(SkillUpdateBlockedReason.LOCAL_CHANGES);
    expect(found?.detail).toBe(SkillUninstallReason.LOCAL_MODIFICATION);
    expect(dto.nextActionKey).toBe('skills.update.nextAction.blocked');
    // The recorded bytes are gone, so no diff body is invented for this file.
    const entry = dto.files.find((file) => file.relativePath === 'reference/notes.md');
    expect(entry?.localState).toBe('modified');
    expect(entry?.diff).toBeNull();
  });

  it('blocks on an unrecorded file inside the install root', () => {
    install();
    writeFileSync(path.join(installRoot(), 'my-note.txt'), 'user file\n');

    const dto = plan().dto;
    expect(dto.updatable).toBe(false);
    const found = dto.blockers.find((entry) => entry.path?.endsWith('my-note.txt'));
    expect(found?.code).toBe(SkillUpdateBlockedReason.LOCAL_CHANGES);
    expect(found?.detail).toBe(SkillUninstallReason.UNMANAGED_FILE);
    expect(dto.stats.localUnknown).toBe(1);
  });

  it('blocks on a recorded file that is missing from disk', () => {
    install();
    rmSync(path.join(installRoot(), 'assets', 'logo.svg'));

    const dto = plan().dto;
    expect(dto.updatable).toBe(false);
    const found = dto.blockers.find((entry) => entry.path?.endsWith('assets/logo.svg'));
    expect(found?.code).toBe(SkillUpdateBlockedReason.LOCAL_CHANGES);
    expect(found?.detail).toBe(SkillUninstallReason.RECEIPT_ORPHAN);
  });

  it('blocks on a symlink without following it', () => {
    install();
    symlinkSync('/etc/hosts', path.join(installRoot(), 'planted-link'));

    const dto = plan().dto;
    expect(dto.updatable).toBe(false);
    const found = dto.blockers.find((entry) => entry.path?.endsWith('planted-link'));
    expect(found?.code).toBe(SkillUpdateBlockedReason.LOCAL_CHANGES);
    expect(found?.detail).toBe(SkillUninstallReason.NOT_A_REGULAR_FILE);
  });

  it('blocks an incompatible candidate while still showing the plan', () => {
    install();
    const record = plan({
      compatibility: evaluateCommandMateCompatibility('>=9.0.0', HOST),
    });
    expect(record.dto.updatable).toBe(false);
    expect(record.dto.blockers.map((entry) => entry.code)).toContain(
      SkillUpdateBlockedReason.INCOMPATIBLE
    );
    // A blocked plan is never spendable.
    expect(
      planErrorCode(() =>
        consumeSkillUpdatePlan(
          record.token,
          {
            actor: ACTOR,
            worktreeId: WORKTREE_ID,
            skillId: SKILL_ID,
            toVersion: TO_VERSION,
            riskAcknowledged: true,
            riskIncreaseAcknowledged: true,
          },
          observationFromDisk()
        )
      )
    ).toBe(SkillPlanErrorCode.NOT_INSTALLABLE);
  });
});

describe('token contract', () => {
  const EXPECTED = {
    actor: ACTOR,
    worktreeId: WORKTREE_ID,
    skillId: SKILL_ID,
    toVersion: TO_VERSION,
    riskAcknowledged: false,
    riskIncreaseAcknowledged: false,
  };

  it('spends a token exactly once', () => {
    install();
    const record = plan();

    const first = consumeSkillUpdatePlan(record.token, EXPECTED, observationFromDisk());
    expect(first.consumedAt).not.toBeNull();
    expect(
      planErrorCode(() => consumeSkillUpdatePlan(record.token, EXPECTED, observationFromDisk()))
    ).toBe(SkillPlanErrorCode.CONSUMED);
  });

  it('refuses a token presented for another target before saying anything else', () => {
    install();
    const record = plan();
    expect(
      planErrorCode(() =>
        consumeSkillUpdatePlan(
          record.token,
          { ...EXPECTED, worktreeId: 'wt-2' },
          observationFromDisk()
        )
      )
    ).toBe(SkillPlanErrorCode.BINDING_MISMATCH);
    expect(
      planErrorCode(() =>
        consumeSkillUpdatePlan(
          record.token,
          { ...EXPECTED, toVersion: '9.9.9' },
          observationFromDisk()
        )
      )
    ).toBe(SkillPlanErrorCode.BINDING_MISMATCH);
  });

  it('answers STALE when the filesystem changed after the plan', () => {
    install();
    const record = plan();
    writeFileSync(path.join(installRoot(), 'reference', 'notes.md'), 'changed after plan\n');

    expect(
      planErrorCode(() => consumeSkillUpdatePlan(record.token, EXPECTED, observationFromDisk()))
    ).toBe(SkillPlanErrorCode.STALE);
  });

  it('answers STALE when branch or HEAD moved after the plan', () => {
    install();
    const record = plan();
    const observation = observationFromDisk();

    expect(
      planErrorCode(() =>
        consumeSkillUpdatePlan(record.token, EXPECTED, { ...observation, branch: 'main' })
      )
    ).toBe(SkillPlanErrorCode.STALE);
    expect(
      planErrorCode(() =>
        consumeSkillUpdatePlan(record.token, EXPECTED, {
          ...observation,
          headCommit: 'a'.repeat(40),
        })
      )
    ).toBe(SkillPlanErrorCode.STALE);
    expect(
      planErrorCode(() =>
        consumeSkillUpdatePlan(record.token, EXPECTED, { ...observation, receiptDigest: null })
      )
    ).toBe(SkillPlanErrorCode.STALE);
  });

  it('expires on the #1233 TTL', () => {
    install();
    const now = 1_700_000_000_000;
    const record = plan({ now });
    expect(getSkillUpdatePlanCount()).toBe(1);

    expect(
      planErrorCode(() =>
        consumeSkillUpdatePlan(record.token, EXPECTED, observationFromDisk(), {
          now: now + 11 * 60 * 1000,
        })
      )
    ).toBe(SkillPlanErrorCode.EXPIRED);
    expect(planErrorCode(() => getSkillUpdatePlan(record.token))).toBe(
      SkillPlanErrorCode.NOT_FOUND
    );
  });
});
