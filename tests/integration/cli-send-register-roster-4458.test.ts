/**
 * Issue #4458 (item 1): `send --agent <tool> --instance <id> --register` after the roster
 * reached its limit (10) and rows were removed to make room. Driven as the CLI runs,
 * against the real routes (`GET/PATCH /api/worktrees/:id`, `resolve-target`, `send`) and
 * an in-memory database (the `cli-tool-policy-write-apis-4449` harness). No tmux, no
 * server, no real agent (the tool is a fake), no file under $HOME (everything is under
 * os.tmpdir(), removed after each test).
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { getAgentInstances, setAgentInstances } from '@/lib/db/agent-instances-db';
import { upsertWorktree } from '@/lib/db';
import { createRepository } from '@/lib/db/db-repository';
import { resetSessionLaunchFlightsForTest } from '@/lib/session/session-launch-flight';
import { resetLaunchRoleStateForTest, setLaunchRoleDatabaseForTest } from '@/lib/session/role-launch';
import { noteInputStart, resetInstanceInputLocks } from '@/lib/session/instance-input-lock';
import { MAX_AGENT_INSTANCES, type AgentInstance } from '@/lib/cli-tools/types';
import { validateAgentInstancesInput } from '@/lib/agent-instances-validator';
import { defaultAlias } from '@/cli/utils/agent-instances';
import type { Worktree } from '@/types/models';

const fakeTool = vi.hoisted(() => ({ running: false, typed: [] as string[] }));

vi.mock('@/lib/cli-tools/codex', () => ({
  CodexTool: class {
    id = 'codex';
    name = 'Codex CLI';
    command = 'codex';
    async isInstalled() { return true; }
    async isRunning() { return fakeTool.running; }
    async startSession() { fakeTool.running = true; }
    async sendMessage(_id: string, message: string) {
      noteInputStart();
      fakeTool.typed.push(message);
    }
    async killSession() { fakeTool.running = false; }
    getSessionName(id: string, instanceId?: string) { return `mcbd-codex-${id}-${instanceId ?? 'codex'}`; }
  },
}));
vi.mock('@/lib/cli-tools/claude', () => ({
  ClaudeTool: class {
    id = 'claude';
    name = 'Claude Code';
    command = 'claude';
    async isInstalled() { return true; }
    async isRunning() { return fakeTool.running; }
    async startSession() { fakeTool.running = true; }
    async sendMessage(_id: string, message: string) {
      noteInputStart();
      fakeTool.typed.push(message);
    }
    async killSession() { fakeTool.running = false; }
    getSessionName(id: string, instanceId?: string) { return `mcbd-claude-${id}-${instanceId ?? 'claude'}`; }
  },
}));
vi.mock('@/lib/cli-tools/session-ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/session-ownership')>()),
  checkSessionOwnership: vi.fn(async () => ({ verdict: 'absent' })),
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
vi.mock('@/lib/polling/auto-yes-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/polling/auto-yes-manager')>()),
  startAutoYesPolling: vi.fn(() => ({ started: true })),
  stopAutoYesPolling: vi.fn(),
  stopAutoYesPollingByWorktree: vi.fn(),
}));
vi.mock('@/lib/hooks/pending-decision-recheck', () => ({
  recheckPendingDecisions: vi.fn(async () => ({ reason: 'test', examined: 0, delivered: 0, skipped: 0 })),
}));

import * as sendRoute from '@/app/api/worktrees/[id]/send/route';
import * as resolveTargetRoute from '@/app/api/worktrees/[id]/resolve-target/route';
import * as worktreeRoute from '@/app/api/worktrees/[id]/route';
import { createSendCommand } from '@/cli/commands/send';
import { createInstancesCommand } from '@/cli/commands/instances';
import * as instanceRolesRoute from '@/app/api/worktrees/[id]/instances/roles/route';
import * as rolesRoute from '@/app/api/roles/route';
import { createAgentRole } from '@/lib/db/agent-roles-db';

const WT = 'wt-4458';

let dir: string;
let db: Database.Database;
/** Bodies of every PATCH /api/worktrees/:id, as sent. */
let patches: Array<Record<string, unknown>>;
/** POSTs to instances/roles (`--register --role`) and to /send. */
let rolePosts: number;
let sendPosts: number;
/** Every answer of a PATCH /api/worktrees/:id (status and body). */
let patchAnswers: Array<{ status: number; body: Record<string, unknown> }>;

type RouteHandler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

