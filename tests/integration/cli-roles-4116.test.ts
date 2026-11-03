/**
 * Issue #4116: the role commands, driven as a person runs them, against the real
 * routes and an in-memory database. `fetch` is what is replaced: the CLI does its
 * real requests, the routes answer them, and a real send service stands between the
 * route and a fake tool that records what was typed. No tmux, no server, no home.
 *
 * Everything that races is really interleaved: the hook runs at the moment named.
 *
 * Conflicts per command: `add`/`edit` name, `edit` version, `rm` in use, `instances
 * add` exists and roster, `send` the role condition and roster. `show`, `list`,
 * `defaults` read, and `default` / `set-role` overwrite what they name, so they have
 * nothing to conflict with; the server has no version on a default.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import type { Command } from 'commander';
import { runMigrations } from '@/lib/db/db-migrations';
import { getAgentInstances, setAgentInstances } from '@/lib/db/agent-instances-db';
import { getWorktreeById, upsertWorktree } from '@/lib/db';
import { createRepository } from '@/lib/db/db-repository';
import {
  createAgentRole,
  getAgentRole,
  getInstanceRoleState,
  getLatestRoleLaunchRecords,
  listAgentRoles,
  recordRoleLaunch,
  setInstanceRoleState,
  setSystemRoleDefault,
} from '@/lib/db/agent-roles-db';
import { resetSessionLaunchFlightsForTest } from '@/lib/session/session-launch-flight';
import {
  getLaunchRoleEvidence,
  resetLaunchRoleStateForTest,
  resolveLaunchRole,
  runWithLaunchRole,
  setLaunchRoleDatabaseForTest,
} from '@/lib/session/role-launch';
import { beginAgentSession, buildAgentLaunchCommandLine } from '@/lib/session/agent-session-lifecycle';
import { fixedEnvReader } from '@/lib/agent-roles/composition';
import { noteInputStart, resetInstanceInputLocks } from '@/lib/session/instance-input-lock';
import { resolveAgentInstances } from '@/lib/session/agent-instances-resolver';
import type { Worktree } from '@/types/models';

const fakeTool = vi.hoisted(() => ({
  running: false,
  typed: [] as string[],
  /** Runs inside the send, right before the sender notes its first key. */
  beforeFirstKey: null as null | (() => Promise<void>),
  onStart: null as null | ((instanceId: string | undefined) => Promise<void>),
}));

vi.mock('@/lib/cli-tools/codex', () => ({
  CodexTool: class {
    id = 'codex';
    name = 'Codex CLI';
    command = 'codex';
    async isInstalled() { return true; }
    async isRunning() { return fakeTool.running; }
    async startSession(_id: string, _worktreePath: string, instanceId?: string) {
      await fakeTool.onStart?.(instanceId);
      fakeTool.running = true;
    }
    async sendMessage(_id: string, message: string) {
      await fakeTool.beforeFirstKey?.();
      noteInputStart();
      fakeTool.typed.push(message);
    }
    async killSession() { fakeTool.running = false; }
    getSessionName(id: string, instanceId?: string) { return `mcbd-codex-${id}-${instanceId ?? 'codex'}`; }
  },
}));
const ownership = vi.hoisted(() => ({ hook: null as null | (() => void) }));
vi.mock('@/lib/cli-tools/session-ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/session-ownership')>()),
  checkSessionOwnership: vi.fn(async () => {
    ownership.hook?.();
    return { verdict: 'absent' };
  }),
}));
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: '/wt' })),
}));
vi.mock('@/app/api/worktrees/[id]/send/pane-shell', () => ({ isPaneBackAtShell: vi.fn(async () => false) }));
vi.mock('@/lib/session/prompt-waiting-guard', () => ({
  isPromptWaiting: vi.fn(async () => ({ waiting: false })),
  promptWaitingMessage: vi.fn(() => 'prompt waiting'),
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutputFresh: vi.fn(async () => '') }));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn(), getActivePollers: vi.fn(() => []) }));
vi.mock('@/lib/assistant-response-saver', () => ({ savePendingAssistantResponse: vi.fn() }));
vi.mock('@/lib/ws-server', () => ({ broadcast: vi.fn(), broadcastMessage: vi.fn(), cleanupRooms: vi.fn() }));
vi.mock('@/lib/session-cleanup', () => ({
  cleanupMultipleWorktrees: vi.fn(async () => ({ results: [], warnings: [] })),
  createOwnedSessionKiller: vi.fn(() => vi.fn(async () => false)),
}));
vi.mock('@/lib/git/git-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/git/git-utils')>()),
  getGitStatus: vi.fn(async () => {
    throw new Error('not a repository');
  }),
}));
vi.mock('@/lib/realtime/terminal-broadcast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime/terminal-broadcast')>()),
  broadcastSessionStatus: vi.fn(),
}));
vi.mock('@/lib/db/db-instance', () => {
  const holder: { db: Database.Database | null } = { db: null };
  return {
    getDbInstance: () => {
      if (!holder.db) throw new Error('Mock database not initialized');
      return holder.db;
    },
    setMockDb: (value: Database.Database | null) => {
      holder.db = value;
    },
  };
});

import * as rolesRoute from '@/app/api/roles/route';
import * as roleRoute from '@/app/api/roles/[id]/route';
import * as systemRoute from '@/app/api/settings/agent-role-defaults/route';
import * as repositoryDefaultsRoute from '@/app/api/repositories/[id]/role-defaults/route';
import * as repositoriesRoute from '@/app/api/repositories/route';
import * as instanceRolesRoute from '@/app/api/worktrees/[id]/instances/roles/route';
import * as sendRoute from '@/app/api/worktrees/[id]/send/route';
import * as tasksRoute from '@/app/api/worktrees/[id]/tasks/route';
import * as resolveTargetRoute from '@/app/api/worktrees/[id]/resolve-target/route';
import { createRolesCommand } from '@/cli/commands/roles';
import { createInstancesCommand } from '@/cli/commands/instances';
import { createSendCommand } from '@/cli/commands/send';

const WT = 'wt-4116';
const target = { worktreeId: WT, cliToolId: 'codex' as const };
const CONTRACT = 'version: 1\ntitle: t\ngoal: |\n  Do the work.\nscope:\n  allow: ["src/**"]\n';
const BODY = '一行目\n\n  二行目  \r\n末尾の改行あり\n';

let dir: string;
let worktreePath: string;
let root: string;
let db: Database.Database;
let reviewer: string;
let writer: string;
let taskStatuses: string[];
/** The Auto-Yes route's state and what it was told, per `<tool>:<instance>`. */
let autoYes: { on: boolean; posts: Array<Record<string, unknown>> };

type RouteHandler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

/** What the tests need of the routes this harness does not run for real. */
function stubbed(pathname: string): unknown | undefined {
  if (pathname === '/api/capabilities') return { serverVersion: 'test', capabilities: ['resolve-session-target'] };
  if (pathname === '/api/worktrees') {
    return { worktrees: [{ id: WT, path: worktreePath, repositoryPath: root }], repositories: [] };
  }
  if (pathname === `/api/worktrees/${WT}`) {
    const row = getWorktreeById(db, WT) as Worktree;
    return { id: WT, name: 'wt', agentInstances: resolveAgentInstances(db, WT, row.selectedAgents) };
  }
  if (pathname === `/api/worktrees/${WT}/current-output`) return { isRunning: fakeTool.running };
  if (pathname === `/api/worktrees/${WT}/auto-yes`) return { instances: {} };
  if (pathname === `/api/worktrees/${WT}/opencode/session`) return { instances: [] };
  return undefined;
}

