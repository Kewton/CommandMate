/**
 * Install Plan (Issue #1233)
 *
 * Two properties carry the weight here. First, the receipt is fixed at plan
 * time and previewed like any other write — a receipt that only appeared during
 * apply would be a file the user approved without seeing. Second, the token is
 * a single-use handle bound to one actor, target, version and tree: replaying
 * it, pointing it elsewhere, or spending it after the branch moved must all
 * fail, and each with its own reason.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';

vi.mock('@/lib/git/git-exec', () => ({
  execGitCommand: vi.fn(),
  execFileAsync: vi.fn(),
}));

vi.mock('@/lib/skills/snapshot-store', () => ({ releaseSkillSnapshot: vi.fn() }));

import {
  SKILL_PLAN_TTL_MS,
  SKILL_RECEIPT_FILENAME,
  SkillPlanErrorCode,
  assertSkillPlanCurrent,
  buildSkillInstallReceipt,
  computeSkillPlanBindingHash,
  consumeSkillInstallPlan,
  createSkillInstallPlan,
  discardSkillInstallPlan,
  getSkillInstallPlan,
  isSkillPlanError,
  parseInstalledReceipt,
  resetSkillInstallPlanCacheForTesting,
  serializeSkillInstallReceipt,
  sweepSkillInstallPlans,
  type CreateSkillInstallPlanInput,
  type SkillPlanActor,
} from '@/lib/skills/install-plan';
import { validateSkillInstallReceipt } from '@/lib/skills/schema';
import { computeSkillTreeHash } from '@/lib/skills/preview-diff';
import { execFileAsync, execGitCommand } from '@/lib/git/git-exec';
import { releaseSkillSnapshot } from '@/lib/skills/snapshot-store';
import type { SkillPackageSnapshot } from '@/lib/skills/package-validator';
import type { SkillCommandMateCompatibility } from '@/lib/skills/compatibility';
import type { SkillManifest } from '@/types/skills';
import { makeCatalogVersion } from './fixtures';

const execGitCommandMock = vi.mocked(execGitCommand);
const execFileAsyncMock = vi.mocked(execFileAsync) as unknown as ReturnType<typeof vi.fn>;
const releaseSkillSnapshotMock = vi.mocked(releaseSkillSnapshot);

const SKILL_ID = 'demo-skill';
const VERSION = '1.2.3';
const HEAD = 'f'.repeat(40);
const SNAPSHOT_ID = '0'.repeat(32);

const COMPATIBLE: SkillCommandMateCompatibility = {
  status: 'compatible',
  requiredRange: '>=0.11.0',
  currentVersion: '0.11.4',
  reasonCode: 'SKILL_COMPAT_SATISFIED',
  messageKey: 'skills.compatibility.reason.satisfied',
  message: 'CommandMate 0.11.4 satisfies >=0.11.0.',
};

const INCOMPATIBLE: SkillCommandMateCompatibility = {
  status: 'incompatible',
  requiredRange: '>=9.0.0',
  currentVersion: '0.11.4',
  reasonCode: 'SKILL_COMPAT_HOST_VERSION_OUT_OF_RANGE',
  messageKey: 'skills.compatibility.reason.hostVersionOutOfRange',
  message: 'This Skill requires CommandMate >=9.0.0, but 0.11.4 is running.',
};

function digest(value: Uint8Array | string): string {
  return createHash('sha256').update(Buffer.from(value as never)).digest('hex');
}

interface PackageFile {
  path: string;
  content: string;
  executable?: boolean;
  script?: boolean;
}

/**
 * A package snapshot with the shape `validateSkillPackage` produces. Built by
 * hand so a plan test does not have to construct a real tar.gz for every case.
 */
