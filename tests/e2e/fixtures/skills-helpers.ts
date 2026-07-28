/**
 * Browser-side API stubs for the Skill Catalog / install E2E specs (Issue #1242).
 *
 * The E2E server runs with an empty, non-git `CM_ROOT_DIR` (playwright.config.ts),
 * so it has zero worktrees and no route to the upstream Catalog — the real
 * `GET /api/skills` would attempt a network fetch against
 * `raw.githubusercontent.com`. Both are stubbed in the browser with `page.route`
 * rather than by seeding the server, because seeding is process-wide state that
 * the destructive specs in this suite share.
 *
 * What that buys and what it does not: these specs assert the *rendered product* —
 * that a user on a real page, in a real browser, at a real viewport can see the
 * target, risk, permissions, scripts and file diff before approving, and that the
 * approval gates hold. They do not assert server behaviour; that is covered by
 * `tests/integration/skills-mvp-*.test.ts` against the real routes.
 *
 * The response bodies are typed against the same wire contract the components
 * consume, so a change to what the API returns breaks type-check here instead of
 * drifting into a hand-written mirror.
 */

import type { Page, Request } from '@playwright/test';
import type {
  SkillDetailResponse,
  SkillDiffEntry,
  SkillDto,
  SkillInstallPlanDto,
  SkillInstallResponse,
  SkillListResponse,
  SkillUninstallPlanDto,
  SkillUninstallResponse,
  SkillVersionDto,
} from '@/components/skills/types';
import type { Worktree } from '@/types/models';

/** iPhone-class width. AppShell switches to its mobile layout below 768px. */
export const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;

export const WORKTREE_ID = 'e2e-demo-wt';
export const SKILL_ID = 'release-helper';
export const HIGH_RISK_SKILL_ID = 'script-runner';

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

function sha(seed: string, length: number): string {
  return seed.repeat(length).slice(0, length);
}

export function makeCatalogMeta(
  overrides: Partial<SkillListResponse['catalog']> = {}
): SkillListResponse['catalog'] {
  return {
    schemaVersion: 1,
    fetchedAt: '2026-07-29T00:00:00Z',
    revalidatedAt: '2026-07-29T00:05:00Z',
    stale: false,
    offline: false,
    state: 'fresh',
    staleReason: null,
    source: { repository: 'Kewton/commandmate-skills', ref: 'main', revision: 'etag-e2e' },
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
    source: { repository: 'Kewton/commandmate-skills', ref: 'v1.2.0', commit: sha('a', 40) },
    artifact: {
      assetName: 'release-helper-1.2.0.tar.gz',
      sha256: sha('b', 64),
      size: 20480,
      format: 'tar.gz',
    },
    compatibility: {
      commandmate: {
        status: 'compatible',
        reasonCode: 'SKILL_COMPAT_SATISFIED',
        messageKey: 'skills.compatibility.reason.satisfied',
        message: 'CommandMate satisfies the required range ">=0.11.0".',
        requiredRange: '>=0.11.0',
        currentVersion: '0.15.0',
      },
      // Only the two Agents the publisher declares. Everything else must stay
      // absent rather than be rendered as unsupported (see skills-catalog.spec).
      agents: [
        {
          agent: 'claude',
          support: 'native',
          labelKey: 'skills.compatibility.native',
          evidence: 'Discovered from .claude/skills on Claude Code 2.1.220.',
        },
        {
          agent: 'codex',
          support: 'native',
          labelKey: 'skills.compatibility.native',
          evidence: 'Discovered from .agents/skills on Codex CLI 0.145.0.',
        },
      ],
    },
    ...overrides,
  };
}

