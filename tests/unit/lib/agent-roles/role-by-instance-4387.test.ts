/**
 * The role of every instance at once (Issue #4387): the same answers as the
 * per-worktree read, with git asked about each path once for the whole server.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { createRepository } from '@/lib/db/db-repository';
import {
  createAgentRole,
  getAllInstanceRoleStates,
  getAllLatestLaunchedRoles,
  hasAnyRepositoryRoleDefault,
  instanceRoleKey,
  recordRoleLaunch,
  setInstanceRoleState,
  setRepositoryRoleState,
  setSystemRoleDefault,
} from '@/lib/db/agent-roles-db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import { buildInstanceRoleSettings } from '@/lib/agent-roles/management';
import { buildRoleByInstance } from '@/lib/agent-roles/role-by-instance';
import type { RoleResolverDeps } from '@/lib/agent-roles/resolve';
import type { InstanceRoleSummary, RoleLaunchSnapshotInput } from '@/types/agent-roles';

const ROOT_A = '/tmp/cm-4387/root-a';
const ROOT_B = '/tmp/cm-4387/root-b';
const ROOT_C = '/tmp/cm-4387/root-c';

function insertWorktree(db: Database.Database, id: string, repositoryPath: string): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES (?, ?, ?, ?, 'repo')`
  ).run(id, id, `/tmp/cm-4387/${id}`, repositoryPath);
}

/** Git as a table: path → common dir. Unlisted paths are repository `/common/.git`. */
function fakeGit(table: Record<string, string | null> = {}, existing: readonly string[] = []) {
  const asked: string[] = [];
  const deps: RoleResolverDeps = {
    resolveCommonDir: async (path) => {
      asked.push(path);
      return path in table ? table[path] : '/common/.git';
    },
    pathExists: (path) => existing.includes(path),
  };
  return { deps, asked };
}

function launched(worktreeId: string, instanceId: string, generation: string, role: { id: string; name: string } | null): RoleLaunchSnapshotInput {
  return {
    worktreeId,
    instanceId,
    cliToolId: 'claude',
    phase: 'launched',
    sessionGeneration: generation,
    source: role ? 'instance' : 'fallback',
    repositoryId: null,
    roleId: role?.id ?? null,
    roleName: role?.name ?? null,
    bodyVersion: role ? 1 : null,
    bodyFingerprint: role ? 'a'.repeat(64) : null,
    injectionFingerprint: role ? 'b'.repeat(64) : null,
    artifactFingerprint: null,
    adapterId: 'claude',
    adapterVersion: null,
    wrapperVersion: null,
    artifactPath: null,
    effectiveAgent: null,
    compositionSourceFingerprint: null,
    noRoleReason: role ? null : 'no-default',
  };
}

