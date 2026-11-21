/**
 * Issue #4466 PR0: the table of one send operation — the vessel of
 * `docs/design/send-atomic-4466.md` §6.1 (rows generated from its axes) and §4.3 (the
 * hooks), before any of the fix exists. Tests only; nothing in `src/` changes.
 *
 * Three kinds of rows, all observed the same way (§6.1: the content of the tables an
 * operation touches, and what it does outside the database, before and after):
 *
 *  (i)  The new route `POST /api/worktrees/:id/send-operation` (§4.1). Every row asserts
 *       what the design expects of the route as if it existed (status, code, `policy`,
 *       nothing left on a refusal; the rows and keys written on success; the hook point
 *       reached). It does not exist yet — a green test below pins that — so the rows are
 *       `it.fails`, marked `// #4466 PR1b`: the PR that adds the route removes the mark.
 *       The rows come from `sendOperationRows()` (`tests/helpers/send-operation-table-4466/
 *       table.ts`, where the axes, every reduction and its reason are written).
 *  (ii) The CLI on the shapes of the known limits K1 and K2 of 0.53.0 (§1), twice:
 *       - on the new path (the capability list has `send-operation-v1`, the dispatch has the
 *         new route): the design's outcome. `it.fails`, marked `// #4466 PR2`, removed by
 *         the PR that moves `send` onto the route. K1's change happens at h-S2 (the reply-to
 *         end turns antigravity between S1 and S2), so its outcome is
 *         `OPERATION_TARGET_CHANGED`, exit 31 (§4.2 (a), C3, H1).
 *       - on the old path (a server without the capability, today's separate requests,
 *         the change made between two requests): the defect itself, the positive control of
 *         this PR. `it.fails`, marked `// #4466 old server`: it stays, because an old server
 *         keeps K1 / K2 (§2 「I1 の範囲の外」, H3).
 *  (iii) Today's routes and CLI on what already holds (a refusal at the first write leaves
 *       nothing; an allowed operation writes as before, the negative control), and the
 *       fixtures checked to work now (mem on / off / at the limit, the roster limit, the
 *       env baseline). Ordinary tests, green. The CLI rows run with the new capability
 *       offered, so after PR2 they go through the new route and stay what they assert.
 *
 * Everything runs in-process against the real route modules: an in-memory database copied
 * per test from templates built once (mem on / off / at its limit), fake CLI tools (no agy,
 * no `~/.gemini`: the antigravity module is a fake; `PATH` is the run's empty `bin` and
 * `/usr/bin:/bin`, which hold no agy / claude / codex; `HOME` is the run's directory), no
 * tmux, a recording fake WebSocket. The worktree is one git repository under os.tmpdir()
 * made once (mem resolves its branch from it), read only by the rows (a last test checks
 * that no row wrote into it). No server listens; `CM_PORT` is a free port taken at run
 * time. Every directory is removed in afterEach / afterAll, also when a setup failed.
 *
 * @vitest-environment node
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { getAgentInstances, setAgentInstances } from '@/lib/db/agent-instances-db';
import { upsertWorktree } from '@/lib/db';
import { createRepository } from '@/lib/db/db-repository';
import { createAgentRole, getInstanceRoleState, setInstanceRoleState } from '@/lib/db/agent-roles-db';
import { getMemSettings, saveMemSettings, MEM_OPEN_LIMITS } from '@/lib/db/mem-db';
import { MEM_EXIT_BY_CODE } from '@/types/mem';
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
import { MAX_AGENT_INSTANCES } from '@/lib/cli-tools/types';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import type { Worktree } from '@/types/models';
import { FIXTURE, FIXTURE_ROSTER, GIT_PATH, fillerRows, gitInit, seedRosterNeighbours } from '../helpers/send-operation-table-4466/fixture';
import {
  BASE_OPS,
  EXIT,
  MEM_EXIT,
  ORIGINS,
  ROSTER_LIMIT_REFUSAL,
  sendOperationBody,
  sendOperationRows,
  type TableRow,
  type Tool,
} from '../helpers/send-operation-table-4466/table';
import {
  OBSERVED_TABLES,
  diffSnapshots,
  summarizeChanges,
  takeSnapshot,
  withoutOwnChanges,
  type Change,
  type OperationSnapshot,
} from '../helpers/send-operation-table-4466/observe';
import {
  SEND_OPERATION_HOOK_POINTS,
  SendOperationStop,
  clearSendOperationHooks,
  firedSendOperationHooks,
  runSendOperationHook,
  setSendOperationHook,
  stoppedSendOperationHooks,
} from '../helpers/send-operation-table-4466/hooks';
import {
  SEND_OPERATION_ROUTE_FILE,
  SEND_OPERATION_ROUTE_MISSING,
  freePort,
  loadSendOperationRoute,
  loadSendOperationRouteIfPresent,
  runCli,
  type CliResult,
  type RouteHandler,
} from '../helpers/send-operation-table-4466/harness';

/** What the fakes recorded: keys, launches, broadcasts, pollers. */
const record = vi.hoisted(() => ({
  running: new Set<string>(),
  typed: [] as string[],
  launched: [] as string[],
  broadcasts: [] as string[],
  pollers: [] as string[],
  onStart: null as null | ((tool: string, instanceId: string | undefined) => Promise<void>),
}));

/** A fake tool: no tmux, no binary; it records what it is asked to do. */
const fakeToolClass = vi.hoisted(() => (tool: string, name: string, command: string) => class {
  id = tool;
  name = name;
  command = command;
  async isInstalled() { return true; }
  async isRunning(_id: string, instanceId?: string) { return record.running.has(`${tool}:${instanceId ?? tool}`); }
  async startSession(_id: string, _worktreePath: string, instanceId?: string) {
    await record.onStart?.(tool, instanceId);
    record.launched.push(`${tool}:${instanceId ?? tool}`);
    record.running.add(`${tool}:${instanceId ?? tool}`);
  }
  async sendMessage(_id: string, message: string, instanceId?: string) {
    noteInputStart();
    record.typed.push(`${tool}:${instanceId ?? tool}:${message.slice(0, 40)}`);
  }
  async killSession(_id: string, instanceId?: string) { record.running.delete(`${tool}:${instanceId ?? tool}`); }
  getSessionName(id: string, instanceId?: string) { return `mcbd-${tool}-${id}-${instanceId ?? tool}`; }
});

vi.mock('@/lib/cli-tools/codex', () => ({ CodexTool: fakeToolClass('codex', 'Codex CLI', 'codex') }));
vi.mock('@/lib/cli-tools/antigravity', () => ({ AntigravityTool: fakeToolClass('antigravity', 'Antigravity', 'agy') }));
vi.mock('@/lib/cli-tools/claude', () => ({ ClaudeTool: fakeToolClass('claude', 'Claude Code', 'claude') }));
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
vi.mock('@/lib/polling/response-poller', () => ({
  startPolling: vi.fn((worktreeId: string, cliToolId: string) => void record.pollers.push(`start:response:${worktreeId}/${cliToolId}`)),
  getActivePollers: vi.fn(() => []),
}));
vi.mock('@/lib/assistant-response-saver', () => ({ savePendingAssistantResponse: vi.fn() }));
vi.mock('@/lib/ws-server', () => ({
  broadcast: vi.fn((room: string) => void record.broadcasts.push(`broadcast:${room}`)),
  broadcastMessage: vi.fn((type: string) => void record.broadcasts.push(`message:${type}`)),
  cleanupRooms: vi.fn(),
}));
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
  broadcastSessionStatus: vi.fn((worktreeId: string) => void record.broadcasts.push(`session-status:${worktreeId}`)),
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
  startAutoYesPolling: vi.fn((worktreeId: string, cliToolId: string, instanceId?: string) => {
    record.pollers.push(`start:auto-yes:${worktreeId}/${cliToolId}/${instanceId ?? cliToolId}`);
    return { started: true };
  }),
  stopAutoYesPolling: vi.fn((worktreeId: string, cliToolId?: string, instanceId?: string) => {
    record.pollers.push(`stop:auto-yes:${worktreeId}/${cliToolId ?? ''}/${instanceId ?? ''}`);
  }),
  stopAutoYesPollingByWorktree: vi.fn((worktreeId: string) => void record.pollers.push(`stop:auto-yes:${worktreeId}/*`)),
}));
vi.mock('@/lib/hooks/pending-decision-recheck', () => ({
  recheckPendingDecisions: vi.fn(async () => ({ reason: 'test', examined: 0, delivered: 0, skipped: 0 })),
}));
/** §6.1 「端の解決の失敗」: a roster read that throws for one instance id (the #4496 fault), and how often it hit. */
const rosterFault = vi.hoisted(() => ({ instanceId: null as string | null, hits: 0 }));
vi.mock('@/lib/db/agent-instances-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/agent-instances-db')>();
  return {
    ...actual,
    getAgentInstance: (...args: Parameters<typeof actual.getAgentInstance>) => {
      if (rosterFault.instanceId !== null && args[2] === rosterFault.instanceId) {
        rosterFault.hits += 1;
        throw new Error('roster unreadable (injected)');
      }
      return actual.getAgentInstance(...args);
    },
  };
});

