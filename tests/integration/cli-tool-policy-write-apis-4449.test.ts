/**
 * Issue #4449: the tool policy is judged AT the writes a send makes before its message —
 * `POST/PUT instances/roles` and `POST tasks` (and the Auto-Yes grant's relay) — in the
 * same request, and the CLI asks nothing first (`GET …/tool-policy` is never called).
 * Driven as the CLI runs, against the real routes and an in-memory database (the
 * `cli-tool-policy-4437` harness). The two paths #4437 PR2 left open are pinned here as
 * "no row in instances / roles / tasks, exit 33, the reason on stderr's first line":
 *   1. the ask failing (500, or 404 from a server before #4437) let the task be written;
 *   2. a default that turned antigravity after the ask was written under codex's verdict.
 * And I2 across the task and the message: a default that turns antigravity AFTER the task
 * was written does not move the message (`/send` takes `taskId` and goes to the task's
 * recorded target), with --reply-to, --auto-yes and --note too. No tmux, no server, no agy (the tool is a fake), no file
 * under $HOME (everything is under os.tmpdir(), removed after each test).
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
import { createAgentRole, getInstanceRoleState } from '@/lib/db/agent-roles-db';
import { listTasks } from '@/lib/db/tasks-db';
import { resetSessionLaunchFlightsForTest } from '@/lib/session/session-launch-flight';
import {
  resetLaunchRoleStateForTest,
  resolveLaunchRole,
  runWithLaunchRole,
  setLaunchRoleDatabaseForTest,
} from '@/lib/session/role-launch';
import { beginAgentSession, buildAgentLaunchCommandLine } from '@/lib/session/agent-session-lifecycle';
import { fixedEnvReader } from '@/lib/agent-roles/composition';
import { noteInputStart, resetInstanceInputLocks } from '@/lib/session/instance-input-lock';
import type { Worktree } from '@/types/models';

const fakeTool = vi.hoisted(() => ({
  running: false,
  typed: [] as string[],
  /** Runs inside the send, right before the sender notes its first key. */
  beforeFirstKey: null as null | (() => Promise<void>),
  onStart: null as null | ((instanceId: string | undefined) => Promise<void>),
  claudeRunning: (() => false) as () => boolean,
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
vi.mock('@/lib/cli-tools/antigravity', () => ({
  AntigravityTool: class {
    id = 'antigravity';
    name = 'Antigravity';
    command = 'agy';
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
    getSessionName(id: string, instanceId?: string) { return `mcbd-antigravity-${id}-${instanceId ?? 'antigravity'}`; }
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

vi.mock('@/lib/polling/auto-yes-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/polling/auto-yes-manager')>()),
  startAutoYesPolling: vi.fn(() => ({ started: true })),
  stopAutoYesPolling: vi.fn(),
  stopAutoYesPollingByWorktree: vi.fn(),
}));
/**
 * The mutation seams of the I1' table (Issue #4449, re-instruction 2b): one judgment taken
 * out, everything else as it is. `write` = the write APIs' own judgment
 * (`findWriteToolPolicyRefusal`); `send` / `auto-yes` = every judgment of that operation.
 * Null (the default) changes nothing.
 */
const seam = vi.hoisted(() => ({ off: null as null | 'write' | 'send' | 'auto-yes' }));
vi.mock('@/lib/tool-policy/policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tool-policy/policy')>();
  return {
    ...actual,
    decideToolPolicy: (input: Parameters<typeof actual.decideToolPolicy>[0]) =>
      seam.off === input.operation ? { allowed: true } : actual.decideToolPolicy(input),
  };
});
vi.mock('@/app/api/worktrees/[id]/send/write-tool-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/api/worktrees/[id]/send/write-tool-policy')>();
  return {
    ...actual,
    findWriteToolPolicyRefusal: (...args: Parameters<typeof actual.findWriteToolPolicyRefusal>) =>
      seam.off === 'write' ? null : actual.findWriteToolPolicyRefusal(...args),
  };
});
vi.mock('@/lib/hooks/pending-decision-recheck', () => ({
  recheckPendingDecisions: vi.fn(async () => ({ reason: 'test', examined: 0, delivered: 0, skipped: 0 })),
}));
vi.mock('@/lib/cli-tools/claude', () => ({
  ClaudeTool: class {
    id = 'claude';
    name = 'Claude Code';
    command = 'claude';
    async isInstalled() { return true; }
    async isRunning() { return fakeTool.claudeRunning(); }
    async startSession() {}
    async sendMessage() {}
    async killSession() {}
    getSessionName(id: string, instanceId?: string) { return `mcbd-claude-${id}-${instanceId ?? 'claude'}`; }
  },
}));

