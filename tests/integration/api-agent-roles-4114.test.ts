/**
 * The role API, driven through the routes (Issue #4114).
 *
 * Repository lifetime is checked through the real DELETE and restore routes, and
 * the duplicate-root case through real git worktrees: the shape of what `git`
 * says is what the resolution rests on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree, getWorktreeById } from '@/lib/db';
import {
  createRepository,
  deleteRepository,
  getRepositoryByPath,
} from '@/lib/db/db-repository';
import {
  getAgentInstances,
  setAgentInstances,
} from '@/lib/db/agent-instances-db';
import {
  getInstanceRoleState,
  recordRoleLaunch,
} from '@/lib/db/agent-roles-db';
import type { Worktree } from '@/types/models';
import {
  errorExample,
  instanceCreateExample,
  instanceSettingsExample,
  repositoryDefaultsExample,
  roleDeleteConflictExample,
  roleDeleteExample,
  roleDetailExample,
  roleEditExample,
  roleListExample,
  systemDefaultsExample,
} from './fixtures/agent-roles-api-examples';

let testDb: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => testDb,
}));

vi.mock('@/lib/session-cleanup', async () => {
  const db = await vi.importActual<typeof import('@/lib/db')>('@/lib/db');
  return {
    cleanupMultipleWorktrees: vi.fn().mockResolvedValue({ results: [], warnings: [] }),
    killWorktreeSession: vi.fn().mockResolvedValue(false),
    createOwnedSessionKiller: vi.fn(() => vi.fn().mockResolvedValue(false)),
    syncWorktreesAndCleanup: vi.fn(async (database: Database.Database, worktrees: Worktree[]) => {
      for (const worktree of worktrees) db.upsertWorktree(database, worktree);
      return { syncResult: { deletedIds: [] }, cleanupWarnings: [] };
    }),
  };
});

vi.mock('@/lib/ws-server', () => ({
  broadcast: vi.fn(),
  broadcastMessage: vi.fn(),
  cleanupRooms: vi.fn(),
}));

// The temp directory is under /var or /tmp, which repository routes refuse.
vi.mock('@/config/system-directories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/config/system-directories')>()),
  isSystemDirectory: () => false,
}));

const scanned = vi.hoisted(() => ({ worktrees: [] as Worktree[] }));
vi.mock('@/lib/git/worktrees', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/git/worktrees')>()),
  scanWorktrees: vi.fn(async () => scanned.worktrees),
}));

import * as rolesRoute from '@/app/api/roles/route';
import * as roleRoute from '@/app/api/roles/[id]/route';
import * as systemDefaultsRoute from '@/app/api/settings/agent-role-defaults/route';
import * as repositoryDefaultsRoute from '@/app/api/repositories/[id]/role-defaults/route';
import * as instanceRolesRoute from '@/app/api/worktrees/[id]/instances/roles/route';
import { DELETE as deleteRepositoryRoute } from '@/app/api/repositories/route';
import { PUT as restoreRepositoryRoute } from '@/app/api/repositories/restore/route';
import { PUT as updateRepositoryRoute } from '@/app/api/repositories/[id]/route';

function request(url: string, method: string, body?: unknown): NextRequest {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const req = new Request(`http://localhost:3000${url}`, init) as unknown as NextRequest;
  Object.defineProperty(req, 'nextUrl', { value: new URL(`http://localhost:3000${url}`) });
  return req;
}
const params = <T,>(value: T) => ({ params: Promise.resolve(value) });

async function createRole(name = 'Marketer', body = 'あなたはマーケターです。'): Promise<{ id: string; bodyVersion: number }> {
  const response = await rolesRoute.POST(request('/api/roles', 'POST', { name, body }));
  expect(response.status).toBe(201);
  return (await response.json()).role;
}

const WT = 'wt-4114';

function worktree(id: string, path: string, repositoryPath: string): Worktree {
  return {
    id,
    name: id,
    path,
    repositoryPath,
    repositoryName: 'repo',
  } as Worktree;
}

async function repoDefaults(repositoryId: string) {
  const response = await repositoryDefaultsRoute.GET(
    request(`/api/repositories/${repositoryId}/role-defaults`, 'GET'),
    params({ id: repositoryId })
  );
  return { status: response.status, body: await response.json() };
}
const putRepoDefault = (repositoryId: string, cliToolId: string, role: unknown) =>
  repositoryDefaultsRoute.PUT(
    request(`/api/repositories/${repositoryId}/role-defaults`, 'PUT', { cliToolId, role }),
    params({ id: repositoryId })
  );
const getInstances = async (id = WT) => {
  const response = await instanceRolesRoute.GET(request(`/api/worktrees/${id}/instances/roles`, 'GET'), params({ id }));
  return { status: response.status, body: await response.json() };
};
const putInstance = (instanceId: string, role: unknown, id = WT) =>
  instanceRolesRoute.PUT(
    request(`/api/worktrees/${id}/instances/roles`, 'PUT', { instanceId, role }),
    params({ id })
  );
const postInstance = (body: unknown, id = WT) =>
  instanceRolesRoute.POST(request(`/api/worktrees/${id}/instances/roles`, 'POST', body), params({ id }));

/** Same keys, recursively. Arrays compare their first element. */
function keysOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.length > 0 ? [keysOf(value[0])] : [];
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, keysOf(entry)])
    );
  }
  return typeof value === 'object' ? 'null' : typeof value;
}

