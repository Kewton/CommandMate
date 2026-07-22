/**
 * Catalog API fixtures for the Skill Catalog UI tests (Issue #1232)
 *
 * Shaped from `lib/api/skills-api` so the tests break if the #1231 wire
 * contract changes rather than passing against a stale hand-written shape.
 */

import type {
  SkillCatalogMetaDto,
  SkillDiffEntry,
  SkillDto,
  SkillInstallPlanDto,
  SkillInstallResponse,
  SkillUninstallFileEntry,
  SkillUninstallPlanDto,
  SkillUninstallResponse,
  SkillVersionDto,
} from '@/components/skills/types';
import type { Worktree } from '@/types/models';

export function makeCatalogMeta(overrides: Partial<SkillCatalogMetaDto> = {}): SkillCatalogMetaDto {
  return {
    schemaVersion: 1,
    fetchedAt: '2026-07-20T00:00:00Z',
    revalidatedAt: '2026-07-20T00:05:00Z',
    stale: false,
    offline: false,
    state: 'fresh',
    staleReason: null,
    source: { repository: 'Kewton/commandmate-skills', ref: 'main', revision: 'etag-1' },
    ...overrides,
  };
}

export function makeVersion(overrides: Partial<SkillVersionDto> = {}): SkillVersionDto {
  return {
    version: '1.2.0',
    changelog: 'Adds the release checklist step.',
    publishedAt: '2026-07-01T00:00:00Z',
    declaredRisk: 'low',
    prerelease: false,
    source: {
      repository: 'Kewton/commandmate-skills',
      ref: 'v1.2.0',
      commit: 'a'.repeat(40),
    },
    artifact: {
      assetName: 'release-helper-1.2.0.tar.gz',
      sha256: 'b'.repeat(64),
      size: 20480,
      format: 'tar.gz',
    },
    compatibility: {
      commandmate: {
        status: 'compatible',
        reasonCode: 'SKILL_COMPAT_SATISFIED',
        messageKey: 'skills.compatibility.reason.satisfied',
        message: 'CommandMate 0.11.4 satisfies the required range ">=0.11.0".',
        requiredRange: '>=0.11.0',
        currentVersion: '0.11.4',
      },
      agents: [
        {
          agent: 'claude',
          support: 'native',
          labelKey: 'skills.compatibility.native',
          evidence: 'Verified against the Agent Skills specification.',
        },
      ],
    },
    ...overrides,
  };
}

export function makeSkill(overrides: Partial<SkillDto> = {}): SkillDto {
  const versions = overrides.versions ?? [makeVersion()];
  return {
    id: 'release-helper',
    name: 'Release Helper',
    summary: 'Walks an agent through the release checklist.',
    provider: { name: 'CommandMate', url: 'https://example.invalid/publisher' },
    license: 'MIT',
    homepage: 'https://example.invalid/release-helper',
    keywords: ['release', 'checklist'],
    latest: '1.2.0',
    recommendedVersion: '1.2.0',
    recommendedReason: 'SKILL_RECOMMEND_HIGHEST_COMPATIBLE',
    compatibility: versions[0]?.compatibility.commandmate ?? null,
    ...overrides,
    versions,
  };
}

/** An entry whose only version is out of range for the running CommandMate. */
export function makeIncompatibleSkill(): SkillDto {
  const version = makeVersion({
    version: '2.0.0',
    declaredRisk: 'high',
    compatibility: {
      commandmate: {
        status: 'incompatible',
        reasonCode: 'SKILL_COMPAT_HOST_VERSION_OUT_OF_RANGE',
        messageKey: 'skills.compatibility.reason.hostVersionOutOfRange',
        message: 'This Skill requires CommandMate ">=9.0.0", but CommandMate 0.11.4 is running.',
        requiredRange: '>=9.0.0',
        currentVersion: '0.11.4',
      },
      agents: [
        {
          agent: 'codex',
          support: 'unknown',
          labelKey: 'skills.compatibility.unknown',
          evidence: 'Not verified.',
        },
      ],
    },
  });
  return makeSkill({
    id: 'future-skill',
    name: 'Future Skill',
    summary: 'Needs a CommandMate that is not released yet.',
    latest: '2.0.0',
    recommendedVersion: null,
    recommendedReason: 'SKILL_RECOMMEND_NONE_COMPATIBLE',
    compatibility: version.compatibility.commandmate,
    versions: [version],
  });
}