function makeSnapshot(
  files: PackageFile[] = [{ path: 'SKILL.md', content: '# demo\n' }],
  overrides: Partial<SkillPackageSnapshot> = {}
): SkillPackageSnapshot {
  const bytesByPath = new Map(
    files.map((file) => [file.path, Buffer.from(file.content, 'utf-8')])
  );
  const manifest: SkillManifest = {
    schema_version: 1,
    id: SKILL_ID,
    name: SKILL_ID,
    version: VERSION,
    summary: 'Draft release notes.',
    description: 'A demo Skill used by the install plan tests.',
    capabilities: ['Draft release notes from merged pull requests.'],
    expected_outcomes: ['A reviewable draft in under a minute.'],
    provider: { name: 'CommandMate', url: 'https://example.invalid' },
    license: 'MIT',
    compatibility: { commandmate: '>=0.11.0', agents: [] },
    requirements: { commands: [{ name: 'gh', version_range: '>=2.0.0' }], network_hosts: [] },
    declared_permissions: ['filesystem_read'],
    declared_risk: 'low',
    risk_rationale: 'Reads the repository only.',
    files: files.map((file) => ({
      path: file.path,
      sha256: digest(bytesByPath.get(file.path)!),
      size: bytesByPath.get(file.path)!.byteLength,
      kind: file.path === 'SKILL.md' ? 'skill_md' : file.script ? 'script' : 'asset',
      executable: file.executable === true,
      script: file.script === true,
    })),
  };

  return {
    skillId: SKILL_ID,
    version: VERSION,
    manifest,
    files: manifest.files
      .map((file) => ({
        path: file.path,
        sha256: file.sha256,
        size: file.size,
        executable: file.executable,
      }))
      .sort((a, b) => (a.path < b.path ? -1 : 1)),
    directories: [],
    inspection: {
      executable_paths: files.filter((f) => f.executable).map((f) => f.path),
      script_paths: files.filter((f) => f.script).map((f) => f.path),
      network_hosts: [],
      declared_permissions: ['filesystem_read'],
    },
    declaredRisk: 'low',
    computedRisk: 'low',
    effectiveRisk: 'low',
    readFile: (filePath: string) => {
      const bytes = bytesByPath.get(filePath);
      if (!bytes) throw new Error(`unknown file ${filePath}`);
      return new Uint8Array(bytes);
    },
    ...overrides,
  };
}

let worktreeDir: string;

function makeInput(overrides: Partial<CreateSkillInstallPlanInput> = {}): CreateSkillInstallPlanInput {
  return {
    actor: { type: 'user', id: null },
    worktree: {
      id: 'demo-wt',
      name: 'feature/demo',
      path: worktreeDir,
      repositoryName: 'CommandMate',
      syncedBranch: 'feature/demo',
    },
    snapshot: makeSnapshot(),
    version: makeCatalogVersion({ version: VERSION }),
    snapshotId: SNAPSHOT_ID,
    compatibility: COMPATIBLE,
    ...overrides,
  };
}

function installRootDir(): string {
  return path.join(worktreeDir, '.agents/skills', SKILL_ID);
}

beforeEach(() => {
  worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-plan-'));
  resetSkillInstallPlanCacheForTesting();
  execGitCommandMock.mockReset();
  execFileAsyncMock.mockReset();
  releaseSkillSnapshotMock.mockReset();
  execGitCommandMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'symbolic-ref') return 'feature/demo';
    if (args[0] === 'rev-parse') return HEAD;
    if (args[0] === 'status') return '';
    return null;
  });
  execFileAsyncMock.mockRejectedValue(Object.assign(new Error('exit 1'), { stdout: '' }));
});

afterEach(() => {
  fs.rmSync(worktreeDir, { recursive: true, force: true });
});

