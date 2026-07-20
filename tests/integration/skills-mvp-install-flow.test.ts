/**
 * Skill MVP install/uninstall flow, end to end (Issue #1242)
 *
 * @vitest-environment node
 *
 * The MVP gate: Catalog → plan → install → receipt → Agent discovery →
 * uninstall, run over the three Skills the MVP ships, against a real git
 * repository and the real snapshot/staging/filesystem layers. Only the Catalog
 * document and the artifact download are stubbed, because the suite must not
 * touch the network; everything that writes is the production code path.
 *
 * The UI and the CLI are both exercised, and deliberately against the *same*
 * route handlers with the *same* fixture Catalog — that is the property the
 * acceptance condition asks for. The CLI is driven by intercepting `fetch` and
 * dispatching into the handlers, so no socket is opened and a running
 * CommandMate server on port 3000 can never be reached by accident.
 */

import path from 'path';
import { existsSync, lstatSync, readFileSync } from 'fs';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const state = vi.hoisted(() => ({ configRoot: '' }));

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  })),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

// Locks, journals and snapshots must land in a throwaway root, never in the
// developer's real ~/.commandmate.
vi.mock('@/cli/utils/install-context', () => ({
  ensureConfigDir: () => state.configRoot,
  getConfigDir: () => state.configRoot,
  isGlobalInstall: () => false,
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn() }));
vi.mock('@/lib/db', () => ({ getWorktreeById: vi.fn() }));
vi.mock('@/lib/skills/catalog-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/skills/catalog-client')>();
  return { ...actual, getSkillCatalog: vi.fn() };
});
vi.mock('@/lib/skills/artifact-downloader', () => ({ downloadSkillArtifact: vi.fn() }));
vi.mock('@/lib/version-checker', () => ({ getServerVersion: vi.fn(() => '0.11.4') }));

import { POST as buildPlan } from '@/app/api/worktrees/[id]/skills/[skillId]/plan/route';
import { POST as applyInstall } from '@/app/api/worktrees/[id]/skills/[skillId]/install/route';
import { POST as buildUninstallPlan } from '@/app/api/worktrees/[id]/skills/[skillId]/uninstall-plan/route';
import { POST as applyUninstall } from '@/app/api/worktrees/[id]/skills/[skillId]/uninstall/route';
import { GET as listCatalog } from '@/app/api/skills/route';
import { getWorktreeById } from '@/lib/db';
import { getDbInstance } from '@/lib/db/db-instance';
import { getSkillCatalog } from '@/lib/skills/catalog-client';
import { downloadSkillArtifact } from '@/lib/skills/artifact-downloader';
import { runMigrations } from '@/lib/db/db-migrations';
import { SKILL_RECEIPT_FILENAME, resetSkillInstallPlanCacheForTesting } from '@/lib/skills/install-plan';
import { resetSkillUninstallPlanCacheForTesting } from '@/lib/skills/uninstall-plan';
import {
  resetSkillSnapshotStoreForTesting,
  sweepSkillSnapshots,
  getSkillSnapshotUsage,
} from '@/lib/skills/snapshot-store';
import { getSkillInstallation, listSkillInstallations } from '@/lib/skills/installed-state';
import { listSkillOperationAudit } from '@/lib/skills/operation-audit';
import { loadAgentsSkills } from '@/lib/slash-commands';
import { validateSkillInstallReceipt } from '@/lib/skills/schema';
import type { Worktree } from '@/types/models';
import {
  MVP_SKILLS,
  WORKTREE_ID,
  buildArtifact,
  buildCatalog,
  catalogResult,
  createTestRoot,
  git,
  initGitRepo,
  installRootOf,
  removeTestRoot,
  listDirEntries,
  residueReport,
  snapshotTree,
  treeDelta,
  type BuiltArtifact,
} from './skills/mvp-harness';