import * as instanceRolesRoute from '@/app/api/worktrees/[id]/instances/roles/route';
import * as sendRoute from '@/app/api/worktrees/[id]/send/route';
import * as tasksRoute from '@/app/api/worktrees/[id]/tasks/route';
import * as taskRoute from '@/app/api/tasks/[taskId]/route';
import * as resolveTargetRoute from '@/app/api/worktrees/[id]/resolve-target/route';
import * as autoYesRoute from '@/app/api/worktrees/[id]/auto-yes/route';
import * as toolPolicyRoute from '@/app/api/worktrees/[id]/tool-policy/route';
import * as memItemsRoute from '@/app/api/worktrees/[id]/mem/items/route';
import * as rolesRoute from '@/app/api/roles/route';
import * as roleRoute from '@/app/api/roles/[id]/route';
import * as worktreeRoute from '@/app/api/worktrees/[id]/route';
import * as relaysRoute from '@/app/api/relays/route';
import * as relayCancelRoute from '@/app/api/relays/[relayId]/cancel/route';
import {
  beginAutoYesShutdown,
  clearAllAutoYesStates,
  getAutoYesStateCompositeKeys,
  peekAutoYesState,
  resetAutoYesShutdownForTesting,
  setAutoYesEnabled,
} from '@/lib/auto-yes-state';
import { resolveEnvSnapshotDir } from '@/lib/verification/env-snapshot';
import { createSendCommand } from '@/cli/commands/send';

const WT = FIXTURE.worktreeId;
/** A contract that runs the env-clean gate, so `POST /tasks` writes an env baseline (the observation's control). */
const ENV_CONTRACT_PATH = '.commandmate/tasks/env.yaml';
const ENV_CONTRACT = `${FIXTURE.contract}verify:\n  gates:\n    - env-clean\n`;
/** The worktree's verify config: one gate, no `requireEnvClean` (so only ENV_CONTRACT runs env-clean). */
const VERIFY_YAML = 'version: 1\ngates:\n  - id: noop\n    command: "true"\n    timeoutSec: 10\n';
/** Today's capability list, and the one of a server with the new route (§4.6). */
const OLD_CAPABILITIES = ['resolve-session-target'];
const NEW_CAPABILITIES = ['resolve-session-target', 'send-operation-v1'];

// ---------------------------------------------------------------------------
// The world: one git worktree, templates built once, copied for each test
// ---------------------------------------------------------------------------

type TemplateKind = 'base' | 'mem-on' | 'mem-off' | 'mem-limit';
const templates = new Map<TemplateKind, Buffer>();
let sharedDir: string | undefined;
let worktreePath: string;
/** The worktree's files (`.git` aside) once made: no row may write into it. */
let worktreeFilesAtStart: string[];
let roleId: string;
let repositoryId: string;
let dir: string | undefined;
let db: Database.Database | undefined;
/** Every request the CLI made (`METHOD /path`), each answer (`METHOD /path status`), and each body. */
let requests: string[];
let answered: string[];
let bodies: Record<string, Array<Record<string, unknown>>>;
/** Runs right after a route answered the CLI (`METHOD /path`): a change between two requests (the old path). */
let afterRoute: ((request: string) => void) | null;
let capabilities: string[];
let stdinTTY: PropertyDescriptor | undefined;
let port: number;
/** What the test itself changed during an operation (an interrupt's input), taken out of its result. */
let ownChanges: Change[];

const liveDb = (): Database.Database => {
  if (!db) throw new Error('no database for this test');
  return db;
};

function listFiles(root: string): string[] {
  return fs.readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((entry) => !entry.startsWith('.git')).sort();
}

async function setMockDb(value: Database.Database | null): Promise<void> {
  const holder = (await import('@/lib/db/db-instance')) as unknown as { setMockDb: (v: Database.Database | null) => void };
  holder.setMockDb(value);
}

function setMemMode(build: Database.Database, mode: 'on' | 'off'): void {
  const current = getMemSettings(build, repositoryId);
  saveMemSettings(build, repositoryId, { version: current.version, features: current.features, rules: [{ match: 'glob', pattern: '**', mode }] });
}