function routed(pathname: string): { handlers: Record<string, unknown>; params: Record<string, string> } | null {
  let match: RegExpMatchArray | null;
  if (pathname === '/api/roles') return { handlers: rolesRoute, params: {} };
  if ((match = pathname.match(/^\/api\/roles\/([^/]+)$/))) return { handlers: roleRoute, params: { id: match[1] } };
  if (pathname === '/api/settings/agent-role-defaults') return { handlers: systemRoute, params: {} };
  if (pathname === '/api/repositories') return { handlers: repositoriesRoute, params: {} };
  if ((match = pathname.match(/^\/api\/repositories\/([^/]+)\/role-defaults$/))) {
    return { handlers: repositoryDefaultsRoute, params: { id: match[1] } };
  }
  if ((match = pathname.match(/^\/api\/worktrees\/([^/]+)\/instances\/roles$/))) {
    return { handlers: instanceRolesRoute, params: { id: match[1] } };
  }
  if ((match = pathname.match(/^\/api\/worktrees\/([^/]+)\/send$/))) return { handlers: sendRoute, params: { id: match[1] } };
  if ((match = pathname.match(/^\/api\/worktrees\/([^/]+)\/tasks$/))) return { handlers: tasksRoute, params: { id: match[1] } };
  if ((match = pathname.match(/^\/api\/worktrees\/([^/]+)\/resolve-target$/))) {
    return { handlers: resolveTargetRoute, params: { id: match[1] } };
  }
  return null;
}

async function dispatch(input: unknown, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  if (url.pathname.startsWith('/api/tasks/')) {
    taskStatuses.push(JSON.parse(String(init?.body)).status);
    return Response.json({ ok: true });
  }
  if (url.pathname === `/api/worktrees/${WT}/auto-yes`) {
    if (method === 'POST') {
      const body = JSON.parse(String(init?.body));
      autoYes.posts.push(body);
      autoYes.on = body.enabled;
      return Response.json({ enabled: body.enabled });
    }
    return Response.json(url.searchParams.has('cliToolId') ? { enabled: autoYes.on } : { instances: {} });
  }
  const route = routed(url.pathname);
  if (route) {
    const handler = route.handlers[method] as RouteHandler | undefined;
    if (!handler) return Response.json({ error: `no ${method}` }, { status: 405 });
    return handler(new NextRequest(url, init as ConstructorParameters<typeof NextRequest>[1]), {
      params: Promise.resolve(route.params),
    });
  }
  const stub = stubbed(url.pathname);
  if (stub === undefined) throw new Error(`Not stubbed: ${method} ${url.pathname}`);
  return Response.json(stub);
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json: () => any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** The first `process.exit` ends the command, as it really does. */
class ExitSignal extends Error {}

async function runCli(create: () => Command, args: string[], stdin?: Buffer[]): Promise<CliResult> {
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => void out.push(String(line)));
  const error = vi.spyOn(console, 'error').mockImplementation((line: unknown) => void err.push(String(line)));
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code ?? 0);
    throw new ExitSignal(String(code));
  }) as never);
  const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
  if (stdin) Object.defineProperty(process, 'stdin', { configurable: true, value: Readable.from(stdin) });
  try {
    await create().parseAsync(['node', 'cli', ...args]);
  } catch (signal) {
    if (!(signal instanceof ExitSignal)) throw signal;
  } finally {
    log.mockRestore();
    error.mockRestore();
    exit.mockRestore();
    if (stdin && realStdin) Object.defineProperty(process, 'stdin', realStdin);
  }
  const stdout = out.join('\n');
  return { code: exits[0] ?? 0, stdout, stderr: err.join('\n'), json: () => JSON.parse(stdout) };
}

const roles = (...args: string[]) => runCli(createRolesCommand, args);
const instances = (...args: string[]) => runCli(createInstancesCommand, [WT, ...args]);
const send = (...args: string[]) => runCli(createSendCommand, [WT, ...args]);

/** A real launch's effect on what is known, without tmux. */
async function launch(instanceId?: string): Promise<void> {
  const launchTarget = { ...target, instanceId };
  const snapshot = await resolveLaunchRole(db, { ...launchTarget, worktreePath, readEnv: fixedEnvReader({}) });
  await runWithLaunchRole(snapshot, async () => {
    beginAgentSession(launchTarget);
    buildAgentLaunchCommandLine({ target: launchTarget, executablePath: 'codex', worktreePath });
  });
}

/** What a tool's own evidence confirming the start writes (§14). */
function confirmLaunched(instanceId = 'codex'): void {
  const { requested } = getLatestRoleLaunchRecords(db, WT, instanceId);
  if (!requested) throw new Error('nothing was requested');
  const { id: _id, recordedAt: _at, ...record } = requested;
  recordRoleLaunch(db, { ...record, phase: 'launched' });
}

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cli-roles-4116-')));
  worktreePath = path.join(dir, 'wt');
  root = path.join(dir, 'root');
  fs.mkdirSync(path.join(worktreePath, '.commandmate', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(worktreePath, '.commandmate', 'tasks', 'x.yaml'), CONTRACT);
  fs.mkdirSync(root);
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = (await import('@/lib/db/db-instance')) as unknown as {
    setMockDb: (value: Database.Database | null) => void;
  };
  setMockDb(db);
  upsertWorktree(db, {
    id: WT,
    name: 'wt',
    path: worktreePath,
    repositoryPath: root,
    repositoryName: 'repo',
    cliToolId: 'codex',
  } as Worktree);
  db.prepare('UPDATE worktrees SET selected_agents = ? WHERE id = ?').run(JSON.stringify(['codex', 'claude']), WT);
  createRepository(db, { name: 'repo', path: root, cloneSource: 'local' });
  reviewer = createAgentRole(db, { name: 'reviewer', body: 'REVIEW' }).id;
  writer = createAgentRole(db, { name: 'writer', body: 'WRITE' }).id;
  setLaunchRoleDatabaseForTest(db);
  resetSessionLaunchFlightsForTest();
  resetInstanceInputLocks();
  fakeTool.running = false;
  fakeTool.typed = [];
  fakeTool.beforeFirstKey = null;
  fakeTool.onStart = (instanceId) => launch(instanceId);
  ownership.hook = null;
  taskStatuses = [];
  autoYes = { on: false, posts: [] };
  vi.stubEnv('CM_AGENT_HOOKS_INJECT', '0');
  vi.stubEnv('CM_AGENT_ROLE_ARTIFACTS_DIR', path.join(dir, 'data'));
  vi.stubEnv('CODEX_HOME', path.join(dir, 'codex'));
  vi.stubEnv('CM_PORT', '4116');
  fs.mkdirSync(path.join(dir, 'codex'));
  vi.stubGlobal('fetch', dispatch);
});