const getWorktreeByIdMock = vi.mocked(getWorktreeById);
const getDbInstanceMock = vi.mocked(getDbInstance);
const getSkillCatalogMock = vi.mocked(getSkillCatalog);
const downloadSkillArtifactMock = vi.mocked(downloadSkillArtifact);

let worktreeDir: string;
let configRoot: string;
let db: Database.Database;
let artifacts: Map<string, BuiltArtifact>;

// =============================================================================
// Harness
// =============================================================================

function makeWorktree(): Worktree {
  return {
    id: WORKTREE_ID,
    name: 'demo-worktree',
    path: worktreeDir,
    branch: 'main',
    repositoryName: 'commandmate',
    repositoryDisplayName: 'CommandMate',
  } as Worktree;
}

function wireCatalog(): void {
  const catalog = buildCatalog([...artifacts.values()]);
  getSkillCatalogMock.mockResolvedValue(catalogResult(catalog) as never);
  downloadSkillArtifactMock.mockImplementation(async (skillId: string) => {
    const artifact = artifacts.get(skillId);
    if (!artifact) throw new Error(`no fixture artifact for ${skillId}`);
    return {
      skillId: artifact.skillId,
      version: artifact.version,
      commit: artifact.commit,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      size: artifact.size,
    };
  });
}

/** `authorization` present ⇒ the route binds the plan to the `cli` actor. */
function routeRequest(url: string, body: unknown, asCli: boolean): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
    ...(asCli ? { headers: { authorization: 'Bearer test-token' } } : {}),
  });
}

function params(skillId: string) {
  return { params: Promise.resolve({ id: WORKTREE_ID, skillId }) };
}

async function requestPlan(skillId: string, body: unknown = {}, asCli = false): Promise<Response> {
  return buildPlan(
    routeRequest(`/api/worktrees/${WORKTREE_ID}/skills/${skillId}/plan`, body, asCli),
    params(skillId)
  );
}

async function requestInstall(skillId: string, body: unknown, asCli = false): Promise<Response> {
  return applyInstall(
    routeRequest(`/api/worktrees/${WORKTREE_ID}/skills/${skillId}/install`, body, asCli),
    params(skillId)
  );
}

async function requestUninstallPlan(skillId: string, asCli = false): Promise<Response> {
  return buildUninstallPlan(
    routeRequest(`/api/worktrees/${WORKTREE_ID}/skills/${skillId}/uninstall-plan`, {}, asCli),
    params(skillId)
  );
}

async function requestUninstall(skillId: string, body: unknown, asCli = false): Promise<Response> {
  return applyUninstall(
    routeRequest(`/api/worktrees/${WORKTREE_ID}/skills/${skillId}/uninstall`, body, asCli),
    params(skillId)
  );
}

/** plan → install, asserting each hop, and returning the install response body. */
async function installViaApi(skillId: string, asCli = false): Promise<Record<string, unknown>> {
  const planResponse = await requestPlan(skillId, {}, asCli);
  expect(planResponse.status).toBe(200);
  const plan = (await planResponse.json()) as Record<string, never>;
  const planDto = plan.plan as Record<string, never>;
  expect(planDto.installable).toBe(true);

  const installResponse = await requestInstall(
    skillId,
    {
      planToken: planDto.token,
      version: (planDto.skill as Record<string, string>).version,
      acknowledgeRisk: Boolean(planDto.requiresRiskAcknowledgement),
    },
    asCli
  );
  expect(installResponse.status).toBe(200);
  return (await installResponse.json()) as Record<string, unknown>;
}