export function makeSkill(overrides: Partial<SkillDto> = {}): SkillDto {
  const versions = overrides.versions ?? [makeVersion()];
  return {
    id: SKILL_ID,
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

/** A second entry, so list filtering has something to filter out. */
export function makeSecondSkill(): SkillDto {
  return makeSkill({
    id: 'issue-refinement',
    name: 'Issue Refinement',
    summary: 'Turns a rough report into an actionable issue.',
    keywords: ['issue', 'triage'],
  });
}

/** A package that ships an executable script, so risk gating has a subject. */
export function makeHighRiskSkill(): SkillDto {
  const version = makeVersion({
    version: '2.0.0',
    declaredRisk: 'high',
    artifact: {
      assetName: 'script-runner-2.0.0.tar.gz',
      sha256: sha('c', 64),
      size: 40960,
      format: 'tar.gz',
    },
    source: { repository: 'Kewton/commandmate-skills', ref: 'v2.0.0', commit: sha('e', 40) },
  });
  return makeSkill({
    id: HIGH_RISK_SKILL_ID,
    name: 'Script Runner',
    summary: 'Runs a packaged shell script as part of the workflow.',
    keywords: ['script'],
    latest: '2.0.0',
    recommendedVersion: '2.0.0',
    compatibility: version.compatibility.commandmate,
    versions: [version],
  });
}

export function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: WORKTREE_ID,
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
    sha256: sha('d', 64),
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

/**
 * An Install Plan for the low-risk Skill.
 *
 * `installRoots` carries both discovery roots (#1460): the preview a user
 * approves has to name every location the install writes to, or the approval is
 * for something narrower than what happens.
 */
export function makeInstallPlan(overrides: Partial<SkillInstallPlanDto> = {}): SkillInstallPlanDto {
  return {
    token: 'a1b2c3d4'.repeat(6),
    expiresAt: '2026-07-29T00:10:00Z',
    installable: true,
    requiresRiskAcknowledgement: false,
    riskAcknowledged: false,
    riskAcknowledgementMessageKey: null,
    blockers: [],
    warnings: [],
    target: {
      worktreeId: WORKTREE_ID,
      worktreeName: 'feature/demo',
      repositoryName: 'CommandMate',
      syncedBranch: 'feature/demo',
      branch: 'feature/demo',
      headState: 'attached',
      headCommit: sha('f', 40),
      workingTreeDirty: false,
      installRoot: '.agents/skills/release-helper',
      installRoots: ['.agents/skills/release-helper', '.claude/skills/release-helper'],
      currentTreeHash: sha('1', 64),
      plannedTreeHash: sha('2', 64),
      existingInstall: null,
    },
    skill: {
      id: SKILL_ID,
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
          currentVersion: '0.15.0',
        },
        agents: [{ agent: 'claude', support: 'native', evidence: 'Spec verified.' }],
      },
      source: { repository: 'Kewton/commandmate-skills', ref: 'v1.2.0', commit: sha('a', 40) },
      artifact: {
        assetName: 'release-helper-1.2.0.tar.gz',
        sha256: sha('b', 64),
        size: 20480,
        format: 'tar.gz',
      },
    },
    receipt: {
      path: '.agents/skills/release-helper/.commandmate-receipt.json',
      sha256: sha('d', 64),
      size: 512,
    },
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

/** A plan whose package ships a script, so the acknowledgement gate applies. */
export function makeHighRiskInstallPlan(): SkillInstallPlanDto {
  const base = makeInstallPlan();
  return {
    ...base,
    requiresRiskAcknowledgement: true,
    riskAcknowledgementMessageKey: 'skills.plan.highRiskAcknowledgement',
    target: {
      ...base.target,
      installRoot: '.agents/skills/script-runner',
      installRoots: ['.agents/skills/script-runner', '.claude/skills/script-runner'],
    },
    skill: {
      ...base.skill,
      id: HIGH_RISK_SKILL_ID,
      name: 'Script Runner',
      version: '2.0.0',
      declaredRisk: 'high',
      computedRisk: 'high',
      effectiveRisk: 'high',
      riskRationale: 'The package ships an executable script.',
      declaredPermissions: ['filesystem_read', 'process_execution'],
      executablePaths: ['scripts/run.sh'],
      scriptPaths: ['scripts/run.sh'],
    },
    files: [
      makeDiffEntry({ path: '.agents/skills/script-runner/SKILL.md' }),
      makeDiffEntry({
        path: '.agents/skills/script-runner/scripts/run.sh',
        executable: true,
        diff: '+#!/bin/sh',
      }),
    ],
    stats: { ...base.stats, added: 2 },
  };
}

export function makeInstallResponse(): SkillInstallResponse {
  return {
    operation: {
      operationId: 'op-e2e-1',
      idempotencyKey: 'skill-install-token',
      state: 'SUCCEEDED',
      result: 'succeeded',
      committed: true,
      reconcilePending: false,
      nextActionKey: 'skills.install.nextAction.succeeded',
      replayed: false,
    },
    install: {
      skillId: SKILL_ID,
      version: '1.2.0',
      installRoot: '.agents/skills/release-helper',
      installRoots: ['.agents/skills/release-helper', '.claude/skills/release-helper'],
      receipt: {
        path: '.agents/skills/release-helper/.commandmate-receipt.json',
        sha256: sha('d', 64),
        size: 512,
      },
      files: [{ path: 'SKILL.md', sha256: sha('d', 64), size: 128, executable: false }],
      treeHash: sha('2', 64),
    },
    reload: {
      skillId: SKILL_ID,
      version: '1.2.0',
      installRoot: '.agents/skills/release-helper',
      agents: [
        { agent: 'claude', support: 'native', messageKey: 'skills.install.reload.native' },
        { agent: 'codex', support: 'native', messageKey: 'skills.install.reload.native' },
      ],
    },
  };
}

export function makeUninstallPlan(
  overrides: Partial<SkillUninstallPlanDto> = {}
): SkillUninstallPlanDto {
  return {
    token: 'f1e2d3c4'.repeat(6),
    expiresAt: '2026-07-29T00:10:00Z',
    removable: true,
    blockers: [],
    nextActionKey: 'skills.uninstall.nextAction.removable',
    target: {
      worktreeId: WORKTREE_ID,
      worktreeName: 'feature/demo',
      repositoryName: 'CommandMate',
      branch: 'feature/demo',
      headState: 'attached',
      headCommit: sha('f', 40),
      workingTreeDirty: false,
      installRoot: '.agents/skills/release-helper',
      currentTreeHash: sha('1', 64),
    },
    skill: {
      id: SKILL_ID,
      version: '1.2.0',
      source: { repository: 'Kewton/commandmate-skills', ref: 'v1.2.0', commit: sha('a', 40) },
      artifact: { assetName: 'release-helper-1.2.0.tar.gz', sha256: sha('b', 64) },
      effectiveRisk: 'low',
      agents: [{ agent: 'claude', support: 'native', messageKey: 'skills.uninstall.reload.native' }],
    },
    receipt: {
      path: '.agents/skills/release-helper/.commandmate-receipt.json',
      sha256: sha('d', 64),
      size: 512,
    },
    removals: [
      {
        path: '.agents/skills/release-helper/SKILL.md',
        relativePath: 'SKILL.md',
        disposition: 'remove',
        reason: 'SKILL_UNINSTALL_MANAGED_UNCHANGED',
        generated: false,
        recordedSha256: sha('d', 64),
        currentSha256: sha('d', 64),
        size: 128,
        executable: false,
      },
    ],
    retained: [],
    stats: { removable: 1, modified: 0, missing: 0, unknown: 0, irregular: 0 },
    ...overrides,
  };
}

export function makeUninstallResponse(): SkillUninstallResponse {
  return {
    operation: {
      operationId: 'op-e2e-2',
      idempotencyKey: 'skill-uninstall-token',
      state: 'SUCCEEDED',
      result: 'succeeded',
      committed: true,
      reconcilePending: false,
      nextActionKey: 'skills.uninstall.nextAction.succeeded',
      replayed: false,
    },
    uninstall: {
      skillId: SKILL_ID,
      version: '1.2.0',
      installRoot: '.agents/skills/release-helper',
      removedFiles: [{ path: 'SKILL.md', sha256: sha('d', 64), size: 128 }],
      removedDirectories: [],
      retained: [],
      receiptRemoved: true,
      fullyRemoved: true,
    },
    reload: {
      skillId: SKILL_ID,
      version: '1.2.0',
      installRoot: '.agents/skills/release-helper',
      agents: [{ agent: 'claude', support: 'native', messageKey: 'skills.uninstall.reload.native' }],
    },
  };
}

// =============================================================================
// Routing
// =============================================================================

/** Every request the browser sent to a Skill write route, in order. */
export interface RequestLog {
  readonly entries: Array<{ method: string; url: string; body: unknown }>;
  /** Requests whose path ends with the given route segment. */
  matching(segment: string): Array<{ method: string; url: string; body: unknown }>;
}

function readBody(request: Request): unknown {
  try {
    return request.postDataJSON();
  } catch {
    return null;
  }
}

export interface SkillRouteOptions {
  skills?: SkillDto[];
  worktrees?: Worktree[];
  catalog?: SkillListResponse['catalog'];
  installPlan?: SkillInstallPlanDto;
  installResponse?: SkillInstallResponse;
  uninstallPlan?: SkillUninstallPlanDto;
  uninstallResponse?: SkillUninstallResponse;
  /** Status + body to answer the plan route with instead of `installPlan`. */
  installPlanError?: { status: number; body: unknown };
}

/**
 * Stub every Skill-related endpoint the pages touch.
 *
 * One handler for a single URL pattern rather than several overlapping globs:
 * `**​/api/skills` and `**​/api/skills/*` both match a detail URL, and which one
 * wins depends on registration order, which is exactly the kind of implicit
 * coupling a test should not rest on.
 */
export async function routeSkillApis(
  page: Page,
  options: SkillRouteOptions = {}
): Promise<RequestLog> {
  const skills = options.skills ?? [makeSkill(), makeSecondSkill()];
  const worktrees = options.worktrees ?? [makeWorktree()];
  const catalog = options.catalog ?? makeCatalogMeta();
  const entries: RequestLog['entries'] = [];

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());

    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, headers: JSON_HEADERS, body: JSON.stringify(body) });

    if (pathname === '/api/worktrees') {
      return json({ worktrees });
    }

    if (pathname === '/api/skills') {
      const body: SkillListResponse = { catalog, skills };
      return json(body);
    }

    const detail = /^\/api\/skills\/([^/]+)$/.exec(pathname);
    if (detail) {
      const skill = skills.find((entry) => entry.id === decodeURIComponent(detail[1]));
      if (!skill) return json({ error: 'Not found', code: 'SKILL_NOT_FOUND' }, 404);
      const body: SkillDetailResponse = { catalog, skill };
      return json(body);
    }

    const operation = /^\/api\/worktrees\/[^/]+\/skills\/[^/]+\/([a-z-]+)$/.exec(pathname);
    if (operation) {
      entries.push({ method: request.method(), url: pathname, body: readBody(request) });
      switch (operation[1]) {
        case 'plan':
          if (options.installPlanError) {
            return json(options.installPlanError.body, options.installPlanError.status);
          }
          return json({ plan: options.installPlan ?? makeInstallPlan() });
        case 'install':
          return json(options.installResponse ?? makeInstallResponse());
        case 'uninstall-plan':
          return json({ plan: options.uninstallPlan ?? makeUninstallPlan() });
        case 'uninstall':
          return json(options.uninstallResponse ?? makeUninstallResponse());
        default:
          return route.continue();
      }
    }

    return route.continue();
  });

  return {
    entries,
    matching: (segment) => entries.filter((entry) => entry.url.endsWith(`/${segment}`)),
  };
}