afterEach(async () => {
  resetLaunchRoleStateForTest();
  resetSessionLaunchFlightsForTest();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  const { setMockDb } = (await import('@/lib/db/db-instance')) as unknown as {
    setMockDb: (value: Database.Database | null) => void;
  };
  setMockDb(null);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A role whose name is another role's ID: the one exact ambiguity the database allows. */
function makeAmbiguous(): { selector: string } {
  createAgentRole(db, { name: reviewer, body: 'NAMED LIKE AN ID' });
  return { selector: reviewer };
}

function expectAmbiguous(result: CliResult): void {
  expect(result.code).toBe(2);
  expect(result.json()).toMatchObject({ success: false, error: 'ambiguous_role' });
  expect(result.json().candidates).toHaveLength(2);
}

describe('roles list / show', () => {
  it('list: every role, no bodies', async () => {
    const result = await roles('list', '--json');
    expect(result.code).toBe(0);
    expect(result.json().roles.map((role: { name: string }) => role.name)).toEqual(['reviewer', 'writer']);
    expect(result.json().roles[0].body).toBeUndefined();
    expect((await roles('list')).stdout).toContain('reviewer');
  });

  it('show: by ID and by name, with what points at it', async () => {
    setSystemRoleDefault(db, 'codex', reviewer);
    const byName = await roles('show', 'reviewer', '--json');
    expect(byName.json()).toMatchObject({ role: { id: reviewer, body: 'REVIEW' }, references: { system: [{ cliToolId: 'codex' }] } });
    expect((await roles('show', reviewer, '--json')).json().role.name).toBe('reviewer');
    expect((await roles('show', 'REVIEWER', '--json')).json().role.id).toBe(reviewer);
  });

  it('show: unknown and ambiguous are told apart', async () => {
    const unknown = await roles('show', 'nobody', '--json');
    expect(unknown.code).toBe(2);
    expect(unknown.json()).toMatchObject({ success: false, error: 'unknown_role' });
    expect(unknown.stderr).toContain('commandmate roles list');
    const { selector } = makeAmbiguous();
    const ambiguous = await roles('show', selector, '--json');
    expectAmbiguous(ambiguous);
    expect(ambiguous.stderr).toContain(reviewer);
  });
});

describe('roles add', () => {
  it('--file keeps the body byte for byte, in Japanese with its line ends', async () => {
    const file = path.join(dir, 'body.md');
    fs.writeFileSync(file, BODY);
    const result = await roles('add', 'マーケター', '--file', file, '--json');
    expect(result.code).toBe(0);
    expect(getAgentRole(db, result.json().role.id)?.body).toBe(BODY);
  });

  it('--stdin keeps it too, a character split across two chunks included', async () => {
    const bytes = Buffer.from(BODY, 'utf8');
    const result = await runCli(createRolesCommand, ['add', 'stdin-role', '--stdin', '--json'], [
      bytes.subarray(0, 1),
      bytes.subarray(1, 4),
      bytes.subarray(4),
    ]);
    expect(result.code).toBe(0);
    expect(getAgentRole(db, result.json().role.id)?.body).toBe(BODY);
  });

  it('a role may be called none: nothing is reserved', async () => {
    const file = path.join(dir, 'b.md');
    fs.writeFileSync(file, 'x');
    const added = await roles('add', 'none', '--file', file, '--json');
    expect(added.code).toBe(0);
    expect((await roles('show', 'none', '--json')).json().role.id).toBe(added.json().role.id);
  });

  it('a taken name is a conflict; no body, both sources, or a bad one are usage', async () => {
    const file = path.join(dir, 'b.md');
    fs.writeFileSync(file, 'x');
    const taken = await roles('add', 'Reviewer', '--file', file, '--json');
    expect(taken.code).toBe(31);
    expect(taken.json()).toMatchObject({ success: false, error: 'name_conflict' });
    expect((await roles('add', 'n')).code).toBe(2);
    expect((await roles('add', 'n', '--file', file, '--stdin')).code).toBe(2);
    expect((await roles('add', 'n', '--file', path.join(dir, 'missing'))).code).toBe(2);
    fs.writeFileSync(file, Buffer.from([0xff, 0xfe]));
    expect((await roles('add', 'n', '--file', file)).stderr).toContain('UTF-8');
    expect(listAgentRoles(db)).toHaveLength(2);
  });
});

describe('roles edit', () => {
  it('answers before and after, the version and what it reaches', async () => {
    setSystemRoleDefault(db, 'codex', reviewer);
    const file = path.join(dir, 'new.md');
    fs.writeFileSync(file, BODY);
    const result = await roles('edit', 'reviewer', '--file', file, '--if-version', '1', '--json');
    expect(result.code).toBe(0);
    expect(result.json()).toMatchObject({
      before: { body: 'REVIEW', bodyVersion: 1 },
      after: { body: BODY, bodyVersion: 2 },
      bodyVersion: 2,
      affected: { system: [{ cliToolId: 'codex' }] },
      impact: { schedules: true, runningSessions: false },
    });
  });

  it('--stdin and --name', async () => {
    const result = await runCli(createRolesCommand, ['edit', reviewer, '--name', 'critic', '--stdin', '--json'], [Buffer.from(BODY)]);
    expect(result.json().after).toMatchObject({ name: 'critic', body: BODY });
  });

  it('a stale version and a taken name are conflicts, and change nothing', async () => {
    const stale = await roles('edit', 'reviewer', '--name', 'x', '--if-version', '7', '--json');
    expect(stale.code).toBe(31);
    expect(stale.json()).toMatchObject({ error: 'version_conflict', currentBodyVersion: 1 });
    const taken = await roles('edit', 'reviewer', '--name', 'writer', '--json');
    expect(taken.code).toBe(31);
    expect(taken.json().error).toBe('name_conflict');
    expect(getAgentRole(db, reviewer)?.name).toBe('reviewer');
  });

  it('unknown, ambiguous, nothing to change and a bad version', async () => {
    expect((await roles('edit', 'nobody', '--name', 'x', '--json')).json().error).toBe('unknown_role');
    expect((await roles('edit', 'reviewer')).code).toBe(2);
    expect((await roles('edit', 'reviewer', '--name', 'x', '--if-version', 'two')).code).toBe(2);
    const { selector } = makeAmbiguous();
    expectAmbiguous(await roles('edit', selector, '--name', 'x', '--json'));
  });
});

describe('roles rm', () => {
  it('in use: a conflict naming what points at it, and --force removes both', async () => {
    setSystemRoleDefault(db, 'codex', reviewer);
    const refused = await roles('rm', 'reviewer', '--json');
    expect(refused.code).toBe(31);
    expect(refused.json()).toMatchObject({ error: 'role_in_use', references: { system: [{ cliToolId: 'codex' }] } });
    expect((await roles('rm', 'reviewer')).stderr).toContain('--force');
    const forced = await roles('rm', 'reviewer', '--force', '--json');
    expect(forced.code).toBe(0);
    expect(forced.json()).toMatchObject({ deleted: { id: reviewer }, affected: { system: [{ cliToolId: 'codex' }] } });
    expect(getAgentRole(db, reviewer)).toBeNull();
  });

  it('unknown and ambiguous', async () => {
    expect((await roles('rm', 'nobody', '--json')).json().error).toBe('unknown_role');
    const { selector } = makeAmbiguous();
    expectAmbiguous(await roles('rm', selector, '--json'));
    expect(listAgentRoles(db)).toHaveLength(3);
  });
});

describe('roles default', () => {
  it('system: before, after and that it reaches the repositories inheriting and Schedules', async () => {
    const set = await roles('default', 'codex', '--role', 'reviewer', '--json');
    expect(set.code).toBe(0);
    expect(set.json()).toMatchObject({
      level: 'system',
      cliToolId: 'codex',
      before: { stored: { state: 'unset' }, effective: { kind: 'none', source: 'fallback' } },
      after: { stored: { state: 'role', roleId: reviewer }, effective: { kind: 'role', source: 'system' } },
      impact: { schedules: true, runningSessions: false, repositories: [{ name: 'repo' }] },
    });
    const none = await roles('default', 'codex', '--none', '--json');
    expect(none.json().after.stored).toEqual({ state: 'unset' });
  });

  it('a repository with a setting of its own is not among those a system default reaches', async () => {
    await roles('default', 'codex', '--repo', 'repo', '--none');
    const set = await roles('default', 'codex', '--role', 'reviewer', '--json');
    expect(set.json().impact.repositories).toEqual([]);
  });

  it('--repo: by ID, path, a worktree of it and name, and each state', async () => {
    const id = (await roles('defaults', '--repo', 'repo', '--json')).json().repository.id;
    const byName = await roles('default', 'codex', '--repo', 'repo', '--role', 'writer', '--json');
    expect(byName.json()).toMatchObject({
      level: 'repository',
      repository: { id },
      before: { stored: { state: 'inherit' } },
      after: { stored: { state: 'role', roleId: writer }, effective: { source: 'repository' } },
      impact: { schedules: true, repositories: [{ id }] },
    });
    const byPath = await roles('default', 'codex', '--repo', root, '--none', '--json');
    expect(byPath.json().after.stored).toEqual({ state: 'none' });
    const byId = await roles('default', 'codex', '--repo', id, '--inherit', '--json');
    expect(byId.json().after.stored).toEqual({ state: 'inherit' });
    const byWorktree = await roles('default', 'codex', '--repo', worktreePath, '--role', 'reviewer', '--json');
    expect(byWorktree.json().repository.id).toBe(id);
  });

  it('--repo .: from inside a worktree, this repository', async () => {
    const spy = vi.spyOn(process, 'cwd').mockReturnValue(worktreePath);
    try {
      const result = await roles('default', 'codex', '--repo', './', '--role', 'reviewer', '--json');
      expect(result.code).toBe(0);
      expect(result.json().repository.path).toBe(root);
    } finally {
      spy.mockRestore();
    }
  });

  it('a bare word is never read as a path', async () => {
    const spy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    try {
      // `root` is a directory here and a registered root's basename, but no repository is named it.
      const result = await roles('default', 'codex', '--repo', 'root', '--none', '--json');
      expect(result.json().error).toBe('unknown_repository');
    } finally {
      spy.mockRestore();
    }
  });

  it('--repo: unknown, a directory with no row, and ambiguous each say so', async () => {
    const elsewhere = path.join(dir, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.mkdirSync(path.join(dir, 'root2'));
    createRepository(db, { name: 'repo', path: path.join(dir, 'root2'), cloneSource: 'local' });

    const ambiguous = await roles('default', 'codex', '--repo', 'repo', '--none', '--json');
    expect(ambiguous.code).toBe(2);
    expect(ambiguous.json().error).toBe('ambiguous_repository');
    expect(ambiguous.json().candidates).toHaveLength(2);

    const unregistered = await roles('default', 'codex', '--repo', elsewhere, '--none', '--json');
    expect(unregistered.code).toBe(2);
    expect(unregistered.json().error).toBe('repository_not_registered');
    expect(unregistered.stderr).toContain('commandmate roles defaults');

    const unknown = await roles('default', 'codex', '--repo', path.join(dir, 'missing'), '--none', '--json');
    expect(unknown.json().error).toBe('unknown_repository');
    expect((await roles('default', 'codex', '--repo', 'nothing', '--none', '--json')).json().error).toBe('unknown_repository');
  });

  it('a tool outside the feature, an unknown role and an ambiguous one change nothing', async () => {
    for (const tool of ['gemini', 'vibe-local', 'nope']) {
      const refused = await roles('default', tool, '--role', 'reviewer', '--json');
      expect(refused.code).toBe(2);
      expect(refused.json().error).toBe('tool_not_supported');
    }
    expect((await roles('default', 'codex', '--role', 'nobody', '--json')).json().error).toBe('unknown_role');
    const { selector } = makeAmbiguous();
    expectAmbiguous(await roles('default', 'codex', '--role', selector, '--json'));
    expectAmbiguous(await roles('default', 'codex', '--repo', 'repo', '--role', selector, '--json'));
    expect((await roles('defaults', '--tool', 'codex', '--json')).json().system[0].stored).toEqual({ state: 'unset' });
  });

  it('flags: exactly one, and --inherit only with --repo', async () => {
    expect((await roles('default', 'codex')).code).toBe(2);
    expect((await roles('default', 'codex', '--none', '--role', 'reviewer')).code).toBe(2);
    const inherit = await roles('default', 'codex', '--inherit');
    expect(inherit.code).toBe(2);
    expect(inherit.stderr).toContain('--repo');
  });

  it('warns when the tool is not enabled yet', async () => {
    const result = await roles('default', 'antigravity', '--role', 'reviewer');
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('not enabled');
  });
});

describe('roles defaults', () => {
  it('changes nothing, and shows stored, effective and source, with no row as inherit', async () => {
    setSystemRoleDefault(db, 'codex', reviewer);
    const before = db.prepare('SELECT count(*) AS n FROM agent_role_repository_defaults').get();
    const result = await roles('defaults', '--repo', 'repo', '--tool', 'codex', '--json');
    expect(result.code).toBe(0);
    expect(result.json().defaults).toHaveLength(1);
    expect(result.json().defaults[0]).toMatchObject({
      cliToolId: 'codex',
      stored: { state: 'inherit' },
      effective: { kind: 'role', source: 'system', role: { id: reviewer } },
    });
    expect(db.prepare('SELECT count(*) AS n FROM agent_role_repository_defaults').get()).toEqual(before);
  });

  it('without --repo: the system level and how to find a repository', async () => {
    setSystemRoleDefault(db, 'codex', reviewer);
    const result = await roles('defaults', '--json');
    const codex = result.json().system.find((entry: { cliToolId: string }) => entry.cliToolId === 'codex');
    expect(codex).toMatchObject({ stored: { state: 'role' }, effective: { kind: 'role', source: 'system' } });
    expect(result.json().repositories).toEqual([expect.objectContaining({ name: 'repo', path: root })]);
    expect((await roles('defaults')).stdout).toContain(root);
  });

  it('unknown and ambiguous repository, and a tool outside the feature', async () => {
    expect((await roles('defaults', '--repo', 'nothing', '--json')).json().error).toBe('unknown_repository');
    fs.mkdirSync(path.join(dir, 'root2'));
    createRepository(db, { name: 'repo', path: path.join(dir, 'root2'), cloneSource: 'local' });
    expect((await roles('defaults', '--repo', 'repo', '--json')).json().error).toBe('ambiguous_repository');
    expect((await roles('defaults', '--tool', 'gemini', '--json')).json().error).toBe('tool_not_supported');
  });
});

describe('instances set-role', () => {
  it('saved while running, with a pending restart only when the two differ', async () => {
    await launch();
    confirmLaunched();
    fakeTool.running = true;

    const differs = await instances('set-role', 'codex', '--role', 'reviewer', '--json');
    expect(differs.code).toBe(0);
    expect(differs.json()).toMatchObject({
      instanceId: 'codex',
      stored: { state: 'role', roleId: reviewer },
      effectiveNext: { kind: 'role', source: 'instance', role: { id: reviewer } },
      applyPending: true,
      restartPending: 'yes',
    });
    expect((await instances('set-role', 'codex', '--role', 'reviewer')).stderr).toContain('Pending:');

    const same = await instances('set-role', 'codex', '--none', '--json');
    expect(same.json()).toMatchObject({ stored: { state: 'none' }, applyPending: false, restartPending: 'no' });
    expect((await instances('set-role', 'codex', '--none')).stderr).not.toContain('Pending:');
    expect((await instances('set-role', 'codex', '--inherit', '--json')).json().stored).toEqual({ state: 'inherit' });
  });

  it('nothing known about a process: not pending, and it says it does not know', async () => {
    const result = await instances('set-role', 'codex', '--role', 'reviewer', '--json');
    expect(result.json()).toMatchObject({ applyPending: false, restartPending: 'unknown', launched: null });
    expect((await instances('set-role', 'codex', '--role', 'reviewer')).stderr).toContain('not known');
  });

  it('unknown role, ambiguous role, not on the roster, a tool outside the feature', async () => {
    expect((await instances('set-role', 'codex', '--role', 'nobody', '--json')).json().error).toBe('unknown_role');
    const notListed = await instances('set-role', 'codex-9', '--role', 'reviewer', '--json');
    expect(notListed.code).toBe(2);
    expect(notListed.json().error).toBe('not_found');
    db.prepare('UPDATE worktrees SET selected_agents = ? WHERE id = ?').run(JSON.stringify(['codex', 'gemini']), WT);
    const outside = await instances('set-role', 'gemini', '--role', 'reviewer', '--json');
    expect(outside.code).toBe(2);
    expect(outside.json().error).toBe('tool_not_supported');
    const { selector } = makeAmbiguous();
    expectAmbiguous(await instances('set-role', 'codex', '--role', selector, '--json'));
  });

  it('flags: exactly one; --no-role is add\'s and --none is set-role\'s', async () => {
    expect((await instances('set-role', 'codex')).code).toBe(2);
    expect((await instances('set-role', 'codex', '--none', '--inherit')).code).toBe(2);
    expect((await instances('set-role', 'codex', '--no-role')).code).toBe(2);
    expect((await instances('set-role')).code).toBe(2);
    expect((await instances('kill', 'codex', '--role', 'reviewer')).code).toBe(2);
    expect((await instances('add', '--agent', 'codex', '--none')).code).toBe(2);
  });
});

describe('instances add', () => {
  it('--role: the instance and its role together', async () => {
    const result = await instances('add', '--agent', 'codex', '--role', 'reviewer', '--json');
    expect(result.code).toBe(0);
    expect(result.json()).toMatchObject({
      created: { instanceId: 'codex-2' },
      stored: { state: 'role', roleId: reviewer },
      effectiveNext: { source: 'instance' },
    });
    expect(getInstanceRoleState(db, WT, 'codex-2')).toMatchObject({ state: 'role', roleId: reviewer });
    expect(getAgentInstances(db, WT).map(({ id }) => id)).toContain('codex-2');
  });

  it('--no-role: explicitly none', async () => {
    await instances('add', '--agent', 'codex', '--no-role', '--id', 'codex-3');
    expect(getInstanceRoleState(db, WT, 'codex-3')).toEqual({ state: 'none' });
  });

  it('neither: as before, following the defaults', async () => {
    const result = await instances('add', '--agent', 'codex', '--id', 'codex-4');
    expect(result.code).toBe(0);
    expect(getInstanceRoleState(db, WT, 'codex-4')).toEqual({ state: 'inherit' });
  });

  it('unknown, ambiguous and a tool outside the feature leave no instance', async () => {
    expect((await instances('add', '--agent', 'codex', '--role', 'nobody', '--json')).json().error).toBe('unknown_role');
    expect((await instances('add', '--agent', 'gemini', '--role', 'reviewer', '--json')).json().error).toBe('tool_not_supported');
    expect((await instances('add', '--agent', 'gemini', '--no-role', '--json')).json().error).toBe('tool_not_supported');
    expect((await instances('add', '--agent', 'codex', '--role', 'reviewer', '--no-role')).code).toBe(2);
    const { selector } = makeAmbiguous();
    expectAmbiguous(await instances('add', '--agent', 'codex', '--role', selector, '--json'));
    expect(getAgentInstances(db, WT)).toEqual([]);
  });

  it('conflicts: an id already there, and a roster changed after it was read', async () => {
    const exists = await instances('add', '--agent', 'codex', '--id', 'codex', '--role', 'reviewer', '--json');
    expect(exists.code).toBe(31);
    expect(exists.json().error).toBe('instance_exists');

    // Between the read of the revision and the create.
    const realFetch = dispatch;
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST' && String(input).endsWith('/instances/roles')) {
        setAgentInstances(db, WT, [{ id: 'codex', cliTool: 'codex', alias: 'Renamed', order: 0 }]);
      }
      return realFetch(input, init);
    });
    const changed = await instances('add', '--agent', 'codex', '--id', 'codex-5', '--role', 'reviewer', '--json');
    expect(changed.code).toBe(31);
    expect(changed.json().error).toBe('roster_changed');
    expect(getInstanceRoleState(db, WT, 'codex-5')).toEqual({ state: 'inherit' });
  });
});