async function uninstallViaApi(skillId: string, asCli = false): Promise<Record<string, unknown>> {
  const planResponse = await requestUninstallPlan(skillId, asCli);
  expect(planResponse.status).toBe(200);
  const plan = (await planResponse.json()) as Record<string, never>;
  const planDto = plan.plan as Record<string, never>;
  expect(planDto.removable).toBe(true);

  const response = await requestUninstall(skillId, { planToken: planDto.token }, asCli);
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSkillInstallPlanCacheForTesting();
  resetSkillUninstallPlanCacheForTesting();
  resetSkillSnapshotStoreForTesting();

  worktreeDir = createTestRoot('wt');
  configRoot = createTestRoot('cfg');
  state.configRoot = configRoot;
  initGitRepo(worktreeDir);

  db = new Database(':memory:');
  runMigrations(db);
  getDbInstanceMock.mockReturnValue(db);
  getWorktreeByIdMock.mockReturnValue(makeWorktree());

  artifacts = new Map(
    MVP_SKILLS.map((skill) => [skill.id, buildArtifact(skill.id, skill.version)])
  );
  wireCatalog();
});

afterEach(() => {
  db.close();
  resetSkillSnapshotStoreForTesting();
  removeTestRoot(worktreeDir);
  removeTestRoot(configRoot);
});

// =============================================================================
// Happy path — the MVP gate
// =============================================================================

describe('Skill MVP: Catalog → install → discovery → uninstall', () => {
  it('installs all three MVP Skills and lists them in the Catalog API', async () => {
    const catalogResponse = await listCatalog(
      new NextRequest('http://localhost/api/skills') as never
    );
    expect(catalogResponse.status).toBe(200);
    const listed = (await catalogResponse.json()) as { skills: { id: string }[] };
    expect(listed.skills.map((skill) => skill.id).sort()).toEqual(
      MVP_SKILLS.map((skill) => skill.id).sort()
    );

    for (const skill of MVP_SKILLS) {
      const body = await installViaApi(skill.id);
      expect((body.operation as Record<string, string>).result).toBe('succeeded');
    }

    for (const skill of MVP_SKILLS) {
      const root = installRootOf(worktreeDir, skill.id);
      expect(existsSync(path.join(root, 'SKILL.md'))).toBe(true);
      expect(existsSync(path.join(root, SKILL_RECEIPT_FILENAME))).toBe(true);
    }
  });

  it('writes a deterministic, schema-valid receipt that matches the artifact', async () => {
    const skill = MVP_SKILLS[0];
    await installViaApi(skill.id);

    const receiptPath = path.join(installRootOf(worktreeDir, skill.id), SKILL_RECEIPT_FILENAME);
    const bytes = readFileSync(receiptPath);
    const receipt = validateSkillInstallReceipt(JSON.parse(bytes.toString('utf-8')));
    expect(receipt.errors).toEqual([]);
    expect(receipt.ok).toBe(true);

    const value = receipt.value as unknown as Record<string, never>;
    const artifact = artifacts.get(skill.id)!;
    expect(value.skill_id).toBe(skill.id);
    expect(value.version).toBe(skill.version);
    expect((value.artifact as Record<string, string>).sha256).toBe(artifact.sha256);
    expect((value.source as Record<string, string>).commit).toBe(artifact.commit);
    expect(value.install_root).toBe(`.agents/skills/${skill.id}`);

    // Deterministic: no timestamp, no actor, no machine path, no signed URL.
    const text = bytes.toString('utf-8');
    expect(text).not.toContain(worktreeDir);
    expect(text).not.toMatch(/installed_at|actor|"url"/);
  });

  it('indexes the install in the DB and records exactly one audit row per operation', async () => {
    const skill = MVP_SKILLS[0];
    const body = await installViaApi(skill.id);
    const operationId = (body.operation as Record<string, string>).operationId;

    const record = getSkillInstallation(db, WORKTREE_ID, skill.id);
    expect(record).not.toBeNull();
    expect(record!.version).toBe(skill.version);
    expect(record!.operationId).toBe(operationId);

    const audit = listSkillOperationAudit(db, { worktreeId: WORKTREE_ID, skillId: skill.id });
    expect(audit).toHaveLength(1);
    expect(audit[0].result).toBe('succeeded');
    expect(audit[0].operation).toBe('install');
  });

  it('surfaces the installed Skill to Agent discovery from .agents/skills', async () => {
    expect(await loadAgentsSkills(worktreeDir)).toHaveLength(0);

    for (const skill of MVP_SKILLS) await installViaApi(skill.id);

    const discovered = await loadAgentsSkills(worktreeDir);
    expect(discovered.map((command) => command.name).sort()).toEqual(
      MVP_SKILLS.map((skill) => skill.name).sort()
    );
    for (const skill of MVP_SKILLS) {
      const entry = discovered.find((command) => command.name === skill.name);
      expect(entry?.filePath).toContain(path.join('.agents', 'skills', skill.id, 'SKILL.md'));
    }
  });

  it('removes every installed byte on uninstall and leaves the worktree as found', async () => {
    const before = snapshotTree(worktreeDir);

    for (const skill of MVP_SKILLS) await installViaApi(skill.id);
    expect(listSkillInstallations(db, WORKTREE_ID)).toHaveLength(3);

    for (const skill of MVP_SKILLS) {
      const body = await uninstallViaApi(skill.id);
      expect((body.operation as Record<string, string>).result).toBe('succeeded');
    }

    expect(listSkillInstallations(db, WORKTREE_ID)).toHaveLength(0);
    expect(await loadAgentsSkills(worktreeDir)).toHaveLength(0);

    const after = snapshotTree(worktreeDir);
    expect(treeDelta(before, after)).toEqual({ added: [], removed: [], changed: [] });
  });
});