describe('receipt', () => {
  it('produces a document the contract validator accepts', () => {
    const receipt = buildSkillInstallReceipt({
      snapshot: makeSnapshot(),
      version: makeCatalogVersion({ version: VERSION }),
    });
    const result = validateSkillInstallReceipt(receipt);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('is byte-identical for identical inputs', () => {
    const version = makeCatalogVersion({ version: VERSION });
    const a = serializeSkillInstallReceipt(
      buildSkillInstallReceipt({ snapshot: makeSnapshot(), version })
    );
    const b = serializeSkillInstallReceipt(
      buildSkillInstallReceipt({ snapshot: makeSnapshot(), version })
    );
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('carries no timestamp, actor, absolute path or artifact URL', () => {
    const text = Buffer.from(
      serializeSkillInstallReceipt(
        buildSkillInstallReceipt({
          snapshot: makeSnapshot(),
          version: makeCatalogVersion({ version: VERSION }),
        })
      )
    ).toString('utf-8');

    expect(text).not.toContain('https://');
    expect(text).not.toContain(os.tmpdir());
    expect(text).not.toMatch(/"(?:installed_at|timestamp|actor|url)"/);
    expect(JSON.parse(text).install_root).toBe(`.agents/skills/${SKILL_ID}`);
  });

  it('records the effective risk alongside both inputs', () => {
    const receipt = buildSkillInstallReceipt({
      snapshot: makeSnapshot([{ path: 'SKILL.md', content: '# x\n' }], {
        declaredRisk: 'low',
        computedRisk: 'high',
        effectiveRisk: 'high',
      }),
      version: makeCatalogVersion({ version: VERSION }),
    });
    expect(receipt).toMatchObject({
      declared_risk: 'low',
      computed_risk: 'high',
      effective_risk: 'high',
    });
  });

  it('round-trips through parseInstalledReceipt and rejects junk', () => {
    const receipt = buildSkillInstallReceipt({
      snapshot: makeSnapshot(),
      version: makeCatalogVersion({ version: VERSION }),
    });
    const parsed = parseInstalledReceipt(serializeSkillInstallReceipt(receipt));
    expect(parsed?.skill_id).toBe(SKILL_ID);
    expect(parseInstalledReceipt(Buffer.from('not json'))).toBeNull();
    expect(parseInstalledReceipt(Buffer.from('{"skill_id":1}'))).toBeNull();
  });
});

describe('createSkillInstallPlan', () => {
  it('pins the target, branch, HEAD, artifact digest and expiry', async () => {
    const now = 1_800_000_000_000;
    const record = await createSkillInstallPlan(makeInput({ now }));

    expect(record.binding).toMatchObject({
      operation: 'install',
      worktreeId: 'demo-wt',
      skillId: SKILL_ID,
      version: VERSION,
      branch: 'feature/demo',
      headCommit: HEAD,
      snapshotId: SNAPSHOT_ID,
    });
    expect(record.expiresAt).toBe(now + SKILL_PLAN_TTL_MS);
    expect(record.dto.expiresAt).toBe('2027-01-15T08:10:00Z');
    expect(record.dto.target).toMatchObject({
      branch: 'feature/demo',
      headState: 'attached',
      headCommit: HEAD,
      installRoot: `.agents/skills/${SKILL_ID}`,
    });
    expect(record.binding.currentTreeHash).toBe(computeSkillTreeHash([]));
  });

  it('issues an opaque token that carries no secret or path', async () => {
    const record = await createSkillInstallPlan(makeInput());
    expect(record.token).toMatch(/^[0-9a-f]{48}$/);
    expect(record.token).not.toContain(SKILL_ID);
    expect(JSON.stringify(record.dto)).not.toContain(worktreeDir);
  });

  it('includes the generated receipt in the inventory, the diff and the planned tree', async () => {
    const record = await createSkillInstallPlan(makeInput());
    const receiptPath = `.agents/skills/${SKILL_ID}/${SKILL_RECEIPT_FILENAME}`;

    const entry = record.dto.files.find((file) => file.path === receiptPath);
    expect(entry).toMatchObject({ change: 'add', generated: true });
    expect(entry?.sha256).toBe(record.dto.receipt.sha256);
    expect(record.dto.receipt.path).toBe(receiptPath);
    expect(record.dto.receipt.sha256).toBe(digest(record.receiptBytes));

    expect(record.dto.target.plannedTreeHash).toBe(
      computeSkillTreeHash([
        { path: 'SKILL.md', sha256: digest('# demo\n'), executable: false },
        {
          path: SKILL_RECEIPT_FILENAME,
          sha256: record.dto.receipt.sha256,
          executable: false,
        },
      ])
    );
  });

  it('shows every artifact file in the diff', async () => {
    const snapshot = makeSnapshot([
      { path: 'SKILL.md', content: '# demo\n' },
      { path: 'commandmate.skill.yaml', content: 'id: demo-skill\n' },
      { path: 'scripts/run.sh', content: '#!/bin/sh\necho hi\n', executable: true, script: true },
    ]);
    const record = await createSkillInstallPlan(makeInput({ snapshot }));

    expect(record.dto.files.map((file) => file.path).sort()).toEqual([
      `.agents/skills/${SKILL_ID}/${SKILL_RECEIPT_FILENAME}`,
      `.agents/skills/${SKILL_ID}/SKILL.md`,
      `.agents/skills/${SKILL_ID}/commandmate.skill.yaml`,
      `.agents/skills/${SKILL_ID}/scripts/run.sh`,
    ]);
    expect(record.dto.installable).toBe(true);
  });

  it('serves the manifest facts the Catalog cannot supply', async () => {
    const snapshot = makeSnapshot([
      { path: 'SKILL.md', content: '# demo\n' },
      { path: 'run.sh', content: '#!/bin/sh\n', executable: true, script: true },
    ]);
    const record = await createSkillInstallPlan(makeInput({ snapshot }));

    expect(record.dto.skill).toMatchObject({
      capabilities: ['Draft release notes from merged pull requests.'],
      expectedOutcomes: ['A reviewable draft in under a minute.'],
      declaredPermissions: ['filesystem_read'],
      riskRationale: 'Reads the repository only.',
      executablePaths: ['run.sh'],
      scriptPaths: ['run.sh'],
    });
    expect(record.dto.skill.requirements.commands).toEqual([
      { name: 'gh', versionRange: '>=2.0.0' },
    ]);
    expect(record.dto.skill.artifact).not.toHaveProperty('url');
    expect(JSON.stringify(record.dto.skill)).not.toContain('https://github.com');
  });

  it('refuses to call a plan installable when an unmanaged file is in the way', async () => {
    fs.mkdirSync(installRootDir(), { recursive: true });
    fs.writeFileSync(path.join(installRootDir(), 'SKILL.md'), 'hand written\n');

    const record = await createSkillInstallPlan(makeInput());
    expect(record.dto.installable).toBe(false);
    expect(record.dto.blockers).toContainEqual({
      code: 'SKILL_DIFF_UNMANAGED_SKILL',
      path: `.agents/skills/${SKILL_ID}/SKILL.md`,
    });
  });

  it('treats the previous receipt as managed so a re-install is not self-blocking', async () => {
    const previous = buildSkillInstallReceipt({
      snapshot: makeSnapshot(),
      version: makeCatalogVersion({ version: VERSION }),
    });
    fs.mkdirSync(installRootDir(), { recursive: true });
    fs.writeFileSync(path.join(installRootDir(), 'SKILL.md'), '# demo\n');
    fs.writeFileSync(
      path.join(installRootDir(), SKILL_RECEIPT_FILENAME),
      Buffer.from(serializeSkillInstallReceipt(previous))
    );

    const record = await createSkillInstallPlan(makeInput());
    expect(record.dto.installable).toBe(true);
    expect(record.dto.target.existingInstall?.version).toBe(VERSION);
    expect(
      record.dto.files.find((file) => file.path.endsWith('SKILL.md'))?.change
    ).toBe('unchanged');
  });

  it('reports an incompatible Skill as a blocker rather than refusing to explain', async () => {
    const record = await createSkillInstallPlan(makeInput({ compatibility: INCOMPATIBLE }));
    expect(record.dto.installable).toBe(false);
    expect(record.dto.blockers).toContainEqual({
      code: 'skills.compatibility.reason.hostVersionOutOfRange',
      path: null,
    });
    expect(record.dto.skill.compatibility.commandmate.status).toBe('incompatible');
  });

  it('requires an explicit acknowledgement for a high effective risk', async () => {
    const snapshot = makeSnapshot([{ path: 'run.sh', content: '#!/bin/sh\n', executable: true }], {
      computedRisk: 'high',
      effectiveRisk: 'high',
    });
    const record = await createSkillInstallPlan(makeInput({ snapshot }));

    expect(record.dto.requiresRiskAcknowledgement).toBe(true);
    expect(record.dto.riskAcknowledged).toBe(false);
    expect(record.dto.riskAcknowledgementMessageKey).toBe('skills.plan.highRiskAcknowledgement');
  });

  it('leaves a low-risk plan without an acknowledgement prompt', async () => {
    const record = await createSkillInstallPlan(makeInput());
    expect(record.dto.requiresRiskAcknowledgement).toBe(false);
    expect(record.dto.riskAcknowledgementMessageKey).toBeNull();
  });

  it('records a detached HEAD without inventing a branch', async () => {
    execGitCommandMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse') return HEAD;
      if (args[0] === 'status') return '';
      return null;
    });
    const record = await createSkillInstallPlan(makeInput());
    expect(record.dto.target).toMatchObject({ headState: 'detached', branch: null });
    expect(record.dto.warnings).toContain('SKILL_PREVIEW_DETACHED_HEAD');
    expect(record.binding.branch).toBeNull();
  });

  it('records an unborn HEAD without inventing a commit', async () => {
    execGitCommandMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') return 'main';
      if (args[0] === 'status') return '';
      return null;
    });
    const record = await createSkillInstallPlan(makeInput());
    expect(record.dto.target).toMatchObject({ headState: 'unborn', headCommit: null });
    expect(record.dto.warnings).toContain('SKILL_PREVIEW_UNBORN_HEAD');
  });

  it('rejects a target that cannot be resolved inside the worktree', async () => {
    const snapshot = makeSnapshot();
    Object.defineProperty(snapshot, 'skillId', { value: '../escape' });
    await expect(createSkillInstallPlan(makeInput({ snapshot }))).rejects.toMatchObject({
      code: SkillPlanErrorCode.TARGET_UNSAFE,
    });
  });
});