/** An entry CommandMate could not judge at all. */
export function makeUnknownSkill(): SkillDto {
  const version = makeVersion({
    version: '0.9.0',
    declaredRisk: 'moderate',
    compatibility: {
      commandmate: {
        status: 'unknown',
        reasonCode: 'SKILL_COMPAT_RANGE_UNSUPPORTED',
        messageKey: 'skills.compatibility.reason.rangeUnsupported',
        message: 'This Skill declares the unsupported CommandMate version range "latest".',
        requiredRange: 'latest',
        currentVersion: '0.11.4',
      },
      agents: [],
    },
  });
  return makeSkill({
    id: 'mystery-skill',
    name: 'Mystery Skill',
    summary: 'Declares a range CommandMate cannot interpret.',
    keywords: ['mystery'],
    latest: '0.9.0',
    recommendedVersion: '0.9.0',
    recommendedReason: 'SKILL_RECOMMEND_LATEST_UNVERIFIED',
    compatibility: version.compatibility.commandmate,
    versions: [version],
  });
}

// =============================================================================
// Install / uninstall wire fixtures (Issue #1431)
// =============================================================================

export function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'demo-wt',
    name: 'feature/demo',
    path: '/srv/worktrees/demo',
    repositoryPath: '/srv/repos/CommandMate',
    repositoryName: 'CommandMate',
    branch: 'feature/demo',
    ...overrides,
  };
}

export function makeDiffEntry(overrides: Partial<SkillDiffEntry> = {}): SkillDiffEntry {
  return {
    path: '.agents/skills/release-helper/SKILL.md',
    change: 'add',
    reason: 'SKILL_DIFF_NEW_FILE',
    generated: false,
    sha256: 'c'.repeat(64),
    size: 128,
    executable: false,
    currentSha256: null,
    currentSize: null,
    binary: false,
    lineEnding: 'lf',
    gitIgnored: false,
    diff: '+# Release Helper',
    diffTruncated: false,
    additions: 1,
    deletions: 0,
    ...overrides,
  };
}

export function makeInstallPlan(overrides: Partial<SkillInstallPlanDto> = {}): SkillInstallPlanDto {
  return {
    token: 'a1b2c3d4'.repeat(6),
    expiresAt: '2026-07-21T00:10:00Z',
    installable: true,
    requiresRiskAcknowledgement: false,
    riskAcknowledged: false,
    riskAcknowledgementMessageKey: null,
    blockers: [],
    warnings: [],
    target: {
      worktreeId: 'demo-wt',
      worktreeName: 'feature/demo',
      repositoryName: 'CommandMate',
      syncedBranch: 'feature/demo',
      branch: 'feature/demo',
      headState: 'attached',
      headCommit: 'd'.repeat(40),
      workingTreeDirty: false,
      installRoot: '.agents/skills/release-helper',
      installRoots: ['.agents/skills/release-helper', '.claude/skills/release-helper'],
      currentTreeHash: 'e'.repeat(64),
      plannedTreeHash: 'f'.repeat(64),
      existingInstall: null,
    },
    skill: {
      id: 'release-helper',
      name: 'Release Helper',
      version: '1.2.0',
      summary: 'Walks an agent through the release checklist.',
      description: 'Longer description.',
      capabilities: ['Release checklist'],
      expectedOutcomes: ['A tagged release'],
      provider: { name: 'CommandMate' },
      license: 'MIT',
      homepage: null,
      declaredPermissions: ['filesystem_read'],
      requirements: { commands: [{ name: 'git', versionRange: '>=2.0.0' }], networkHosts: [] },
      declaredRisk: 'low',
      computedRisk: 'low',
      effectiveRisk: 'low',
      riskRationale: 'The package contains no scripts.',
      executablePaths: [],
      scriptPaths: [],
      compatibility: {
        commandmate: {
          status: 'compatible',
          reasonCode: 'SKILL_COMPAT_SATISFIED',
          messageKey: 'skills.compatibility.reason.satisfied',
          message: 'ok',
          requiredRange: '>=0.11.0',
          currentVersion: '0.11.4',
        },
        agents: [{ agent: 'claude', support: 'native', evidence: 'Spec verified.' }],
      },
      source: { repository: 'Kewton/commandmate-skills', ref: 'v1.2.0', commit: 'a'.repeat(40) },
      artifact: {
        assetName: 'release-helper-1.2.0.tar.gz',
        sha256: 'b'.repeat(64),
        size: 20480,
        format: 'tar.gz',
      },
    },
    receipt: { path: '.agents/skills/release-helper/.commandmate-receipt.json', sha256: 'c'.repeat(64), size: 512 },
    files: [makeDiffEntry()],
    stats: {
      added: 1,
      modified: 0,
      unchanged: 0,
      conflicted: 0,
      unmanaged: 0,
      binaryFiles: 0,
      truncatedFiles: 0,
      diffBytes: 32,
    },
    ...overrides,
  };
}

