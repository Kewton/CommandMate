/**
 * Which role applies (Issue #4114).
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  createRepository,
  deleteRepository,
  ensureEnvRepositoriesRegistered,
  getRepositoryByPath,
  setRepositoryEnabled,
} from '@/lib/db/db-repository';
import {
  createAgentRole,
  deleteAgentRole,
  setInstanceRoleState,
  setRepositoryRoleState,
  setSystemRoleDefault,
} from '@/lib/db/agent-roles-db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import { migrateWorktreeIdPreservingChildren } from '@/lib/db/worktree-db';
import {
  AgentRoleTargetNotFoundError,
  resolveInstanceRole,
  resolveRepositoryToolRole,
  resolveWorktreeToolRole,
  type RoleResolverDeps,
} from '@/lib/agent-roles/resolve';
import type { RoleAssignmentInput } from '@/types/agent-roles';

const WT = 'wt-4114';
const ROOT_A = '/tmp/cm-4114/root-a';
const ROOT_B = '/tmp/cm-4114/root-b';

function insertWorktree(db: Database.Database, id: string, repositoryPath: string): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES (?, ?, ?, ?, 'repo')`
  ).run(id, id, `/tmp/cm-4114/${id}`, repositoryPath);
}

/** Everything under one common dir unless a path is listed as another repo or unknown. */
function deps(overrides: Record<string, string | null> = {}, existing: readonly string[] = []): RoleResolverDeps {
  return {
    resolveCommonDir: async (p) => (p in overrides ? overrides[p] : '/common/.git'),
    pathExists: (p) => existing.includes(p),
  };
}