function routed(pathname: string): { handlers: Record<string, unknown>; params: Record<string, string> } | null {
  if (pathname === '/api/roles') return { handlers: rolesRoute, params: {} };
  const routes: Array<[RegExp, Record<string, unknown>]> = [
    [/^\/api\/worktrees\/([^/]+)\/instances\/roles$/, instanceRolesRoute],
    [/^\/api\/worktrees\/([^/]+)\/send$/, sendRoute],
    [/^\/api\/worktrees\/([^/]+)\/resolve-target$/, resolveTargetRoute],
    [/^\/api\/worktrees\/([^/]+)$/, worktreeRoute],
  ];
  for (const [pattern, handlers] of routes) {
    const match = pathname.match(pattern);
    if (match) return { handlers, params: { id: match[1] } };
  }
  return null;
}

async function dispatch(input: unknown, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  if (url.pathname.startsWith('/api/tasks/')) return Response.json({ ok: true });
  if (url.pathname === '/api/capabilities') return Response.json({ serverVersion: 'test', capabilities: ['resolve-session-target'] });
  if (url.pathname === `/api/worktrees/${WT}/current-output`) return Response.json({ isRunning: fakeTool.running });
  if (url.pathname === `/api/worktrees/${WT}/opencode/session`) return Response.json({ instances: [] });
  const route = routed(url.pathname);
  if (!route) throw new Error(`Not stubbed: ${method} ${url.pathname}`);
  const handler = route.handlers[method] as RouteHandler | undefined;
  if (!handler) return Response.json({ error: `no ${method}` }, { status: 405 });
  const isPatch = method === 'PATCH' && url.pathname === `/api/worktrees/${WT}`;
  if (isPatch && init?.body) patches.push(JSON.parse(String(init.body)));
  if (method === 'POST' && url.pathname === `/api/worktrees/${WT}/instances/roles`) rolePosts += 1;
  if (method === 'POST' && url.pathname === `/api/worktrees/${WT}/send`) sendPosts += 1;
  const response = await handler(new NextRequest(url, init as ConstructorParameters<typeof NextRequest>[1]), {
    params: Promise.resolve(route.params),
  });
  if (isPatch) patchAnswers.push({ status: response.status, body: await response.clone().json() });
  return response;
}

class ExitSignal extends Error {}

async function run(
  command: { parseAsync: (argv: string[]) => Promise<unknown> },
  args: string[]
): Promise<{ code: number; stderr: string[] }> {
  const err: string[] = [];
  const exits: number[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation((line: unknown) => void err.push(String(line)));
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code ?? 0);
    throw new ExitSignal(String(code));
  }) as never);
  try {
    await command.parseAsync(['node', 'cli', ...args]);
  } catch (signal) {
    if (!(signal instanceof ExitSignal)) throw signal;
  } finally {
    log.mockRestore();
    error.mockRestore();
    exit.mockRestore();
  }
  return { code: exits[0] ?? 0, stderr: err };
}

const send = (...args: string[]) => run(createSendCommand(), [WT, ...args]);
const instances = (...args: string[]) => run(createInstancesCommand(), [WT, ...args]);

const roster = (): AgentInstance[] => getAgentInstances(db, WT);
const rosterIds = (): string[] => roster().map(({ id }) => id);

/** claude, claude-2 … claude-N: a roster filled the way `instances add --agent claude` fills it. */
function claudeRoster(n: number): AgentInstance[] {
  return Array.from({ length: n }, (_, i) => {
    const id = i === 0 ? 'claude' : `claude-${i + 1}`;
    return { id, cliTool: 'claude', alias: i === 0 ? 'Claude' : `Claude ${i + 1}`, order: i };
  });
}

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cli-send-register-4458-')));
  const worktreePath = path.join(dir, 'wt');
  const root = path.join(dir, 'root');
  fs.mkdirSync(worktreePath, { recursive: true });
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
    cliToolId: 'claude',
  } as Worktree);
  createRepository(db, { name: 'repo', path: root, cloneSource: 'local' });
  createAgentRole(db, { name: 'reviewer', body: 'REVIEW' });
  setLaunchRoleDatabaseForTest(db);
  rolePosts = 0;
  sendPosts = 0;
  resetSessionLaunchFlightsForTest();
  resetInstanceInputLocks();
  fakeTool.running = false;
  fakeTool.typed = [];
  patches = [];
  patchAnswers = [];
  vi.stubEnv('CM_AGENT_HOOKS_INJECT', '0');
  vi.stubEnv('CM_AGENT_ROLE_ARTIFACTS_DIR', path.join(dir, 'data'));
  vi.stubEnv('CODEX_HOME', path.join(dir, 'codex'));
  vi.stubEnv('CM_PORT', '4458');
  for (const name of ['TMUX', 'CLAUDECODE', 'CM_RUN_ORIGIN', 'CM_WORKTREE_ID', 'CM_AGENT_WORKTREE_ID', 'CM_INSTANCE_ID', 'CM_AGENT_INSTANCE_ID', 'CM_CLI_TOOL', 'CM_AGENT_TOOL']) {
    vi.stubEnv(name, '');
  }
  vi.stubEnv('HOME', dir);
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