describe('instances --json', () => {
  it('each row: what it holds, what it was started with and what comes next, with sources', async () => {
    setSystemRoleDefault(db, 'codex', writer);
    await launch();
    confirmLaunched();
    fakeTool.running = true;
    setInstanceRoleState(db, WT, 'codex', { state: 'role', roleId: reviewer });

    const rows = (await instances('--json')).json();
    const codex = rows.find((row: { instanceId: string }) => row.instanceId === 'codex');
    expect(codex.role).toMatchObject({
      stored: { state: 'role', roleId: reviewer },
      effectiveNext: { kind: 'role', source: 'instance', role: { id: reviewer } },
      launched: { source: 'system', roleId: writer, roleName: 'writer' },
      restartPending: 'yes',
    });
    const table = (await instances()).stdout;
    expect(table).toContain('ROLE_AT_START');
    expect(table).toContain('reviewer(instance)');
    expect(table).toContain('writer');
  });
});

describe('send --role', () => {
  const typed = () => fakeTool.typed;

  it('not running: saved, started with it, and sent', async () => {
    const result = await send('hello', '--instance', 'codex', '--role', 'reviewer');
    expect(result.code).toBe(0);
    expect(typed()).toEqual(['hello']);
    expect(getInstanceRoleState(db, WT, 'codex')).toMatchObject({ state: 'role', roleId: reviewer });
    expect(getLaunchRoleEvidence(target)?.injectionFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('running with the same role: sent', async () => {
    setInstanceRoleState(db, WT, 'codex', { state: 'role', roleId: reviewer });
    await launch();
    fakeTool.running = true;
    const result = await send('hello', '--instance', 'codex', '--role', 'reviewer');
    expect(result.code).toBe(0);
    expect(typed()).toEqual(['hello']);
  });

  it('running with another role: exit 32, nothing typed, the setting saved and says so', async () => {
    setInstanceRoleState(db, WT, 'codex', { state: 'role', roleId: writer });
    await launch();
    fakeTool.running = true;
    const result = await send('hello', '--instance', 'codex', '--role', 'reviewer');
    expect(result.code).toBe(32);
    expect(typed()).toEqual([]);
    expect(result.stderr).toContain('different role');
    expect(result.stderr).toContain('stayed saved');
    expect(result.stderr).toContain('sendOutcome=not_sent');
    expect(getInstanceRoleState(db, WT, 'codex')).toMatchObject({ state: 'role', roleId: reviewer });
  });

  it('--no-role against a process with a role: refused the same way', async () => {
    setInstanceRoleState(db, WT, 'codex', { state: 'role', roleId: writer });
    await launch();
    fakeTool.running = true;
    expect((await send('hello', '--instance', 'codex', '--no-role')).code).toBe(32);
    expect(typed()).toEqual([]);
  });

  it('running with nothing known about its start: exit 32, nothing typed', async () => {
    fakeTool.running = true;
    const result = await send('hello', '--instance', 'codex', '--role', 'reviewer');
    expect(result.code).toBe(32);
    expect(result.stderr).toContain('no record');
    expect(typed()).toEqual([]);
  });

  it('unknown, ambiguous, both flags and a tool outside the feature: nothing happens', async () => {
    const unknown = await send('hello', '--instance', 'codex', '--role', 'nobody');
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("No role is called 'nobody'");
    expect((await send('hello', '--instance', 'codex', '--role', 'reviewer', '--no-role')).code).toBe(2);
    expect((await send('hello', '--instance', 'gemini', '--role', 'reviewer')).code).toBe(2);
    const { selector } = makeAmbiguous();
    const ambiguous = await send('hello', '--instance', 'codex', '--role', selector);
    expect(ambiguous.code).toBe(2);
    expect(ambiguous.stderr).toContain('could mean');
    expect(typed()).toEqual([]);
    expect(getInstanceRoleState(db, WT, 'codex')).toEqual({ state: 'inherit' });
  });

  it('an ad-hoc id with no --register: refused, and it says so', async () => {
    const result = await send('hello', '--instance', 'codex-7', '--agent', 'codex', '--role', 'reviewer');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('not in the roster');
    expect(typed()).toEqual([]);
  });

  it('a plain send to a process with another role is not conditional', async () => {
    setInstanceRoleState(db, WT, 'codex', { state: 'role', roleId: writer });
    await launch();
    fakeTool.running = true;
    setInstanceRoleState(db, WT, 'codex', { state: 'role', roleId: reviewer });
    expect((await send('hello', '--instance', 'codex')).code).toBe(0);
    expect(typed()).toEqual(['hello']);
  });
});

describe('send --register --role', () => {
  it('the first start already has the role, and the instance exists before it', async () => {
    let rosterAtStart: string[] = [];
    fakeTool.onStart = async (instanceId) => {
      rosterAtStart = getAgentInstances(db, WT).map(({ id }) => id);
      await launch(instanceId);
    };
    const result = await send('hello', '--instance', 'codex-2', '--agent', 'codex', '--register', '--role', 'reviewer');
    expect(result.code).toBe(0);
    expect(rosterAtStart).toContain('codex-2');
    expect(fakeTool.typed).toEqual(['hello']);
    const launched = await instances('--json');
    const row = launched.json().find((entry: { instanceId: string }) => entry.instanceId === 'codex-2');
    expect(row.role).toMatchObject({
      stored: { state: 'role', roleId: reviewer },
      requested: { roleId: reviewer, source: 'instance' },
    });
    expect(getLaunchRoleEvidence({ ...target, instanceId: 'codex-2' })?.injectionFingerprint).toBe(
      row.role.requested.injectionFingerprint
    );
  });

  it('repeating replaces the setting, and is a condition: the same role goes, another does not', async () => {
    const args = ['--instance', 'codex-2', '--agent', 'codex', '--register'];
    await send('one', ...args, '--role', 'reviewer');
    const again = await send('two', ...args, '--role', 'reviewer');
    expect(again.code).toBe(0);
    expect(again.stderr).not.toContain('registered in roster');
    expect(fakeTool.typed).toEqual(['one', 'two']);

    const other = await send('three', ...args, '--role', 'writer');
    expect(other.code).toBe(32);
    expect(fakeTool.typed).toEqual(['one', 'two']);
    expect(getInstanceRoleState(db, WT, 'codex-2')).toMatchObject({ state: 'role', roleId: writer });
  });

  it('--register alone leaves a role already there alone', async () => {
    const args = ['--instance', 'codex-2', '--agent', 'codex', '--register'];
    await send('one', ...args, '--role', 'reviewer');
    expect((await send('two', ...args)).code).toBe(0);
    expect(getInstanceRoleState(db, WT, 'codex-2')).toMatchObject({ state: 'role', roleId: reviewer });
  });

  it('a roster changed after it was read: exit 31, nothing sent', async () => {
    const realFetch = dispatch;
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST' && String(input).endsWith('/instances/roles')) {
        setAgentInstances(db, WT, [{ id: 'codex', cliTool: 'codex', alias: 'Renamed', order: 0 }]);
      }
      return realFetch(input, init);
    });
    const result = await send('hello', '--instance', 'codex-2', '--agent', 'codex', '--register', '--role', 'reviewer');
    expect(result.code).toBe(31);
    expect(fakeTool.typed).toEqual([]);
  });
});