import * as instanceRolesRoute from '@/app/api/worktrees/[id]/instances/roles/route';
import * as sendRoute from '@/app/api/worktrees/[id]/send/route';
import * as tasksRoute from '@/app/api/worktrees/[id]/tasks/route';
import * as resolveTargetRoute from '@/app/api/worktrees/[id]/resolve-target/route';
import * as autoYesRoute from '@/app/api/worktrees/[id]/auto-yes/route';
import * as toolPolicyRoute from '@/app/api/worktrees/[id]/tool-policy/route';
import * as rolesRoute from '@/app/api/roles/route';
import * as worktreeRoute from '@/app/api/worktrees/[id]/route';
import * as relaysRoute from '@/app/api/relays/route';
import * as roleRoute from '@/app/api/roles/[id]/route';
import { clearAllAutoYesStates, getAutoYesState } from '@/lib/auto-yes-state';
import { createSendCommand } from '@/cli/commands/send';
import { ANTIGRAVITY_FAQ_URL, ANTIGRAVITY_TERMS_URL } from '@/lib/tool-policy/policy';

const WT = 'wt-4449';
const CONTRACT = 'version: 1\ntitle: t\ngoal: |\n  Do the work.\nscope:\n  allow: ["src/**"]\n';

let dir: string;
let worktreePath: string;
let db: Database.Database;
/** Every request the CLI made, method and path. */
let requests: string[];
/**
 * I7e: what the check before the writes (`GET …/tool-policy`) does instead of the route
 * (a 500, a server before PR1), or what happens right after it answers.
 */
let checkOverride: (() => Response) | null;
let afterCheck: (() => void) | null;
/** Runs right before a request reaches its route (`METHOD /path`). */
let beforeRoute: ((request: string) => void) | null;
/** Runs right after a route answered (`METHOD /path`). */
let afterRoute: ((request: string) => void) | null;


type RouteHandler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

function routed(pathname: string): { handlers: Record<string, unknown>; params: Record<string, string> } | null {
  if (pathname === '/api/roles') return { handlers: rolesRoute, params: {} };
  if (pathname === '/api/relays') return { handlers: relaysRoute, params: {} };
  const role = pathname.match(/^\/api\/roles\/([^/]+)$/);
  if (role) return { handlers: roleRoute, params: { id: role[1] } };
  const routes: Array<[RegExp, Record<string, unknown>]> = [
    [/^\/api\/worktrees\/([^/]+)\/instances\/roles$/, instanceRolesRoute],
    [/^\/api\/worktrees\/([^/]+)\/send$/, sendRoute],
    [/^\/api\/worktrees\/([^/]+)\/tasks$/, tasksRoute],
    [/^\/api\/worktrees\/([^/]+)\/resolve-target$/, resolveTargetRoute],
    [/^\/api\/worktrees\/([^/]+)\/auto-yes$/, autoYesRoute],
    [/^\/api\/worktrees\/([^/]+)\/tool-policy$/, toolPolicyRoute],
    // The roster save of a plain --register, after its message (`registerInstance`).
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
  requests.push(`${method} ${url.pathname}`);
  if (url.pathname.startsWith('/api/tasks/')) return Response.json({ ok: true });
  if (url.pathname === '/api/capabilities') return Response.json({ serverVersion: 'test', capabilities: ['resolve-session-target'] });
  if (url.pathname === `/api/worktrees/${WT}/current-output`) return Response.json({ isRunning: fakeTool.running });
  if (url.pathname === `/api/worktrees/${WT}/opencode/session`) return Response.json({ instances: [] });
  // `send --note`'s mem item (Issue #4226), kept out of this suite's subject.
  if (url.pathname === `/api/worktrees/${WT}/mem/items`) return Response.json({ item: { id: 'note-1' } }, { status: 201 });
  const isCheck = url.pathname === `/api/worktrees/${WT}/tool-policy`;
  if (isCheck && checkOverride) return checkOverride();
  const route = routed(url.pathname);
  if (!route) throw new Error(`Not stubbed: ${method} ${url.pathname}`);
  const handler = route.handlers[method] as RouteHandler | undefined;
  if (!handler) return Response.json({ error: `no ${method}` }, { status: 405 });
  beforeRoute?.(`${method} ${url.pathname}`);
  const response = await handler(new NextRequest(url, init as ConstructorParameters<typeof NextRequest>[1]), {
    params: Promise.resolve(route.params),
  });
  if (isCheck) afterCheck?.();
  afterRoute?.(`${method} ${url.pathname}`);
  return response;
}

class ExitSignal extends Error {}

async function send(...args: string[]): Promise<{ code: number; stderr: string[] }> {
  const err: string[] = [];
  const exits: number[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation((line: unknown) => void err.push(String(line)));
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code ?? 0);
    throw new ExitSignal(String(code));
  }) as never);
  try {
    await createSendCommand().parseAsync(['node', 'cli', WT, ...args]);
  } catch (signal) {
    if (!(signal instanceof ExitSignal)) throw signal;
  } finally {
    log.mockRestore();
    error.mockRestore();
    exit.mockRestore();
  }
  return { code: exits[0] ?? 0, stderr: err };
}

