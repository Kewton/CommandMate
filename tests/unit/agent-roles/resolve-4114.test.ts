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
import { getAgentInstances, setAgentInstances } from '@/lib/db/agent-instances-db';
import {
  buildInstanceRoleSettings,
  buildRepositoryRoleDefaults,
  computeRosterRevision,
} from '@/lib/agent-roles/management';
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

      it('an unidentifiable root with no row still holds inherit, which disagrees with a role', async () => {
        const a = register(ROOT_A);
        register(ROOT_B);
        setRepositoryRoleState(db, a, 'claude', { state: 'role', roleId: roleR });
        const result = await resolveInstanceRole(
          db,
          { worktreeId: WT, instanceId: 'claude' },
          deps({ [ROOT_B]: null }, [ROOT_B])
        );
        expect(result).toMatchObject({ kind: 'ambiguous', reason: 'membership-undetermined' });
      });

      it('an unidentifiable root that inherits, like a member that inherits, blocks nothing', async () => {
        register(ROOT_A);
        register(ROOT_B);
        setSystemRoleDefault(db, 'claude', roleS);
        const result = await resolveInstanceRole(
          db,
          { worktreeId: WT, instanceId: 'claude' },
          deps({ [ROOT_B]: null }, [ROOT_B])
        );
        expect(result).toMatchObject({ kind: 'role', source: 'system' });
      });

      describe('a git failure does not change whether two settings agree', () => {
        type State = 'inherit' | 'none' | 'role-1' | 'role-2';
        const states: State[] = ['inherit', 'none', 'role-1', 'role-2'];
        const pairs = states.flatMap((a) => states.map((b): [State, State] => [a, b]));

        it.each(pairs)('A=%s B=%s', async (stateA, stateB) => {
          const toInput = (state: State): RoleAssignmentInput =>
            state === 'role-1'
              ? { state: 'role', roleId: roleR }
              : state === 'role-2'
                ? { state: 'role', roleId: roleS }
                : { state };
          const a = register(ROOT_A);
          const b = register(ROOT_B);
          setRepositoryRoleState(db, a, 'claude', toInput(stateA));
          setRepositoryRoleState(db, b, 'claude', toInput(stateB));

          const target = { worktreeId: WT, instanceId: 'claude' };
          const answered = await resolveInstanceRole(db, target, deps());
          const failed = await resolveInstanceRole(db, target, deps({ [ROOT_B]: null }, [ROOT_B]));

          expect(failed.kind).toBe(answered.kind);
          expect(answered.kind === 'ambiguous').toBe(stateA !== stateB);
          if (failed.kind === 'ambiguous') expect(failed.reason).toBe('membership-undetermined');
          if (answered.kind === 'ambiguous') expect(answered.reason).toBe('root-settings-differ');
        });
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

  describe('a change while git is being asked', () => {
    /** A resolver that runs `change` once, in the middle of the first question. */
    function interrupting(change: () => void): RoleResolverDeps {
      let done = false;
      return {
        resolveCommonDir: async () => {
          if (!done) {
            done = true;
            change();
          }
          return '/common/.git';
        },
        pathExists: () => false,
      };
    }
    const geminiRoster = [{ id: 'second', cliTool: 'gemini' as const, alias: 'x', order: 0 }];
    const codexRoster = [{ id: 'second', cliTool: 'codex' as const, alias: 'x', order: 0 }];

    it('resolveInstanceRole answers for the tool the setting was made for', async () => {
      register(ROOT_A);
      setAgentInstances(db, WT, geminiRoster);
      const result = await resolveInstanceRole(
        db,
        { worktreeId: WT, instanceId: 'second' },
        interrupting(() => {
          setAgentInstances(db, WT, codexRoster);
          setInstanceRoleState(db, WT, 'second', { state: 'role', roleId: roleI });
        })
      );
      expect(result).toMatchObject({ kind: 'role', source: 'instance', cliToolId: 'codex' });
    });

    it('the settings list never pairs the old tool with the new setting', async () => {
      register(ROOT_A);
      setAgentInstances(db, WT, geminiRoster);
      const settings = await buildInstanceRoleSettings(
        db,
        WT,
        interrupting(() => {
          setAgentInstances(db, WT, codexRoster);
          setInstanceRoleState(db, WT, 'second', { state: 'role', roleId: roleI });
        })
      );
      expect(settings.instances).toHaveLength(1);
      expect(settings.instances[0]).toMatchObject({
        cliToolId: 'codex',
        supported: true,
        stored: { state: 'role', roleId: roleI },
        application: { effectiveNext: { kind: 'role', source: 'instance', cliToolId: 'codex' } },
      });
      expect(settings.rosterRevision).toBe(computeRosterRevision(getAgentInstances(db, WT)));
    });

    it('a re-scan that moves the worktree to another root asks again', async () => {
      const a = register(ROOT_A);
      const b = register(ROOT_B);
      setRepositoryRoleState(db, a, 'claude', { state: 'role', roleId: roleR });
      setRepositoryRoleState(db, b, 'claude', { state: 'none' });
      const calls: string[] = [];
      let moved = false;
      const result = await resolveInstanceRole(db, { worktreeId: WT, instanceId: 'claude' }, {
        resolveCommonDir: async (path) => {
          calls.push(path);
          if (!moved) {
            moved = true;
            db.prepare('UPDATE worktrees SET repository_path = ? WHERE id = ?').run(ROOT_B, WT);
          }
          return path === ROOT_A ? '/a/.git' : '/b/.git';
        },
        pathExists: () => false,
      });
      expect(result).toMatchObject({ kind: 'none', source: 'repository', repositoryId: b });
    });

    it('a root registered meanwhile takes part', async () => {
      const a = register(ROOT_A);
      setRepositoryRoleState(db, a, 'claude', { state: 'role', roleId: roleR });
      const result = await resolveInstanceRole(
        db,
        { worktreeId: WT, instanceId: 'claude' },
        interrupting(() => register(ROOT_B))
      );
      expect(result).toMatchObject({ kind: 'ambiguous', reason: 'root-settings-differ' });
    });

    it('a root deleted meanwhile does not take part', async () => {
      const a = register(ROOT_A);
      const b = register(ROOT_B);
      setRepositoryRoleState(db, a, 'claude', { state: 'role', roleId: roleR });
      const result = await resolveInstanceRole(
        db,
        { worktreeId: WT, instanceId: 'claude' },
        interrupting(() => deleteRepository(db, b))
      );
      expect(result).toMatchObject({ kind: 'role', repositoryIds: [a] });
    });

    it('a worktree deleted meanwhile is not found', async () => {
      register(ROOT_A);
      const remove = () => db.prepare('DELETE FROM worktrees WHERE id = ?').run(WT);
      await expect(
        resolveInstanceRole(db, { worktreeId: WT, instanceId: 'claude' }, interrupting(remove))
      ).rejects.toThrow(AgentRoleTargetNotFoundError);
    });

    it('the defaults-only entrances read after the wait as well', async () => {
      const a = register(ROOT_A);
      const schedule = await resolveWorktreeToolRole(
        db,
        { worktreeId: WT, cliToolId: 'claude' },
        interrupting(() => setRepositoryRoleState(db, a, 'claude', { state: 'none' }))
      );
      expect(schedule).toMatchObject({ kind: 'none', source: 'repository' });

      const { repository, defaults } = await buildRepositoryRoleDefaults(
        db,
        a,
        interrupting(() => {
          setRepositoryRoleState(db, a, 'claude', { state: 'role', roleId: roleR });
          setRepositoryEnabled(db, a, false);
        })
      );
      expect(repository.enabled).toBe(false);
      const claude = defaults.find((entry) => entry.cliToolId === 'claude');
      expect(claude?.stored).toMatchObject({ state: 'role', roleId: roleR });
      expect(claude?.effective).toMatchObject({ kind: 'role', source: 'repository' });
    });

    /**
     * Apply one atomic change at every microtask tick of a resolution, and require
     * each answer to be wholly from before it or wholly from after it. The gap this
     * guards is between the last check and the reads: a promise resolving there hands
     * control to whatever else is queued, however short the code looks.
     */
    describe('no tick of the event loop splits an answer', () => {
      const TICKS = 40;

      function reopen(): void {
        db.close();
        db = new Database(':memory:');
        runMigrations(db);
        insertWorktree(db, WT, ROOT_A);
        roleI = createAgentRole(db, { name: 'individual', body: 'I' }).id;
        roleR = createAgentRole(db, { name: 'repository', body: 'R' }).id;
        roleS = createAgentRole(db, { name: 'system', body: 'S' }).id;
      }

      /** @returns The labels of the answers seen: both must occur, or the sweep proved nothing. */
      async function sweep<R>(
        scenario: () => { run: () => Promise<R>; change: () => void; label: (result: R) => string }
      ): Promise<Set<string>> {
        const seen = new Set<string>();
        for (let tick = 0; tick <= TICKS; tick += 1) {
          reopen();
          const { run, change, label } = scenario();
          const applied = (async () => {
            for (let i = 0; i < tick; i += 1) await null;
            change();
          })();
          const [result] = await Promise.all([run(), applied]);
          seen.add(label(result));
        }
        return seen;
      }

      /** A worktree that moves from root A to root B, with the git answers following it. */
      function movingWorktree(): { a: string; b: string; deps: RoleResolverDeps; move: () => void } {
        const a = register(ROOT_A);
        const b = register(ROOT_B);
        let moved = false;
        return {
          a,
          b,
          deps: {
            resolveCommonDir: async (path) => {
              if (path === ROOT_A) return '/a/.git';
              if (path === ROOT_B) return '/b/.git';
              return moved ? '/b/.git' : '/a/.git';
            },
            pathExists: () => false,
          },
          move: () => {
            moved = true;
            db.prepare('UPDATE worktrees SET repository_path = ? WHERE id = ?').run(ROOT_B, WT);
          },
        };
      }

      /** Root A alone, then in one step a second root of the same repository and new settings. */
      function growingRepository(): { a: string; deps: RoleResolverDeps; grow: () => void } {
        const a = register(ROOT_A);
        setRepositoryRoleState(db, a, 'claude', { state: 'role', roleId: roleR });
        return {
          a,
          deps: { resolveCommonDir: async () => '/common/.git', pathExists: () => false },
          grow: () => {
            setRepositoryRoleState(db, a, 'claude', { state: 'none' });
            const b = register(ROOT_B);
            setRepositoryRoleState(db, b, 'claude', { state: 'none' });
          },
        };
      }

      it('resolveInstanceRole', async () => {
        const seen = await sweep(() => {
          const { a, b, deps, move } = movingWorktree();
          setRepositoryRoleState(db, a, 'claude', { state: 'role', roleId: roleR });
          return {
            run: () => resolveInstanceRole(db, { worktreeId: WT, instanceId: 'claude' }, deps),
            change: () => {
              move();
              setInstanceRoleState(db, WT, 'claude', { state: 'role', roleId: roleI });
            },
            label: (result) =>
              `${result.repositoryId === a ? 'A' : result.repositoryId === b ? 'B' : '?'}/${result.source}`,
          };
        });
        expect([...seen].sort()).toEqual(['A/repository', 'B/instance']);
      });

      it('resolveWorktreeToolRole', async () => {
        const seen = await sweep(() => {
          const { a, b, deps, move } = movingWorktree();
          setRepositoryRoleState(db, a, 'claude', { state: 'role', roleId: roleR });
          return {
            run: () => resolveWorktreeToolRole(db, { worktreeId: WT, cliToolId: 'claude' }, deps),
            change: () => {
              move();
              setRepositoryRoleState(db, a, 'claude', { state: 'none' });
              setRepositoryRoleState(db, b, 'claude', { state: 'role', roleId: roleS });
            },
            label: (result) =>
              `${result.repositoryId === a ? 'A' : 'B'}/${result.kind === 'role' ? result.role.name : result.kind}`,
          };
        });
        expect([...seen].sort()).toEqual(['A/repository', 'B/system']);
      });

      it('resolveRepositoryToolRole', async () => {
        const seen = await sweep(() => {
          const { a, deps, grow } = growingRepository();
          return {
            run: () => resolveRepositoryToolRole(db, { repositoryId: a, cliToolId: 'claude' }, deps),
            change: grow,
            label: (result) => `${result.repositoryIds.length}/${result.kind}`,
          };
        });
        expect([...seen].sort()).toEqual(['1/role', '2/none']);
      });

      it('buildInstanceRoleSettings', async () => {
        const seen = await sweep(() => {
          const { a, deps, move } = movingWorktree();
          setRepositoryRoleState(db, a, 'claude', { state: 'role', roleId: roleR });
          return {
            run: () => buildInstanceRoleSettings(db, WT, deps),
            change: () => {
              move();
              setInstanceRoleState(db, WT, 'claude', { state: 'role', roleId: roleI });
            },
            label: (settings) => {
              const claude = settings.instances.find((entry) => entry.instanceId === 'claude');
              const next = claude?.application.effectiveNext;
              return `${next?.repositoryId === a ? 'A' : 'B'}/${claude?.stored.state}/${next?.source}`;
            },
          };
        });
        expect([...seen].sort()).toEqual(['A/inherit/repository', 'B/role/instance']);
      });

      it('buildRepositoryRoleDefaults', async () => {
        const seen = await sweep(() => {
          const { a, deps, grow } = growingRepository();
          return {
            run: () => buildRepositoryRoleDefaults(db, a, deps),
            change: grow,
            label: ({ defaults }) => {
              const claude = defaults.find((entry) => entry.cliToolId === 'claude');
              return `${claude?.effective.repositoryIds.length}/${claude?.stored.state}/${claude?.effective.kind}`;
            },
          };
        });
        expect([...seen].sort()).toEqual(['1/role/role', '2/none/none']);
      });
    });

    it('gives up rather than answer from something that never settles', async () => {
      register(ROOT_A);
      let flip = 0;
      await expect(
        resolveInstanceRole(db, { worktreeId: WT, instanceId: 'claude' }, {
          resolveCommonDir: async () => {
            flip += 1;
            db.prepare('UPDATE worktrees SET repository_path = ? WHERE id = ?').run(`/tmp/cm-4114/flip-${flip}`, WT);
            return '/common/.git';
          },
          pathExists: () => false,
        })
      ).rejects.toThrow(/kept changing/);
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