/** The rows other than `id`, as they stood: an add keeps every one of them (I4). */
const othersOf = (rows: AgentInstance[], id: string): Array<Omit<AgentInstance, 'order'>> =>
  rows.filter((row) => row.id !== id).map(({ id: rowId, cliTool, alias }) => ({ id: rowId, cliTool, alias }));

describe('Issue #4458 (1): send --register into the room left after the limit', () => {
  it.each([
    ['two rows removed (8 left)', ['claude-6', 'claude-7']],
    ['one row removed (9 left)', ['claude-6']],
  ])('%s: send --agent claude --instance claude-6 --register registers it, exit 0, the other rows untouched', async (_label, removed) => {
    setAgentInstances(db, WT, claudeRoster(MAX_AGENT_INSTANCES));
    for (const id of removed) expect(await instances('remove', id)).toMatchObject({ code: 0 });
    const before = roster();
    patches = [];
    patchAnswers = [];

    const result = await send('hello', '--agent', 'claude', '--instance', 'claude-6', '--register');

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('Instance registered in roster: claude-6');
    expect(result.stderr.filter((line) => line.startsWith('Warning'))).toEqual([]);
    expect(fakeTool.typed).toEqual(['hello']);
    expect(rosterIds()).toEqual([...before.map(({ id }) => id), 'claude-6']);
    expect(roster().find(({ id }) => id === 'claude-6')).toMatchObject({ cliTool: 'claude', order: before.length });
    expect(othersOf(roster(), 'claude-6')).toEqual(othersOf(before, 'claude-6'));
    expect(patchAnswers.map(({ status }) => status)).toEqual([200]);
  });

  it('control: instances add --agent claude takes the same room', async () => {
    setAgentInstances(db, WT, claudeRoster(MAX_AGENT_INSTANCES));
    expect(await instances('remove', 'claude-6')).toMatchObject({ code: 0 });
    expect(await instances('add', '--agent', 'claude')).toMatchObject({ code: 0 });
    expect(rosterIds()).toContain('claude-6');
  });
});

describe('Issue #4458 (2): at the limit', () => {
  it('send --register: sent once, a warning, exit 0, no row added and nothing saved', async () => {
    setAgentInstances(db, WT, claudeRoster(MAX_AGENT_INSTANCES));
    const before = roster();

    const result = await send('hello', '--agent', 'claude', '--instance', 'claude-11', '--register');

    expect(result.code).toBe(0);
    expect(fakeTool.typed).toEqual(['hello']);
    const text = result.stderr.join('\n');
    expect(text).toMatch(/^Warning: the message was sent, but could not register 'claude-11' in the roster \(already at the 10-instance limit\)/m);
    expect(text).toMatch(/Do not send it again/);
    expect(roster()).toEqual(before);
    expect(patches).toEqual([]);
  });
});

describe('Issue #4458 (3): what the roster write would refuse is not sent to it', () => {
  it('an id that is not one (an alias-shaped --instance): exit 2 before anything is sent, with the reason', async () => {
    setAgentInstances(db, WT, claudeRoster(8));

    const result = await send('hello', '--agent', 'claude', '--instance', 'Worker 6', '--register');

    expect(result.code).toBe(2);
    expect(result.stderr[0]).toMatch(/^Error: --register needs an instance id the roster accepts, and 'Worker 6' is not one/);
    expect(result.stderr[0]).toContain('Nothing was sent.');
    expect(fakeTool.typed).toEqual([]);
    expect(patches).toEqual([]);
    expect(rosterIds()).toHaveLength(8);
  });

  it('a default alias over 50 characters (a 64-character id): exit 2 before anything is sent, with the reason and a command that registers it', async () => {
    setAgentInstances(db, WT, claudeRoster(8));
    const longId = 'w'.repeat(64);

    const result = await send('hello', '--agent', 'claude', '--instance', longId, '--register');

    expect(result.code).toBe(2);
    expect(fakeTool.typed).toEqual([]);
    expect(sendPosts).toBe(0);
    expect(patches).toEqual([]);
    expect(rosterIds()).toHaveLength(8);
    const text = result.stderr.join('\n');
    expect(text).toMatch(/^Error: --register would name '.+', longer than the 50 characters an alias may have/m);
    expect(text).toContain('Nothing was sent.');
    // The command it gives does what it says.
    const command = text.match(/commandmate instances (\S+) add --agent (\S+) --id (\S+) --alias "([^"]+)"/);
    expect(command).not.toBeNull();
    const [, wt, agent, id, alias] = command as RegExpMatchArray;
    expect(wt).toBe(WT);
    expect(alias.length).toBeLessThanOrEqual(50);
    expect(await instances('add', '--agent', agent, '--id', id, '--alias', alias)).toMatchObject({ code: 0 });
    expect(roster().find((row) => row.id === longId)).toMatchObject({ cliTool: 'claude', alias });
  });

  it('the same id already on the roster: nothing to register, so it is sent as before', async () => {
    const longId = 'w'.repeat(64);
    setAgentInstances(db, WT, [...claudeRoster(8), { id: longId, cliTool: 'claude', alias: 'Long', order: 8 }]);

    const result = await send('hello', '--agent', 'claude', '--instance', longId, '--register');

    expect(result.code).toBe(0);
    expect(fakeTool.typed).toEqual(['hello']);
    expect(patches).toEqual([]);
  });
});