describe('[#4387] buildRoleByInstance', () => {
  let db: Database.Database;
  let roleX: string;
  let roleY: string;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    roleX = createAgentRole(db, { name: 'X', body: 'x' }).id;
    roleY = createAgentRole(db, { name: 'Y', body: 'y' }).id;
  });
  afterEach(() => db.close());

  const register = (path: string): string => createRepository(db, { name: path, path, cloneSource: 'local' }).id;

  /** What the per-worktree read says the next start uses, in the summary's terms. */
  async function perWorktree(worktreeId: string, deps: RoleResolverDeps): Promise<Record<string, InstanceRoleSummary>> {
    const settings = await buildInstanceRoleSettings(db, worktreeId, deps);
    return Object.fromEntries(
      settings.instances.map(({ instanceId, application: { effectiveNext: next } }) => [
        instanceId,
        next.kind === 'role'
          ? { kind: 'role', roleId: next.role.id, roleName: next.role.name, basis: 'setting' }
          : { kind: next.kind },
      ])
    );
  }

  it('answers what the per-worktree read answers, for every kind of answer', async () => {
    // Repository one at ROOT_A; repository two checked out at ROOT_B and ROOT_D; three at ROOT_C.
    const ROOT_D = '/tmp/cm-4387/root-d';
    const a = register(ROOT_A);
    const b = register(ROOT_B);
    const d = register(ROOT_D);
    register(ROOT_C);
    insertWorktree(db, 'wt-1', ROOT_A);
    insertWorktree(db, 'wt-2', ROOT_B);
    insertWorktree(db, 'wt-3', ROOT_C);
    setAgentInstances(db, 'wt-3', [
      { id: 'claude', cliTool: 'claude', alias: 'claude', order: 0 },
      { id: 'claude-2', cliTool: 'claude', alias: 'claude-2', order: 1 },
      { id: 'vibe-local', cliTool: 'vibe-local', alias: 'vibe-local', order: 2 },
    ]);
    // wt-1: a repository role. wt-2: its two roots disagree → ambiguous for claude.
    // wt-3: no setting, an instance set to none, a tool roles do not apply to.
    setRepositoryRoleState(db, a, 'claude', { state: 'role', roleId: roleX });
    setRepositoryRoleState(db, b, 'claude', { state: 'role', roleId: roleX });
    setRepositoryRoleState(db, d, 'claude', { state: 'role', roleId: roleY });
    setSystemRoleDefault(db, 'codex', roleY);
    setInstanceRoleState(db, 'wt-3', 'claude-2', { state: 'none' });
    const table = {
      [ROOT_A]: '/one/.git',
      '/tmp/cm-4387/wt-1': '/one/.git',
      [ROOT_B]: '/two/.git',
      [ROOT_D]: '/two/.git',
      '/tmp/cm-4387/wt-2': '/two/.git',
      [ROOT_C]: '/three/.git',
      '/tmp/cm-4387/wt-3': '/three/.git',
    };

    const all = await buildRoleByInstance(db, fakeGit(table).deps);
    for (const id of ['wt-1', 'wt-2', 'wt-3']) {
      expect(all.get(id)).toEqual(await perWorktree(id, fakeGit(table).deps));
    }
    // The kinds this case is about, spelled out so the comparison above is not vacuous.
    expect(all.get('wt-1')?.claude).toEqual({ kind: 'role', roleId: roleX, roleName: 'X', basis: 'setting' });
    expect(all.get('wt-2')?.claude).toEqual({ kind: 'ambiguous' });
    expect(all.get('wt-2')?.codex).toEqual({ kind: 'role', roleId: roleY, roleName: 'Y', basis: 'setting' });
    expect(all.get('wt-3')).toEqual({
      claude: { kind: 'none' },
      'claude-2': { kind: 'none' },
      'vibe-local': { kind: 'none' },
    });
  });

  it('a root git cannot identify makes a differing setting ambiguous, as for one worktree', async () => {
    const a = register(ROOT_A);
    register(ROOT_B);
    insertWorktree(db, 'wt-1', ROOT_A);
    setRepositoryRoleState(db, a, 'claude', { state: 'role', roleId: roleX });
    const table = { [ROOT_B]: null };
    const all = await buildRoleByInstance(db, fakeGit(table, [ROOT_B]).deps);
    expect(all.get('wt-1')?.claude).toEqual({ kind: 'ambiguous' });
    expect(all.get('wt-1')).toEqual(await perWorktree('wt-1', fakeGit(table, [ROOT_B]).deps));
  });

  it('asks git about each path once for the whole server', async () => {
    const a = register(ROOT_A);
    register(ROOT_B);
    for (let i = 0; i < 5; i += 1) insertWorktree(db, `wt-${i}`, ROOT_A);
    setRepositoryRoleState(db, a, 'claude', { state: 'role', roleId: roleX });
    const { deps, asked } = fakeGit();
    await buildRoleByInstance(db, deps);
    expect([...asked].sort()).toEqual(
      [ROOT_A, ROOT_B, ...[0, 1, 2, 3, 4].map((i) => `/tmp/cm-4387/wt-${i}`)].sort()
    );
  });

  it('does not ask git when no root holds a setting, and answers the same', async () => {
    register(ROOT_A);
    insertWorktree(db, 'wt-1', ROOT_A);
    setSystemRoleDefault(db, 'claude', roleX);
    const { deps, asked } = fakeGit();
    const all = await buildRoleByInstance(db, deps);
    expect(asked).toEqual([]);
    expect(all.get('wt-1')?.claude).toEqual({ kind: 'role', roleId: roleX, roleName: 'X', basis: 'setting' });
    expect(all.get('wt-1')).toEqual(await perWorktree('wt-1', fakeGit().deps));
  });

  it('a running process with a launched record keeps its role after the setting changes', async () => {
    insertWorktree(db, 'wt-1', ROOT_A);
    setInstanceRoleState(db, 'wt-1', 'claude', { state: 'role', roleId: roleX });
    recordRoleLaunch(db, launched('wt-1', 'claude', 'g1', { id: roleX, name: 'X' }));
    setInstanceRoleState(db, 'wt-1', 'claude', { state: 'role', roleId: roleY });
    const running = (generation: string | null) => ({
      ...fakeGit().deps,
      currentGeneration: (worktreeId: string, _tool: string, instanceId: string) =>
        worktreeId === 'wt-1' && instanceId === 'claude' ? generation : null,
    });

    expect((await buildRoleByInstance(db, running('g1'))).get('wt-1')?.claude).toEqual({
      kind: 'role',
      roleId: roleX,
      roleName: 'X',
      basis: 'launched',
    });
    // Another process (or none): the record says nothing about it, so the setting answers.
    for (const generation of ['g2', null]) {
      expect((await buildRoleByInstance(db, running(generation))).get('wt-1')?.claude).toEqual({
        kind: 'role',
        roleId: roleY,
        roleName: 'Y',
        basis: 'setting',
      });
    }
  });

  it('a running process launched with no role is none, whatever the setting says now', async () => {
    insertWorktree(db, 'wt-1', ROOT_A);
    recordRoleLaunch(db, launched('wt-1', 'claude', 'g1', null));
    setInstanceRoleState(db, 'wt-1', 'claude', { state: 'role', roleId: roleX });
    const all = await buildRoleByInstance(db, { currentGeneration: () => 'g1' });
    expect(all.get('wt-1')?.claude).toEqual({ kind: 'none' });
  });
});