async function postMemItem(text: string, instanceId: string = FIXTURE.replyTo): Promise<{ status: number; payload: Record<string, unknown> }> {
  const response = await memItemsRoute.POST(
    new NextRequest(`http://localhost/api/worktrees/${WT}/mem/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instanceId, kind: 'waiting', text, closeWhen: 'at:2099-01-01T00:00:00Z' }),
    }),
    { params: Promise.resolve({ id: WT }) }
  );
  return { status: response.status, payload: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

beforeAll(async () => {
  port = await freePort();
  sharedDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-send-operation-4466-shared-')));
  worktreePath = path.join(sharedDir, 'wt');
  fs.mkdirSync(path.join(worktreePath, '.commandmate', 'tasks'), { recursive: true });
  gitInit(worktreePath);
  fs.writeFileSync(path.join(worktreePath, FIXTURE.contractPath), FIXTURE.contract);
  fs.writeFileSync(path.join(worktreePath, ENV_CONTRACT_PATH), ENV_CONTRACT);
  fs.writeFileSync(path.join(worktreePath, '.commandmate', 'verify.yaml'), VERIFY_YAML);
  worktreeFilesAtStart = listFiles(worktreePath);

  const build = new Database(':memory:');
  try {
    runMigrations(build);
    upsertWorktree(build, {
      id: WT,
      name: 'wt',
      path: worktreePath,
      repositoryPath: worktreePath,
      repositoryName: 'repo',
      cliToolId: 'codex',
    } as Worktree);
    build.prepare('UPDATE worktrees SET selected_agents = ? WHERE id = ?').run(JSON.stringify(['codex', 'antigravity', 'claude']), WT);
    setAgentInstances(build, WT, FIXTURE_ROSTER.map((row) => ({ ...row })) as AgentInstance[]);
    repositoryId = createRepository(build, { name: 'repo', path: worktreePath, cloneSource: 'local' }).id;
    roleId = createAgentRole(build, { name: FIXTURE.roleName, body: 'REVIEW' }).id;
    seedRosterNeighbours(build);
    templates.set('base', build.serialize());
    setMemMode(build, 'off');
    templates.set('mem-off', build.serialize());
    setMemMode(build, 'on');
    templates.set('mem-on', build.serialize());
    // At the limit: `MEM_OPEN_LIMITS.waiting.max` open waiting items on the branch, written by mem itself.
    await setMockDb(build);
    for (let index = 0; index < (MEM_OPEN_LIMITS.waiting.max ?? 0); index += 1) {
      const written = await postMemItem(`filler ${index}`);
      if (written.status !== 201) throw new Error(`mem filler ${index}: ${written.status} ${JSON.stringify(written.payload)}`);
    }
    templates.set('mem-limit', build.serialize());
  } finally {
    await setMockDb(null);
    build.close();
  }
});

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-send-operation-4466-')));
  for (const sub of ['home', 'bin', 'codex']) fs.mkdirSync(path.join(dir, sub));
  await loadTemplate('base');
  resetSessionLaunchFlightsForTest();
  resetInstanceInputLocks();
  clearAllAutoYesStates();
  resetAutoYesShutdownForTesting();
  clearSendOperationHooks();
  record.running.clear();
  record.typed = [];
  record.launched = [];
  record.broadcasts = [];
  record.pollers = [];
  record.onStart = null;
  rosterFault.instanceId = null;
  rosterFault.hits = 0;
  requests = [];
  answered = [];
  bodies = {};
  afterRoute = null;
  capabilities = NEW_CAPABILITIES;
  ownChanges = [];
  stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  // No agy / claude / codex on PATH (git only, for mem), no real HOME: no agy, no ~/.gemini is reachable.
  vi.stubEnv('PATH', `${path.join(dir, 'bin')}:${GIT_PATH}`);
  vi.stubEnv('HOME', path.join(dir, 'home'));
  vi.stubEnv('CM_ANTIGRAVITY_NOTICE_DIR', path.join(dir, 'notice'));
  vi.stubEnv('CM_AGENT_HOOKS_INJECT', '0');
  vi.stubEnv('CM_AGENT_ROLE_ARTIFACTS_DIR', path.join(dir, 'data'));
  vi.stubEnv('CM_AGENT_ROLE_ANTIGRAVITY_AGENTS_DIR', path.join(dir, 'agy-agents'));
  vi.stubEnv('CODEX_HOME', path.join(dir, 'codex'));
  vi.stubEnv('CM_PORT', String(port));
  vi.stubEnv('CM_ANTIGRAVITY_USAGE', '');
  for (const name of ['TMUX', 'CLAUDECODE', 'CM_RUN_ORIGIN', 'CM_WORKTREE_ID', 'CM_AGENT_WORKTREE_ID', 'CM_INSTANCE_ID', 'CM_AGENT_INSTANCE_ID', 'CM_CLI_TOOL']) {
    vi.stubEnv(name, '');
  }
  // The default caller is a session (the CLI's `session` origin); asOrigin() changes it.
  vi.stubEnv('CM_AGENT_TOOL', 'codex');
  vi.stubGlobal('fetch', dispatch);
});

afterEach(async () => {
  if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
  clearSendOperationHooks();
  resetLaunchRoleStateForTest();
  resetSessionLaunchFlightsForTest();
  clearAllAutoYesStates();
  resetAutoYesShutdownForTesting();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await setMockDb(null);
  db?.close();
  db = undefined;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

afterAll(() => {
  // Also when a setup failed half-way (review P3-1).
  db?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  if (sharedDir) fs.rmSync(sharedDir, { recursive: true, force: true });
  templates.clear();
});

/** Replace this test's database by a fresh copy of one template. */
async function loadTemplate(kind: TemplateKind): Promise<void> {
  const template = templates.get(kind);
  if (!template) throw new Error(`no template ${kind}`);
  db?.close();
  db = new Database(template);
  await setMockDb(db);
  setLaunchRoleDatabaseForTest(db);
}

// ---------------------------------------------------------------------------
// Driving: today's routes and the new one for the CLI, the new one for the (i) rows
// ---------------------------------------------------------------------------

function routed(pathname: string): { handlers: Record<string, unknown>; params: Record<string, string> } | null {
  if (pathname === '/api/roles') return { handlers: rolesRoute, params: {} };
  if (pathname === '/api/relays') return { handlers: relaysRoute, params: {} };
  const role = pathname.match(/^\/api\/roles\/([^/]+)$/);
  if (role) return { handlers: roleRoute, params: { id: role[1] } };
  const cancel = pathname.match(/^\/api\/relays\/([^/]+)\/cancel$/);
  if (cancel) return { handlers: relayCancelRoute, params: { relayId: cancel[1] } };
  const task = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (task) return { handlers: taskRoute, params: { taskId: task[1] } };
  const routes: Array<[RegExp, Record<string, unknown>]> = [
    [/^\/api\/worktrees\/([^/]+)\/instances\/roles$/, instanceRolesRoute],
    [/^\/api\/worktrees\/([^/]+)\/send$/, sendRoute],
    [/^\/api\/worktrees\/([^/]+)\/tasks$/, tasksRoute],
    [/^\/api\/worktrees\/([^/]+)\/resolve-target$/, resolveTargetRoute],
    [/^\/api\/worktrees\/([^/]+)\/auto-yes$/, autoYesRoute],
    [/^\/api\/worktrees\/([^/]+)\/tool-policy$/, toolPolicyRoute],
    [/^\/api\/worktrees\/([^/]+)\/mem\/items$/, memItemsRoute],
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
  const key = `${method} ${url.pathname}`;
  requests.push(key);
  if (typeof init?.body === 'string') {
    try {
      (bodies[key] ??= []).push(JSON.parse(init.body) as Record<string, unknown>);
    } catch {
      // not JSON: not recorded
    }
  }
  if (url.pathname === '/api/capabilities') return Response.json({ serverVersion: 'test', capabilities });
  if (url.pathname === `/api/worktrees/${WT}/current-output`) return Response.json({ isRunning: record.running.size > 0 });
  if (url.pathname === `/api/worktrees/${WT}/opencode/session`) return Response.json({ instances: [] });
  if (url.pathname === '/api/worktrees') return Response.json({ worktrees: [{ id: WT }] });
  let handler: RouteHandler | undefined;
  let params: Record<string, string> = {};
  const operation = url.pathname.match(/^\/api\/worktrees\/([^/]+)\/send-operation$/);
  if (operation) {
    // The new route (§4.1): a 404 while it does not exist, as a server without it answers.
    const route = await loadSendOperationRouteIfPresent();
    if (!route) return Response.json({ error: 'Not Found' }, { status: 404 });
    handler = method === 'POST' ? route.POST : undefined;
    params = { id: operation[1] };
  } else {
    const route = routed(url.pathname);
    if (!route) throw new Error(`Not stubbed: ${key}`);
    handler = route.handlers[method] as RouteHandler | undefined;
    params = route.params;
  }
  if (!handler) return Response.json({ error: `no ${method}` }, { status: 405 });
  const response = await handler(new NextRequest(url, init as ConstructorParameters<typeof NextRequest>[1]), {
    params: Promise.resolve(params),
  });
  answered.push(`${key} ${response.status}`);
  afterRoute?.(key);
  return response;
}

/** A real launch's effect on what is known (the cli-roles-4116 way), without tmux. */
async function launch(tool: string, instanceId: string | undefined): Promise<void> {
  const launchTarget = { worktreeId: WT, cliToolId: tool as CLIToolType, instanceId };
  const snapshot = await resolveLaunchRole(liveDb(), { ...launchTarget, worktreePath, readEnv: fixedEnvReader({}) });
  await runWithLaunchRole(snapshot, async () => {
    beginAgentSession(launchTarget);
    buildAgentLaunchCommandLine({ target: launchTarget, executablePath: tool === 'antigravity' ? 'agy' : tool, worktreePath });
  });
}

/** Make a change as the test (an interrupt's input): recorded, so the result does not count it. */
function asTestInput(change: () => void): void {
  const before = snapshot();
  change();
  ownChanges.push(...diffSnapshots(before, snapshot()));
}

/** The roster with one instance's tool changed (the h-S2 / h-S3 / K1 changes). */
function retool(instanceId: string, tool: Tool): void {
  asTestInput(() => {
    const roster = getAgentInstances(liveDb(), WT).map((row) => (row.id === instanceId ? { ...row, cliTool: tool } : row));
    setAgentInstances(liveDb(), WT, roster as AgentInstance[]);
  });
}

/** The worktree's default tool changed (the h-S2 `default` input). */
function redefault(tool: Tool): void {
  asTestInput(() => void liveDb().prepare('UPDATE worktrees SET cli_tool_id = ? WHERE id = ?').run(tool, WT));
}

/**
 * The env baselines, `name:sha256` (`resolveEnvSnapshotDir()`, beside the database path).
 * `tests/setup.ts` (`isolateTestDatabaseEnv`) points `CM_DB_PATH` at a directory of this
 * worker under os.tmpdir(), so the directory is the worker's, never the real one; files
 * from earlier tests of the worker stay, and only the difference is read.
 */
function envSnapshotFiles(): string[] {
  try {
    const where = resolveEnvSnapshotDir();
    if (!fs.existsSync(where)) return [];
    return fs.readdirSync(where).map((name) => {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(where, name))).digest('hex');
      return `${name}:${hash}`;
    });
  } catch (error) {
    // A directory that cannot be read is still an observation, never a silent "nothing".
    return [`<unreadable: ${error instanceof Error ? error.message : String(error)}>`];
  }
}

function outside() {
  const grants = getAutoYesStateCompositeKeys().map((key) => {
    const [worktreeId, cliToolId, instanceId] = key.split(':');
    return `${key}=${JSON.stringify(peekAutoYesState(worktreeId, cliToolId as CLIToolType, instanceId))}`;
  });
  return {
    grants,
    pollers: record.pollers,
    envSnapshots: envSnapshotFiles(),
    typed: record.typed,
    launched: record.launched,
    broadcasts: record.broadcasts,
  };
}

const snapshot = (): OperationSnapshot => takeSnapshot(liveDb(), outside);

/** The template a row needs: mem's state matters to a `--note` row only. */
function templateOf(row: TableRow): TemplateKind {
  if (!row.modifiers.includes('note')) return 'base';
  return row.mem === 'on' ? 'mem-on' : row.mem === 'off' ? 'mem-off' : 'mem-limit';
}

/** Put the world in the row's state and register its hook (§6.1 「割り込み」). */
async function arrangeRow(row: TableRow): Promise<void> {
  await loadTemplate(templateOf(row));
  const current = liveDb();
  if (row.worktreeDefault !== 'codex') current.prepare('UPDATE worktrees SET cli_tool_id = ? WHERE id = ?').run(row.worktreeDefault, WT);
  if (row.rosterFull) {
    setAgentInstances(current, WT, [...getAgentInstances(current, WT), ...fillerRows(MAX_AGENT_INSTANCES)] as AgentInstance[]);
  }
  if (row.existingGrant) setAutoYesEnabled(WT, row.targetTool, true, 3_600_000, undefined, row.typedInstance, 'careful');
  if (row.existingRole) setInstanceRoleState(current, WT, row.typedInstance, { state: row.existingRole });
  if (row.shutdown) beginAutoYesShutdown();
  vi.stubEnv('CM_ANTIGRAVITY_USAGE', row.declaration === 'api-key' ? 'api-key' : '');
  rosterFault.instanceId = row.rosterFault ?? null;
  record.onStart = (tool, instanceId) => launch(tool, instanceId);
  const interrupt = row.interrupt;
  switch (interrupt.kind) {
    case 'h-S2':
      setSendOperationHook('h-S2', () => {
        const deny = interrupt.direction === 'to-deny';
        if (interrupt.input === 'roster-tool') retool(FIXTURE.instanceOf.codex, deny ? 'antigravity' : 'claude');
        if (interrupt.input === 'default') redefault(deny ? 'antigravity' : 'claude');
        if (interrupt.input === 'reply-to-roster') retool(FIXTURE.replyTo, deny ? 'antigravity' : 'codex');
        if (interrupt.input === 'declaration') vi.stubEnv('CM_ANTIGRAVITY_USAGE', deny ? '' : 'api-key');
      });
      break;
    case 's0-first':
      // The refusing value would be turned allowing here; S0 refuses before (the hook must not run).
      setSendOperationHook('h-S2', () => {
        if (interrupt.input === 'roster-tool') retool(FIXTURE.instanceOf.antigravity, 'codex');
        if (interrupt.input === 'default') redefault('codex');
        if (interrupt.input === 'reply-to-roster') retool(FIXTURE.replyToAntigravity, 'claude');
        if (interrupt.input === 'declaration') vi.stubEnv('CM_ANTIGRAVITY_USAGE', 'api-key');
      });
      break;
    case 'h-S3':
      setSendOperationHook('h-S3', () => retool(FIXTURE.instanceOf.codex, 'antigravity'));
      break;
    case 'h-S3b':
      // The delivery stage is not driven here (no reply exists to deliver): PR1b drives the
      // relay pump after this row and checks the relay is withdrawn (#4456 (5), outside I1).
      setSendOperationHook('h-S3b', () => retool(FIXTURE.replyTo, 'antigravity'));
      break;
    case 'h-S1-stop':
      setSendOperationHook('h-S1', () => {
        throw new SendOperationStop('h-S1');
      });
      break;
    case 'none':
      break;
  }
}

interface RouteResult {
  status: number;
  payload: Record<string, unknown>;
  /** The route let the hook's stop out (rather than answering it). */
  stopPropagated: boolean;
  changes: Change[];
}

/** One (i) row: load the route, arrange, POST, observe. */
async function driveSendOperation(row: TableRow): Promise<RouteResult> {
  const route = await loadSendOperationRoute();
  await arrangeRow(row);
  const before = snapshot();
  let status = 0;
  let payload: Record<string, unknown> = {};
  let stopPropagated = false;
  try {
    const response = await route.POST(
      new NextRequest(`http://localhost/api/worktrees/${WT}/send-operation`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sendOperationBody(row, roleId)),
      }),
      { params: Promise.resolve({ id: WT }) }
    );
    status = response.status;
    payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  } catch (error) {
    if (!(error instanceof SendOperationStop)) throw error;
    stopPropagated = true;
  }
  return { status, payload, stopPropagated, changes: withoutOwnChanges(diffSnapshots(before, snapshot()), ownChanges) };
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/** What a row's result breaks; empty when it is what the design expects. */
function routeRowBroken(row: TableRow, result: RouteResult): string[] {
  const current = liveDb();
  const expected = row.expected;
  const changed = summarizeChanges(result.changes);
  const fired = firedSendOperationHooks();
  const hooks = [
    ...row.hooks.reached.filter((point) => !fired.includes(point)).map((point) => `${point} not reached`),
    ...row.hooks.notReached.filter((point) => fired.includes(point)).map((point) => `${point} reached`),
    ...(row.rosterFault !== undefined && rosterFault.hits === 0 ? ['the injected roster fault never hit'] : []),
  ];
  if (expected.kind === 'stopped') {
    return [
      ...hooks,
      ...(stoppedSendOperationHooks().includes('h-S1') ? [] : ['not stopped at h-S1']),
      ...(result.stopPropagated || result.status >= 500 ? [] : [`answered ${result.status} after the stop`]),
      ...(changed.length === 0 ? [] : [`S1 wrote: ${changed.join(', ')}`]),
    ];
  }
  if (expected.kind === 'refused') {
    const code = typeof result.payload.code === 'string' ? result.payload.code : null;
    const policy = asRecord(result.payload.policy);
    const want = expected.policy;
    return [
      ...hooks,
      ...(result.status === expected.status ? [] : [`status ${result.status}`]),
      ...(expected.codes === null || (code !== null && expected.codes.includes(code)) ? [] : [`code ${code}`]),
      ...(want === undefined ? [] : [
        ...(policy.stage === want.stage ? [] : [`policy.stage ${String(policy.stage)}`]),
        ...(policy.operation === want.operation ? [] : [`policy.operation ${String(policy.operation)}`]),
        ...(policy.tool === want.tool ? [] : [`policy.tool ${String(policy.tool)}`]),
        ...(want.origins.includes(String(policy.origin)) ? [] : [`policy.origin ${String(policy.origin)}`]),
        ...(want.endpoint === undefined || policy.endpoint === want.endpoint ? [] : [`policy.endpoint ${String(policy.endpoint)}`]),
      ]),
      ...(changed.length === 0 ? [] : [`left: ${changed.join(', ')}`]),
    ];
  }
  const parts = new Set(result.changes.map(({ part }) => part));
  const typed = result.changes.find(({ part }) => part === 'typed')?.added ?? [];
  const writes = expected.writes;
  const tasks = current.prepare('SELECT cli_tool_id AS tool, instance_id AS instance FROM tasks').all() as Array<{ tool: string; instance: string | null }>;
  const relays = current.prepare('SELECT from_instance_id AS fromId, to_instance_id AS toId FROM session_relays').all() as Array<{ fromId: string; toId: string }>;
  const policy = asRecord(result.payload.policy);
  const judgedRelay = asRecord(policy.relay);
  const grant = writes.grant ? peekAutoYesState(WT, writes.grant.key.split('/')[0] as CLIToolType, writes.grant.key.split('/')[1]) : null;
  return [
    ...hooks,
    ...(result.status >= 200 && result.status < 300 ? [] : [`status ${result.status}`]),
    ...(result.payload.ok === true ? [] : ['ok is not true']),
    ...(typed.length === 1 && typed[0].startsWith(`${expected.typed.tool}:${expected.typed.instanceId}:`) ? [] : [`typed ${JSON.stringify(typed)}`]),
    ...(writes.task
      ? (tasks.length === 1 && tasks[0].tool === expected.typed.tool && tasks[0].instance === expected.typed.instanceId ? [] : [`tasks ${JSON.stringify(tasks)}`])
      : (parts.has('tasks') ? ['a task row'] : [])),
    ...(writes.rosterRow !== null
      ? (getAgentInstances(current, WT).some(({ id }) => id === writes.rosterRow) ? [] : [`${writes.rosterRow} not on the roster`])
      : (parts.has('agent_instances') ? ['a roster change'] : [])),
    ...(writes.role !== null
      ? (getInstanceRoleState(current, WT, writes.role.instanceId).state === writes.role.state ? [] : [`role of ${writes.role.instanceId} ${JSON.stringify(getInstanceRoleState(current, WT, writes.role.instanceId))}`])
      : (parts.has('agent_instance_roles') ? ['a role change'] : [])),
    ...(writes.relay !== null
      ? (relays.length === 1 && relays[0].fromId === writes.relay.from && relays[0].toId === writes.relay.to ? [] : [`relays ${JSON.stringify(relays)}`])
      : (parts.has('session_relays') ? ['a relay row'] : [])),
    ...(writes.note === parts.has('mem_items') ? [] : [writes.note ? 'no note item' : 'a mem item']),
    ...(writes.grant !== null
      ? (grant?.enabled === true && (grant as { answerMode?: string }).answerMode === writes.grant.answerMode ? [] : [`grant ${JSON.stringify(grant)}`])
      : (result.changes.some(({ part, added }) => part === 'grants' && added.some((entry) => entry.includes('"enabled":true'))) ? ['a grant'] : [])),
    ...(asRecord(policy.target).tool === expected.judged.target ? [] : [`policy.target ${JSON.stringify(policy.target)}`]),
    ...(expected.judged.relay === undefined || (judgedRelay.from === expected.judged.relay.from && judgedRelay.to === expected.judged.relay.to)
      ? [] : [`policy.relay ${JSON.stringify(policy.relay)}`]),
  ];
}