describe('Issue #4458: --register --role asks the same judgment before it creates anything', () => {
  it('at the limit: exit 2, no POST, nothing sent, no row and no role written', async () => {
    setAgentInstances(db, WT, claudeRoster(MAX_AGENT_INSTANCES));
    const before = roster();

    const result = await send('hello', '--agent', 'claude', '--instance', 'claude-11', '--register', '--role', 'reviewer');

    expect(result.code).toBe(2);
    expect(result.stderr.join('\n')).toMatch(/^Error: could not register 'claude-11' in the roster \(already at the 10-instance limit\)\. Nothing was written or sent\./m);
    expect(rolePosts).toBe(0);
    expect(sendPosts).toBe(0);
    expect(fakeTool.typed).toEqual([]);
    expect(roster()).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_instance_roles').get()).toEqual({ n: 0 });
  });

  it('a 64-character id: exit 2, no POST, nothing sent, no row', async () => {
    setAgentInstances(db, WT, claudeRoster(8));

    const result = await send('hello', '--agent', 'claude', '--instance', 'w'.repeat(64), '--register', '--role', 'reviewer');

    expect(result.code).toBe(2);
    expect(rolePosts).toBe(0);
    expect(sendPosts).toBe(0);
    expect(fakeTool.typed).toEqual([]);
    expect(rosterIds()).toHaveLength(8);
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_instance_roles').get()).toEqual({ n: 0 });
  });

  it('control: room left after the limit: created with its role (one POST)', async () => {
    setAgentInstances(db, WT, claudeRoster(MAX_AGENT_INSTANCES));
    expect(await instances('remove', 'claude-6')).toMatchObject({ code: 0 });

    await send('hello', '--agent', 'claude', '--instance', 'claude-6', '--register', '--role', 'reviewer');

    expect(rolePosts).toBe(1);
    expect(rosterIds()).toContain('claude-6');
  });
});

/**
 * I2 of #4458 as one table: for the same roster and row, the CLI saves exactly what the
 * server's validator accepts. `accepted` is written out, not computed, so a change to either
 * side (the limit compared with >= instead of >, a copy of the rules in the CLI) turns a row red.
 */
describe('Issue #4458 (4): send --register and the server judge the same rows', () => {
  const LONG_ID = 'w'.repeat(64);
  const rows: Array<{ size: number; id: string; accepted: boolean }> = [
    { size: 1, id: 'claude-x', accepted: true },
    { size: 8, id: 'claude-x', accepted: true },
    { size: 9, id: 'claude-x', accepted: true },
    { size: 10, id: 'claude-x', accepted: false },
    { size: 8, id: LONG_ID, accepted: false },
    { size: 9, id: LONG_ID, accepted: false },
    { size: 8, id: `x${'w'.repeat(64)}`, accepted: false },
    { size: 8, id: 'claude_x-1', accepted: true },
  ];

  it.each(rows.map((row) => [`${row.size} rows + ${row.id.length > 20 ? `${row.id.length}-char id` : row.id}`, row] as const))(
    '%s',
    async (_name, row) => {
      setAgentInstances(db, WT, claudeRoster(row.size));
      const added = { id: row.id, cliTool: 'claude', alias: defaultAlias('claude', row.id), order: row.size };
      // The server's verdict on the list the save would carry.
      expect(validateAgentInstancesInput([...roster(), added]).valid).toBe(row.accepted);

      const result = await send('hello', '--agent', 'claude', '--instance', row.id, '--register');

      expect(rosterIds().includes(row.id)).toBe(row.accepted);
      // A row the server refuses is never sent to it: no 400 to explain afterwards.
      expect(patchAnswers.filter(({ status }) => status !== 200)).toEqual([]);
      expect(patches).toHaveLength(row.accepted ? 1 : 0);
      if (!row.accepted) expect(result.stderr.join('\n')).toMatch(/^(Warning|Error): /m);
    },
  );
});