describe('the pin reaches the first key (--expect-*)', () => {
  /** The process running now, and what to pin it by. */
  async function pinned(): Promise<string[]> {
    await launch();
    fakeTool.running = true;
    const evidence = getLaunchRoleEvidence(target);
    return ['--expect-role-generation', evidence?.sessionGeneration as string, '--expect-no-role'];
  }

  it('the same process: it goes (negative control)', async () => {
    const pin = await pinned();
    const result = await send('hello', '--instance', 'codex', ...pin);
    expect(result.code).toBe(0);
    expect(fakeTool.typed).toEqual(['hello']);
  });

  it('replaced with the same role right before the first key: not typed, exit 32', async () => {
    const pin = await pinned();
    fakeTool.beforeFirstKey = () => launch();
    const result = await send('hello', '--instance', 'codex', ...pin);
    expect(result.code).toBe(32);
    expect(fakeTool.typed).toEqual([]);
    expect(result.stderr).toContain('replaced');
    expect(result.stderr).toContain('sendOutcome=not_sent');
  });

  it('without the pin, that same replacement would have got the message (positive control)', async () => {
    await pinned();
    fakeTool.beforeFirstKey = () => launch();
    expect((await send('hello', '--instance', 'codex')).code).toBe(0);
    expect(fakeTool.typed).toEqual(['hello']);
  });

  it('with --contract: the same, and the task is recorded as failed', async () => {
    const pin = await pinned();
    fakeTool.beforeFirstKey = () => launch();
    const result = await send('--contract', '.commandmate/tasks/x.yaml', '--instance', 'codex', ...pin);
    expect(result.code).toBe(32);
    expect(fakeTool.typed).toEqual([]);
    expect(taskStatuses).toEqual(['failed']);
  });

  it('with --contract, the same process: it goes and the task runs', async () => {
    const pin = await pinned();
    const result = await send('--contract', '.commandmate/tasks/x.yaml', '--instance', 'codex', ...pin);
    expect(result.code).toBe(0);
    expect(fakeTool.typed).toHaveLength(1);
    expect(taskStatuses).toEqual(['running']);
  });

  it('with --role: the pin holds as well', async () => {
    const pin = await pinned();
    fakeTool.beforeFirstKey = () => launch();
    const result = await send('hello', '--instance', 'codex', '--no-role', ...pin);
    expect(result.code).toBe(32);
    expect(fakeTool.typed).toEqual([]);
  });

  it('a process gone before the send: refused without starting another', async () => {
    const pin = await pinned();
    fakeTool.running = false;
    const started = vi.fn();
    fakeTool.onStart = async () => started();
    const result = await send('hello', '--instance', 'codex', ...pin);
    expect(result.code).toBe(32);
    expect(started).not.toHaveBeenCalled();
    expect(fakeTool.typed).toEqual([]);
  });

  it('another generation already: refused', async () => {
    const pin = await pinned();
    await launch();
    expect((await send('hello', '--instance', 'codex', ...pin)).code).toBe(32);
    expect(fakeTool.typed).toEqual([]);
  });

  it('usage: a generation needs what it pins', async () => {
    expect((await send('hello', '--instance', 'codex', '--expect-role-generation', 'g')).code).toBe(2);
    expect((await send('hello', '--instance', 'codex', '--expect-no-role', '--expect-role-fingerprint', 'f')).code).toBe(2);
    expect(fakeTool.typed).toEqual([]);
  });
});