// =============================================================================
// Change containment
// =============================================================================

describe('Skill MVP: change containment', () => {
  it('changes nothing in the worktree outside .agents/skills/<id>', async () => {
    const before = snapshotTree(worktreeDir);
    for (const skill of MVP_SKILLS) await installViaApi(skill.id);
    const after = snapshotTree(worktreeDir);

    const delta = treeDelta(before, after);
    expect(delta.removed).toEqual([]);
    expect(delta.changed).toEqual([]);

    const allowedPrefixes = MVP_SKILLS.map((skill) => `.agents/skills/${skill.id}/`);
    const outside = delta.added.filter(
      (file) => !allowedPrefixes.some((prefix) => file.startsWith(prefix))
    );
    expect(outside).toEqual([]);

    // Every added file is either a declared payload file or the one managed
    // metadata file the contract names.
    for (const skill of MVP_SKILLS) {
      const receipt = JSON.parse(
        readFileSync(
          path.join(installRootOf(worktreeDir, skill.id), SKILL_RECEIPT_FILENAME),
          'utf-8'
        )
      ) as { files: { path: string }[] };
      const declared = new Set([
        ...receipt.files.map((file) => `.agents/skills/${skill.id}/${file.path}`),
        `.agents/skills/${skill.id}/${SKILL_RECEIPT_FILENAME}`,
      ]);
      const forSkill = delta.added.filter((file) =>
        file.startsWith(`.agents/skills/${skill.id}/`)
      );
      expect(forSkill.filter((file) => !declared.has(file))).toEqual([]);
    }
  });

  it('leaves the git working tree clean except for the untracked install root', async () => {
    for (const skill of MVP_SKILLS) await installViaApi(skill.id);

    const status = git(worktreeDir, ['status', '--porcelain']);
    const lines = status.split('\n').filter((line) => line.length > 0);
    expect(lines).toEqual(['?? .agents/']);

    // Nothing tracked was modified: the diff against HEAD is empty.
    expect(git(worktreeDir, ['diff', 'HEAD', '--name-only'])).toBe('');
  });

  it('changes only the enumerated service-owned state root outside the worktree', async () => {
    const before = snapshotTree(configRoot, []);
    for (const skill of MVP_SKILLS) await installViaApi(skill.id);
    const after = snapshotTree(configRoot, []);

    const delta = treeDelta(before, after);
    expect(delta.removed).toEqual([]);
    expect(delta.changed).toEqual([]);

    const allowed = ['skills/journal/', 'skills/locks/', 'skills/package-staging/', 'data/skill-snapshots/'];
    expect(delta.added.filter((file) => !allowed.some((dir) => file.startsWith(dir)))).toEqual([]);
  });

  it('keeps the service state root and its snapshots private (0700 / 0400)', async () => {
    await installViaApi(MVP_SKILLS[0].id);

    expect(lstatSync(path.join(configRoot, 'skills')).mode & 0o777).toBe(0o700);
    expect(lstatSync(path.join(configRoot, 'skills', 'locks')).mode & 0o777).toBe(0o700);
    expect(lstatSync(path.join(configRoot, 'skills', 'journal')).mode & 0o777).toBe(0o700);

    const snapshotRoot = path.join(configRoot, 'data', 'skill-snapshots');
    expect(lstatSync(snapshotRoot).mode & 0o777).toBe(0o700);
    for (const [file, facts] of snapshotTree(snapshotRoot, [])) {
      expect(facts.mode, `snapshot ${file}`).toBe(0o400);
    }
  });
});

