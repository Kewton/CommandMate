/**
 * Migration v64: the role tables (Issue #4114).
 *
 * Pins what the design depends on and SQLite would otherwise let drift: which
 * references are foreign keys and which deliberately are not, that the
 * rollback removes everything, and that the worktree-id rename and delete
 * machinery finds the two worktree-scoped tables by introspection.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  CURRENT_SCHEMA_VERSION,
  getCurrentVersion,
  rollbackMigrations,
  runMigrations,
} from '@/lib/db/db-migrations';
import {
  getDeletableWorktreeChildTables,
  getWorktreeChildTables,
} from '@/lib/db/migrations/worktree-child-tables';
import {
  deleteWorktreesByIds,
  migrateWorktreeIdPreservingChildren,
} from '@/lib/db/worktree-db';
import { createRepository, deleteRepository } from '@/lib/db/db-repository';
import {
  createAgentRole,
  deleteAgentRole,
  getInstanceRoleState,
  getLatestRoleLaunchRecords,
  getRepositoryRoleStates,
  recordRoleLaunch,
  setInstanceRoleState,
  setRepositoryRoleState,
  setSystemRoleDefault,
} from '@/lib/db/agent-roles-db';
import type { RoleLaunchSnapshotInput } from '@/types/agent-roles';

function fkTargets(db: Database.Database, table: string): Array<{ table: string; from: string; on_delete: string }> {
  return db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as Array<{
    table: string;
    from: string;
    on_delete: string;
  }>;
}

function insertWorktree(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES (?, ?, ?, ?, 'repo')`
  ).run(id, id, `/tmp/cm-4114/${id}`, '/tmp/cm-4114/repo');
}

const SNAPSHOT: RoleLaunchSnapshotInput = {
  worktreeId: 'wt-a',
  instanceId: 'claude',
  cliToolId: 'claude',
  phase: 'requested',
  sessionGeneration: 'gen-1',
  source: 'instance',
  repositoryId: 'repo-at-the-time',
  roleId: 'role-at-the-time',
  roleName: 'Marketer',
  bodyVersion: 3,
  bodyFingerprint: 'a'.repeat(64),
  injectionFingerprint: 'b'.repeat(64),
  artifactFingerprint: 'c'.repeat(64),
  adapterId: 'claude',
  adapterVersion: '1',
  wrapperVersion: '1',
  artifactPath: '/tmp/cm-4114/artifact.md',
  effectiveAgent: null,
  compositionSourceFingerprint: null,
  noRoleReason: null,
};

describe('migration v64', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    insertWorktree(db, 'wt-a');
  });
  afterEach(() => db.close());

  it('is the current version', () => {
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(64);
  });

  it('never points a role reference at agent_roles with SET NULL', () => {
    for (const table of [
      'agent_role_system_defaults',
      'agent_role_repository_defaults',
      'agent_instance_roles',
    ]) {
      const fk = fkTargets(db, table).find((entry) => entry.table === 'agent_roles');
      expect(fk, table).toBeDefined();
      expect(fk?.on_delete, table).toBe('RESTRICT');
    }
  });

  it('system default: role_id is NOT NULL, so "no row" is the only way to say unset', () => {
    expect(() =>
      db
        .prepare(`INSERT INTO agent_role_system_defaults (cli_tool_id, role_id, updated_at) VALUES ('claude', NULL, 1)`)
        .run()
    ).toThrow(/NOT NULL/);
  });

  it('repository default cascades from repositories and only from there', () => {
    const fk = fkTargets(db, 'agent_role_repository_defaults').find((entry) => entry.table === 'repositories');
    expect(fk?.on_delete).toBe('CASCADE');

    const repo = createRepository(db, { name: 'r', path: '/tmp/cm-4114/r', cloneSource: 'local' });
    const role = createAgentRole(db, { name: 'A', body: 'x' });
    setRepositoryRoleState(db, repo.id, 'claude', { state: 'role', roleId: role.id });
    expect(deleteRepository(db, repo.id)).toBe(true);
    expect(
      db.prepare('SELECT COUNT(*) AS c FROM agent_role_repository_defaults').get()
    ).toEqual({ c: 0 });
    expect(getRepositoryRoleStates(db, repo.id)).toEqual({});
  });

  it('the launch record has no FK to roles or repositories and survives their deletion', () => {
    const targets = fkTargets(db, 'agent_role_launch_records').map((entry) => entry.table);
    expect(targets).toEqual(['worktrees']);

    const repo = createRepository(db, { name: 'r', path: '/tmp/cm-4114/r', cloneSource: 'local' });
    const role = createAgentRole(db, { name: 'A', body: 'x' });
    recordRoleLaunch(db, { ...SNAPSHOT, roleId: role.id, repositoryId: repo.id });
    deleteAgentRole(db, role.id);
    deleteRepository(db, repo.id);

    const { requested } = getLatestRoleLaunchRecords(db, 'wt-a', 'claude');
    expect(requested?.roleId).toBe(role.id);
    expect(requested?.repositoryId).toBe(repo.id);
    expect(requested?.roleName).toBe('Marketer');
  });

  it('the launch record has no column that could hold a body', () => {
    const columns = (db.prepare(`PRAGMA table_info(agent_role_launch_records)`).all() as Array<{ name: string }>).map(
      (column) => column.name
    );
    expect(columns).not.toContain('body');
    expect(columns).toEqual(
      expect.arrayContaining([
        'body_fingerprint',
        'injection_fingerprint',
        'artifact_fingerprint',
        'adapter_version',
        'wrapper_version',
        'artifact_path',
        'effective_agent',
        'composition_source_fingerprint',
        'session_generation',
        'source',
        'repository_id',
        'no_role_reason',
        'phase',
      ])
    );
  });

  it('requested and launched are separate rows, and one generation holds one of each', () => {
    recordRoleLaunch(db, SNAPSHOT);
    recordRoleLaunch(db, { ...SNAPSHOT, phase: 'launched' });
    expect(() => recordRoleLaunch(db, SNAPSHOT)).toThrow(/UNIQUE/);

    const latest = getLatestRoleLaunchRecords(db, 'wt-a', 'claude');
    expect(latest.requested?.phase).toBe('requested');
    expect(latest.launched?.phase).toBe('launched');
  });

  it('getWorktreeChildTables() finds both worktree-scoped tables, and neither is guarded', () => {
    const children = getWorktreeChildTables(db);
    const deletable = getDeletableWorktreeChildTables(db);
    for (const table of ['agent_instance_roles', 'agent_role_launch_records']) {
      expect(children).toContainEqual({ table, column: 'worktree_id' });
      expect(deletable).toContainEqual({ table, column: 'worktree_id' });
    }
    expect(children.map((child) => child.table)).not.toContain('agent_role_repository_defaults');
  });

  it('a worktree id rename moves the individual setting and the launch record', () => {
    const role = createAgentRole(db, { name: 'A', body: 'x' });
    setInstanceRoleState(db, 'wt-a', 'claude', { state: 'role', roleId: role.id });
    recordRoleLaunch(db, SNAPSHOT);

    db.transaction(() => migrateWorktreeIdPreservingChildren(db, 'wt-a', 'wt-b'))();

    expect(getInstanceRoleState(db, 'wt-b', 'claude')).toEqual({
      state: 'role',
      roleId: role.id,
      roleName: 'A',
    });
    expect(getInstanceRoleState(db, 'wt-a', 'claude')).toEqual({ state: 'inherit' });
    expect(getLatestRoleLaunchRecords(db, 'wt-b', 'claude').requested?.sessionGeneration).toBe('gen-1');
  });

  it('deleting a worktree removes its setting and its launch records', () => {
    const role = createAgentRole(db, { name: 'A', body: 'x' });
    setInstanceRoleState(db, 'wt-a', 'claude', { state: 'role', roleId: role.id });
    recordRoleLaunch(db, SNAPSHOT);
    deleteWorktreesByIds(db, ['wt-a']);
    expect(db.prepare('SELECT COUNT(*) AS c FROM agent_instance_roles').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM agent_role_launch_records').get()).toEqual({ c: 0 });
  });

  it('a later default change does not rewrite a recorded launch', () => {
    const role = createAgentRole(db, { name: 'Old', body: 'x' });
    setSystemRoleDefault(db, 'claude', role.id);
    recordRoleLaunch(db, { ...SNAPSHOT, roleId: role.id, source: 'system', roleName: 'Old' });

    const other = createAgentRole(db, { name: 'New', body: 'y' });
    setSystemRoleDefault(db, 'claude', other.id);

    const { requested } = getLatestRoleLaunchRecords(db, 'wt-a', 'claude');
    expect(requested?.roleId).toBe(role.id);
    expect(requested?.roleName).toBe('Old');
  });

  it('rolls back to v63 without leaving a table behind', () => {
    rollbackMigrations(db, 63);
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map(
      (row) => row.name
    );
    for (const table of [
      'agent_roles',
      'agent_role_system_defaults',
      'agent_role_repository_defaults',
      'agent_instance_roles',
      'agent_role_launch_records',
    ]) {
      expect(names).not.toContain(table);
    }
    expect(getCurrentVersion(db)).toBe(63);
  });
});
