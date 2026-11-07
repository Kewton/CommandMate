/**
 * Issue #4115: a Schedule's role, and the daily summary having none.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Module from 'module';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { createRepository } from '@/lib/db/db-repository';
import {
  createAgentRole,
  setInstanceRoleState,
  setRepositoryRoleState,
  setSystemRoleDefault,
} from '@/lib/db/agent-roles-db';
import { resolveScheduleRole } from '@/lib/session/role-launch';
import { buildCliArgs } from '@/lib/session/claude-executor';
import { executeSchedule, type ScheduleState } from '@/lib/job-executor';

const executeClaudeCommand = vi.hoisted(() => vi.fn());
const dbHolder = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@/lib/session/claude-executor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session/claude-executor')>()),
  executeClaudeCommand,
}));

/** job-executor reaches the database through a lazy `require`, which vi.mock does not see. */
type ModuleWithLoad = { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const moduleLoader = Module as unknown as ModuleWithLoad;
const originalLoad = moduleLoader._load;

const WT = 'wt-schedule-4115';
let dir: string;
let worktreePath: string;
let db: Database.Database;
let repositoryId: string;
let a: string;
let b: string;

function resolve(cliToolId = 'claude', explicitAgent?: string, env: Record<string, string> = {}) {
  return resolveScheduleRole(
    db,
    { worktreeId: WT, cliToolId, worktreePath, explicitAgent, env },
    { resolveCommonDir: async () => null, pathExists: () => false }
  );
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-role-schedule-4115-'));
  worktreePath = path.join(dir, 'wt');
  fs.mkdirSync(worktreePath);
  db = new Database(':memory:');
  runMigrations(db);
  const root = path.join(dir, 'root');
  fs.mkdirSync(root);
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES (?, ?, ?, ?, 'repo')`
  ).run(WT, WT, worktreePath, root);
  repositoryId = createRepository(db, { name: 'repo', path: root, cloneSource: 'local' }).id;
  a = createAgentRole(db, { name: 'A', body: 'BODY A' }).id;
  b = createAgentRole(db, { name: 'B', body: 'BODY B' }).id;
  dbHolder.db = db;
  executeClaudeCommand.mockReset();
  executeClaudeCommand.mockResolvedValue({ status: 'completed', output: 'ok', exitCode: 0 });
  vi.stubEnv('CM_AGENT_ROLE_ARTIFACTS_DIR', path.join(dir, 'data'));
  vi.stubEnv('CODEX_HOME', path.join(dir, 'codex'));
  vi.stubEnv('COPILOT_HOME', path.join(dir, 'copilot'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(dir, 'config'));
  fs.mkdirSync(path.join(dir, 'codex'));
  fs.mkdirSync(path.join(dir, 'copilot'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('resolveScheduleRole', () => {
  it('prefers the repository default over the system default', async () => {
    setSystemRoleDefault(db, 'claude', a);
    setRepositoryRoleState(db, repositoryId, 'claude', { state: 'role', roleId: b });
    await expect(resolve()).resolves.toMatchObject({ kind: 'role', roleName: 'B' });
  });

  it('respects the repository\'s explicit "none" over the system default', async () => {
    setSystemRoleDefault(db, 'claude', a);
    setRepositoryRoleState(db, repositoryId, 'claude', { state: 'none' });
    await expect(resolve()).resolves.toEqual({ kind: 'none' });
  });

  it('with no row for the repository it takes the system default', async () => {
    setSystemRoleDefault(db, 'claude', a);
    await expect(resolve()).resolves.toMatchObject({ kind: 'role', roleName: 'A' });
  });

  it('does not inherit the primary\'s own setting', async () => {
    setInstanceRoleState(db, WT, 'claude', { state: 'role', roleId: b });
    await expect(resolve()).resolves.toEqual({ kind: 'none' });
    setSystemRoleDefault(db, 'claude', a);
    await expect(resolve()).resolves.toMatchObject({ roleName: 'A' });
  });

  it('a file it cannot write is a refusal, not a run without the role', async () => {
    fs.writeFileSync(path.join(dir, 'data'), 'in the way');
    setSystemRoleDefault(db, 'claude', a);
    await expect(resolve()).resolves.toMatchObject({ kind: 'refused', refusal: { reason: 'artifact-failed' } });
  });

  it('the disabled adapter refuses', async () => {
    setSystemRoleDefault(db, 'antigravity', a);
    await expect(resolve('antigravity')).resolves.toMatchObject({ kind: 'refused', refusal: { reason: 'adapter-disabled' } });
  });

  it('a tool outside D3 has no role, and no database question is asked', async () => {
    const spy = vi.spyOn(db, 'prepare');
    await expect(resolve('gemini')).resolves.toEqual({ kind: 'none' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('an explicit agent is kept: V1 alongside, V2 overriding that agent, refused when it has its own text', async () => {
    setSystemRoleDefault(db, 'opencode', a);
    setSystemRoleDefault(db, 'opencode-v2', a);
    const v1 = await resolve('opencode', 'plan');
    expect(v1.kind).toBe('role');
    const v2 = await resolve('opencode-v2', 'plan');
    if (v2.kind !== 'role') throw new Error(v2.kind);
    expect(Object.keys(JSON.parse(v2.role.env.OPENCODE_CONFIG_CONTENT).agents)).toEqual(['plan']);

    const refused = await resolve('opencode-v2', 'plan', {
      OPENCODE_CONFIG_CONTENT: '{"agents":{"plan":{"system":"mine"}}}',
    });
    expect(refused).toMatchObject({ kind: 'refused', refusal: { reason: 'composition-failed' } });
  });

  it.each(['opencode', 'opencode-v2'])('%s: a broken env of the user\'s refuses, so the run never gets it', async (cliToolId) => {
    setSystemRoleDefault(db, cliToolId, a);
    const refused = await resolve(cliToolId, undefined, { OPENCODE_CONFIG_CONTENT: '{broken' });
    expect(refused).toMatchObject({ kind: 'refused', refusal: { reason: 'composition-failed' } });
  });

  it('the env it composes with is the one the child gets, kept whole', async () => {
    setSystemRoleDefault(db, 'opencode-v2', a);
    const composed = await resolve('opencode-v2', undefined, {
      OPENCODE_CONFIG_CONTENT: '{"default_agent":"mine","model":"m","providers":{"p":{}}}',
    });
    if (composed.kind !== 'role') throw new Error(composed.kind);
    const value = JSON.parse(composed.role.env.OPENCODE_CONFIG_CONTENT);
    expect(value).toMatchObject({ default_agent: 'mine', model: 'm', providers: { p: {} } });
    expect(Object.keys(value.agents)).toEqual(['mine']);
  });
});

describe('buildCliArgs with a role', () => {
  const leading = (args: string[]) => ({ args, headlessPosition: 'leading' as const, env: {} });
  const trailing = (args: string[]) => ({ args, headlessPosition: 'trailing' as const, env: {} });

  it('Codex: `-p` before `exec`', () => {
    expect(buildCliArgs('M', 'codex', undefined, { role: leading(['-p', 'cm-role-x']) }).slice(0, 3)).toEqual(['-p', 'cm-role-x', 'exec']);
  });

  it('Copilot: `gh copilot --agent <id>`, before `-p`', () => {
    expect(buildCliArgs('M', 'copilot', undefined, { role: leading(['--agent', 'cm-role-x']) }).slice(0, 4)).toEqual([
      'copilot',
      '--agent',
      'cm-role-x',
      '-p',
    ]);
  });

  it('Claude and Command Code: after what they had; no role is unchanged', () => {
    const plain = buildCliArgs('M', 'claude');
    expect(buildCliArgs('M', 'claude', undefined, { role: trailing(['--append-system-prompt-file', '/f']) })).toEqual([
      ...plain,
      '--append-system-prompt-file',
      '/f',
    ]);
    expect(buildCliArgs('M', 'command-code', undefined, { role: trailing(['--mod', '/f.ts']) }).slice(-2)).toEqual(['--mod', '/f.ts']);
    expect(buildCliArgs('M', 'claude', undefined, { role: trailing([]) })).toEqual(plain);
  });

  it('never has the body: only what it was handed', () => {
    expect(buildCliArgs('M', 'opencode', undefined, { role: trailing([]) })).toEqual(buildCliArgs('M', 'opencode'));
  });
});

describe('executeSchedule', () => {
  const state = (cliToolId: string): ScheduleState =>
    ({
      scheduleId: 'schedule-1',
      worktreeId: WT,
      isExecuting: false,
      entry: { name: 's', message: 'do it', cliToolId, permission: undefined },
    }) as unknown as ScheduleState;

  afterEach(() => {
    moduleLoader._load = originalLoad;
  });

  beforeEach(() => {
    moduleLoader._load = function (request: string, parent: unknown, isMain: boolean) {
      if (request.endsWith('db-instance')) return { getDbInstance: () => dbHolder.db };
      return originalLoad.call(this, request, parent, isMain);
    };
    db.prepare(
      `INSERT INTO scheduled_executions (id, worktree_id, name, message, cron_expression, cli_tool_id, enabled, created_at, updated_at)
       VALUES ('schedule-1', ?, 's', 'do it', '* * * * *', 'claude', 1, 0, 0)`
    ).run(WT);
  });

  it('hands the role to the run', async () => {
    setSystemRoleDefault(db, 'claude', a);
    await executeSchedule(state('claude'));
    const options = executeClaudeCommand.mock.calls[0][4];
    expect(options.role.args[0]).toBe('--append-system-prompt-file');
    expect(JSON.stringify(executeClaudeCommand.mock.calls[0])).not.toContain('BODY A');
  });

  it('with no role the options are as they were', async () => {
    await executeSchedule(state('claude'));
    expect(executeClaudeCommand.mock.calls[0][4]).toBeUndefined();
  });

  it('a role it cannot prepare fails the run, and runs nothing', async () => {
    fs.writeFileSync(path.join(dir, 'data'), 'in the way');
    setSystemRoleDefault(db, 'claude', a);
    await executeSchedule(state('claude'));
    expect(executeClaudeCommand).not.toHaveBeenCalled();
    const row = db.prepare('SELECT status, result FROM execution_logs').get() as { status: string; result: string };
    expect(row.status).toBe('failed');
    expect(row.result).toMatch(/role launch refused: artifact-failed/);
  });
});

describe('the daily summary', () => {
  it('neither resolves a role nor reaches the module that does', () => {
    const generator = fs.readFileSync('src/lib/daily-summary-generator.ts', 'utf8');
    const executor = fs.readFileSync('src/lib/session/claude-executor.ts', 'utf8');
    expect(generator).not.toMatch(/role-launch|agent-roles|resolveScheduleRole/);
    // The executor is shared, so it must not open a role's database on its own.
    expect(executor).not.toMatch(/from '@\/lib\/(session\/role-launch|agent-roles|db\/agent-roles-db)/);
    expect(generator).not.toMatch(/role:/);
  });

  it('a run with no role option gets no role, whatever the defaults say', () => {
    setSystemRoleDefault(db, 'claude', a);
    expect(buildCliArgs('M', 'claude')).not.toContain('--append-system-prompt-file');
  });
});