export function makeInstallResponse(): SkillInstallResponse {
  return {
    operation: {
      operationId: 'op-1',
      idempotencyKey: 'skill-install-token',
      state: 'SUCCEEDED',
      result: 'succeeded',
      committed: true,
      reconcilePending: false,
      nextActionKey: 'skills.install.nextAction.succeeded',
      replayed: false,
    },
    install: {
      skillId: 'release-helper',
      version: '1.2.0',
      installRoot: '.agents/skills/release-helper',
      installRoots: ['.agents/skills/release-helper', '.claude/skills/release-helper'],
      receipt: { path: '.agents/skills/release-helper/.commandmate-receipt.json', sha256: 'c'.repeat(64), size: 512 },
      files: [{ path: 'SKILL.md', sha256: 'c'.repeat(64), size: 128, executable: false }],
      treeHash: 'f'.repeat(64),
    },
    reload: {
      skillId: 'release-helper',
      version: '1.2.0',
      installRoot: '.agents/skills/release-helper',
      agents: [{ agent: 'claude', support: 'native', messageKey: 'skills.install.reload.native' }],
    },
  };
}

export function makeUninstallFile(
  overrides: Partial<SkillUninstallFileEntry> = {}
): SkillUninstallFileEntry {
  return {
    path: '.agents/skills/release-helper/SKILL.md',
    relativePath: 'SKILL.md',
    disposition: 'remove',
    reason: 'SKILL_UNINSTALL_MANAGED_UNCHANGED',
    generated: false,
    recordedSha256: 'c'.repeat(64),
    currentSha256: 'c'.repeat(64),
    size: 128,
    executable: false,
    ...overrides,
  };
}

export function makeUninstallPlan(
  overrides: Partial<SkillUninstallPlanDto> = {}
): SkillUninstallPlanDto {
  return {
    token: 'f1e2d3c4'.repeat(6),
    expiresAt: '2026-07-21T00:10:00Z',
    removable: true,
    blockers: [],
    nextActionKey: 'skills.uninstall.nextAction.removable',
    target: {
      worktreeId: 'demo-wt',
      worktreeName: 'feature/demo',
      repositoryName: 'CommandMate',
      branch: 'feature/demo',
      headState: 'attached',
      headCommit: 'd'.repeat(40),
      workingTreeDirty: false,
      installRoot: '.agents/skills/release-helper',
      currentTreeHash: 'e'.repeat(64),
    },
    skill: {
      id: 'release-helper',
      version: '1.2.0',
      source: { repository: 'Kewton/commandmate-skills', ref: 'v1.2.0', commit: 'a'.repeat(40) },
      artifact: { assetName: 'release-helper-1.2.0.tar.gz', sha256: 'b'.repeat(64) },
      effectiveRisk: 'low',
      agents: [{ agent: 'claude', support: 'native', messageKey: 'skills.uninstall.reload.native' }],
    },
    receipt: { path: '.agents/skills/release-helper/.commandmate-receipt.json', sha256: 'c'.repeat(64), size: 512 },
    removals: [makeUninstallFile()],
    retained: [],
    stats: { removable: 1, modified: 0, missing: 0, unknown: 0, irregular: 0 },
    ...overrides,
  };
}

export function makeUninstallResponse(): SkillUninstallResponse {
  return {
    operation: {
      operationId: 'op-2',
      idempotencyKey: 'skill-uninstall-token',
      state: 'SUCCEEDED',
      result: 'succeeded',
      committed: true,
      reconcilePending: false,
      nextActionKey: 'skills.uninstall.nextAction.succeeded',
      replayed: false,
    },
    uninstall: {
      skillId: 'release-helper',
      version: '1.2.0',
      installRoot: '.agents/skills/release-helper',
      removedFiles: [{ path: 'SKILL.md', sha256: 'c'.repeat(64), size: 128 }],
      removedDirectories: [],
      retained: [],
      receiptRemoved: true,
      fullyRemoved: true,
    },
    reload: {
      skillId: 'release-helper',
      version: '1.2.0',
      installRoot: '.agents/skills/release-helper',
      agents: [{ agent: 'claude', support: 'native', messageKey: 'skills.uninstall.reload.native' }],
    },
  };
}