/** A real codex launch's effect on what is known, without tmux (the cli-roles-4116 way). */
async function launchCodex(instanceId?: string, cliToolId: 'codex' | 'antigravity' = 'codex'): Promise<void> {
  const launchTarget = { worktreeId: WT, cliToolId, instanceId };
  const snapshot = await resolveLaunchRole(db, { ...launchTarget, worktreePath, readEnv: fixedEnvReader({}) });
  await runWithLaunchRole(snapshot, async () => {
    beginAgentSession(launchTarget);
    buildAgentLaunchCommandLine({ target: launchTarget, executablePath: cliToolId === 'codex' ? 'codex' : 'agy', worktreePath });
  });
}

const rosterIds = (): string[] => getAgentInstances(db, WT).map(({ id }) => id);

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cli-tool-policy-4449-')));
  worktreePath = path.join(dir, 'wt');
  const root = path.join(dir, 'root');
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
  db.prepare('UPDATE worktrees SET selected_agents = ? WHERE id = ?').run(JSON.stringify(['codex', 'antigravity']), WT);
  createRepository(db, { name: 'repo', path: root, cloneSource: 'local' });
  createAgentRole(db, { name: 'reviewer', body: 'REVIEW' });
  setLaunchRoleDatabaseForTest(db);
  resetSessionLaunchFlightsForTest();
  resetInstanceInputLocks();
  clearAllAutoYesStates();
  fakeTool.running = false;
  fakeTool.typed = [];
  fakeTool.beforeFirstKey = null;
  fakeTool.onStart = null;
  ownership.hook = null;
  seam.off = null;
  requests = [];
  checkOverride = null;
  afterCheck = null;
  beforeRoute = null;
  afterRoute = null;
  vi.stubEnv('CM_AGENT_HOOKS_INJECT', '0');
  vi.stubEnv('CM_AGENT_ROLE_ARTIFACTS_DIR', path.join(dir, 'data'));
  vi.stubEnv('CM_AGENT_ROLE_ANTIGRAVITY_AGENTS_DIR', path.join(dir, 'agy-agents'));
  vi.stubEnv('CODEX_HOME', path.join(dir, 'codex'));
  vi.stubEnv('CM_PORT', '4449');
  // The caller is an agent session (I5): the server's table refuses antigravity from it.
  for (const name of ['TMUX', 'CLAUDECODE', 'CM_RUN_ORIGIN', 'CM_WORKTREE_ID', 'CM_AGENT_WORKTREE_ID', 'CM_INSTANCE_ID', 'CM_AGENT_INSTANCE_ID', 'CM_CLI_TOOL']) {
    vi.stubEnv(name, '');
  }
  vi.stubEnv('CM_AGENT_TOOL', 'codex');
  vi.stubEnv('CM_ANTIGRAVITY_USAGE', '');
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