type CliOrigin = Exclude<(typeof ORIGINS)[number], 'legacy'>;

/** The CLI's origin inputs (`src/cli/utils/send-origin.ts`), the repro-4449 way. */
function asOrigin(origin: CliOrigin): void {
  vi.stubEnv('CM_AGENT_TOOL', origin === 'session' ? 'codex' : '');
  Object.defineProperty(process.stdin, 'isTTY', { value: origin !== 'unknown', configurable: true });
  if (origin === 'agent') vi.stubEnv('CLAUDECODE', '1');
  if (origin === 'schedule') vi.stubEnv('CM_RUN_ORIGIN', 'schedule');
}

interface CliRowResult extends CliResult {
  changes: Change[];
}

async function sendCli(...args: string[]): Promise<CliRowResult> {
  record.onStart ??= (tool, instanceId) => launch(tool, instanceId);
  const before = snapshot();
  const result = await runCli(createSendCommand(), [WT, ...args]);
  return { ...result, changes: withoutOwnChanges(diffSnapshots(before, snapshot()), ownChanges) };
}

/** I1 through the CLI (§2, §5.1 C2): the exit, the reason first, stdout empty, nothing left. */
function cliRefusalBroken(result: CliRowResult, exit: number, firstLine: RegExp): string[] {
  const changed = summarizeChanges(result.changes);
  return [
    ...(result.code === exit ? [] : [`exit ${result.code}`]),
    ...(firstLine.test(result.stderr[0] ?? '') ? [] : [`stderr[0] ${result.stderr[0]}`]),
    ...(result.stdout.length === 0 ? [] : [`stdout ${JSON.stringify(result.stdout)}`]),
    ...(changed.length === 0 ? [] : [`left: ${changed.join(', ')}`]),
  ];
}
const policyLine = (code: 'TOOL_POLICY_DENIED' | 'RELAY_TOOL_POLICY_DENIED'): RegExp => new RegExp(`^Error \\[${code}\\]: `);