// =============================================================================
// Residue
// =============================================================================

describe('Skill MVP: no temporary residue', () => {
  it('leaves no staging directory, lock or orphaned reference after install', async () => {
    for (const skill of MVP_SKILLS) await installViaApi(skill.id);

    const residue = residueReport(configRoot, worktreeDir);
    expect(residue.locks).toEqual([]);
    expect(residue.packageStaging).toEqual([]);
    expect(residue.worktreeStaging).toEqual([]);
  });

  /**
   * Verified snapshots deliberately outlive the operation: #1229 keeps them as
   * a TTL cache so a retry does not re-download. What must not survive is a
   * *reference* — a snapshot still held at refcount > 0 is never evicted, so it
   * would leak for the process lifetime. Expiring the clock and sweeping proves
   * every reference was returned.
   */
  it('holds no snapshot reference once the operations finish', async () => {
    for (const skill of MVP_SKILLS) await installViaApi(skill.id);
    expect(getSkillSnapshotUsage().count).toBe(MVP_SKILLS.length);

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.setSystemTime(Date.now() + 31 * 60 * 1000);
      sweepSkillSnapshots();
      expect(getSkillSnapshotUsage()).toEqual({ count: 0, totalBytes: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves no residue after uninstall either', async () => {
    for (const skill of MVP_SKILLS) await installViaApi(skill.id);
    for (const skill of MVP_SKILLS) await uninstallViaApi(skill.id);

    const residue = residueReport(configRoot, worktreeDir);
    expect(residue.locks).toEqual([]);
    expect(residue.packageStaging).toEqual([]);
    expect(residue.worktreeStaging).toEqual([]);

    // Every installed byte is gone, and so is each Skill's own root...
    for (const skill of MVP_SKILLS) {
      expect(existsSync(installRootOf(worktreeDir, skill.id))).toBe(false);
    }
    expect(snapshotTree(worktreeDir).size).toBe(1); // README.md only

    // ...but `.agents/skills` itself is left in place, empty. uninstall only
    // rmdir's directories the receipt implies, so a directory the user (or an
    // earlier Skill) may still want is never collected. Documented as an MVP
    // known constraint rather than asserted away.
    expect(existsSync(path.join(worktreeDir, '.agents', 'skills'))).toBe(true);
    expect(listDirEntries(path.join(worktreeDir, '.agents', 'skills'))).toEqual([]);
  });

  it('leaves no residue when the plan is built but never applied', async () => {
    const response = await requestPlan(MVP_SKILLS[0].id);
    expect(response.status).toBe(200);

    const residue = residueReport(configRoot, worktreeDir);
    expect(residue.locks).toEqual([]);
    expect(residue.packageStaging).toEqual([]);
    expect(residue.worktreeStaging).toEqual([]);
    expect(existsSync(installRootOf(worktreeDir, MVP_SKILLS[0].id))).toBe(false);
  });
});

// =============================================================================
// CLI parity — same routes, same fixture Catalog
// =============================================================================

describe('Skill MVP: CLI and UI reach the same result through the same routes', () => {
  /**
   * Dispatch the CLI's `fetch` into the route handlers.
   *
   * No socket is opened, so a CommandMate server listening on port 3000 cannot
   * be reached even if `CM_PORT` is exported in the developer's shell. An
   * unrecognised path throws rather than falling through to the network.
   */
  function interceptCliFetch(): void {
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const asCli = true;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const install = url.pathname.match(
        /^\/api\/worktrees\/([^/]+)\/skills\/([^/]+)\/(plan|install|uninstall-plan|uninstall)$/
      );

      let response: Response;
      if (url.pathname === '/api/skills') {
        response = await listCatalog(new NextRequest(url.toString()) as never);
      } else if (install) {
        const skillId = install[2];
        const action = install[3];
        if (action === 'plan') response = await requestPlan(skillId, body, asCli);
        else if (action === 'install') response = await requestInstall(skillId, body, asCli);
        else if (action === 'uninstall-plan') response = await requestUninstallPlan(skillId, asCli);
        else response = await requestUninstall(skillId, body, asCli);
      } else {
        throw new Error(`CLI reached an unstubbed endpoint: ${url.pathname}`);
      }

      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        json: async () => JSON.parse(text),
        text: async () => text,
      } as Response;
    });
  }

  /** Captured CLI stderr, so an unexpected exit code reports its own reason. */
  function stderrOf(spy: { mock: { calls: unknown[][] } }): string {
    return spy.mock.calls.map((call) => call.join(' ')).join('\n') || '(no stderr)';
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('installs and uninstalls through the CLI command with the same on-disk result', async () => {
    interceptCliFetch();
    const { createSkillCommand } = await import('@/cli/commands/skill');

    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const skill = MVP_SKILLS[0];
      await createSkillCommand().parseAsync([
        'node', 'skill', 'install', skill.id,
        '--worktree', WORKTREE_ID, '--version', skill.version, '--yes',
      ]);

      expect(exit, stderrOf(error)).not.toHaveBeenCalled();
      expect(existsSync(path.join(installRootOf(worktreeDir, skill.id), 'SKILL.md'))).toBe(true);
      expect(getSkillInstallation(db, WORKTREE_ID, skill.id)).not.toBeNull();
      expect(await loadAgentsSkills(worktreeDir)).toHaveLength(1);

      await createSkillCommand().parseAsync([
        'node', 'skill', 'uninstall', skill.id, '--worktree', WORKTREE_ID, '--yes',
      ]);

      expect(exit, stderrOf(error)).not.toHaveBeenCalled();
      expect(existsSync(installRootOf(worktreeDir, skill.id))).toBe(false);
      expect(getSkillInstallation(db, WORKTREE_ID, skill.id)).toBeNull();
    } finally {
      exit.mockRestore();
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('refuses to write in a non-TTY session without --yes', async () => {
    interceptCliFetch();
    const { createSkillCommand } = await import('@/cli/commands/skill');

    const originalIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = undefined as unknown as boolean;
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const skill = MVP_SKILLS[0];
      await createSkillCommand().parseAsync([
        'node', 'skill', 'install', skill.id,
        '--worktree', WORKTREE_ID, '--version', skill.version,
      ]);

      expect(exit, stderrOf(error)).toHaveBeenCalledWith(12);
      expect(existsSync(installRootOf(worktreeDir, skill.id))).toBe(false);
    } finally {
      process.stdin.isTTY = originalIsTTY;
      exit.mockRestore();
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('binds a plan to the channel that created it', async () => {
    const skill = MVP_SKILLS[0];
    const planResponse = await requestPlan(skill.id, {}, false); // UI actor
    const plan = (await planResponse.json()) as { plan: Record<string, never> };

    // The CLI presenting a UI-issued token is a binding mismatch, not a write.
    const response = await requestInstall(
      skill.id,
      { planToken: plan.plan.token, version: skill.version, acknowledgeRisk: false },
      true
    );
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('SKILL_PLAN_BINDING_MISMATCH');
    expect(existsSync(installRootOf(worktreeDir, skill.id))).toBe(false);
  });
});

// =============================================================================
// Opt-in: the real published Catalog and releases
// =============================================================================

/**
 * The published Catalog is real and reachable, but CI must stay deterministic
 * and offline, so this runs only when explicitly enabled. When it is skipped
 * the reason is the skip name itself, not a silent absence.
 */
const REAL_CATALOG_ENABLED = process.env.CM_SKILLS_E2E_REAL_CATALOG === '1';

describe.skipIf(!REAL_CATALOG_ENABLED)(
  'Skill MVP: real published Catalog (opt-in via CM_SKILLS_E2E_REAL_CATALOG=1)',
  () => {
    it('fetches the official Catalog and finds the three MVP Skills', async () => {
      const actual = await vi.importActual<typeof import('@/lib/skills/catalog-client')>(
        '@/lib/skills/catalog-client'
      );
      const result = await actual.getSkillCatalog({ hostVersion: '0.11.4' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const ids = result.snapshot.catalog.entries.map((entry) => entry.id).sort();
      expect(ids).toEqual(MVP_SKILLS.map((skill) => skill.id).sort());
    }, 30_000);
  }
);

// =============================================================================
// Guard: the fixture Catalog is a test-only seam
// =============================================================================

describe('Skill MVP: the Catalog endpoint is not configurable', () => {
  it('is a hardcoded exact-match allowlist that no env var can widen', async () => {
    const config = await vi.importActual<typeof import('@/config/skill-catalog-config')>(
      '@/config/skill-catalog-config'
    );

    expect(config.SKILL_CATALOG_URL).toBe(
      'https://raw.githubusercontent.com/Kewton/commandmate-skills/main/catalog/v1/catalog.json'
    );
    expect(config.isAllowedSkillCatalogUrl(config.SKILL_CATALOG_URL)).toBe(true);

    // Prefix, subdomain and userinfo variants are all refused: the check is
    // exact string equality, not a prefix test.
    for (const candidate of [
      'https://raw.githubusercontent.com/Kewton/commandmate-skills/main/catalog/v1/catalog.json/evil',
      'https://raw.githubusercontent.com.evil.test/Kewton/commandmate-skills/main/catalog/v1/catalog.json',
      'https://user:pass@raw.githubusercontent.com/Kewton/commandmate-skills/main/catalog/v1/catalog.json',
      'http://raw.githubusercontent.com/Kewton/commandmate-skills/main/catalog/v1/catalog.json',
    ]) {
      expect(config.isAllowedSkillCatalogUrl(candidate), candidate).toBe(false);
    }

    // Setting the obvious override names changes nothing: the module reads none
    // of them. (Re-importing with the env set would pick up a value if one were
    // ever read at module scope.)
    for (const name of ['SKILL_CATALOG_URL', 'CM_SKILL_CATALOG_URL', 'CM_SKILLS_CATALOG']) {
      process.env[name] = 'https://evil.test/catalog.json';
    }
    try {
      vi.resetModules();
      const reimported = await vi.importActual<typeof import('@/config/skill-catalog-config')>(
        '@/config/skill-catalog-config'
      );
      expect(reimported.SKILL_CATALOG_URL).toBe(config.SKILL_CATALOG_URL);
      expect(reimported.isAllowedSkillCatalogUrl('https://evil.test/catalog.json')).toBe(false);
    } finally {
      for (const name of ['SKILL_CATALOG_URL', 'CM_SKILL_CATALOG_URL', 'CM_SKILLS_CATALOG']) {
        delete process.env[name];
      }
    }
  });

  it('never exposes an artifact URL through the read-only Catalog API', async () => {
    const response = await listCatalog(new NextRequest('http://localhost/api/skills') as never);
    const text = await response.text();
    expect(text).not.toContain('releases/download');
    expect(text).not.toContain('"url"');
  });
});