const count = (table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
/** I1: the rows a refused send must not leave (all three tables start empty here). */
const writtenRows = (): Record<string, number> => ({
  agent_instances: count('agent_instances'),
  agent_instance_roles: count('agent_instance_roles'),
  tasks: count('tasks'),
});
const NO_ROWS = { agent_instances: 0, agent_instance_roles: 0, tasks: 0 };
const CHECK = `GET /api/worktrees/${WT}/tool-policy`;

/** Refused: exit 33, the reason first on stderr, nothing typed, nothing written, nothing asked first. */
function expectRefusedWithNoRows(result: { code: number; stderr: string[] }, code = 'TOOL_POLICY_DENIED'): void {
  expect(result.code).toBe(33);
  expect(result.stderr[0]).toMatch(new RegExp(`^Error \\[${code}\\]: `));
  expect(result.stderr.join('\n')).toContain(ANTIGRAVITY_TERMS_URL);
  expect(result.stderr.join('\n')).toContain(ANTIGRAVITY_FAQ_URL);
  expect(result.stderr.join('\n')).not.toMatch(/Task created|Message sent\.|safe to send it again/);
  expect(writtenRows()).toEqual(NO_ROWS);
  expect(fakeTool.typed).toEqual([]);
  expect(requests).not.toContain(CHECK);
  expect(requests).not.toContain(`POST /api/worktrees/${WT}/send`);
}

describe('path 1 of #4449: an ask that fails can no longer let the write through', () => {
  describe.each([
    ['a 500', () => Response.json({ error: 'boom' }, { status: 500 })],
    ['a server before #4437 (404)', () => Response.json({ error: 'Not Found' }, { status: 404 })],
  ] as const)('GET …/tool-policy would answer %s', (_label, answer) => {
    beforeEach(() => {
      checkOverride = answer;
    });

    it('4449 send --contract: no task row, exit 33, the reason first', async () => {
      expectRefusedWithNoRows(await send('--contract', '.commandmate/tasks/x.yaml', '--instance', 'antigravity'));
      expect(requests).toContain(`POST /api/worktrees/${WT}/tasks`);
    });

    it('4449 send --register --role: no instance and no role row, exit 33, the reason first', async () => {
      expectRefusedWithNoRows(await send('hello', '--agent', 'antigravity', '--instance', 'agy-new', '--register', '--role', 'reviewer'));
      expect(requests).toContain(`POST /api/worktrees/${WT}/instances/roles`);
      expect(rosterIds()).not.toContain('agy-new');
    });

    it('4449 send --contract --role: no task and no role row, exit 33, the reason first', async () => {
      expectRefusedWithNoRows(await send('--contract', '.commandmate/tasks/x.yaml', '--instance', 'antigravity', '--role', 'reviewer'));
      expect(getInstanceRoleState(db, WT, 'antigravity')).toEqual({ state: 'inherit' });
    });

    it('4449 send --contract --reply-to with antigravity at the relay\'s other end: no task row, exit 33', async () => {
      expectRefusedWithNoRows(
        await send('--contract', '.commandmate/tasks/x.yaml', '--instance', 'codex', '--reply-to', `${WT}@antigravity`),
        'RELAY_TOOL_POLICY_DENIED',
      );
    });
  });
});

describe('path 2 of #4449: a default that turns antigravity is judged where the row is written', () => {
  it('4449 send --contract naming no target, the default turned antigravity before the task: no task row, exit 33, the reason first', async () => {
    beforeRoute = (request) => {
      if (request === `POST /api/worktrees/${WT}/tasks`) {
        db.prepare('UPDATE worktrees SET cli_tool_id = ? WHERE id = ?').run('antigravity', WT);
      }
    };
    expectRefusedWithNoRows(await send('--contract', '.commandmate/tasks/x.yaml'));
  });
});

describe('I2 of #4449: the message goes where its task was judged and written', () => {
  const flipAfterTask = (): void => {
    afterRoute = (request) => {
      if (request === `POST /api/worktrees/${WT}/tasks`) {
        db.prepare('UPDATE worktrees SET cli_tool_id = ? WHERE id = ?').run('antigravity', WT);
      }
    };
  };
  /** Bodies of every request to `path`, as sent. */
  let bodies: Record<string, Array<Record<string, unknown>>>;
  beforeEach(() => {
    bodies = {};
    fakeTool.onStart = (instanceId) => launchCodex(instanceId);
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`;
      if (init?.body) (bodies[key] ??= []).push(JSON.parse(String(init.body)));
      return dispatch(input, init);
    });
  });

  it.each([
    ['alone', []],
    ['with --auto-yes', ['--auto-yes']],
    ['with --reply-to', ['--reply-to', `${WT}@claude`]],
    ['with --reply-to --note', ['--reply-to', `${WT}@claude`, '--note', 'the review']],
  ])('4449 send --contract naming no target %s, the default turned antigravity after the task: sent to codex, exit 0, one task row', async (_label, extra) => {
    if (extra.includes('--note')) vi.stubEnv('CM_WORKTREE_ID', WT);
    flipAfterTask();
    const result = await send('--contract', '.commandmate/tasks/x.yaml', ...extra);
    expect(result.stderr.filter((line) => line.startsWith('Error'))).toEqual([]);
    expect(result.code).toBe(0);
    expect(listTasks(db, WT).map((task) => [task.cliToolId, task.instanceId])).toEqual([['codex', null]]);
    expect(fakeTool.typed).toHaveLength(1);
    const [sendBody] = bodies[`POST /api/worktrees/${WT}/send`];
    // #4116: the body still names nobody; the task binds the target.
    expect(sendBody).toMatchObject({ taskId: listTasks(db, WT)[0].id });
    expect(sendBody).not.toHaveProperty('cliToolId');
    expect(sendBody).not.toHaveProperty('instanceId');
    if (extra.includes('--auto-yes')) {
      expect(getAutoYesState(WT, 'codex', 'codex')?.enabled).toBe(true);
      expect(getAutoYesState(WT, 'antigravity', 'antigravity')?.enabled ?? false).toBe(false);
    }
  });
});

describe('the Auto-Yes grant of --auto-yes --reply-to (Issue #4449)', () => {
  it('4449: a relay refused by rule 0 arms nothing: exit 33, the relay\'s reason first', async () => {
    const result = await send('hello', '--instance', 'codex', '--auto-yes', '--reply-to', `${WT}@antigravity`);
    expect(result.code).toBe(33);
    expect(result.stderr[0]).toMatch(/^Error \[RELAY_TOOL_POLICY_DENIED\]: /);
    expect(getAutoYesState(WT, 'codex', 'codex')?.enabled ?? false).toBe(false);
    expect(requests).not.toContain(CHECK);
    expect(fakeTool.typed).toEqual([]);
  });
});

describe('controls (Issue #4449): what is allowed writes as before', () => {
  it('4449 control — codex\'s --contract from the same session creates its task and is typed', async () => {
    fakeTool.onStart = (instanceId) => launchCodex(instanceId);
    const result = await send('--contract', '.commandmate/tasks/x.yaml', '--instance', 'codex');
    expect(result.code).toBe(0);
    expect(listTasks(db, WT)).toHaveLength(1);
    expect(fakeTool.typed).toHaveLength(1);
  });

  it('4449 control — a declared server registers antigravity with its role', async () => {
    vi.stubEnv('CM_ANTIGRAVITY_USAGE', 'api-key');
    const result = await send('hello', '--agent', 'antigravity', '--instance', 'agy-new', '--register', '--role', 'reviewer');
    expect(result.code).not.toBe(33);
    expect(rosterIds()).toContain('agy-new');
    expect(getInstanceRoleState(db, WT, 'agy-new')).toMatchObject({ state: 'role' });
  });

  it('4449 control — a declared server creates antigravity\'s task', async () => {
    vi.stubEnv('CM_ANTIGRAVITY_USAGE', 'api-key');
    await send('--contract', '.commandmate/tasks/x.yaml', '--instance', 'antigravity');
    expect(listTasks(db, WT).map((task) => task.cliToolId)).toEqual(['antigravity']);
  });
});

/**
 * I1' of #4449 as one table (re-instruction 2b): the first request a `send` writes judges
 * every policy target the command goes on to (the send, the Auto-Yes grant), on the real
 * target, and writes nothing when any of them is refused.
 *
 *  - axis 1: every non-empty subset of --contract / --register / --role / --auto-yes
 *    (15); --register comes with --agent antigravity --instance agy-new, the others go to
 *    the roster's antigravity
 *  - axis 2: the origin the CLI reads — terminal / agent / schedule / unknown
 *  - axis 3: the stage that is refused, read off `src/lib/tool-policy/policy.ts`
 *    (antigravity, no declaration): send is a person's only (`terminal`), Auto-Yes nobody's.
 *    The first write is the stage: instances/roles (--register --role), else tasks
 *    (--contract), else the grant (--auto-yes), else /send.
 *
 * Refused rows: no row in tasks / instances / role settings, no grant, nothing typed, exit
 * 33, the reason first. Allowed rows (terminal without --auto-yes): as today. The mutation
 * column takes one judgment out (`seam`) and expects the row to turn red.
 */
describe('I1\' of #4449: every write combination × origin, refused before anything is written', () => {
  type Flag = 'contract' | 'register' | 'role' | 'auto-yes';
  type Origin = 'terminal' | 'agent' | 'schedule' | 'unknown';
  type Stage = 'instances' | 'tasks' | 'auto-yes' | 'send';
  type Seam = 'write' | 'send' | 'auto-yes';
  const FLAGS: Flag[] = ['contract', 'register', 'role', 'auto-yes'];
  const ORIGINS: Origin[] = ['terminal', 'agent', 'schedule', 'unknown'];
  const COMBOS: Flag[][] = Array.from({ length: 15 }, (_, i) => FLAGS.filter((_flag, bit) => ((i + 1) >> bit) & 1));

  /** Per the policy table: send is refused from anyone but a person, Auto-Yes from everyone. */
  const refusedBy = (flags: Flag[], origin: Origin): Seam[] => [
    ...(origin === 'terminal' ? [] : ['send' as const]),
    ...(flags.includes('auto-yes') ? ['auto-yes' as const] : []),
  ];
  const firstWrite = (flags: Flag[]): Stage => {
    if (flags.includes('register') && flags.includes('role')) return 'instances';
    if (flags.includes('contract')) return 'tasks';
    if (flags.includes('auto-yes')) return 'auto-yes';
    return 'send';
  };
  /** The seams that turn a refused row red: its only refusing judgment, or the write's own when it writes first. */
  const redWithout = (flags: Flag[], origin: Origin): Seam[] => {
    const by = refusedBy(flags, origin);
    return [
      ...(by.length === 1 ? by : []),
      ...(['instances', 'tasks'].includes(firstWrite(flags)) ? ['write' as const] : []),
    ];
  };
  const argsOf = (flags: Flag[]): string[] => [
    ...(flags.includes('contract') ? ['--contract', '.commandmate/tasks/x.yaml'] : ['hello']),
    ...(flags.includes('register') ? ['--agent', 'antigravity', '--instance', 'agy-new', '--register'] : ['--instance', 'antigravity']),
    ...(flags.includes('role') ? ['--role', 'reviewer'] : []),
    ...(flags.includes('auto-yes') ? ['--auto-yes'] : []),
  ];

  const ttyBefore = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const asOrigin = (origin: Origin): void => {
    vi.stubEnv('CM_AGENT_TOOL', '');
    Object.defineProperty(process.stdin, 'isTTY', { value: origin !== 'unknown', configurable: true });
    if (origin === 'agent') vi.stubEnv('CLAUDECODE', '1');
    if (origin === 'schedule') vi.stubEnv('CM_RUN_ORIGIN', 'schedule');
  };
  afterEach(() => {
    if (ttyBefore) Object.defineProperty(process.stdin, 'isTTY', ttyBefore);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  });

  const grants = (): string[] => ['antigravity', 'agy-new']
    .filter((instanceId) => getAutoYesState(WT, 'antigravity', instanceId)?.enabled);
  /** What a refused row breaks; empty when the refusal holds. */
  const refusalBroken = (result: { code: number; stderr: string[] }): string[] => [
    ...(result.code === 33 ? [] : [`exit ${result.code}`]),
    ...(/^Error \[TOOL_POLICY_DENIED\]: /.test(result.stderr[0] ?? '') ? [] : [`stderr[0] ${result.stderr[0]}`]),
    ...(JSON.stringify(writtenRows()) === JSON.stringify(NO_ROWS) ? [] : [`rows ${JSON.stringify(writtenRows())}`]),
    ...(grants().length === 0 ? [] : [`grants ${grants().join(',')}`]),
    ...(fakeTool.typed.length === 0 ? [] : [`typed ${fakeTool.typed.length}`]),
  ];

  const rows = COMBOS.flatMap((flags) => ORIGINS.map((origin) => ({
    name: `${flags.join('+')} from ${origin}`,
    flags,
    origin,
    refused: refusedBy(flags, origin).length > 0,
  })));

  it('4449 the table has every combination and origin (15 × 4)', () => {
    expect(rows).toHaveLength(60);
    expect(rows.filter((row) => row.refused)).toHaveLength(53);
  });

  it.each(rows.filter((row) => row.refused).map((row) => [row.name, row] as const))(
    '4449 refused: %s — no row, no grant, nothing typed, exit 33, the reason first',
    async (_name, row) => {
      asOrigin(row.origin);
      const result = await send(...argsOf(row.flags));
      expect(refusalBroken(result)).toEqual([]);
    },
  );

  it.each(rows.filter((row) => !row.refused).map((row) => [row.name, row] as const))(
    '4449 allowed: %s — written and typed as before',
    async (_name, row) => {
      asOrigin(row.origin);
      fakeTool.onStart = (instanceId) => launchCodex(instanceId, 'antigravity');
      const result = await send(...argsOf(row.flags));
      expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
      expect(fakeTool.typed).toHaveLength(1);
      expect(listTasks(db, WT)).toHaveLength(row.flags.includes('contract') ? 1 : 0);
      if (row.flags.includes('register')) expect(rosterIds()).toContain('agy-new');
      if (row.flags.includes('role')) {
        expect(getInstanceRoleState(db, WT, row.flags.includes('register') ? 'agy-new' : 'antigravity')).toMatchObject({ state: 'role' });
      }
    },
  );

  const mutations = rows.filter((row) => row.refused).flatMap((row) =>
    redWithout(row.flags, row.origin).map((off) => [`${row.name}, without the ${off} judgment`, row, off] as const));

  it.each(mutations)('4449 mutation: %s — the refusal no longer holds', async (_name, row, off) => {
    seam.off = off;
    asOrigin(row.origin);
    const result = await send(...argsOf(row.flags));
    expect(refusalBroken(result)).not.toEqual([]);
  });
});

describe('I3\' of #4449: the grant\'s relay is judged again after the last await', () => {
  it('4449 the reply-to session turns antigravity while ownership is checked: 409, no grant, no poller', async () => {
    const { startAutoYesPolling } = await import('@/lib/polling/auto-yes-manager');
    vi.mocked(startAutoYesPolling).mockClear();
    setAgentInstances(db, WT, [
      { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 0 },
      { id: 'review', cliTool: 'claude', alias: 'Review', order: 1 },
    ] as Parameters<typeof setAgentInstances>[2]);
    ownership.hook = () => {
      setAgentInstances(db, WT, [
        { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 0 },
        { id: 'review', cliTool: 'antigravity', alias: 'Review', order: 1 },
      ] as Parameters<typeof setAgentInstances>[2]);
    };
    const response = await dispatch(`http://localhost/api/worktrees/${WT}/auto-yes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, cliToolId: 'codex', instanceId: 'codex', replyTo: { worktreeId: WT, instanceId: 'review' } }),
    });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('RELAY_TOOL_POLICY_DENIED');
    expect(getAutoYesState(WT, 'codex', 'codex')?.enabled ?? false).toBe(false);
    expect(startAutoYesPolling).not.toHaveBeenCalled();
  });

  it('4449 control — the reply-to session stays claude: the grant is armed', async () => {
    setAgentInstances(db, WT, [
      { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 0 },
      { id: 'review', cliTool: 'claude', alias: 'Review', order: 1 },
    ] as Parameters<typeof setAgentInstances>[2]);
    const response = await dispatch(`http://localhost/api/worktrees/${WT}/auto-yes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, cliToolId: 'codex', instanceId: 'codex', replyTo: { worktreeId: WT, instanceId: 'review' } }),
    });
    expect(response.status).toBe(200);
    expect(getAutoYesState(WT, 'codex', 'codex')?.enabled).toBe(true);
  });
});