describe('plan token lifecycle', () => {
  const actor: SkillPlanActor = { type: 'user', id: null };
  const expected = {
    actor,
    worktreeId: 'demo-wt',
    skillId: SKILL_ID,
    version: VERSION,
    riskAcknowledged: false,
  };

  function observed(record: Awaited<ReturnType<typeof createSkillInstallPlan>>) {
    return {
      branch: record.binding.branch,
      headCommit: record.binding.headCommit,
      currentTreeHash: record.binding.currentTreeHash,
    };
  }

  it('spends a token exactly once', async () => {
    const record = await createSkillInstallPlan(makeInput());
    expect(consumeSkillInstallPlan(record.token, expected, observed(record)).token).toBe(
      record.token
    );

    try {
      consumeSkillInstallPlan(record.token, expected, observed(record));
      expect.unreachable('replay must be rejected');
    } catch (error) {
      expect(isSkillPlanError(error) && error.code).toBe(SkillPlanErrorCode.CONSUMED);
      expect(isSkillPlanError(error) && error.status).toBe(409);
    }
  });

  it('rejects an unknown or malformed token as not found', async () => {
    for (const token of ['ff', 'z'.repeat(48), 'a'.repeat(48)]) {
      expect(() => getSkillInstallPlan(token)).toThrow(
        expect.objectContaining({ code: SkillPlanErrorCode.NOT_FOUND })
      );
    }
  });

  it('rejects an expired plan with its own reason', async () => {
    const now = 1_800_000_000_000;
    const record = await createSkillInstallPlan(makeInput({ now }));
    expect(() =>
      consumeSkillInstallPlan(record.token, expected, observed(record), {
        now: now + SKILL_PLAN_TTL_MS,
      })
    ).toThrow(expect.objectContaining({ code: SkillPlanErrorCode.EXPIRED }));
  });

  it.each([
    ['a different worktree', { worktreeId: 'other-wt' }],
    ['a different Skill', { skillId: 'other-skill' }],
    ['a different version', { version: '9.9.9' }],
    ['a different actor channel', { actor: { type: 'cli' as const, id: null } }],
  ])('refuses a token presented for %s', async (_label, override) => {
    const record = await createSkillInstallPlan(makeInput());
    expect(() =>
      consumeSkillInstallPlan(record.token, { ...expected, ...override }, observed(record))
    ).toThrow(expect.objectContaining({ code: SkillPlanErrorCode.BINDING_MISMATCH }));
  });

  it.each([
    ['the branch moved', { branch: 'other' }],
    ['HEAD advanced', { headCommit: 'e'.repeat(40) }],
    ['the destination tree changed', { currentTreeHash: 'deadbeef' }],
  ])('rejects a plan as stale when %s', async (_label, drift) => {
    const record = await createSkillInstallPlan(makeInput());
    expect(() =>
      consumeSkillInstallPlan(record.token, expected, { ...observed(record), ...drift })
    ).toThrow(expect.objectContaining({ code: SkillPlanErrorCode.STALE }));
  });

  it('maps every drift reason to 409 so apply answers PLAN_STALE consistently', async () => {
    const record = await createSkillInstallPlan(makeInput());
    try {
      assertSkillPlanCurrent(record, { ...observed(record), branch: 'moved' });
      expect.unreachable('drift must be rejected');
    } catch (error) {
      expect(isSkillPlanError(error) && error.code).toBe('SKILL_PLAN_STALE');
      expect(isSkillPlanError(error) && error.status).toBe(409);
    }
  });

  it('refuses to spend a token for a plan that is not installable', async () => {
    fs.mkdirSync(installRootDir(), { recursive: true });
    fs.writeFileSync(path.join(installRootDir(), 'SKILL.md'), 'hand written\n');
    const record = await createSkillInstallPlan(makeInput());

    expect(() => consumeSkillInstallPlan(record.token, expected, observed(record))).toThrow(
      expect.objectContaining({ code: SkillPlanErrorCode.NOT_INSTALLABLE })
    );
  });

  it('refuses to spend a high-risk token without an acknowledgement', async () => {
    const snapshot = makeSnapshot([{ path: 'run.sh', content: '#!/bin/sh\n', executable: true }], {
      computedRisk: 'high',
      effectiveRisk: 'high',
    });
    const record = await createSkillInstallPlan(makeInput({ snapshot }));

    expect(() => consumeSkillInstallPlan(record.token, expected, observed(record))).toThrow(
      expect.objectContaining({ code: SkillPlanErrorCode.RISK_NOT_ACKNOWLEDGED })
    );
    expect(
      consumeSkillInstallPlan(
        record.token,
        { ...expected, riskAcknowledged: true },
        observed(record)
      ).token
    ).toBe(record.token);
  });

  it('binds the hash to the target, so two plans for different worktrees differ', async () => {
    const a = await createSkillInstallPlan(makeInput());
    const b = await createSkillInstallPlan(
      makeInput({
        worktree: {
          id: 'other-wt',
          name: 'other',
          path: worktreeDir,
          repositoryName: 'CommandMate',
          syncedBranch: null,
        },
      })
    );
    expect(a.bindingHash).not.toBe(b.bindingHash);
    expect(computeSkillPlanBindingHash(a.binding)).toBe(a.bindingHash);
  });

  it('releases the artifact reference when an unconsumed plan is discarded', async () => {
    const record = await createSkillInstallPlan(makeInput());
    discardSkillInstallPlan(record.token);
    expect(releaseSkillSnapshotMock).toHaveBeenCalledWith(SNAPSHOT_ID);
    expect(() => getSkillInstallPlan(record.token)).toThrow(
      expect.objectContaining({ code: SkillPlanErrorCode.NOT_FOUND })
    );
  });

  it('keeps the artifact reference for a consumed plan, since apply now owns it', async () => {
    const record = await createSkillInstallPlan(makeInput());
    consumeSkillInstallPlan(record.token, expected, observed(record));
    discardSkillInstallPlan(record.token);
    expect(releaseSkillSnapshotMock).not.toHaveBeenCalled();
  });

  it('releases the artifact reference on the sweeper alone (Issue #1429)', async () => {
    const record = await createSkillInstallPlan(makeInput());

    expect(sweepSkillInstallPlans({ now: record.expiresAt - 1 })).toBe(0);
    expect(releaseSkillSnapshotMock).not.toHaveBeenCalled();

    expect(sweepSkillInstallPlans({ now: record.expiresAt })).toBe(1);
    expect(releaseSkillSnapshotMock).toHaveBeenCalledWith(SNAPSHOT_ID);
    expect(sweepSkillInstallPlans({ now: record.expiresAt })).toBe(0);
    expect(releaseSkillSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the artifact reference when the sweeper meets a consumed plan', async () => {
    const record = await createSkillInstallPlan(makeInput());
    consumeSkillInstallPlan(record.token, expected, observed(record));

    expect(sweepSkillInstallPlans({ now: record.expiresAt })).toBe(1);
    expect(releaseSkillSnapshotMock).not.toHaveBeenCalled();
  });
});
