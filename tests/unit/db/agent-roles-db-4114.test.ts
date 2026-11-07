/**
 * The role tables' CRUD and the lifetime of an individual setting (Issue #4114).
 *
 * The negative controls are the existing roster behaviours: `setAgentInstances`
 * deletes and re-inserts every row, so a setting that survives a rename does so
 * only because it lives in its own table.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  getAgentInstances,
  removeAgentInstance,
  setAgentInstances,
} from '@/lib/db/agent-instances-db';
import { updateSelectedAgents } from '@/lib/db/worktree-db';
import { createRepository } from '@/lib/db/db-repository';
import {
  AgentRoleInUseError,
  AgentRoleNameConflictError,
  AgentRoleNotFoundError,
  AgentRoleVersionConflictError,
  AgentRoleValidationError,
  createAgentRole,
  deleteAgentRole,
  getAgentRole,
  getAgentRoleReferences,
  getInstanceRoleState,
  getRepositoryRoleStates,
  getSystemRoleDefaults,
  listAgentRoles,
  setInstanceRoleState,
  setRepositoryRoleState,
  setSystemRoleDefault,
  updateAgentRole,
} from '@/lib/db/agent-roles-db';
import { MAX_ROLE_BODY_BYTES, MAX_ROLE_NAME_LENGTH } from '@/types/agent-roles';
import { computeFingerprint } from '@/lib/agent-roles/fingerprint';
import type { AgentInstance } from '@/lib/cli-tools/types';

const WT = 'wt-4114';

function roster(...ids: Array<[string, AgentInstance['cliTool'], string?]>): AgentInstance[] {
  return ids.map(([id, cliTool, alias], order) => ({ id, cliTool, alias: alias ?? id, order }));
}

describe('agent roles db', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    db.prepare(
      `INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES (?, ?, ?, ?, 'repo')`
    ).run(WT, WT, '/tmp/cm-4114/wt', '/tmp/cm-4114/repo');
  });
  afterEach(() => db.close());

  describe('role validation', () => {
    it('stores the body byte for byte and fingerprints exactly those bytes', () => {
      const body = '  先頭の空白と末尾の改行\n';
      const role = createAgentRole(db, { name: ' PM ', body });
      expect(role.name).toBe('PM');
      expect(role.body).toBe(body);
      expect(role.bodyVersion).toBe(1);
      expect(role.bodyFingerprint).toBe(computeFingerprint(Buffer.from(body, 'utf8')));
    });

    it('takes a body of exactly the limit in bytes and refuses one more byte', () => {
      createAgentRole(db, { name: 'at-limit', body: 'x'.repeat(MAX_ROLE_BODY_BYTES) });
      expect(() => createAgentRole(db, { name: 'over', body: 'x'.repeat(MAX_ROLE_BODY_BYTES + 1) })).toThrow(
        AgentRoleValidationError
      );
    });

    it('counts bytes, not characters', () => {
      const threeBytes = 'あ'; // 3 bytes in UTF-8
      const fits = threeBytes.repeat(Math.floor(MAX_ROLE_BODY_BYTES / 3));
      createAgentRole(db, { name: 'fits', body: fits });
      expect(() => createAgentRole(db, { name: 'no', body: `${fits}あ` })).toThrow(AgentRoleValidationError);
    });

    it.each(['', '   ', '\n\t \r\n', '\u3000'])('refuses the empty or blank body %j', (body) => {
      expect(() => createAgentRole(db, { name: 'blank', body })).toThrow(AgentRoleValidationError);
    });

    it('refuses a body SQLite or a generated file could not keep exactly', () => {
      expect(() => createAgentRole(db, { name: 'nul', body: 'a\0b' })).toThrow(AgentRoleValidationError);
      expect(() => createAgentRole(db, { name: 'lone', body: 'a\ud83db' })).toThrow(AgentRoleValidationError);
    });

    it('refuses an empty, over-long or duplicate name', () => {
      expect(() => createAgentRole(db, { name: '  ', body: 'x' })).toThrow(AgentRoleValidationError);
      expect(() => createAgentRole(db, { name: 'n'.repeat(MAX_ROLE_NAME_LENGTH + 1), body: 'x' })).toThrow(
        AgentRoleValidationError
      );
      expect(() => createAgentRole(db, { name: 'bad\nname', body: 'x' })).toThrow(AgentRoleValidationError);
      createAgentRole(db, { name: 'Marketer', body: 'x' });
      expect(() => createAgentRole(db, { name: 'marketer', body: 'y' })).toThrow(AgentRoleNameConflictError);
      expect(listAgentRoles(db).map((role) => role.name)).toEqual(['Marketer']);
    });
  });

  describe('editing', () => {
    it('bumps the body version only when the body changes', () => {
      const role = createAgentRole(db, { name: 'A', body: 'one' });
      const renamed = updateAgentRole(db, role.id, { name: 'B' });
      expect(renamed.after.bodyVersion).toBe(1);
      expect(renamed.after.name).toBe('B');
      expect(renamed.before.name).toBe('A');

      const same = updateAgentRole(db, role.id, { body: 'one' });
      expect(same.after.bodyVersion).toBe(1);

      const edited = updateAgentRole(db, role.id, { body: 'two', expectedBodyVersion: 1 });
      expect(edited.before.body).toBe('one');
      expect(edited.after.body).toBe('two');
      expect(edited.after.bodyVersion).toBe(2);
      expect(edited.after.bodyFingerprint).not.toBe(edited.before.bodyFingerprint);
    });

    it('detects a stale edit and leaves the row alone', () => {
      const role = createAgentRole(db, { name: 'A', body: 'one' });
      updateAgentRole(db, role.id, { body: 'two' });
      expect(() => updateAgentRole(db, role.id, { body: 'three', expectedBodyVersion: 1 })).toThrow(
        AgentRoleVersionConflictError
      );
      expect(getAgentRole(db, role.id)?.body).toBe('two');
    });

    it('answers with what the edit affects', () => {
      const role = createAgentRole(db, { name: 'A', body: 'one' });
      setSystemRoleDefault(db, 'codex', role.id);
      const { affected } = updateAgentRole(db, role.id, { body: 'two' });
      expect(affected.system).toEqual([{ cliToolId: 'codex' }]);
    });

    it('refuses an unknown role', () => {
      expect(() => updateAgentRole(db, 'nope', { body: 'x' })).toThrow(AgentRoleNotFoundError);
    });
  });

  describe('deleting', () => {
    function useEverywhere(roleId: string): string {
      const repo = createRepository(db, { name: 'r', path: '/tmp/cm-4114/repo', cloneSource: 'local' });
      setSystemRoleDefault(db, 'claude', roleId);
      setRepositoryRoleState(db, repo.id, 'claude', { state: 'role', roleId });
      setInstanceRoleState(db, WT, 'claude', { state: 'role', roleId });
      return repo.id;
    }

    it('refuses a role in use and names every reference', () => {
      const role = createAgentRole(db, { name: 'A', body: 'x' });
      const repositoryId = useEverywhere(role.id);
      let caught: unknown;
      try {
        deleteAgentRole(db, role.id);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AgentRoleInUseError);
      expect((caught as AgentRoleInUseError).references).toEqual({
        instances: [{ worktreeId: WT, instanceId: 'claude' }],
        repositories: [{ repositoryId, repositoryPath: '/tmp/cm-4114/repo', cliToolId: 'claude' }],
        system: [{ cliToolId: 'claude' }],
      });
      expect(getAgentRole(db, role.id)).not.toBeNull();
    });

    it('force removes the rows, which reads as inherit and NOT as an explicit none', () => {
      const role = createAgentRole(db, { name: 'A', body: 'x' });
      const repositoryId = useEverywhere(role.id);
      const { affected } = deleteAgentRole(db, role.id, { force: true });
      expect(affected.instances).toHaveLength(1);
      expect(affected.repositories).toHaveLength(1);
      expect(affected.system).toHaveLength(1);
      expect(getAgentRole(db, role.id)).toBeNull();

      expect(getInstanceRoleState(db, WT, 'claude')).toEqual({ state: 'inherit' });
      expect(getRepositoryRoleStates(db, repositoryId)).toEqual({});
      expect(getSystemRoleDefaults(db)).toEqual({});
      expect(getAgentRoleReferences(db, role.id)).toEqual({ instances: [], repositories: [], system: [] });
    });

    it('rolls the whole force delete back if any part of it fails', () => {
      const role = createAgentRole(db, { name: 'A', body: 'x' });
      useEverywhere(role.id);
      db.exec(`
        CREATE TRIGGER block_role_delete BEFORE DELETE ON agent_roles
        BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;
      `);
      expect(() => deleteAgentRole(db, role.id, { force: true })).toThrow(/simulated failure/);
      expect(getInstanceRoleState(db, WT, 'claude').state).toBe('role');
      expect(Object.keys(getSystemRoleDefaults(db))).toEqual(['claude']);
    });

    it('a role that nothing references deletes without force', () => {
      const role = createAgentRole(db, { name: 'A', body: 'x' });
      deleteAgentRole(db, role.id);
      expect(getAgentRole(db, role.id)).toBeNull();
    });
  });

  describe('the three states', () => {
    it('inherit removes the row, none stores NULL, role stores the id', () => {
      const role = createAgentRole(db, { name: 'A', body: 'x' });
      setInstanceRoleState(db, WT, 'claude', { state: 'none' });
      expect(getInstanceRoleState(db, WT, 'claude')).toEqual({ state: 'none' });
      setInstanceRoleState(db, WT, 'claude', { state: 'role', roleId: role.id });
      expect(getInstanceRoleState(db, WT, 'claude')).toEqual({ state: 'role', roleId: role.id, roleName: 'A' });
      setInstanceRoleState(db, WT, 'claude', { state: 'inherit' });
      expect(getInstanceRoleState(db, WT, 'claude')).toEqual({ state: 'inherit' });
      expect(db.prepare('SELECT COUNT(*) AS c FROM agent_instance_roles').get()).toEqual({ c: 0 });
    });

    it('refuses to point any level at a role that does not exist', () => {
      const repo = createRepository(db, { name: 'r', path: '/tmp/cm-4114/repo', cloneSource: 'local' });
      expect(() => setInstanceRoleState(db, WT, 'claude', { state: 'role', roleId: 'nope' })).toThrow(
        AgentRoleNotFoundError
      );
      expect(() => setRepositoryRoleState(db, repo.id, 'claude', { state: 'role', roleId: 'nope' })).toThrow(
        AgentRoleNotFoundError
      );
      expect(() => setSystemRoleDefault(db, 'claude', 'nope')).toThrow(AgentRoleNotFoundError);
    });

    it('a null system default removes the row', () => {
      const role = createAgentRole(db, { name: 'A', body: 'x' });
      setSystemRoleDefault(db, 'claude', role.id);
      expect(getSystemRoleDefaults(db)).toEqual({ claude: { roleId: role.id, roleName: 'A' } });
      setSystemRoleDefault(db, 'claude', null);
      expect(getSystemRoleDefaults(db)).toEqual({});
    });
  });

  describe('individual settings across roster writes', () => {
    let roleId: string;
    beforeEach(() => {
      roleId = createAgentRole(db, { name: 'A', body: 'x' }).id;
      setAgentInstances(db, WT, roster(['claude', 'claude'], ['codex', 'codex'], ['codex-2', 'codex']));
      setInstanceRoleState(db, WT, 'codex-2', { state: 'role', roleId });
      setInstanceRoleState(db, WT, 'codex', { state: 'none' });
    });

    it('a rename and a reorder keep the settings (negative control: rows really were replaced)', () => {
      setAgentInstances(db, WT, roster(['codex-2', 'codex', 'Renamed'], ['codex', 'codex'], ['claude', 'claude']));
      expect(getAgentInstances(db, WT)[0].alias).toBe('Renamed');
      expect(getInstanceRoleState(db, WT, 'codex-2').state).toBe('role');
      expect(getInstanceRoleState(db, WT, 'codex').state).toBe('none');
    });

    it('leaving the roster removes the setting, and the same id comes back clean', () => {
      setAgentInstances(db, WT, roster(['claude', 'claude'], ['codex', 'codex']));
      expect(getInstanceRoleState(db, WT, 'codex-2')).toEqual({ state: 'inherit' });
      expect(getInstanceRoleState(db, WT, 'codex').state).toBe('none');

      setAgentInstances(db, WT, roster(['claude', 'claude'], ['codex', 'codex'], ['codex-2', 'codex']));
      expect(getInstanceRoleState(db, WT, 'codex-2')).toEqual({ state: 'inherit' });
    });

    it('removeAgentInstance removes the setting, and re-adding the id does not inherit it', () => {
      expect(removeAgentInstance(db, WT, 'codex-2')).toBe(true);
      expect(getInstanceRoleState(db, WT, 'codex-2')).toEqual({ state: 'inherit' });
    });

    it('does not touch another worktree', () => {
      db.prepare(
        `INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES ('other', 'o', '/tmp/cm-4114/o', '/tmp/cm-4114/repo', 'repo')`
      ).run();
      setInstanceRoleState(db, 'other', 'codex-2', { state: 'role', roleId });
      setAgentInstances(db, WT, roster(['claude', 'claude']));
      expect(getInstanceRoleState(db, 'other', 'codex-2').state).toBe('role');
    });

    it('clearing the roster removes everything for this worktree', () => {
      setAgentInstances(db, WT, []);
      expect(getInstanceRoleState(db, WT, 'codex').state).toBe('inherit');
    });
  });

  describe('derived primaries', () => {
    it('the first roster save keeps a primary it includes and drops one it does not', () => {
      setInstanceRoleState(db, WT, 'claude', { state: 'none' });
      setInstanceRoleState(db, WT, 'codex', { state: 'none' });
      setAgentInstances(db, WT, roster(['claude', 'claude'], ['claude-2', 'claude']));
      expect(getInstanceRoleState(db, WT, 'claude').state).toBe('none');
      expect(getInstanceRoleState(db, WT, 'codex').state).toBe('inherit');
    });

    it('selectedAgents hiding a primary keeps its setting, and showing it again finds it', () => {
      setInstanceRoleState(db, WT, 'codex', { state: 'none' });
      updateSelectedAgents(db, WT, ['claude', 'copilot']);
      expect(getInstanceRoleState(db, WT, 'codex').state).toBe('none');
      updateSelectedAgents(db, WT, ['claude', 'codex']);
      expect(getInstanceRoleState(db, WT, 'codex').state).toBe('none');
    });

    it('setting a primary does not save a roster', () => {
      setInstanceRoleState(db, WT, 'codex', { state: 'none' });
      expect(getAgentInstances(db, WT)).toEqual([]);
    });
  });
});