describe('role resolution', () => {
  let db: Database.Database;
  let roleI: string;
  let roleR: string;
  let roleS: string;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    insertWorktree(db, WT, ROOT_A);
    roleI = createAgentRole(db, { name: 'individual', body: 'I' }).id;
    roleR = createAgentRole(db, { name: 'repository', body: 'R' }).id;
    roleS = createAgentRole(db, { name: 'system', body: 'S' }).id;
  });
  afterEach(() => db.close());

  function register(path: string): string {
    return createRepository(db, { name: path, path, cloneSource: 'local' }).id;
  }

  describe('all 18 combinations', () => {
    type I = 'inherit' | 'none' | 'role';
    type S = 'unset' | 'role';
    const combos: Array<[I, I, S, 'role' | 'none', string, 'instance' | 'repository' | 'system' | 'fallback']> = [
      ['role', 'role', 'role', 'role', 'individual', 'instance'],
      ['role', 'role', 'unset', 'role', 'individual', 'instance'],
      ['role', 'none', 'role', 'role', 'individual', 'instance'],
      ['role', 'none', 'unset', 'role', 'individual', 'instance'],
      ['role', 'inherit', 'role', 'role', 'individual', 'instance'],
      ['role', 'inherit', 'unset', 'role', 'individual', 'instance'],
      ['none', 'role', 'role', 'none', '', 'instance'],
      ['none', 'role', 'unset', 'none', '', 'instance'],
      ['none', 'none', 'role', 'none', '', 'instance'],
      ['none', 'none', 'unset', 'none', '', 'instance'],
      ['none', 'inherit', 'role', 'none', '', 'instance'],
      ['none', 'inherit', 'unset', 'none', '', 'instance'],
      ['inherit', 'role', 'role', 'role', 'repository', 'repository'],
      ['inherit', 'role', 'unset', 'role', 'repository', 'repository'],
      ['inherit', 'none', 'role', 'none', '', 'repository'],
      ['inherit', 'none', 'unset', 'none', '', 'repository'],
      ['inherit', 'inherit', 'role', 'role', 'system', 'system'],
      ['inherit', 'inherit', 'unset', 'none', '', 'fallback'],
    ];

    it('lists every combination once', () => {
      expect(new Set(combos.map((c) => c.slice(0, 3).join())).size).toBe(18);
    });

    it.each(combos)('instance=%s repository=%s system=%s → %s %s (%s)', async (i, r, s, kind, name, source) => {
      const repositoryId = register(ROOT_A);
      const toInput = (state: I, roleId: string): RoleAssignmentInput =>
        state === 'role' ? { state, roleId } : { state };
      setInstanceRoleState(db, WT, 'claude', toInput(i, roleI));
      setRepositoryRoleState(db, repositoryId, 'claude', toInput(r, roleR));
      if (s === 'role') setSystemRoleDefault(db, 'claude', roleS);

      const result = await resolveInstanceRole(db, { worktreeId: WT, instanceId: 'claude' }, deps());

      expect(result.kind).toBe(kind);
      expect(result.source).toBe(source);
      expect(result.repositoryId).toBe(repositoryId);
      if (result.kind === 'role') {
        expect(result.role.name).toBe(name);
      } else if (result.kind === 'none') {
        expect(result.reason).toBe(source === 'fallback' ? 'no-default' : 'explicit-none');
      }
    });
  });

  it('hands out an immutable role with the body fingerprint and no injection fingerprint', async () => {
    setSystemRoleDefault(db, 'claude', roleS);
    const result = await resolveInstanceRole(db, { worktreeId: WT, instanceId: 'claude' }, deps());
    if (result.kind !== 'role') throw new Error('expected a role');
    expect(Object.isFrozen(result.role)).toBe(true);
    expect(result.role).toEqual({
      id: roleS,
      name: 'system',
      bodyVersion: 1,
      body: 'S',
      bodyFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('a tool only sees its own defaults', async () => {
    setSystemRoleDefault(db, 'codex', roleS);
    const claude = await resolveInstanceRole(db, { worktreeId: WT, instanceId: 'claude' }, deps());
    expect(claude.kind).toBe('none');
    const codex = await resolveInstanceRole(db, { worktreeId: WT, instanceId: 'codex' }, deps());
    expect(codex.kind).toBe('role');
  });

  describe('ownership of a worktree by registered roots', () => {
    it('no registered root skips the repository level, and reading creates no repository row', async () => {
      setSystemRoleDefault(db, 'claude', roleS);
      const withSystem = await resolveInstanceRole(db, { worktreeId: WT, instanceId: 'claude' }, deps({}));
      expect(withSystem.source).toBe('system');
      expect(withSystem.repositoryId).toBeNull();
      setSystemRoleDefault(db, 'claude', null);
      const none = await resolveInstanceRole(db, { worktreeId: WT, instanceId: 'claude' }, deps({}));
      expect(none.source).toBe('fallback');
      expect(none.repositoryId).toBeNull();
      expect(db.prepare('SELECT COUNT(*) AS c FROM repositories').get()).toEqual({ c: 0 });
    });

    it('a worktree that does not exist is an error, not "no role"', async () => {
      await expect(resolveInstanceRole(db, { worktreeId: 'nope', instanceId: 'claude' }, deps())).rejects.toThrow(
        AgentRoleTargetNotFoundError
      );
      await expect(resolveWorktreeToolRole(db, { worktreeId: 'nope', cliToolId: 'claude' }, deps())).rejects.toThrow(
        AgentRoleTargetNotFoundError
      );
    });

    it('a database error propagates instead of reading as "no role"', async () => {
      db.exec('DROP TABLE agent_role_system_defaults');
      await expect(resolveInstanceRole(db, { worktreeId: WT, instanceId: 'claude' }, deps())).rejects.toThrow(
        /no such table/
      );
    });

    it('two roots with the same setting resolve the same whichever was scanned last', async () => {
      const a = register(ROOT_A);
      const b = register(ROOT_B);
      setRepositoryRoleState(db, a, 'claude', { state: 'role', roleId: roleR });
      setRepositoryRoleState(db, b, 'claude', { state: 'role', roleId: roleR });

      const results = [];
      for (const scannedLast of [ROOT_A, ROOT_B, ROOT_A]) {
        db.prepare('UPDATE worktrees SET repository_path = ? WHERE id = ?').run(scannedLast, WT);
        results.push(await resolveInstanceRole(db, { worktreeId: WT, instanceId: 'claude' }, deps()));
      }
      for (const result of results) {
        expect(result).toEqual(results[0]);
        expect(result.kind).toBe('role');
      }
      expect(results[0].repositoryIds.sort()).toEqual([a, b].sort());
    });

    it('two roots that disagree are reported as ambiguous, whichever was scanned last', async () => {
      const a = register(ROOT_A);
      const b = register(ROOT_B);
      setRepositoryRoleState(db, a, 'claude', { state: 'role', roleId: roleR });
      setRepositoryRoleState(db, b, 'claude', { state: 'none' });
      setSystemRoleDefault(db, 'claude', roleS);

      for (const scannedLast of [ROOT_A, ROOT_B]) {
        db.prepare('UPDATE worktrees SET repository_path = ? WHERE id = ?').run(scannedLast, WT);
        const result = await resolveInstanceRole(db, { worktreeId: WT, instanceId: 'claude' }, deps());
        expect(result.kind).toBe('ambiguous');
        if (result.kind !== 'ambiguous') continue;
        expect(result.reason).toBe('root-settings-differ');
        expect(result.source).toBe('repository');
        expect(result.roots.map((root) => root.path).sort()).toEqual([ROOT_A, ROOT_B]);
      }
    });

    it('a root with no row disagrees with a root that has one; it is not a free pass', async () => {
      const a = register(ROOT_A);
      register(ROOT_B);
      setRepositoryRoleState(db, a, 'claude', { state: 'role', roleId: roleR });
      const result = await resolveInstanceRole(db, { worktreeId: WT, instanceId: 'claude' }, deps());
      expect(result.kind).toBe('ambiguous');
    });

    it('two roots both inheriting fall through to the system default', async () => {
      register(ROOT_A);
      register(ROOT_B);
      setSystemRoleDefault(db, 'claude', roleS);
      const result = await resolveInstanceRole(db, { worktreeId: WT, instanceId: 'claude' }, deps());
      expect(result.kind).toBe('role');
      expect(result.source).toBe('system');
    });

    it('an individual setting does not need the roots to agree', async () => {
      const a = register(ROOT_A);
      register(ROOT_B);
      setRepositoryRoleState(db, a, 'claude', { state: 'role', roleId: roleR });
      setInstanceRoleState(db, WT, 'claude', { state: 'role', roleId: roleI });
      const result = await resolveInstanceRole(db, { worktreeId: WT, instanceId: 'claude' }, deps());
      expect(result.kind).toBe('role');
      expect(result.source).toBe('instance');
    });

    it('a root of a different repository takes no part (negative control)', async () => {
      const a = register(ROOT_A);
      const b = register(ROOT_B);
      setRepositoryRoleState(db, a, 'claude', { state: 'role', roleId: roleR });
      setRepositoryRoleState(db, b, 'claude', { state: 'none' });
      const result = await resolveInstanceRole(
        db,
        { worktreeId: WT, instanceId: 'claude' },
        deps({ [ROOT_B]: '/other/.git' })
      );
      expect(result.kind).toBe('role');
      expect(result.repositoryIds).toEqual([a]);
    });

    it('a worktree whose path differs from its root is still found through the common dir', async () => {
      db.prepare('UPDATE worktrees SET repository_path = ? WHERE id = ?').run('/tmp/cm-4114/unregistered', WT);
      const a = register(ROOT_A);
      setRepositoryRoleState(db, a, 'claude', { state: 'role', roleId: roleR });
      const result = await resolveInstanceRole(db, { worktreeId: WT, instanceId: 'claude' }, deps());
      expect(result.kind).toBe('role');
      expect(result.repositoryId).toBe(a);
    });

    it('a disabled root does not take part when an enabled root of the same repository remains', async () => {
      const a = register(ROOT_A);
      const b = register(ROOT_B);
      setRepositoryRoleState(db, a, 'claude', { state: 'role', roleId: roleR });
      setRepositoryRoleState(db, b, 'claude', { state: 'none' });
      setRepositoryEnabled(db, b, false);
      db.prepare('UPDATE worktrees SET repository_path = ? WHERE id = ?').run(ROOT_B, WT);
      const result = await resolveInstanceRole(db, { worktreeId: WT, instanceId: 'claude' }, deps());
      expect(result.kind).toBe('role');
      expect(result.repositoryIds).toEqual([a]);
    });

    it('a disabled root is still the root when it is the only one, so disabling changes nothing', async () => {
      const a = register(ROOT_A);
      setRepositoryRoleState(db, a, 'claude', { state: 'role', roleId: roleR });
      setRepositoryEnabled(db, a, false);
      const result = await resolveInstanceRole(db, { worktreeId: WT, instanceId: 'claude' }, deps());
      expect(result.kind).toBe('role');
      expect(result.source).toBe('repository');
    });

    describe('when git cannot answer', () => {
      it('an enabled root that exists but cannot be identified blocks a disagreeing answer', async () => {
        const a = register(ROOT_A);
        const b = register(ROOT_B);
        setRepositoryRoleState(db, a, 'claude', { state: 'role', roleId: roleR });
        setRepositoryRoleState(db, b, 'claude', { state: 'none' });
        const result = await resolveInstanceRole(
          db,
          { worktreeId: WT, instanceId: 'claude' },
          deps({ [ROOT_B]: null }, [ROOT_B])
        );
        expect(result.kind).toBe('ambiguous');
        if (result.kind === 'ambiguous') expect(result.reason).toBe('membership-undetermined');
      });

      it('an unidentifiable root that agrees does not block', async () => {
        const a = register(ROOT_A);
        const b = register(ROOT_B);
        setRepositoryRoleState(db, a, 'claude', { state: 'role', roleId: roleR });
        setRepositoryRoleState(db, b, 'claude', { state: 'role', roleId: roleR });
        const result = await resolveInstanceRole(
          db,
          { worktreeId: WT, instanceId: 'claude' },
          deps({ [ROOT_B]: null }, [ROOT_B])
        );
        expect(result.kind).toBe('role');
      });

      it('an unidentifiable root with no setting for the tool blocks nothing', async () => {
        const a = register(ROOT_A);
        register(ROOT_B);
        setRepositoryRoleState(db, a, 'claude', { state: 'role', roleId: roleR });
        const result = await resolveInstanceRole(
          db,
          { worktreeId: WT, instanceId: 'claude' },
          deps({ [ROOT_B]: null }, [ROOT_B])
        );
        expect(result.kind).toBe('role');
      });

      it('a root whose directory is gone blocks nothing: it cannot be scanned', async () => {
        const a = register(ROOT_A);
        const b = register(ROOT_B);
        setRepositoryRoleState(db, a, 'claude', { state: 'role', roleId: roleR });
        setRepositoryRoleState(db, b, 'claude', { state: 'none' });
        const result = await resolveInstanceRole(
          db,
          { worktreeId: WT, instanceId: 'claude' },
          deps({ [ROOT_B]: null }, [])
        );
        expect(result.kind).toBe('role');
      });

      it('a disabled unidentifiable root blocks nothing', async () => {
        const a = register(ROOT_A);
        const b = register(ROOT_B);
        setRepositoryRoleState(db, a, 'claude', { state: 'role', roleId: roleR });
        setRepositoryRoleState(db, b, 'claude', { state: 'none' });
        setRepositoryEnabled(db, b, false);
        const result = await resolveInstanceRole(
          db,
          { worktreeId: WT, instanceId: 'claude' },
          deps({ [ROOT_B]: null }, [ROOT_B])
        );
        expect(result.kind).toBe('role');
      });

      it('with no identity for the worktree, the root it names is used unless another could disagree', async () => {
        const a = register(ROOT_A);
        setRepositoryRoleState(db, a, 'claude', { state: 'role', roleId: roleR });
        const unknown = { [`/tmp/cm-4114/${WT}`]: null, [ROOT_A]: null };
        const alone = await resolveInstanceRole(db, { worktreeId: WT, instanceId: 'claude' }, deps(unknown));
        expect(alone.kind).toBe('role');

        const b = register(ROOT_B);
        setRepositoryRoleState(db, b, 'claude', { state: 'none' });
        const contested = await resolveInstanceRole(db, { worktreeId: WT, instanceId: 'claude' }, deps(unknown, [ROOT_B]));
        expect(contested.kind).toBe('ambiguous');
      });
    });
  });

  it('the env re-sync keeps the repository id and its default', async () => {
    ensureEnvRepositoriesRegistered(db, [ROOT_A]);
    const before = getRepositoryByPath(db, ROOT_A);
    setRepositoryRoleState(db, before!.id, 'claude', { state: 'role', roleId: roleR });

    ensureEnvRepositoriesRegistered(db, [ROOT_A]);

    expect(getRepositoryByPath(db, ROOT_A)?.id).toBe(before!.id);
    const result = await resolveInstanceRole(db, { worktreeId: WT, instanceId: 'claude' }, deps());
    expect(result.source).toBe('repository');
  });

  it('a physical delete loses the default, and re-registering the path does not bring it back', async () => {
    const a = register(ROOT_A);
    setRepositoryRoleState(db, a, 'claude', { state: 'role', roleId: roleR });
    deleteRepository(db, a);
    const again = register(ROOT_A);
    expect(again).not.toBe(a);
    const result = await resolveInstanceRole(db, { worktreeId: WT, instanceId: 'claude' }, deps());
    expect(result.kind).toBe('none');
    expect(result.source).toBe('fallback');
    expect(result.repositoryId).toBe(again);
  });

  it('a renamed worktree keeps resolving its individual setting', async () => {
    setInstanceRoleState(db, WT, 'claude', { state: 'role', roleId: roleI });
    db.transaction(() => migrateWorktreeIdPreservingChildren(db, WT, 'wt-new'))();
    const result = await resolveInstanceRole(db, { worktreeId: 'wt-new', instanceId: 'claude' }, deps());
    expect(result.source).toBe('instance');
  });

  it('deleting a role falls back to inherit at every level, never to an explicit none', async () => {
    const a = register(ROOT_A);
    setInstanceRoleState(db, WT, 'claude', { state: 'role', roleId: roleI });
    setRepositoryRoleState(db, a, 'claude', { state: 'role', roleId: roleR });
    setSystemRoleDefault(db, 'claude', roleS);

    deleteAgentRole(db, roleI, { force: true });
    expect(await resolveInstanceRole(db, { worktreeId: WT, instanceId: 'claude' }, deps())).toMatchObject({
      kind: 'role',
      source: 'repository',
    });
    deleteAgentRole(db, roleR, { force: true });
    expect(await resolveInstanceRole(db, { worktreeId: WT, instanceId: 'claude' }, deps())).toMatchObject({
      kind: 'role',
      source: 'system',
    });
  });

  describe('the target', () => {
    it.each(['gemini', 'vibe-local'] as const)('%s is out of scope even with rows present', async (tool) => {
      db.prepare(`INSERT INTO agent_role_system_defaults (cli_tool_id, role_id, updated_at) VALUES (?, ?, 1)`).run(
        tool,
        roleS
      );
      const result = await resolveInstanceRole(db, { worktreeId: WT, instanceId: tool }, deps());
      expect(result).toMatchObject({ kind: 'none', source: 'unsupported', reason: 'unsupported-tool' });
      const schedule = await resolveWorktreeToolRole(db, { worktreeId: WT, cliToolId: tool }, deps());
      expect(schedule).toMatchObject({ kind: 'none', source: 'unsupported' });
    });

    it('a roster instance resolves by the tool the roster declares', async () => {
      setAgentInstances(db, WT, [{ id: 'second', cliTool: 'codex', alias: 'x', order: 0 }]);
      setSystemRoleDefault(db, 'codex', roleS);
      const result = await resolveInstanceRole(db, { worktreeId: WT, instanceId: 'second' }, deps());
      expect(result.source).toBe('system');
      expect(result.cliToolId).toBe('codex');
    });

    it('an ad-hoc id with an explicit tool gets the defaults of that tool, and no row is written', async () => {
      setSystemRoleDefault(db, 'codex', roleS);
      const result = await resolveInstanceRole(
        db,
        { worktreeId: WT, instanceId: 'codex-3', requestedCliTool: 'codex' },
        deps()
      );
      expect(result.source).toBe('system');
      expect(db.prepare('SELECT COUNT(*) AS c FROM agent_instance_roles').get()).toEqual({ c: 0 });
    });

    it('a contradicted request resolves by the declaration, as the session authority does', async () => {
      setAgentInstances(db, WT, [{ id: 'second', cliTool: 'codex', alias: 'x', order: 0 }]);
      const result = await resolveInstanceRole(
        db,
        { worktreeId: WT, instanceId: 'second', requestedCliTool: 'claude' },
        deps()
      );
      expect(result.cliToolId).toBe('codex');
    });
  });

  describe('the entrances with no instance', () => {
    it('Schedule: worktree and tool, from the defaults only, ignoring individual settings', async () => {
      const a = register(ROOT_A);
      setInstanceRoleState(db, WT, 'claude', { state: 'role', roleId: roleI });
      setRepositoryRoleState(db, a, 'claude', { state: 'role', roleId: roleR });
      const result = await resolveWorktreeToolRole(db, { worktreeId: WT, cliToolId: 'claude' }, deps());
      expect(result).toMatchObject({ kind: 'role', source: 'repository', repositoryId: a });
    });

    it('repository and tool, before any instance exists', async () => {
      const a = register(ROOT_A);
      const b = register(ROOT_B);
      setRepositoryRoleState(db, a, 'claude', { state: 'role', roleId: roleR });
      expect(await resolveRepositoryToolRole(db, { repositoryId: a, cliToolId: 'claude' }, deps())).toMatchObject({
        kind: 'ambiguous',
      });
      expect(
        await resolveRepositoryToolRole(db, { repositoryId: a, cliToolId: 'claude' }, deps({ [ROOT_B]: '/other/.git' }))
      ).toMatchObject({ kind: 'role', source: 'repository', repositoryId: a });
      expect(b).toBeTruthy();
    });

    it('an unknown repository is an error', async () => {
      await expect(resolveRepositoryToolRole(db, { repositoryId: 'nope', cliToolId: 'claude' }, deps())).rejects.toThrow(
        AgentRoleTargetNotFoundError
      );
    });
  });
});
