/**
 * `GET /api/sessions/roles` (Issue #4387): the role of every instance, for the
 * `/sessions` filter, driven through the route against a real database and, for
 * the ambiguous case, real git (two checkouts of one repository registered as two
 * roots). Which process is running is the one thing mocked: only a live launch
 * writes it (`role-launch`'s evidence), and this suite starts none.
 *
 * Positive control: before #4387 the route does not exist, so every case here fails
 * at the import. Negative control: `GET /api/worktrees` keeps its shape (no role map).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { createRepository } from '@/lib/db/db-repository';
import {
  createAgentRole,
  recordRoleLaunch,
  setInstanceRoleState,
  setRepositoryRoleState,
} from '@/lib/db/agent-roles-db';
import type { RoleLaunchSnapshotInput, SessionRolesResponse } from '@/types/agent-roles';

let testDb: Database.Database;
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => testDb }));
vi.mock('@/lib/tmux/tmux', () => ({ listSessions: vi.fn(async () => []) }));

const running = vi.hoisted(() => new Map<string, string>());
vi.mock('@/lib/session/role-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session/role-launch')>()),
  getLaunchRoleEvidence: ({ worktreeId, instanceId, cliToolId }: { worktreeId: string; instanceId?: string; cliToolId: string }) => {
    const generation = running.get(`${worktreeId}/${instanceId ?? cliToolId}`);
    return generation ? { sessionGeneration: generation, injectionFingerprint: null } : null;
  },
}));

const logged = vi.hoisted(() => [] as Array<{ level: string; action: string }>);
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>();
  return {
    ...actual,
    createLogger: (module: string) => {
      const inner = actual.createLogger(module);
      const note = (level: 'debug' | 'info' | 'warn' | 'error') => (action: string, data?: Record<string, unknown>) => {
        logged.push({ level, action });
        inner[level](action, data);
      };
      return { ...inner, debug: note('debug'), info: note('info'), warn: note('warn'), error: note('error') };
    },
  };
});

import { GET as getSessionRoles } from '@/app/api/sessions/roles/route';
import { GET as getWorktrees } from '@/app/api/worktrees/route';

async function roles(): Promise<SessionRolesResponse> {
  const response = await getSessionRoles();
  expect(response.status).toBe(200);
  return response.json();
}

function launchedRecord(worktreeId: string, instanceId: string, generation: string, role: { id: string; name: string }): RoleLaunchSnapshotInput {
  return {
    worktreeId,
    instanceId,
    cliToolId: 'claude',
    phase: 'launched',
    sessionGeneration: generation,
    source: 'instance',
    repositoryId: null,
    roleId: role.id,
    roleName: role.name,
    bodyVersion: 1,
    bodyFingerprint: 'a'.repeat(64),
    injectionFingerprint: 'b'.repeat(64),
    artifactFingerprint: null,
    adapterId: 'claude',
    adapterVersion: null,
    wrapperVersion: null,
    artifactPath: null,
    effectiveAgent: null,
    compositionSourceFingerprint: null,
    noRoleReason: null,
  };
}

describe('[#4387] GET /api/sessions/roles', () => {
  let base: string;
  let roleX: { id: string; name: string };
  let roleY: { id: string; name: string };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'cm-4387-')));
    testDb = new Database(':memory:');
    runMigrations(testDb);
    running.clear();
    logged.length = 0;
    roleX = createAgentRole(testDb, { name: 'Marketer', body: 'm' });
    roleY = createAgentRole(testDb, { name: 'Reviewer', body: 'r' });
    upsertWorktree(testDb, { id: 'wt-a', name: 'wt-a', path: join(base, 'wt-a'), repositoryPath: join(base, 'none'), repositoryName: 'r' });
  });

  afterEach(() => {
    testDb.close();
    rmSync(base, { recursive: true, force: true });
  });

  it('a running instance with a launched record is launched; the others are their setting', async () => {
    setInstanceRoleState(testDb, 'wt-a', 'claude', { state: 'role', roleId: roleX.id });
    setInstanceRoleState(testDb, 'wt-a', 'codex', { state: 'role', roleId: roleY.id });
    recordRoleLaunch(testDb, launchedRecord('wt-a', 'claude', 'g1', roleX));
    running.set('wt-a/claude', 'g1');

    const body = await roles();
    expect(body.rolesUnavailable).toBeUndefined();
    expect(body.roleByWorktree['wt-a']).toMatchObject({
      claude: { kind: 'role', roleId: roleX.id, roleName: 'Marketer', basis: 'launched' },
      codex: { kind: 'role', roleId: roleY.id, roleName: 'Reviewer', basis: 'setting' },
    });
  });

  it('right after the setting changes, a running instance still answers the role it was started with', async () => {
    setInstanceRoleState(testDb, 'wt-a', 'claude', { state: 'role', roleId: roleX.id });
    recordRoleLaunch(testDb, launchedRecord('wt-a', 'claude', 'g1', roleX));
    running.set('wt-a/claude', 'g1');
    setInstanceRoleState(testDb, 'wt-a', 'claude', { state: 'role', roleId: roleY.id });

    expect((await roles()).roleByWorktree['wt-a'].claude).toEqual({
      kind: 'role',
      roleId: roleX.id,
      roleName: 'Marketer',
      basis: 'launched',
    });

    // Stopped: the record is history, and the next start's role answers.
    running.clear();
    expect((await roles()).roleByWorktree['wt-a'].claude).toEqual({
      kind: 'role',
      roleId: roleY.id,
      roleName: 'Reviewer',
      basis: 'setting',
    });
  });

  it('ambiguous (two checkouts of one repository disagree) is told apart from none', async () => {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    const main = join(base, 'main');
    const second = join(base, 'second');
    const work = join(base, 'work');
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    git(main, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '-b', 'second', second);
    git(main, 'worktree', 'add', '-q', '-b', 'work', work);
    const rootMain = createRepository(testDb, { name: 'main', path: main, cloneSource: 'local' }).id;
    const rootSecond = createRepository(testDb, { name: 'second', path: second, cloneSource: 'local' }).id;
    upsertWorktree(testDb, { id: 'wt-work', name: 'work', path: work, repositoryPath: main, repositoryName: 'main' });
    setRepositoryRoleState(testDb, rootMain, 'claude', { state: 'role', roleId: roleX.id });
    setRepositoryRoleState(testDb, rootSecond, 'claude', { state: 'role', roleId: roleY.id });
    setInstanceRoleState(testDb, 'wt-work', 'codex', { state: 'none' });

    const body = await roles();
    expect(body.roleByWorktree['wt-work'].claude).toEqual({ kind: 'ambiguous' });
    expect(body.roleByWorktree['wt-work'].codex).toEqual({ kind: 'none' });

    // Control: once the roots agree, the same instance has the role.
    setRepositoryRoleState(testDb, rootSecond, 'claude', { state: 'role', roleId: roleX.id });
    expect((await roles()).roleByWorktree['wt-work'].claude).toEqual({
      kind: 'role',
      roleId: roleX.id,
      roleName: 'Marketer',
      basis: 'setting',
    });
  });

  it('when the roles cannot be read, answers 200 with an empty map, says so, and logs', async () => {
    testDb.exec('DROP TABLE agent_role_launch_records');
    const body = await roles();
    expect(body).toEqual({ success: true, roleByWorktree: {}, rolesUnavailable: true });
    expect(logged).toContainEqual({ level: 'error', action: 'roles:read-failed' });
  });

  it('GET /api/worktrees keeps its shape: the roles are not on the list', async () => {
    setInstanceRoleState(testDb, 'wt-a', 'claude', { state: 'role', roleId: roleX.id });
    const response = await getWorktrees(new NextRequest(new Request('http://localhost:3000/api/worktrees?includeStatus=0')));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.worktrees).toHaveLength(1);
    expect(body.worktrees[0]).not.toHaveProperty('roleByInstance');
    expect(body).not.toHaveProperty('roleByWorktree');
  });
});