describe('role API', () => {
  let base: string;

  beforeEach(() => {
    testDb = new Database(':memory:');
    runMigrations(testDb);
    base = realpathSync(mkdtempSync(join(tmpdir(), 'cm-role-api-')));
    testDb
      .prepare(
        `INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES (?, ?, ?, ?, 'repo')`
      )
      .run(WT, WT, join(base, 'wt'), join(base, 'repo'));
    scanned.worktrees = [];
    vi.clearAllMocks();
  });
  afterEach(() => {
    testDb.close();
    rmSync(base, { recursive: true, force: true });
  });

  describe('/api/roles', () => {
    it('lists without the body and returns it on request', async () => {
      const role = await createRole();
      const list = await (await rolesRoute.GET()).json();
      expect(list.roles).toHaveLength(1);
      expect(list.roles[0].body).toBeUndefined();
      expect(list.roles[0].bodyBytes).toBe(Buffer.byteLength('あなたはマーケターです。'));

      const detail = await (await roleRoute.GET(request(`/api/roles/${role.id}`, 'GET'), params({ id: role.id }))).json();
      expect(detail.role.body).toBe('あなたはマーケターです。');
    });

    it.each([
      ['blank body', { name: 'a', body: '  \n ' }],
      ['empty body', { name: 'a', body: '' }],
      ['oversized body', { name: 'a', body: 'x'.repeat(16385) }],
      ['missing name', { body: 'x' }],
      ['non-string body', { name: 'a', body: 1 }],
    ])('answers 400 for %s', async (_label, body) => {
      const response = await rolesRoute.POST(request('/api/roles', 'POST', body));
      expect(response.status).toBe(400);
      expect((await response.json()).success).toBe(false);
    });

    it('answers 400 for a malformed body, not 500', async () => {
      expect((await rolesRoute.POST(request('/api/roles', 'POST', '{nope'))).status).toBe(400);
    });

    it('answers 409 for a duplicate name', async () => {
      await createRole('Same');
      const response = await rolesRoute.POST(request('/api/roles', 'POST', { name: 'Same', body: 'y' }));
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe('name_conflict');
    });

    it('the edit reports before, after, the version and what it affects', async () => {
      const role = await createRole();
      const response = await roleRoute.PUT(
        request(`/api/roles/${role.id}`, 'PUT', { body: '新しい本文', expectedBodyVersion: 1 }),
        params({ id: role.id })
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.bodyVersion).toBe(2);
      expect(body.before.bodyVersion).toBe(1);
      expect(body.after.body).toBe('新しい本文');
    });

    it('a stale edit answers 409 with the current version', async () => {
      const role = await createRole();
      const put = (expectedBodyVersion: number, body: string) =>
        roleRoute.PUT(request(`/api/roles/${role.id}`, 'PUT', { body, expectedBodyVersion }), params({ id: role.id }));
      await put(1, 'second');
      const response = await put(1, 'third');
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toBe('version_conflict');
      expect(body.currentBodyVersion).toBe(2);
    });

    it('an unknown id answers 404', async () => {
      expect((await roleRoute.GET(request('/api/roles/x', 'GET'), params({ id: 'x' }))).status).toBe(404);
      expect((await roleRoute.PUT(request('/api/roles/x', 'PUT', { body: 'y' }), params({ id: 'x' }))).status).toBe(404);
      expect((await roleRoute.DELETE(request('/api/roles/x', 'DELETE'), params({ id: 'x' }))).status).toBe(404);
    });

    it('deleting a role in use answers 409 with the references; force removes them and says which', async () => {
      const role = await createRole();
      const repo = createRepository(testDb, { name: 'r', path: join(base, 'repo'), cloneSource: 'local' });
      await putRepoDefault(repo.id, 'claude', { state: 'role', roleId: role.id });
      await putInstance('claude', { state: 'role', roleId: role.id });
      await systemDefaultsRoute.PUT(
        request('/api/settings/agent-role-defaults', 'PUT', { cliToolId: 'claude', roleId: role.id })
      );

      const refused = await roleRoute.DELETE(request(`/api/roles/${role.id}`, 'DELETE'), params({ id: role.id }));
      expect(refused.status).toBe(409);
      const conflict = await refused.json();
      expect(conflict.error).toBe('role_in_use');
      expect(conflict.references.instances).toEqual([{ worktreeId: WT, instanceId: 'claude' }]);

      recordRoleLaunch(testDb, {
        worktreeId: WT,
        instanceId: 'claude',
        cliToolId: 'claude',
        phase: 'requested',
        sessionGeneration: 'g1',
        source: 'instance',
        repositoryId: repo.id,
        roleId: role.id,
        roleName: 'Marketer',
        bodyVersion: 1,
        bodyFingerprint: 'a'.repeat(64),
        injectionFingerprint: null,
        artifactFingerprint: null,
        adapterId: 'claude',
        adapterVersion: null,
        wrapperVersion: null,
        artifactPath: null,
        effectiveAgent: null,
        compositionSourceFingerprint: null,
        noRoleReason: null,
      });

      const forced = await roleRoute.DELETE(
        request(`/api/roles/${role.id}?force=true`, 'DELETE'),
        params({ id: role.id })
      );
      expect(forced.status).toBe(200);
      const body = await forced.json();
      expect(body.affected.repositories).toHaveLength(1);
      expect(body.affected.system).toHaveLength(1);

      // The evidence stays, and the settings read as inherit rather than none.
      const after = await getInstances();
      const claude = after.body.instances.find((i: { instanceId: string }) => i.instanceId === 'claude');
      expect(claude.stored).toEqual({ state: 'inherit' });
      expect(claude.application.requested.roleId).toBe(role.id);
      expect((await repoDefaults(repo.id)).body.defaults.find((d: { cliToolId: string }) => d.cliToolId === 'claude').stored).toEqual({
        state: 'inherit',
      });
    });

    it('never logs a body', async () => {
      const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errored = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const role = await createRole('Logged', 'BODY-MARKER-4114');
        await roleRoute.PUT(request(`/api/roles/${role.id}`, 'PUT', { body: 'BODY-MARKER-4114-2' }), params({ id: role.id }));
        await rolesRoute.POST(request('/api/roles', 'POST', { name: 'Logged', body: 'BODY-MARKER-4114-3' }));
        for (const spy of [logged, errored, warned]) {
          expect(JSON.stringify(spy.mock.calls)).not.toContain('BODY-MARKER');
        }
      } finally {
        logged.mockRestore();
        errored.mockRestore();
        warned.mockRestore();
      }
    });
  });

  describe('/api/settings/agent-role-defaults', () => {
    const get = async () => (await systemDefaultsRoute.GET()).json();
    const put = (body: unknown) =>
      systemDefaultsRoute.PUT(request('/api/settings/agent-role-defaults', 'PUT', body));

    it('sets, clears and lists only the supported tools', async () => {
      const role = await createRole();
      expect((await get()).defaults.map((d: { cliToolId: string }) => d.cliToolId)).not.toContain('gemini');

      expect((await put({ cliToolId: 'codex', roleId: role.id })).status).toBe(200);
      const codex = (await get()).defaults.find((d: { cliToolId: string }) => d.cliToolId === 'codex');
      expect(codex.stored).toEqual({ state: 'role', roleId: role.id, roleName: 'Marketer' });

      expect((await put({ cliToolId: 'codex', roleId: null })).status).toBe(200);
      expect((await get()).defaults.find((d: { cliToolId: string }) => d.cliToolId === 'codex').stored).toEqual({
        state: 'unset',
      });
    });

    it('antigravity is settable but marked as not enabled', async () => {
      const antigravity = (await get()).defaults.find((d: { cliToolId: string }) => d.cliToolId === 'antigravity');
      expect(antigravity.adapterEnabled).toBe(false);
    });

    it('refuses an unsupported tool, an unknown tool and an unknown role', async () => {
      const role = await createRole();
      expect((await put({ cliToolId: 'gemini', roleId: role.id })).status).toBe(400);
      expect((await put({ cliToolId: 'nope', roleId: role.id })).status).toBe(400);
      expect((await put({ cliToolId: 'claude', roleId: 'missing' })).status).toBe(404);
      expect((await put({ cliToolId: 'claude' })).status).toBe(400);
    });
  });

  describe('/api/repositories/[id]/role-defaults', () => {
    it('reports the stored state and the effective result in separate fields', async () => {
      const role = await createRole();
      const repo = createRepository(testDb, { name: 'r', path: join(base, 'repo'), cloneSource: 'local' });
      await systemDefaultsRoute.PUT(
        request('/api/settings/agent-role-defaults', 'PUT', { cliToolId: 'claude', roleId: role.id })
      );

      const entry = (await repoDefaults(repo.id)).body.defaults.find(
        (d: { cliToolId: string }) => d.cliToolId === 'claude'
      );
      expect(entry.stored).toEqual({ state: 'inherit' });
      expect(entry.effective).toMatchObject({ kind: 'role', source: 'system', role: { id: role.id } });
      expect(entry.effective.role.body).toBeUndefined();

      expect((await putRepoDefault(repo.id, 'claude', { state: 'none' })).status).toBe(200);
      const none = (await repoDefaults(repo.id)).body.defaults.find(
        (d: { cliToolId: string }) => d.cliToolId === 'claude'
      );
      expect(none.stored).toEqual({ state: 'none' });
      expect(none.effective).toMatchObject({ kind: 'none', source: 'repository', reason: 'explicit-none' });
    });

    it('refuses bad input and an unknown repository', async () => {
      const repo = createRepository(testDb, { name: 'r', path: join(base, 'repo'), cloneSource: 'local' });
      expect((await putRepoDefault(repo.id, 'gemini', { state: 'none' })).status).toBe(400);
      expect((await putRepoDefault(repo.id, 'claude', { state: 'bogus' })).status).toBe(400);
      expect((await putRepoDefault(repo.id, 'claude', { state: 'role' })).status).toBe(400);
      expect((await putRepoDefault(repo.id, 'claude', { state: 'role', roleId: 'x' })).status).toBe(404);
      expect((await putRepoDefault('nope', 'claude', { state: 'none' })).status).toBe(404);
      expect((await repoDefaults('nope')).status).toBe(404);
    });
  });

  describe('repository lifetime, through the API', () => {
    let repoPath: string;
    let repositoryId: string;
    let roleId: string;

    beforeEach(async () => {
      repoPath = join(base, 'repo');
      mkdirSync(repoPath, { recursive: true });
      repositoryId = createRepository(testDb, { name: 'r', path: repoPath, cloneSource: 'local' }).id;
      roleId = (await createRole()).id;
      await putRepoDefault(repositoryId, 'claude', { state: 'role', roleId });
      await putInstance('claude', { state: 'role', roleId });
      scanned.worktrees = [worktree(WT, join(base, 'wt'), repoPath)];
    });

    const claudeDefault = async () =>
      (await repoDefaults(repositoryId)).body.defaults.find((d: { cliToolId: string }) => d.cliToolId === 'claude').stored;

    it('disabling keeps the default', async () => {
      const response = await updateRepositoryRoute(
        request(`/api/repositories/${repositoryId}`, 'PUT', { enabled: false }),
        params({ id: repositoryId })
      );
      expect(response.status).toBe(200);
      expect(await claudeDefault()).toMatchObject({ state: 'role', roleId });
    });

    it('DELETE keeps the default and removes the individual setting; restore reuses the id and does not revive it', async () => {
      const deleted = await deleteRepositoryRoute(request('/api/repositories', 'DELETE', { repositoryPath: repoPath }));
      expect(deleted.status).toBe(200);
      expect(getWorktreeById(testDb, WT)).toBeNull();
      expect(getRepositoryByPath(testDb, repoPath)?.id).toBe(repositoryId);
      expect(await claudeDefault()).toMatchObject({ state: 'role', roleId });

      const restored = await restoreRepositoryRoute(
        request('/api/repositories/restore', 'PUT', { repositoryPath: repoPath })
      );
      expect(restored.status).toBe(200);
      expect(getRepositoryByPath(testDb, repoPath)?.id).toBe(repositoryId);
      expect(await claudeDefault()).toMatchObject({ state: 'role', roleId });

      expect(getWorktreeById(testDb, WT)).not.toBeNull();
      expect(getInstanceRoleState(testDb, WT, 'claude')).toEqual({ state: 'inherit' });
      // The worktree came back under the repository's default, not its old setting.
      const claude = (await getInstances()).body.instances.find((i: { instanceId: string }) => i.instanceId === 'claude');
      expect(claude.application.effectiveNext).toMatchObject({ kind: 'role', source: 'repository', repositoryId });
    });

    it('a physical delete loses the default; registering the same path does not bring it back', async () => {
      expect(deleteRepository(testDb, repositoryId)).toBe(true);
      const again = createRepository(testDb, { name: 'r', path: repoPath, cloneSource: 'local' });
      expect(again.id).not.toBe(repositoryId);
      const entry = (await repoDefaults(again.id)).body.defaults.find(
        (d: { cliToolId: string }) => d.cliToolId === 'claude'
      );
      expect(entry.stored).toEqual({ state: 'inherit' });
    });
  });

  describe('duplicate roots, with real git', () => {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });

    it('a repository registered at two checkouts answers the same for both, and ambiguous when they differ', async () => {
      const main = join(base, 'main');
      const linked = join(base, 'linked');
      const wtPath = join(base, 'feature');
      mkdirSync(main);
      git(main, 'init', '-q');
      git(main, '-c', 'user.email=a@example.com', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'x');
      git(main, 'worktree', 'add', '-q', '-b', 'linked', linked);
      git(main, 'worktree', 'add', '-q', '-b', 'feature', wtPath);
      testDb.prepare('UPDATE worktrees SET path = ?, repository_path = ? WHERE id = ?').run(wtPath, main, WT);

      const a = createRepository(testDb, { name: 'a', path: main, cloneSource: 'local' }).id;
      const b = createRepository(testDb, { name: 'b', path: linked, cloneSource: 'local' }).id;
      const role = await createRole();
      await putRepoDefault(a, 'claude', { state: 'role', roleId: role.id });

      const effective = async () =>
        (await getInstances()).body.instances.find((i: { instanceId: string }) => i.instanceId === 'claude').application
          .effectiveNext;

      expect(await effective()).toMatchObject({ kind: 'ambiguous', reason: 'root-settings-differ' });
      testDb.prepare('UPDATE worktrees SET repository_path = ? WHERE id = ?').run(linked, WT);
      expect(await effective()).toMatchObject({ kind: 'ambiguous', reason: 'root-settings-differ' });

      await putRepoDefault(b, 'claude', { state: 'role', roleId: role.id });
      expect(await effective()).toMatchObject({ kind: 'role', source: 'repository' });
      testDb.prepare('UPDATE worktrees SET repository_path = ? WHERE id = ?').run(main, WT);
      expect(await effective()).toMatchObject({ kind: 'role', source: 'repository' });

      // The management view answers from the same resolution.
      const entry = (await repoDefaults(a)).body.defaults.find((d: { cliToolId: string }) => d.cliToolId === 'claude');
      expect(entry.effective).toMatchObject({ kind: 'role', source: 'repository' });
    });
  });

  describe('/api/worktrees/[id]/instances/roles', () => {
    it('a derived primary can be set without saving a roster', async () => {
      const role = await createRole();
      const before = await getInstances();
      expect(before.body.rosterSaved).toBe(false);
      expect(before.body.instances.length).toBeGreaterThan(0);

      const response = await putInstance('claude', { state: 'role', roleId: role.id });
      expect(response.status).toBe(200);
      expect(getAgentInstances(testDb, WT)).toEqual([]);

      const claude = (await response.json()).instances.find((i: { instanceId: string }) => i.instanceId === 'claude');
      expect(claude.stored).toMatchObject({ state: 'role', roleId: role.id });
      expect(claude.application.effectiveNext).toMatchObject({ kind: 'role', source: 'instance' });
    });

    it('an id that is in no roster answers 404 and writes no row', async () => {
      const response = await putInstance('ghost', { state: 'none' });
      expect(response.status).toBe(404);
      expect(testDb.prepare('SELECT COUNT(*) AS c FROM agent_instance_roles').get()).toEqual({ c: 0 });
    });

    it('a tool the feature does not cover refuses a setting', async () => {
      setAgentInstances(testDb, WT, [{ id: 'gemini', cliTool: 'gemini', alias: 'g', order: 0 }]);
      const response = await putInstance('gemini', { state: 'none' });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('tool_not_supported');
      const listed = (await getInstances()).body.instances[0];
      expect(listed.supported).toBe(false);
      expect(listed.application.effectiveNext).toMatchObject({ kind: 'none', source: 'unsupported' });
    });

    it('answers 400 for a bad state and 404 for an unknown worktree or role', async () => {
      expect((await putInstance('claude', { state: 'bogus' })).status).toBe(400);
      expect((await putInstance('claude', { state: 'role', roleId: 'nope' })).status).toBe(404);
      expect((await putInstance('claude', { state: 'none' }, 'no-such')).status).toBe(404);
      expect((await getInstances('no-such')).status).toBe(404);
    });

    it('reads the defaults before any instance exists, for the add dialog', async () => {
      const role = await createRole();
      await systemDefaultsRoute.PUT(
        request('/api/settings/agent-role-defaults', 'PUT', { cliToolId: 'copilot', roleId: role.id })
      );
      const { body } = await getInstances();
      const copilot = body.toolDefaults.find((d: { cliToolId: string }) => d.cliToolId === 'copilot');
      expect(copilot.effective).toMatchObject({ kind: 'role', source: 'system' });
    });

    describe('POST: create with a role', () => {
      it('creates, keeps the derived roster, and answers the roster and the setting together', async () => {
        const role = await createRole();
        const derivedIds = (await getInstances()).body.instances.map((i: { instanceId: string }) => i.instanceId);

        const response = await postInstance({
          instance: { id: 'codex-2', cliTool: 'codex', alias: 'レビュー' },
          role: { state: 'role', roleId: role.id },
        });
        expect(response.status).toBe(201);
        const body = await response.json();
        expect(body.created.instanceId).toBe('codex-2');
        expect(body.instances.map((i: { instanceId: string }) => i.instanceId)).toEqual([...derivedIds, 'codex-2']);
        const created = body.instances.find((i: { instanceId: string }) => i.instanceId === 'codex-2');
        expect(created.stored).toMatchObject({ state: 'role', roleId: role.id });
        expect(created.application.effectiveNext).toMatchObject({ kind: 'role', source: 'instance' });
        expect(body.rosterSaved).toBe(true);
      });

      it('the setting of a derived primary survives the first roster save this causes', async () => {
        await putInstance('claude', { state: 'none' });
        const response = await postInstance({ instance: { id: 'codex-2', cliTool: 'codex' } });
        expect(response.status).toBe(201);
        expect(getInstanceRoleState(testDb, WT, 'claude')).toEqual({ state: 'none' });
        expect(getInstanceRoleState(testDb, WT, 'codex-2')).toEqual({ state: 'inherit' });
      });

      it('an unknown role leaves no instance behind', async () => {
        const before = getAgentInstances(testDb, WT);
        const response = await postInstance({
          instance: { id: 'codex-2', cliTool: 'codex' },
          role: { state: 'role', roleId: 'nope' },
        });
        expect(response.status).toBe(404);
        expect(getAgentInstances(testDb, WT)).toEqual(before);
      });

      it('a failure inside the role write rolls the instance back too', async () => {
        testDb.exec(`
          CREATE TRIGGER fail_role_write BEFORE INSERT ON agent_instance_roles
          BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;
        `);
        const response = await postInstance({
          instance: { id: 'codex-2', cliTool: 'codex' },
          role: { state: 'none' },
        });
        expect(response.status).toBe(500);
        expect(getAgentInstances(testDb, WT)).toEqual([]);
      });

      it.each([
        ['an invalid id', { instance: { id: 'bad id!', cliTool: 'codex' } }],
        ['an unknown tool', { instance: { id: 'x1', cliTool: 'nope' } }],
        ['a primary id on the wrong tool', { instance: { id: 'copilot', cliTool: 'claude' } }],
        ['a bad state', { instance: { id: 'x1', cliTool: 'codex' }, role: { state: 'bogus' } }],
        ['a role on a tool out of scope', { instance: { id: 'x1', cliTool: 'gemini' }, role: { state: 'none' } }],
        ['no instance', {}],
      ])('answers 400 for %s and creates nothing', async (_label, body) => {
        const response = await postInstance(body);
        expect(response.status).toBe(400);
        expect(getAgentInstances(testDb, WT)).toEqual([]);
      });

      it('an id already in the roster answers 409', async () => {
        await postInstance({ instance: { id: 'codex-2', cliTool: 'codex' } });
        const response = await postInstance({ instance: { id: 'codex-2', cliTool: 'codex' } });
        expect(response.status).toBe(409);
        expect((await response.json()).error).toBe('instance_exists');
      });

      it('a derived primary in the current list also counts as existing', async () => {
        const first = (await getInstances()).body.instances[0];
        const response = await postInstance({ instance: { id: first.instanceId, cliTool: first.cliToolId } });
        expect(response.status).toBe(409);
      });

      it('refuses past the roster limit', async () => {
        setAgentInstances(
          testDb,
          WT,
          Array.from({ length: 10 }, (_, order) => ({ id: `c${order}`, cliTool: 'codex' as const, alias: 'x', order }))
        );
        expect((await postInstance({ instance: { id: 'c10', cliTool: 'codex' } })).status).toBe(400);
      });

      it('a stale roster revision answers 409 and changes nothing', async () => {
        const stale = (await getInstances()).body.rosterRevision;
        await postInstance({ instance: { id: 'first', cliTool: 'codex' } });
        const response = await postInstance({
          instance: { id: 'second', cliTool: 'codex' },
          expectedRosterRevision: stale,
        });
        expect(response.status).toBe(409);
        expect((await response.json()).error).toBe('roster_changed');
        expect(getAgentInstances(testDb, WT).map((i) => i.id)).not.toContain('second');
      });

      it('the current revision goes through; an alias edit moves the revision', async () => {
        const { rosterRevision } = (await getInstances()).body;
        const response = await postInstance({
          instance: { id: 'first', cliTool: 'codex' },
          expectedRosterRevision: rosterRevision,
        });
        expect(response.status).toBe(201);
        const after = (await response.json()).rosterRevision;
        expect(after).not.toBe(rosterRevision);

        const roster = getAgentInstances(testDb, WT).map((i) => (i.id === 'first' ? { ...i, alias: 'Renamed' } : i));
        setAgentInstances(testDb, WT, roster);
        expect((await getInstances()).body.rosterRevision).not.toBe(after);
      });
    });
  });

  describe('the worked examples for #4116 and #4117', () => {
    it('have the keys the routes really answer', async () => {
      const role = await createRole();
      const repo = createRepository(testDb, { name: 'r', path: join(base, 'repo'), cloneSource: 'local' });

      expect(keysOf(await (await rolesRoute.GET()).json())).toEqual(keysOf(roleListExample));

      await systemDefaultsRoute.PUT(
        request('/api/settings/agent-role-defaults', 'PUT', { cliToolId: 'claude', roleId: role.id })
      );
      const detail = await (await roleRoute.GET(request(`/api/roles/${role.id}`, 'GET'), params({ id: role.id }))).json();
      expect(keysOf(detail)).toEqual(keysOf({ ...roleDetailExample, references: { instances: [], repositories: [], system: [{ cliToolId: 'claude' }] } }));

      const edit = await (
        await roleRoute.PUT(request(`/api/roles/${role.id}`, 'PUT', { body: 'next' }), params({ id: role.id }))
      ).json();
      expect(Object.keys(edit).sort()).toEqual(Object.keys(roleEditExample).sort());

      const conflict = await (await roleRoute.DELETE(request(`/api/roles/${role.id}`, 'DELETE'), params({ id: role.id }))).json();
      expect(Object.keys(conflict).sort()).toEqual(Object.keys(roleDeleteConflictExample).sort());

      const defaults = await (await systemDefaultsRoute.GET()).json();
      expect(Object.keys(defaults).sort()).toEqual(Object.keys(systemDefaultsExample).sort());
      expect(Object.keys(defaults.defaults[0]).sort()).toEqual(Object.keys(systemDefaultsExample.defaults[0]).sort());

      const repository = (await repoDefaults(repo.id)).body;
      expect(Object.keys(repository).sort()).toEqual(Object.keys(repositoryDefaultsExample).sort());
      expect(Object.keys(repository.repository).sort()).toEqual(Object.keys(repositoryDefaultsExample.repository).sort());
      expect(Object.keys(repository.defaults[0]).sort()).toEqual(Object.keys(repositoryDefaultsExample.defaults[0]).sort());

      const settings = (await getInstances()).body;
      expect(Object.keys(settings).sort()).toEqual(Object.keys(instanceSettingsExample).sort());
      expect(Object.keys(settings.instances[0]).sort()).toEqual(Object.keys(instanceSettingsExample.instances[0]).sort());
      expect(Object.keys(settings.instances[0].application).sort()).toEqual(
        Object.keys(instanceSettingsExample.instances[0].application).sort()
      );

      const created = await (await postInstance({ instance: { id: 'codex-2', cliTool: 'codex' } })).json();
      expect(Object.keys(created).sort()).toEqual(Object.keys(instanceCreateExample).sort());

      const forced = await (
        await roleRoute.DELETE(request(`/api/roles/${role.id}?force=true`, 'DELETE'), params({ id: role.id }))
      ).json();
      expect(Object.keys(forced).sort()).toEqual(Object.keys(roleDeleteExample).sort());

      const refused = await (await putInstance('ghost', { state: 'none' })).json();
      expect(Object.keys(refused).sort()).toEqual(Object.keys(errorExample).sort());
    });
  });

  it('does not touch upsertWorktree behaviour: a re-scan keeps the individual setting (negative control)', async () => {
    const role = await createRole();
    await putInstance('claude', { state: 'role', roleId: role.id });
    upsertWorktree(testDb, worktree(WT, join(base, 'wt'), join(base, 'other-root')));
    expect(getInstanceRoleState(testDb, WT, 'claude').state).toBe('role');
  });
});