/** Today's write requests: on the new path none of them may be made (the operation is one request). */
const OLD_WRITE_REQUESTS = [
  `POST /api/worktrees/${WT}/instances/roles`,
  `PUT /api/worktrees/${WT}/instances/roles`,
  `POST /api/worktrees/${WT}/tasks`,
  'POST /api/relays',
  `POST /api/worktrees/${WT}/auto-yes`,
  `POST /api/worktrees/${WT}/mem/items`,
  `POST /api/worktrees/${WT}/send`,
];
function newPathBroken(): string[] {
  const operations = requests.filter((request) => request === `POST /api/worktrees/${WT}/send-operation`);
  return [
    ...(operations.length === 1 ? [] : [`POST …/send-operation × ${operations.length}`]),
    ...requests.filter((request) => OLD_WRITE_REQUESTS.includes(request)).map((request) => `old write ${request}`),
  ];
}

const reviewEnd = `${WT}@${FIXTURE.replyTo}`;
const agyEnd = `${WT}@${FIXTURE.replyToAntigravity}`;

// ---------------------------------------------------------------------------
// The table itself
// ---------------------------------------------------------------------------

const ROUTE_ROWS = sendOperationRows();

describe('#4466 PR0 the table: rows generated from the axes of §6.1', () => {
  it('4466 the rows, by family (counted for §6.4 4 / §9 4)', () => {
    const byFamily = ROUTE_ROWS.reduce<Record<string, number>>((count, row) => ({ ...count, [row.family]: (count[row.family] ?? 0) + 1 }), {});
    expect(byFamily).toEqual({
      'target-policy': 840,
      'relay-rule0': 840,
      'auto-yes-policy': 210,
      'relay-non-policy': 140,
      roster: 60,
      mem: 140,
      shutdown: 7,
      'existing-grant': 14,
      'role-conflict': 4,
      'auto-yes-terms': 4,
      none: 1260,
      declared: 7,
      interrupt: 13,
      's1-writes-nothing': 7,
      mismatch: 14,
      'endpoint-unresolved': 1,
    });
    expect(ROUTE_ROWS).toHaveLength(3561);
    expect(new Set(ROUTE_ROWS.map(({ name }) => name)).size).toBe(ROUTE_ROWS.length);
  });

  it('4466 every base operation and origin is in an allowed row and in a refused one; the expected stages', () => {
    for (const base of BASE_OPS) {
      expect(ROUTE_ROWS.some((row) => row.base === base && row.expected.kind === 'allowed')).toBe(true);
      expect(ROUTE_ROWS.some((row) => row.base === base && row.expected.kind === 'refused')).toBe(true);
    }
    for (const origin of ORIGINS) {
      expect(ROUTE_ROWS.some((row) => row.origin === origin && row.expected.kind === 'allowed')).toBe(true);
      expect(ROUTE_ROWS.some((row) => row.origin === origin && row.expected.kind === 'refused')).toBe(true);
    }
    // N1 / I2a: the ad-hoc antigravity send with --reply-to is refused from every origin (C11b, H6).
    const mismatch = ROUTE_ROWS.filter((row) => row.family === 'mismatch' && row.targetTool === 'antigravity');
    expect(mismatch.map((row) => row.expected.kind)).toEqual(mismatch.map(() => 'refused'));
    // The auto-yes-policy family: with --reply-to, rule 0 refuses first (header of table.ts).
    const autoYesStages = ROUTE_ROWS.filter((row) => row.family === 'auto-yes-policy')
      .reduce<Record<string, number>>((count, row) => {
        const stage = row.expected.kind === 'refused' ? row.expected.policy?.stage ?? '-' : row.expected.kind;
        return { ...count, [stage]: (count[stage] ?? 0) + 1 };
      }, {});
    expect(autoYesStages).toEqual({ 'auto-yes': 70, relay: 140 });
    // Every h-S2 row expects its hook reached; every S0-first row expects it not reached.
    for (const row of ROUTE_ROWS.filter((r) => r.interrupt.kind === 'h-S2')) expect(row.hooks.reached).toEqual(['h-S2']);
    for (const row of ROUTE_ROWS.filter((r) => r.interrupt.kind === 's0-first')) {
      expect(row.hooks.notReached).toContain('h-S2');
      expect(row.expected.kind).toBe('refused');
    }
  });

  it('4466 every body has a message or a contract, never both (§4.1, N3)', () => {
    for (const row of ROUTE_ROWS) {
      const body = sendOperationBody(row, roleId);
      expect(('message' in body) !== ('contract' in body)).toBe(true);
    }
  });

  it('4466 the observed tables all exist (a renamed table must not read as "nothing changed")', () => {
    const tables = takeSnapshot(liveDb(), outside).tables;
    for (const table of OBSERVED_TABLES) expect(tables[table]).not.toContain('<missing table>');
    // The roster's neighbours are there before every row (codex P2-3).
    expect(tables.session_notes).toHaveLength(3);
    expect(tables.agent_instance_creation_keys).toHaveLength(1);
    expect(envSnapshotFiles().filter((entry) => entry.startsWith('<unreadable'))).toEqual([]);
  });

  it('4466 each kind of row can be arranged on a fresh world without the route (the vessel works now)', async () => {
    const seen = new Set<string>();
    for (const row of ROUTE_ROWS) {
      const kind = `${row.family}/${row.interrupt.kind}/${templateOf(row)}/${row.worktreeDefault}/${row.rosterFull}/${row.existingGrant}/${row.shutdown}/${row.existingRole}`;
      if (seen.has(kind)) continue;
      seen.add(kind);
      await arrangeRow(row);
      clearSendOperationHooks();
      clearAllAutoYesStates();
      resetAutoYesShutdownForTesting();
    }
    expect(seen.size).toBeGreaterThanOrEqual(20);
  });

  it('4466 the hooks: the four points of §4.3; a reached point is recorded, a stop is recorded and goes out', async () => {
    expect([...SEND_OPERATION_HOOK_POINTS]).toEqual(['h-S1', 'h-S2', 'h-S3', 'h-S3b']);
    setSendOperationHook('h-S1', () => {
      throw new SendOperationStop('h-S1');
    });
    await runSendOperationHook('h-S2', WT);
    await expect(runSendOperationHook('h-S1', WT)).rejects.toBeInstanceOf(SendOperationStop);
    expect(firedSendOperationHooks()).toEqual(['h-S2', 'h-S1']);
    expect(stoppedSendOperationHooks()).toEqual(['h-S1']);
  });

  it('4466 the new route is not there yet (the reason the (i) and new-path (ii) rows are it.fails)', async () => {
    // #4466 PR1b: the route is added; turn this into "it is there".
    expect(fs.existsSync(SEND_OPERATION_ROUTE_FILE)).toBe(false);
    await expect(loadSendOperationRoute()).rejects.toThrow(SEND_OPERATION_ROUTE_MISSING);
    expect(await loadSendOperationRouteIfPresent()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (i) the new route — it.fails until PR1b
// ---------------------------------------------------------------------------

describe('#4466 (i) POST /api/worktrees/:id/send-operation, one row per generated case', () => {
  // #4466 PR1b: the route is added there; remove `.fails` with it.
  it.fails.each(ROUTE_ROWS.map((row) => [row.name, row] as const))('4466 (i) %s', async (_name, row) => {
    const result = await driveSendOperation(row);
    expect(routeRowBroken(row, result)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (ii) the CLI on K1 and K2: the new path (it.fails until PR2) and the old one (stays)
// ---------------------------------------------------------------------------

describe('#4466 (ii) the CLI on the shapes of K1 and K2', () => {
  const K1: Array<[string, string[]]> = [
    ['stage 3: --contract --role --reply-to', ['--contract', FIXTURE.contractPath, '--instance', FIXTURE.instanceOf.codex, '--role', FIXTURE.roleName, '--reply-to', reviewEnd]],
    ['stage 4: --contract --auto-yes --reply-to', ['--contract', FIXTURE.contractPath, '--instance', FIXTURE.instanceOf.codex, '--auto-yes', '--reply-to', reviewEnd]],
    ['stage 5: --contract --reply-to', ['--contract', FIXTURE.contractPath, '--instance', FIXTURE.instanceOf.codex, '--reply-to', reviewEnd]],
  ];
  const K2: Array<[string, string[]]> = [
    ['--model --auto-yes to antigravity', ['hello', '--instance', FIXTURE.instanceOf.antigravity, '--model', FIXTURE.antigravityModel, '--auto-yes']],
    // codex P2-7: the plain --register is saved after the keys and before the deferred Auto-Yes, so its roster row is left too.
    ['--register --model --auto-yes of a new antigravity instance', ['hello', '--agent', 'antigravity', '--instance', FIXTURE.adHoc, '--register', '--model', FIXTURE.antigravityModel, '--auto-yes']],
  ];

  describe('the new path (send-operation-v1): refused with nothing left', () => {
    // #4466 PR2: `send` goes through the new route; remove `.fails` with it.
    it.fails.each(K1)('4466 (ii) new path K1 %s, the reply-to end turns antigravity at h-S2: exit 31 OPERATION_TARGET_CHANGED, nothing left', async (_label, args) => {
      capabilities = NEW_CAPABILITIES;
      setSendOperationHook('h-S2', () => retool(FIXTURE.replyTo, 'antigravity'));
      const result = await sendCli(...args);
      expect([
        ...cliRefusalBroken(result, EXIT.conflict, /^Error\b.*(OPERATION_TARGET_CHANGED|changed)/i),
        ...(firedSendOperationHooks().includes('h-S2') ? [] : ['h-S2 not reached']),
        ...newPathBroken(),
      ]).toEqual([]);
    });

    // #4466 PR2: `send` goes through the new route; remove `.fails` with it.
    it.fails.each(K2)('4466 (ii) new path K2 %s from a person: exit 33, nothing typed, nothing left, one request', async (_label, args) => {
      capabilities = NEW_CAPABILITIES;
      asOrigin('terminal');
      const result = await sendCli(...args);
      const [body] = bodies[`POST /api/worktrees/${WT}/send-operation`] ?? [];
      expect([
        ...cliRefusalBroken(result, EXIT.policy, policyLine('TOOL_POLICY_DENIED')),
        ...newPathBroken(),
        ...(asRecord(body).model === FIXTURE.antigravityModel ? [] : [`body.model ${JSON.stringify(asRecord(body).model)}`]),
        ...(asRecord(asRecord(body).autoYes).timing === 'after-send' ? [] : [`body.autoYes ${JSON.stringify(asRecord(body).autoYes)}`]),
      ]).toEqual([]);
    });
  });

  describe('the old path (a server without the capability): the defect, the positive control', () => {
    /** K1 on the old path: the reply-to end turns antigravity between the task (stage 2) and the later stage. */
    const turnReplyToAfterTask = (): void => {
      afterRoute = (request) => {
        if (request === `POST /api/worktrees/${WT}/tasks`) retool(FIXTURE.replyTo, 'antigravity');
      };
    };

    // #4466 old server: stays `.fails` after PR2 — an old server keeps K1 (§2 I1 の範囲の外, H3).
    it.fails.each(K1)('4466 (ii) old path K1 %s, the reply-to end turns antigravity after the task: exit 33, no task', async (_label, args) => {
      capabilities = OLD_CAPABILITIES;
      turnReplyToAfterTask();
      const result = await sendCli(...args);
      expect(cliRefusalBroken(result, EXIT.policy, policyLine('RELAY_TOOL_POLICY_DENIED'))).toEqual([]);
    });

    // #4466 old server: stays `.fails` after PR2 — an old server keeps K2 (§2 I1 の範囲の外, H3).
    it.fails.each(K2)('4466 (ii) old path K2 %s from a person: exit 33, nothing typed, nothing left', async (_label, args) => {
      capabilities = OLD_CAPABILITIES;
      asOrigin('terminal');
      const result = await sendCli(...args);
      expect(cliRefusalBroken(result, EXIT.policy, policyLine('TOOL_POLICY_DENIED'))).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// (iii) today's routes and CLI on what already holds, and the fixtures — green
// ---------------------------------------------------------------------------

async function post(pathname: string, body: Record<string, unknown>): Promise<{ status: number; payload: Record<string, unknown>; changes: Change[] }> {
  record.onStart ??= (tool, instanceId) => launch(tool, instanceId);
  const before = snapshot();
  const response = await dispatch(`http://localhost${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, payload, changes: diffSnapshots(before, snapshot()) };
}

describe('#4466 (iii) the fixtures work now', () => {
  it('4466 (iii) mem on: a waiting item is written (201)', async () => {
    await loadTemplate('mem-on');
    const written = await postMemItem('the review');
    expect(written.status).toBe(201);
  });

  it('4466 (iii) mem off: refused `disabled` (409), nothing left', async () => {
    await loadTemplate('mem-off');
    const before = snapshot();
    const written = await postMemItem('the review');
    expect({ status: written.status, code: written.payload.code }).toEqual({ status: 409, code: 'disabled' });
    // Today's mem route makes the worktree's incarnation before it judges (design §1 「S1 にできない読み」):
    // the reason the new route makes it in S2. The table's mem rows expect nothing left.
    expect(summarizeChanges(diffSnapshots(before, snapshot()))).toEqual(['mem_worktree_incarnations +1 -0']);
  });

  it('4466 (iii) mem at the limit: refused `limit_exceeded` (409), nothing left', async () => {
    await loadTemplate('mem-limit');
    const before = snapshot();
    const written = await postMemItem('one more');
    expect({ status: written.status, code: written.payload.code }).toEqual({ status: 409, code: 'limit_exceeded' });
    expect(summarizeChanges(diffSnapshots(before, snapshot()))).toEqual([]);
  });

  it('4466 (iii) the exits the table expects of mem are MEM_EXIT_BY_CODE\'s', () => {
    expect(MEM_EXIT).toEqual({ disabled: MEM_EXIT_BY_CODE.disabled, limit_exceeded: MEM_EXIT_BY_CODE.limit_exceeded });
  });

  it('4466 (iii) POST /instances/roles on a full roster: the refusal the roster rows expect, nothing left', async () => {
    setAgentInstances(liveDb(), WT, [...getAgentInstances(liveDb(), WT), ...fillerRows(MAX_AGENT_INSTANCES)] as AgentInstance[]);
    const result = await post(`/api/worktrees/${WT}/instances/roles`, {
      instance: { id: FIXTURE.adHoc, cliTool: 'codex', alias: 'Adhoc' }, role: { state: 'role', roleId }, origin: 'terminal', originEvidence: 'test',
    });
    // Today's roster API names the refusal in `error`; the new route answers it as `code` (table.ts).
    expect({ status: result.status, code: result.payload.error }).toEqual(ROSTER_LIMIT_REFUSAL);
    expect(String(result.payload.message)).toContain(`at most ${MAX_AGENT_INSTANCES}`);
    expect(summarizeChanges(result.changes)).toEqual([]);
  });

  it('4466 (iii) an env baseline is observed: --contract with the env-clean gate writes one (the control of that observation)', async () => {
    asOrigin('terminal');
    const result = await sendCli('--contract', ENV_CONTRACT_PATH, '--instance', FIXTURE.instanceOf.codex);
    expect({ code: result.code, errors: result.stderr.filter((line) => line.startsWith('Error')) }).toEqual({ code: 0, errors: [] });
    expect(result.changes.find(({ part }) => part === 'envSnapshots')?.added).toHaveLength(1);
  });

  it('4466 (iii) an existing grant is observed whole: a refused POST /auto-yes on antigravity leaves its terms as they were', async () => {
    setAutoYesEnabled(WT, 'codex', true, 3_600_000, 'stop-here', FIXTURE.instanceOf.codex, 'careful');
    const result = await post(`/api/worktrees/${WT}/auto-yes`, { enabled: true, cliToolId: 'antigravity', instanceId: FIXTURE.instanceOf.antigravity, origin: 'agent', originEvidence: 'test' });
    expect(result.status).toBe(409);
    expect(summarizeChanges(result.changes)).toEqual([]);
    expect(outside().grants.join('\n')).toContain('"answerMode":"careful"');
  });
});

describe('#4466 (iii) today\'s routes: a policy refusal leaves nothing', () => {
  const agentOrigin = { origin: 'agent', originEvidence: 'test:send-operation-table-4466' };

  it('4466 (iii) POST /tasks for antigravity from an agent: 409 TOOL_POLICY_DENIED, nothing left', async () => {
    const result = await post(`/api/worktrees/${WT}/tasks`, { contractPath: FIXTURE.contractPath, cliToolId: 'antigravity', instanceId: FIXTURE.instanceOf.antigravity, ...agentOrigin });
    expect({ status: result.status, code: result.payload.code }).toEqual({ status: 409, code: 'TOOL_POLICY_DENIED' });
    expect(asRecord(result.payload.policy)).toMatchObject({ operation: 'send', origin: 'agent', tool: 'antigravity' });
    expect(summarizeChanges(result.changes)).toEqual([]);
  });

  it('4466 (iii) POST /instances/roles registering antigravity from an agent: 409 TOOL_POLICY_DENIED, nothing left', async () => {
    const result = await post(`/api/worktrees/${WT}/instances/roles`, {
      instance: { id: FIXTURE.adHoc, cliTool: 'antigravity', alias: 'Agy new' }, role: { state: 'role', roleId }, ...agentOrigin,
    });
    expect({ status: result.status, code: result.payload.code }).toEqual({ status: 409, code: 'TOOL_POLICY_DENIED' });
    expect(summarizeChanges(result.changes)).toEqual([]);
  });

  it('4466 (iii) POST /api/relays with antigravity at the reply-to end: 409 RELAY_TOOL_POLICY_DENIED, no relay row, no system line, no broadcast', async () => {
    const result = await post('/api/relays', {
      from: { worktreeId: WT, instanceId: FIXTURE.replyToAntigravity },
      to: { worktreeId: WT, instanceId: FIXTURE.instanceOf.codex },
    });
    expect({ status: result.status, code: result.payload.code }).toEqual({ status: 409, code: 'RELAY_TOOL_POLICY_DENIED' });
    expect(summarizeChanges(result.changes)).toEqual([]);
  });

  it('4466 (iii) POST /auto-yes on antigravity: 409 TOOL_POLICY_DENIED, no grant, no poller', async () => {
    const result = await post(`/api/worktrees/${WT}/auto-yes`, { enabled: true, cliToolId: 'antigravity', instanceId: FIXTURE.instanceOf.antigravity, ...agentOrigin });
    expect({ status: result.status, code: result.payload.code }).toEqual({ status: 409, code: 'TOOL_POLICY_DENIED' });
    expect(summarizeChanges(result.changes)).toEqual([]);
  });

  it('4466 (iii) POST /send to antigravity from an agent: 409 TOOL_POLICY_DENIED, nothing typed, nothing left', async () => {
    const result = await post(`/api/worktrees/${WT}/send`, { content: 'hello', cliToolId: 'antigravity', instanceId: FIXTURE.instanceOf.antigravity, ...agentOrigin });
    expect({ status: result.status, code: result.payload.code }).toEqual({ status: 409, code: 'TOOL_POLICY_DENIED' });
    expect(summarizeChanges(result.changes)).toEqual([]);
  });

  it('4466 (iii) control — POST /api/relays between a claude and a codex end: 201, one relay row', async () => {
    const result = await post('/api/relays', {
      from: { worktreeId: WT, instanceId: FIXTURE.replyTo },
      to: { worktreeId: WT, instanceId: FIXTURE.instanceOf.codex },
    });
    expect(result.status).toBe(201);
    expect(result.changes.map(({ part }) => part)).toContain('session_relays');
  });

  it('4466 (iii) control — POST /auto-yes on codex: 200, a grant', async () => {
    const result = await post(`/api/worktrees/${WT}/auto-yes`, { enabled: true, cliToolId: 'codex', instanceId: FIXTURE.instanceOf.codex, ...agentOrigin });
    expect(result.status).toBe(200);
    expect(result.changes.map(({ part }) => part)).toContain('grants');
  });
});

describe('#4466 (iii) today\'s CLI: refused at the first write, nothing left (what #4449 / #4496 already hold)', () => {
  const refusedAtFirstWrite: Array<[string, CliOrigin, string[], 'TOOL_POLICY_DENIED' | 'RELAY_TOOL_POLICY_DENIED']> = [
    ['send to antigravity', 'agent', ['hello', '--instance', FIXTURE.instanceOf.antigravity], 'TOOL_POLICY_DENIED'],
    ['--contract to antigravity', 'agent', ['--contract', FIXTURE.contractPath, '--instance', FIXTURE.instanceOf.antigravity], 'TOOL_POLICY_DENIED'],
    ['--contract to antigravity', 'schedule', ['--contract', FIXTURE.contractPath, '--instance', FIXTURE.instanceOf.antigravity], 'TOOL_POLICY_DENIED'],
    ['--contract to antigravity', 'unknown', ['--contract', FIXTURE.contractPath, '--instance', FIXTURE.instanceOf.antigravity], 'TOOL_POLICY_DENIED'],
    ['--contract to antigravity', 'session', ['--contract', FIXTURE.contractPath, '--instance', FIXTURE.instanceOf.antigravity], 'TOOL_POLICY_DENIED'],
    ['--register --role of antigravity', 'agent', ['hello', '--agent', 'antigravity', '--instance', FIXTURE.adHoc, '--register', '--role', FIXTURE.roleName], 'TOOL_POLICY_DENIED'],
    ['--role on antigravity', 'agent', ['hello', '--instance', FIXTURE.instanceOf.antigravity, '--role', FIXTURE.roleName], 'TOOL_POLICY_DENIED'],
    ['--contract --role on antigravity', 'agent', ['--contract', FIXTURE.contractPath, '--instance', FIXTURE.instanceOf.antigravity, '--role', FIXTURE.roleName], 'TOOL_POLICY_DENIED'],
    ['--auto-yes on antigravity', 'terminal', ['hello', '--instance', FIXTURE.instanceOf.antigravity, '--auto-yes'], 'TOOL_POLICY_DENIED'],
    // K2's shape where the first write is the roster or the task: #4449 judges the grant there too (`writePolicyFields`).
    ['--register --role --model --auto-yes of antigravity (K2 at the roster write)', 'terminal', ['hello', '--agent', 'antigravity', '--instance', FIXTURE.adHoc, '--register', '--role', FIXTURE.roleName, '--model', FIXTURE.antigravityModel, '--auto-yes'], 'TOOL_POLICY_DENIED'],
    ['--contract --model --auto-yes to antigravity (K2 at the task write)', 'terminal', ['--contract', FIXTURE.contractPath, '--instance', FIXTURE.instanceOf.antigravity, '--model', FIXTURE.antigravityModel, '--auto-yes'], 'TOOL_POLICY_DENIED'],
    // C11b / C11a of the design (v0.53.0): #4496 judges `to` by the tool `--agent` names, so every origin is refused.
    ...(['terminal', 'session', 'agent', 'schedule', 'unknown'] as const).map((origin): [string, CliOrigin, string[], 'RELAY_TOOL_POLICY_DENIED'] => [
      `an ad-hoc --agent antigravity --reply-to (C11${origin === 'terminal' ? 'b' : 'a'})`, origin, ['hello', '--agent', 'antigravity', '--instance', FIXTURE.adHoc, '--reply-to', reviewEnd], 'RELAY_TOOL_POLICY_DENIED',
    ]),
    ['an ad-hoc --agent antigravity --register --reply-to (C11b)', 'terminal', ['hello', '--agent', 'antigravity', '--instance', FIXTURE.adHoc, '--register', '--reply-to', reviewEnd], 'RELAY_TOOL_POLICY_DENIED'],
    ['--contract --reply-to an antigravity end', 'terminal', ['--contract', FIXTURE.contractPath, '--instance', FIXTURE.instanceOf.codex, '--reply-to', agyEnd], 'RELAY_TOOL_POLICY_DENIED'],
    ['--auto-yes --reply-to an antigravity end', 'session', ['hello', '--instance', FIXTURE.instanceOf.codex, '--auto-yes', '--reply-to', agyEnd], 'RELAY_TOOL_POLICY_DENIED'],
  ];

  it.each(refusedAtFirstWrite)('4466 (iii) %s from %s: exit 33, the reason first, stdout empty, nothing left', async (_label, origin, args, code) => {
    asOrigin(origin);
    const result = await sendCli(...args);
    expect(cliRefusalBroken(result, EXIT.policy, policyLine(code))).toEqual([]);
  });
});

describe('#4466 (iii) negative control: today\'s CLI writes an allowed operation as before', () => {
  const allowed: Array<[string, string[], string[]]> = [
    ['send', ['hello', '--instance', FIXTURE.instanceOf.codex], ['typed']],
    ['--contract', ['--contract', FIXTURE.contractPath, '--instance', FIXTURE.instanceOf.codex], ['tasks', 'typed']],
    ['--register', ['hello', '--agent', 'codex', '--instance', FIXTURE.adHoc, '--register'], ['agent_instances', 'typed']],
    ['--register --role', ['hello', '--agent', 'codex', '--instance', FIXTURE.adHoc, '--register', '--role', FIXTURE.roleName], ['agent_instances', 'agent_instance_roles', 'typed']],
    ['--role', ['hello', '--instance', FIXTURE.instanceOf.codex, '--role', FIXTURE.roleName], ['agent_instance_roles', 'typed']],
    ['--no-role', ['hello', '--instance', FIXTURE.instanceOf.codex, '--no-role'], ['agent_instance_roles', 'typed']],
    ['--contract --role', ['--contract', FIXTURE.contractPath, '--instance', FIXTURE.instanceOf.codex, '--role', FIXTURE.roleName], ['tasks', 'agent_instance_roles', 'typed']],
    ['--contract --auto-yes --reply-to', ['--contract', FIXTURE.contractPath, '--instance', FIXTURE.instanceOf.codex, '--auto-yes', '--reply-to', reviewEnd], ['tasks', 'session_relays', 'grants', 'typed']],
  ];

  it.each(allowed)('4466 (iii) control — %s to codex from a terminal: exit 0, written and typed once into cx', async (_label, args, parts) => {
    asOrigin('terminal');
    const result = await sendCli(...args);
    expect({ code: result.code, errors: result.stderr.filter((line) => line.startsWith('Error')) }).toEqual({ code: 0, errors: [] });
    const changed = result.changes.map(({ part }) => part);
    for (const part of parts) expect(changed).toContain(part);
    const typed = result.changes.find(({ part }) => part === 'typed')?.added ?? [];
    expect(typed).toHaveLength(1);
    expect(typed[0]).toMatch(new RegExp(`^codex:${args.includes(FIXTURE.adHoc) ? FIXTURE.adHoc : FIXTURE.instanceOf.codex}:`));
  });
});

describe('#4466 the shared worktree', () => {
  it('4466 no row wrote into the worktree (it is shared by every row)', () => {
    expect(listFiles(worktreePath)).toEqual(worktreeFilesAtStart);
  });
});