describe('POST /send: the roster moves while it waits', () => {
  const post = (body: Record<string, unknown>) =>
    dispatch(`http://localhost:4116/api/worktrees/${WT}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello', ...body }),
    });

  it('a new row meanwhile: 409 roster_changed, nothing saved, nothing typed', async () => {
    setAgentInstances(db, WT, [
      { id: 'codex', cliTool: 'codex', alias: 'A', order: 0 },
      { id: 'codex-2', cliTool: 'codex', alias: 'B', order: 1 },
    ]);
    ownership.hook = () => {
      ownership.hook = null;
      setAgentInstances(db, WT, [
        { id: 'codex', cliTool: 'codex', alias: 'A', order: 0 },
        { id: 'codex-2', cliTool: 'codex', alias: 'B', order: 1 },
        { id: 'codex-3', cliTool: 'codex', alias: 'C', order: 2 },
      ]);
    };
    const response = await post({ instanceId: 'codex-2', cliToolId: 'codex', role: { state: 'role', roleId: reviewer } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'roster_changed',
      sendOutcome: 'not_sent',
      roleSettings: { saved: false },
    });
    expect(getInstanceRoleState(db, WT, 'codex-2')).toEqual({ state: 'inherit' });
    expect(fakeTool.typed).toEqual([]);
  });

  it('the id now names another tool: 409 roster_changed', async () => {
    setAgentInstances(db, WT, [
      { id: 'codex', cliTool: 'codex', alias: 'A', order: 0 },
      { id: 'helper', cliTool: 'codex', alias: 'B', order: 1 },
    ]);
    ownership.hook = () => {
      ownership.hook = null;
      setAgentInstances(db, WT, [
        { id: 'codex', cliTool: 'codex', alias: 'A', order: 0 },
        { id: 'helper', cliTool: 'claude', alias: 'B', order: 1 },
      ]);
    };
    const response = await post({ instanceId: 'helper', role: { state: 'role', roleId: reviewer } });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('roster_changed');
    expect(getInstanceRoleState(db, WT, 'helper')).toEqual({ state: 'inherit' });
    expect(fakeTool.typed).toEqual([]);
  });

  it('the row is gone: 409 roster_changed, rather than not_found', async () => {
    setAgentInstances(db, WT, [
      { id: 'codex', cliTool: 'codex', alias: 'A', order: 0 },
      { id: 'codex-2', cliTool: 'codex', alias: 'B', order: 1 },
    ]);
    ownership.hook = () => {
      ownership.hook = null;
      setAgentInstances(db, WT, [{ id: 'codex', cliTool: 'codex', alias: 'A', order: 0 }]);
    };
    const response = await post({ instanceId: 'codex-2', cliToolId: 'codex', role: { state: 'role', roleId: reviewer } });
    expect((await response.json()).code).toBe('roster_changed');
  });

  it('nothing moved: it goes (negative control)', async () => {
    setAgentInstances(db, WT, [{ id: 'codex-2', cliTool: 'codex', alias: 'B', order: 0 }]);
    const response = await post({ instanceId: 'codex-2', cliToolId: 'codex', role: { state: 'role', roleId: reviewer } });
    expect(response.status).toBe(201);
    expect(fakeTool.typed).toEqual(['hello']);
  });

  it('a send saying nothing about a role is not affected by a moving roster (negative control)', async () => {
    setAgentInstances(db, WT, [{ id: 'codex-2', cliTool: 'codex', alias: 'B', order: 0 }]);
    ownership.hook = () => {
      ownership.hook = null;
      setAgentInstances(db, WT, [{ id: 'codex-2', cliTool: 'codex', alias: 'Renamed', order: 0 }]);
    };
    const response = await post({ instanceId: 'codex-2', cliToolId: 'codex' });
    expect(response.status).toBe(201);
  });

  it('through the CLI: exit 31', async () => {
    setAgentInstances(db, WT, [{ id: 'codex-2', cliTool: 'codex', alias: 'B', order: 0 }]);
    ownership.hook = () => {
      ownership.hook = null;
      setAgentInstances(db, WT, [{ id: 'codex-2', cliTool: 'codex', alias: 'Renamed', order: 0 }]);
    };
    const result = await send('hello', '--instance', 'codex-2', '--role', 'reviewer');
    expect(result.code).toBe(31);
    expect(result.stderr).toContain('roster changed');
    expect(fakeTool.typed).toEqual([]);
  });
});

describe('a send with a role that types nothing leaves Auto-Yes as it found it', () => {
  async function runningWith(role: string): Promise<void> {
    setInstanceRoleState(db, WT, 'codex', { state: 'role', roleId: role });
    await launch();
    fakeTool.running = true;
  }
  const armAndSend = (...args: string[]) => send('hello', '--instance', 'codex', '--auto-yes', ...args);

  it('it was off: armed, refused, withdrawn', async () => {
    await runningWith(writer);
    const result = await armAndSend('--role', 'reviewer');
    expect(result.code).toBe(32);
    expect(autoYes.posts.map(({ enabled }) => enabled)).toEqual([true, false]);
    expect(autoYes.posts[1]).toMatchObject({ cliToolId: 'codex', instanceId: 'codex' });
    expect(autoYes.on).toBe(false);
    expect(result.stderr).toContain('withdrawn');
  });

  it('it was on: never turned off, and its terms untouched by a refusal', async () => {
    await runningWith(writer);
    autoYes.on = true;
    expect((await armAndSend('--role', 'reviewer')).code).toBe(32);
    expect(autoYes.posts).toEqual([]);
    expect(autoYes.on).toBe(true);
  });

  it('it was on, and the message goes in: this send\'s terms apply then', async () => {
    await runningWith(reviewer);
    autoYes.on = true;
    expect((await armAndSend('--role', 'reviewer', '--duration', '3h')).code).toBe(0);
    expect(fakeTool.typed).toEqual(['hello']);
    expect(autoYes.posts).toEqual([expect.objectContaining({ enabled: true, duration: 3 * 3600 * 1000 })]);
  });

  it('a pin replaced at the first key: withdrawn too', async () => {
    await launch();
    fakeTool.running = true;
    const evidence = getLaunchRoleEvidence(target);
    fakeTool.beforeFirstKey = () => launch();
    const result = await armAndSend('--expect-role-generation', evidence?.sessionGeneration as string, '--expect-no-role');
    expect(result.code).toBe(32);
    expect(autoYes.on).toBe(false);
  });

  it('a roster moved under it: exit 31, withdrawn', async () => {
    setAgentInstances(db, WT, [{ id: 'codex', cliTool: 'codex', alias: 'A', order: 0 }]);
    ownership.hook = () => {
      ownership.hook = null;
      setAgentInstances(db, WT, [{ id: 'codex', cliTool: 'codex', alias: 'Renamed', order: 0 }]);
    };
    expect((await armAndSend('--role', 'reviewer')).code).toBe(31);
    expect(autoYes.on).toBe(false);
  });

  it('the state could not be read: left on, with how to stop it, not guessed off', async () => {
    await runningWith(writer);
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'GET' && url.includes('/auto-yes')) return Response.json({ error: 'x' }, { status: 500 });
      return dispatch(input, init);
    });
    const result = await armAndSend('--role', 'reviewer');
    expect(result.code).toBe(32);
    expect(autoYes.on).toBe(true);
    expect(result.stderr).toContain(`auto-yes ${WT} --disable --instance codex`);
  });

  it('no word on whether it was sent: left on, with how to stop it', async () => {
    await runningWith(reviewer);
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith('/send')) throw new TypeError('fetch failed');
      return dispatch(input, init);
    });
    const result = await armAndSend('--role', 'reviewer');
    expect(result.code).toBe(1);
    expect(autoYes.on).toBe(true);
    expect(result.stderr).toContain('--disable');
  });

  it('a refused relay ends the command before anything is armed', async () => {
    await runningWith(writer);
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith('/api/relays')) {
        return Response.json({ error: 'chain too long', code: 'RELAY_CHAIN_LIMIT' }, { status: 409 });
      }
      if (String(input).includes('/resolve-target')) return dispatch(input, init);
      return dispatch(input, init);
    });
    const result = await armAndSend('--role', 'reviewer', '--reply-to', `${WT}/codex`);
    expect(result.code).not.toBe(0);
    expect(autoYes.posts).toEqual([]);
    expect(fakeTool.typed).toEqual([]);
  });

  it('a send saying nothing about a role reads nothing, and is as it was (negative control)', async () => {
    fakeTool.running = true;
    const reads: string[] = [];
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET' && String(input).includes('/auto-yes')) reads.push(String(input));
      if (String(input).endsWith('/send')) return Response.json({ error: 'x', code: 'SOMETHING', sendOutcome: 'not_sent' }, { status: 409 });
      return dispatch(input, init);
    });
    expect((await armAndSend()).code).not.toBe(0);
    expect(reads).toEqual([]);
    expect(autoYes.posts.map(({ enabled }) => enabled)).toEqual([true]);
    expect(autoYes.on).toBe(true);
  });
});

describe('--contract --role: the setting first, as send --role has it', () => {
  const contract = (...args: string[]) => send('--contract', '.commandmate/tasks/x.yaml', '--instance', 'codex', ...args);

  /** The process runs `running`, and the setting says `next`. */
  async function processAndSetting(running: string, next: string): Promise<void> {
    setInstanceRoleState(db, WT, 'codex', { state: 'role', roleId: running });
    await launch();
    fakeTool.running = true;
    setInstanceRoleState(db, WT, 'codex', { state: 'role', roleId: next });
  }

  it('process A, setting B, --role A: goes, as send --role A does', async () => {
    await processAndSetting(reviewer, writer);
    const result = await contract('--role', 'reviewer');
    expect(result.code).toBe(0);
    expect(fakeTool.typed).toHaveLength(1);
    expect(taskStatuses).toEqual(['running']);
    expect(getInstanceRoleState(db, WT, 'codex')).toMatchObject({ roleId: reviewer });
  });

  it('send --role A in the same state ends the same way (control)', async () => {
    await processAndSetting(reviewer, writer);
    expect((await send('hello', '--instance', 'codex', '--role', 'reviewer')).code).toBe(0);
  });

  it('process A, --role B: 32, nothing typed, no task, and the setting saved and said so', async () => {
    await processAndSetting(reviewer, reviewer);
    const result = await contract('--role', 'writer');
    expect(result.code).toBe(32);
    expect(fakeTool.typed).toEqual([]);
    expect(getInstanceRoleState(db, WT, 'codex')).toMatchObject({ roleId: writer });
    expect(result.stderr).toContain('stayed saved');
  });

  it('process A, setting B, --role C: 32 after saving C, saying so', async () => {
    const third = createAgentRole(db, { name: 'third', body: 'THIRD' }).id;
    await processAndSetting(reviewer, writer);
    const result = await contract('--role', 'third');
    expect(result.code).toBe(32);
    expect(result.stderr).toContain('stayed saved');
    expect(getInstanceRoleState(db, WT, 'codex')).toMatchObject({ roleId: third });
    expect(fakeTool.typed).toEqual([]);
  });

  it('a broken contract saves nothing', async () => {
    await processAndSetting(reviewer, writer);
    fs.writeFileSync(path.join(worktreePath, '.commandmate', 'tasks', 'bad.yaml'), 'version: 1\n');
    const result = await send('--contract', '.commandmate/tasks/bad.yaml', '--instance', 'codex', '--role', 'reviewer');
    expect(result.code).toBe(2);
    expect(getInstanceRoleState(db, WT, 'codex')).toMatchObject({ roleId: writer });
  });

  it('no --role: refused on the settings, and nothing saved (negative control)', async () => {
    await processAndSetting(reviewer, writer);
    expect((await contract()).code).toBe(32);
    expect(getInstanceRoleState(db, WT, 'codex')).toMatchObject({ roleId: writer });
    expect(fakeTool.typed).toEqual([]);
  });

  it('naming neither instance nor tool: the default instance is the one saved', async () => {
    await processAndSetting(reviewer, writer);
    const result = await send('--contract', '.commandmate/tasks/x.yaml', '--role', 'reviewer');
    expect(result.code).toBe(0);
    expect(getInstanceRoleState(db, WT, 'codex')).toMatchObject({ roleId: reviewer });
  });
});

describe('--json answers every failure of a role command', () => {
  const unreachable = async () => {
    throw new TypeError('fetch failed');
  };
  const internal = async (input: unknown, init?: RequestInit) => {
    if (String(input).includes('/api/capabilities')) return dispatch(input, init);
    return Response.json({ success: false, error: 'internal_error', message: 'Internal error' }, { status: 500 });
  };
  const noRoute = async (input: unknown, init?: RequestInit) => {
    if (String(input).includes('/api/capabilities')) return dispatch(input, init);
    return new Response('<html>not here</html>', { status: 404 });
  };
  const COMMANDS: Array<[string, () => Promise<CliResult>]> = [
    ['roles list', () => roles('list', '--json')],
    ['roles show', () => roles('show', 'reviewer', '--json')],
    ['roles rm', () => roles('rm', 'reviewer', '--json')],
    ['roles default', () => roles('default', 'codex', '--none', '--json')],
    ['roles defaults', () => roles('defaults', '--json')],
    ['set-role', () => instances('set-role', 'codex', '--none', '--json')],
    ['add --no-role', () => instances('add', '--agent', 'codex', '--no-role', '--json')],
  ];

  it.each(COMMANDS)('%s: no server is exit 1 with JSON on stdout', async (_name, run) => {
    vi.stubGlobal('fetch', unreachable);
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.json()).toMatchObject({ success: false, error: 'no_response' });
    expect(result.stderr).toContain('Server is not running');
  });

  it.each(COMMANDS)('%s: internal_error is exit 99 with JSON on stdout', async (_name, run) => {
    vi.stubGlobal('fetch', internal);
    const result = await run();
    expect(result.code).toBe(99);
    expect(result.json()).toMatchObject({ success: false, error: 'internal_error' });
  });

  it.each(COMMANDS)('%s: an older server is exit 99 with JSON on stdout', async (_name, run) => {
    vi.stubGlobal('fetch', noRoute);
    const result = await run();
    expect(result.code).toBe(99);
    expect(result.json()).toMatchObject({ success: false, error: 'role_api_unavailable' });
  });

  it('without --json: stderr only, the same exit code (negative control)', async () => {
    vi.stubGlobal('fetch', unreachable);
    const result = await roles('list');
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Server is not running');
  });

  it('add --role: its own usage failures are JSON too', async () => {
    for (const args of [
      ['add', '--no-role', '--json'],
      ['add', '--agent', 'nope', '--no-role', '--json'],
      ['add', '--agent', 'codex', '--id', 'bad id', '--no-role', '--json'],
      ['add', '--agent', 'claude', '--id', 'copilot', '--no-role', '--json'],
    ]) {
      const result = await instances(...args);
      expect(result.code, args.join(' ')).toBe(2);
      expect(result.json().success, args.join(' ')).toBe(false);
    }
  });

  it('an invalid worktree id: JSON on the role forms, as before on the others', async () => {
    const roleForm = await runCli(createInstancesCommand, ['bad id!', 'set-role', 'codex', '--none', '--json']);
    expect(roleForm.code).toBe(2);
    expect(roleForm.json().success).toBe(false);
    const plain = await runCli(createInstancesCommand, ['bad id!', '--json']);
    expect(plain.code).toBe(2);
    expect(plain.stdout).toBe('');
  });

  it('a plain add --json keeps stderr only (negative control)', async () => {
    const result = await instances('add', '--agent', 'nope', '--json');
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
  });

  it('send has no --json to keep a promise about', () => {
    expect(createSendCommand().options.map((option) => option.long)).not.toContain('--json');
  });
});

describe('an OpenCode V1 conversation continuing', () => {
  it('names no flag the CLI lacks, and says what it cannot do; the API\'s sentence is unchanged', async () => {
    const realFetch = dispatch;
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      const response = await realFetch(input, init);
      if (!String(input).endsWith('/send')) return response;
      return Response.json(
        { ...(await response.json()), roleResume: { continued: true, message: 'send with newConversation', newConversationField: 'newConversation' } },
        { status: response.status }
      );
    });
    const result = await send('hello', '--instance', 'codex');
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('continues under a different role');
    expect(result.stderr).toContain('The CLI cannot start a new conversation');
    expect(result.stderr).not.toContain('newConversation');
  });
});