describe('[#4387] server-wide reads in agent-roles-db', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    insertWorktree(db, 'wt-1', ROOT_A);
  });
  afterEach(() => db.close());

  it('hasAnyRepositoryRoleDefault follows the root settings only', () => {
    const role = createAgentRole(db, { name: 'X', body: 'x' }).id;
    setSystemRoleDefault(db, 'claude', role);
    setInstanceRoleState(db, 'wt-1', 'claude', { state: 'role', roleId: role });
    expect(hasAnyRepositoryRoleDefault(db)).toBe(false);
    const root = createRepository(db, { name: 'a', path: ROOT_A, cloneSource: 'local' }).id;
    setRepositoryRoleState(db, root, 'codex', { state: 'none' });
    expect(hasAnyRepositoryRoleDefault(db)).toBe(true);
  });

  it('getAllInstanceRoleStates reads every setting as getInstanceRoleState does', () => {
    const role = createAgentRole(db, { name: 'X', body: 'x' }).id;
    setInstanceRoleState(db, 'wt-1', 'claude', { state: 'role', roleId: role });
    setInstanceRoleState(db, 'wt-1', 'codex', { state: 'none' });
    expect(getAllInstanceRoleStates(db)).toEqual(
      new Map([
        [instanceRoleKey('wt-1', 'claude'), { state: 'role', roleId: role, roleName: 'X' }],
        [instanceRoleKey('wt-1', 'codex'), { state: 'none' }],
      ])
    );
  });

  it('getAllLatestLaunchedRoles keeps the latest launched record of each instance, never a requested one', () => {
    const role = createAgentRole(db, { name: 'X', body: 'x' }).id;
    recordRoleLaunch(db, launched('wt-1', 'claude', 'g1', null));
    recordRoleLaunch(db, launched('wt-1', 'claude', 'g2', { id: role, name: 'X' }));
    recordRoleLaunch(db, { ...launched('wt-1', 'claude', 'g3', null), phase: 'requested' });
    expect(getAllLatestLaunchedRoles(db)).toEqual(
      new Map([[instanceRoleKey('wt-1', 'claude'), { sessionGeneration: 'g2', roleId: role, roleName: 'X' }]])
    );
  });
});
