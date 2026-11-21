/**
 * Issue #4466 PR0: the table of one send operation — the vessel of
 * `docs/design/send-atomic-4466.md` §6.1 (rows generated from its axes) and §4.3 (the
 * hooks), before any of the fix exists. Tests only; nothing in `src/` changes.
 *
 * Three kinds of rows, all observed the same way (§6.1: the content of the tables an
 * operation writes, and what it does outside the database, before and after):
 *
 *  (i)  The new route `POST /api/worktrees/:id/send-operation` (§4.1). It does not exist
 *       yet, so every row is `it.fails` — marked `// #4466 PR1b`, the PR that adds the
 *       route removes the mark. The rows come from `sendOperationRows()`
 *       (`tests/helpers/send-operation-table-4466/table.ts`, where the axes, the folding of
 *       the declaration axis and its reason are written).
 *  (ii) The CLI, through today's separate requests, on the shapes of the known limits K1
 *       and K2 of 0.53.0 (§1). Each expects the design's outcome (exit 33, the reason first
 *       on stderr, stdout empty, nothing left, nothing typed); today they are red, so they
 *       are `it.fails` — marked `// #4466 PR2`, the PR that moves `send` onto the new route
 *       removes the mark. That they are red today is the positive control of this PR.
 *  (iii) Today's routes (`/send`, `/tasks`, `/instances/roles`, `/api/relays`, `/auto-yes`)
 *       and today's CLI on what already holds: a refusal at the first write leaves nothing;
 *       an allowed operation writes as before (the negative control). Ordinary tests, green.
 *
 * Everything runs in-process against the real route modules: an in-memory database built
 * once from a migrated template, fake CLI tools (no agy, no `~/.gemini`: the antigravity
 * module is a fake and `PATH` / `HOME` point into the run's directory under os.tmpdir()),
 * no tmux, a recording fake WebSocket. No server listens; `CM_PORT` is a free port taken
 * at run time. The run's directory is removed after each test.
 *
 * @vitest-environment node
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { getAgentInstances, setAgentInstances } from '@/lib/db/agent-instances-db';
import { upsertWorktree } from '@/lib/db';
import { createRepository } from '@/lib/db/db-repository';
import { createAgentRole } from '@/lib/db/agent-roles-db';
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
import type { AgentInstance } from '@/lib/cli-tools/types';
import type { Worktree } from '@/types/models';
import { FIXTURE, FIXTURE_ROSTER, fillerRows } from '../helpers/send-operation-table-4466/fixture';
import {
  BASE_OPS,
  EXIT,
  ORIGINS,
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
  setSendOperationHook,
} from '../helpers/send-operation-table-4466/hooks';
import {
  SEND_OPERATION_ROUTE_FILE,
  SEND_OPERATION_ROUTE_MISSING,
  freePort,
  loadSendOperationRoute,
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
  async sendMessage(_id: string, message: string) {
    noteInputStart();
    record.typed.push(`${tool}:${message.slice(0, 40)}`);
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
  startPolling: vi.fn((worktreeId: string, cliToolId: string) => void record.pollers.push(`response:${worktreeId}/${cliToolId}`)),
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
  startAutoYesPolling: vi.fn((worktreeId: string, cliToolId: string, instanceId?: string) => {
    record.pollers.push(`auto-yes:${worktreeId}/${cliToolId}/${instanceId ?? cliToolId}`);
    return { started: true };
  }),
  stopAutoYesPolling: vi.fn(),
  stopAutoYesPollingByWorktree: vi.fn(),
}));
vi.mock('@/lib/hooks/pending-decision-recheck', () => ({
  recheckPendingDecisions: vi.fn(async () => ({ reason: 'test', examined: 0, delivered: 0, skipped: 0 })),
}));
/** §6.1 「端の解決の失敗」: a roster read that throws for one instance id (the #4496 fault). */
const rosterFault = vi.hoisted(() => ({ instanceId: null as string | null }));
vi.mock('@/lib/db/agent-instances-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/agent-instances-db')>();
  return {
    ...actual,
    getAgentInstance: (...args: Parameters<typeof actual.getAgentInstance>) => {
      if (rosterFault.instanceId !== null && args[2] === rosterFault.instanceId) throw new Error('roster unreadable (injected)');
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
import * as rolesRoute from '@/app/api/roles/route';
import * as roleRoute from '@/app/api/roles/[id]/route';
import * as worktreeRoute from '@/app/api/worktrees/[id]/route';
import * as relaysRoute from '@/app/api/relays/route';
import * as relayCancelRoute from '@/app/api/relays/[relayId]/cancel/route';
import { clearAllAutoYesStates, getAutoYesStateCompositeKeys, peekAutoYesState } from '@/lib/auto-yes-state';
import { resolveEnvSnapshotDir } from '@/lib/verification/env-snapshot';
import { createSendCommand } from '@/cli/commands/send';
import type { CLIToolType } from '@/lib/cli-tools/types';

const WT = FIXTURE.worktreeId;

// ---------------------------------------------------------------------------
// The world: a migrated template, copied for each test
// ---------------------------------------------------------------------------

let template: Buffer;
let roleId: string;
let dir: string;
let worktreePath: string;
let db: Database.Database;
/** Every request the CLI made, `METHOD /path`, and each answer, `METHOD /path status`. */
let requests: string[];
let answered: string[];
/** Runs right after a route answered the CLI (`METHOD /path`): a change between two requests. */
let afterRoute: ((request: string) => void) | null;
let stdinTTY: PropertyDescriptor | undefined;
let port: number;
/** What the test itself changed during an operation (an interrupt's input), taken out of its result. */
let ownChanges: Change[];

/** The repository root the template's rows name; the per-test worktree path is set on each copy. */
const TEMPLATE_ROOT = '/template-root-4466';

beforeAll(async () => {
  port = await freePort();
  const build = new Database(':memory:');
  runMigrations(build);
  upsertWorktree(build, {
    id: WT,
    name: 'wt',
    path: '/template-wt-4466',
    repositoryPath: TEMPLATE_ROOT,
    repositoryName: 'repo',
    cliToolId: 'codex',
  } as Worktree);
  build.prepare('UPDATE worktrees SET selected_agents = ? WHERE id = ?').run(JSON.stringify(['codex', 'antigravity', 'claude']), WT);
  setAgentInstances(build, WT, FIXTURE_ROSTER.map((row) => ({ ...row })) as AgentInstance[]);
  createRepository(build, { name: 'repo', path: TEMPLATE_ROOT, cloneSource: 'local' });
  roleId = createAgentRole(build, { name: FIXTURE.roleName, body: 'REVIEW' }).id;
  template = build.serialize();
  build.close();
});

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-send-operation-4466-')));
  worktreePath = path.join(dir, 'wt');
  fs.mkdirSync(path.join(worktreePath, '.commandmate', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(worktreePath, FIXTURE.contractPath), FIXTURE.contract);
  for (const sub of ['root', 'home', 'bin', 'codex']) fs.mkdirSync(path.join(dir, sub));
  db = new Database(template);
  db.prepare('UPDATE worktrees SET path = ? WHERE id = ?').run(worktreePath, WT);
  const { setMockDb } = (await import('@/lib/db/db-instance')) as unknown as { setMockDb: (value: Database.Database | null) => void };
  setMockDb(db);
  setLaunchRoleDatabaseForTest(db);
  resetSessionLaunchFlightsForTest();
  resetInstanceInputLocks();
  clearAllAutoYesStates();
  clearSendOperationHooks();
  record.running.clear();
  record.typed = [];
  record.launched = [];
  record.broadcasts = [];
  record.pollers = [];
  record.onStart = null;
  rosterFault.instanceId = null;
  requests = [];
  answered = [];
  afterRoute = null;
  ownChanges = [];
  stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  // No real binary on PATH, no real HOME (no agy, no ~/.gemini is ever reachable).
  vi.stubEnv('PATH', path.join(dir, 'bin'));
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
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  const { setMockDb } = (await import('@/lib/db/db-instance')) as unknown as { setMockDb: (value: Database.Database | null) => void };
  setMockDb(null);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  template = Buffer.alloc(0);
});

// ---------------------------------------------------------------------------
// Driving: today's routes for the CLI, the new route for the (i) rows
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
  if (url.pathname === '/api/capabilities') return Response.json({ serverVersion: 'test', capabilities: ['resolve-session-target'] });
  if (url.pathname === `/api/worktrees/${WT}/current-output`) return Response.json({ isRunning: record.running.size > 0 });
  if (url.pathname === `/api/worktrees/${WT}/opencode/session`) return Response.json({ instances: [] });
  if (url.pathname === '/api/worktrees') return Response.json({ worktrees: [{ id: WT }] });
  const route = routed(url.pathname);
  if (!route) throw new Error(`Not stubbed: ${method} ${url.pathname}`);
  const handler = route.handlers[method] as RouteHandler | undefined;
  if (!handler) return Response.json({ error: `no ${method}` }, { status: 405 });
  const response = await handler(new NextRequest(url, init as ConstructorParameters<typeof NextRequest>[1]), {
    params: Promise.resolve(route.params),
  });
  answered.push(`${method} ${url.pathname} ${response.status}`);
  afterRoute?.(`${method} ${url.pathname}`);
  return response;
}

/** A real launch's effect on what is known (the cli-roles-4116 way), without tmux. */
async function launch(tool: string, instanceId: string | undefined): Promise<void> {
  const launchTarget = { worktreeId: WT, cliToolId: tool as CLIToolType, instanceId };
  const snapshot = await resolveLaunchRole(db, { ...launchTarget, worktreePath, readEnv: fixedEnvReader({}) });
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
    const roster = getAgentInstances(db, WT).map((row) => (row.id === instanceId ? { ...row, cliTool: tool } : row));
    setAgentInstances(db, WT, roster as AgentInstance[]);
  });
}

/** The worktree's default tool changed (the h-S2 `default` input). */
function redefault(tool: Tool): void {
  asTestInput(() => void db.prepare('UPDATE worktrees SET cli_tool_id = ? WHERE id = ?').run(tool, WT));
}

/**
 * The env baselines (`resolveEnvSnapshotDir()`, beside the database path). `CM_DB_PATH` is
 * left as it is: the env reader refuses a path under os.tmpdir() (a system directory), and
 * the contract of the fixture runs no env-clean gate, so no row writes one; the directory
 * is only read, to show that none appeared.
 */
function envSnapshotFiles(): string[] {
  try {
    const where = resolveEnvSnapshotDir();
    return fs.existsSync(where) ? fs.readdirSync(where) : [];
  } catch (error) {
    // A path the env reader refuses is still an observation, never a silent "nothing".
    return [`<unreadable: ${error instanceof Error ? error.message : String(error)}>`];
  }
}

function outside() {
  const grants = getAutoYesStateCompositeKeys().filter((key) => {
    const [worktreeId, cliToolId, instanceId] = key.split(':');
    return peekAutoYesState(worktreeId, cliToolId as CLIToolType, instanceId)?.enabled === true;
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

const snapshot = (): OperationSnapshot => takeSnapshot(db, outside);

/**
 * mem on for the fixture's branch (the allowed `--note` rows). The worktree is not a git
 * repository, so mem resolves no branch; PR1b chooses the seam (e.g. its mem target) and
 * fills this in. Called only after the route loaded, so PR0's (i) rows fail on the route.
 */
function arrangeMemOn(): void {
  throw new Error('#4466 PR1b: arrange mem on for the fixture branch');
}

/** Put the world in the row's state and register its hook (§6.1 「割り込み」). */
function arrangeRow(row: TableRow, options: { mem: boolean } = { mem: true }): void {
  if (row.worktreeDefault !== 'codex') db.prepare('UPDATE worktrees SET cli_tool_id = ? WHERE id = ?').run(row.worktreeDefault, WT);
  if (row.rosterFull) {
    setAgentInstances(db, WT, [...getAgentInstances(db, WT), ...fillerRows(MAX_AGENT_INSTANCES)] as AgentInstance[]);
  }
  vi.stubEnv('CM_ANTIGRAVITY_USAGE', row.declaration === 'api-key' ? 'api-key' : '');
  rosterFault.instanceId = row.rosterFault ?? null;
  if (options.mem && row.memOn && row.modifiers.includes('note')) arrangeMemOn();
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
    case 'h-S3':
      setSendOperationHook('h-S3', () => retool(FIXTURE.instanceOf.codex, 'antigravity'));
      break;
    case 'h-S3b':
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
  changes: Change[];
}

/** One (i) row: load the route (missing until PR1b), arrange, POST, observe. */
async function driveSendOperation(row: TableRow): Promise<RouteResult> {
  const route = await loadSendOperationRoute();
  arrangeRow(row);
  const before = snapshot();
  let status = 0;
  let payload: Record<string, unknown> = {};
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
  }
  return { status, payload, changes: withoutOwnChanges(diffSnapshots(before, snapshot()), ownChanges) };
}

/** What a row's result breaks; empty when it is what the design expects. */
function routeRowBroken(row: TableRow, result: RouteResult): string[] {
  const expected = row.expected;
  const changed = summarizeChanges(result.changes);
  if (expected.kind === 'stopped') return changed.length === 0 ? [] : [`S1 wrote: ${changed.join(', ')}`];
  if (expected.kind === 'refused') {
    const code = typeof result.payload.code === 'string' ? result.payload.code : null;
    const stage = (result.payload.policy as { stage?: unknown } | undefined)?.stage;
    return [
      ...(expected.status === 'non-2xx' ? (result.status >= 300 ? [] : [`status ${result.status}`]) : result.status === expected.status ? [] : [`status ${result.status}`]),
      ...(expected.codes === null || (code !== null && expected.codes.includes(code)) ? [] : [`code ${code}`]),
      ...(expected.policyStage === undefined || stage === expected.policyStage ? [] : [`policy.stage ${String(stage)}`]),
      ...(changed.length === 0 ? [] : [`left: ${changed.join(', ')}`]),
    ];
  }
  const parts = new Set(result.changes.map(({ part }) => part));
  const typed = result.changes.find(({ part }) => part === 'typed')?.added ?? [];
  const writes = expected.writes;
  return [
    ...(result.status >= 200 && result.status < 300 ? [] : [`status ${result.status}`]),
    ...(result.payload.ok === true ? [] : ['ok is not true']),
    ...(writes.task && !parts.has('tasks') ? ['no task row'] : []),
    ...(!writes.task && parts.has('tasks') ? ['a task row'] : []),
    ...(writes.rosterRow !== null && !getAgentInstances(db, WT).some(({ id }) => id === writes.rosterRow) ? [`${writes.rosterRow} not on the roster`] : []),
    ...(writes.roleOf !== null && !parts.has('agent_instance_roles') ? [`no role setting for ${writes.roleOf}`] : []),
    ...(writes.relay && !parts.has('session_relays') ? ['no relay row'] : []),
    ...(writes.note && !parts.has('mem_items') ? ['no note item'] : []),
    ...(writes.grant && !parts.has('grants') ? ['no grant'] : []),
    ...(!writes.grant && parts.has('grants') ? ['a grant'] : []),
    ...(typed.length === 1 && typed[0].startsWith(`${expected.typedTool}:`) ? [] : [`typed ${JSON.stringify(typed)}`]),
  ];
}

/** The CLI's origin inputs (`src/cli/utils/send-origin.ts`), the repro-4449 way. */
function asOrigin(origin: Exclude<(typeof ORIGINS)[number], 'legacy'>): void {
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

/** I1 through the CLI (§2, §5.1 C2): exit 33, the reason first, stdout empty, nothing left, nothing typed. */
function cliRefusalBroken(result: CliRowResult, code: 'TOOL_POLICY_DENIED' | 'RELAY_TOOL_POLICY_DENIED'): string[] {
  const changed = summarizeChanges(result.changes);
  return [
    ...(result.code === EXIT.policy ? [] : [`exit ${result.code}`]),
    ...(new RegExp(`^Error \\[${code}\\]: `).test(result.stderr[0] ?? '') ? [] : [`stderr[0] ${result.stderr[0]}`]),
    ...(result.stdout.length === 0 ? [] : [`stdout ${JSON.stringify(result.stdout)}`]),
    ...(changed.length === 0 ? [] : [`left: ${changed.join(', ')}`]),
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
      'target-policy': 392,
      'relay-rule0': 168,
      'auto-yes-policy': 98,
      'relay-non-policy': 28,
      roster: 28,
      mem: 14,
      none: 588,
      declared: 7,
      interrupt: 10,
      's1-writes-nothing': 7,
      mismatch: 14,
      'endpoint-unresolved': 1,
    });
    expect(ROUTE_ROWS).toHaveLength(1355);
    expect(new Set(ROUTE_ROWS.map(({ name }) => name)).size).toBe(ROUTE_ROWS.length);
  });

  it('4466 every row has a verdict, and every refusal leaves nothing by construction of the check', () => {
    const verdicts = ROUTE_ROWS.reduce<Record<string, number>>((count, row) => ({ ...count, [row.expected.kind]: (count[row.expected.kind] ?? 0) + 1 }), {});
    expect(verdicts.refused + verdicts.allowed + verdicts.stopped).toBe(ROUTE_ROWS.length);
    // Every base operation and every origin is in the allowed rows (the negative control) and in a refused row.
    for (const base of BASE_OPS) {
      expect(ROUTE_ROWS.some((row) => row.base === base && row.expected.kind === 'allowed')).toBe(true);
      expect(ROUTE_ROWS.some((row) => row.base === base && row.expected.kind === 'refused')).toBe(true);
    }
    for (const origin of ORIGINS) {
      expect(ROUTE_ROWS.some((row) => row.origin === origin && row.expected.kind === 'allowed')).toBe(true);
      expect(ROUTE_ROWS.some((row) => row.origin === origin && row.expected.kind === 'refused')).toBe(true);
    }
    // N1 / I2a: the ad-hoc antigravity send with --reply-to is refused from every origin, the terminal included (C11b, H6).
    const mismatch = ROUTE_ROWS.filter((row) => row.family === 'mismatch' && row.targetTool === 'antigravity');
    expect(mismatch.map((row) => row.expected.kind)).toEqual(mismatch.map(() => 'refused'));
    expect(mismatch.filter((row) => row.origin === 'terminal')).toHaveLength(2);
  });

  it('4466 every body has a message or a contract, never both (§4.1, N3)', () => {
    for (const row of ROUTE_ROWS) {
      const body = sendOperationBody(row, roleId);
      expect(('message' in body) !== ('contract' in body)).toBe(true);
    }
  });

  it('4466 the observed tables all exist (a renamed table must not read as "nothing changed")', () => {
    const tables = takeSnapshot(db, outside).tables;
    for (const table of OBSERVED_TABLES) expect(tables[table]).not.toContain('<missing table>');
    expect(envSnapshotFiles()).toEqual([]);
  });

  it('4466 each kind of row can be arranged on a fresh world without the route (the vessel works now)', () => {
    const seen = new Set<string>();
    for (const row of ROUTE_ROWS) {
      const kind = `${row.family}/${row.interrupt.kind}/${row.rosterFull}/${row.worktreeDefault}`;
      if (seen.has(kind)) continue;
      seen.add(kind);
      expect(() => arrangeRow(row, { mem: false })).not.toThrow();
      clearSendOperationHooks();
    }
    expect(seen.size).toBeGreaterThanOrEqual(12);
    expect(getAgentInstances(db, WT).length).toBeLessThanOrEqual(MAX_AGENT_INSTANCES);
  });

  it('4466 the hook points are the four of §4.3 (h-S1 for "S1 writes nothing", h-S2, h-S3, h-S3b)', () => {
    expect([...SEND_OPERATION_HOOK_POINTS]).toEqual(['h-S1', 'h-S2', 'h-S3', 'h-S3b']);
  });

  it('4466 the new route is not there yet (the reason the (i) rows are it.fails)', async () => {
    expect(fs.existsSync(SEND_OPERATION_ROUTE_FILE)).toBe(false);
    await expect(loadSendOperationRoute()).rejects.toThrow(SEND_OPERATION_ROUTE_MISSING);
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
// (ii) the CLI through today's separate requests: K1 and K2 — it.fails until PR2
// ---------------------------------------------------------------------------

describe('#4466 (ii) the CLI on the shapes of K1 and K2: refused with nothing left', () => {
  /** K1: the reply-to end turns antigravity between the task (stage 2) and a later stage. */
  const turnReplyToAfterTask = (): void => {
    afterRoute = (request) => {
      if (request === `POST /api/worktrees/${WT}/tasks`) retool(FIXTURE.replyTo, 'antigravity');
    };
  };

  // #4466 PR2: `send` goes through the new route; remove `.fails` with it.
  it.fails('4466 (ii) K1 stage 4: --contract --auto-yes --reply-to, the reply-to end turns antigravity after the task: exit 33, no task', async () => {
    turnReplyToAfterTask();
    const result = await sendCli('--contract', FIXTURE.contractPath, '--instance', FIXTURE.instanceOf.codex, '--auto-yes', '--reply-to', reviewEnd);
    expect(cliRefusalBroken(result, 'RELAY_TOOL_POLICY_DENIED')).toEqual([]);
  });

  // #4466 PR2: `send` goes through the new route; remove `.fails` with it.
  it.fails('4466 (ii) K1 stage 5: --contract --reply-to, the reply-to end turns antigravity after the task: exit 33, no task', async () => {
    turnReplyToAfterTask();
    const result = await sendCli('--contract', FIXTURE.contractPath, '--instance', FIXTURE.instanceOf.codex, '--reply-to', reviewEnd);
    expect(cliRefusalBroken(result, 'RELAY_TOOL_POLICY_DENIED')).toEqual([]);
  });

  // #4466 PR2: `send` goes through the new route; remove `.fails` with it.
  it.fails('4466 (ii) K1 stage 3: --contract --role --reply-to, the reply-to end turns antigravity after the task: exit 33, no task, no role', async () => {
    turnReplyToAfterTask();
    const result = await sendCli('--contract', FIXTURE.contractPath, '--instance', FIXTURE.instanceOf.codex, '--role', FIXTURE.roleName, '--reply-to', reviewEnd);
    expect(cliRefusalBroken(result, 'RELAY_TOOL_POLICY_DENIED')).toEqual([]);
  });

  // #4466 PR2: `send` goes through the new route; remove `.fails` with it.
  it.fails('4466 (ii) K2: a person\'s --model --auto-yes to antigravity: exit 33, nothing typed, no grant', async () => {
    asOrigin('terminal');
    const result = await sendCli('hello', '--instance', FIXTURE.instanceOf.antigravity, '--model', FIXTURE.antigravityModel, '--auto-yes');
    expect(cliRefusalBroken(result, 'TOOL_POLICY_DENIED')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (iii) today's routes and CLI on what already holds — green
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

describe('#4466 (iii) today\'s routes: a policy refusal leaves nothing', () => {
  const agentOrigin = { origin: 'agent', originEvidence: 'test:send-operation-table-4466' };

  it('4466 (iii) POST /tasks for antigravity from an agent: 409 TOOL_POLICY_DENIED, nothing left', async () => {
    const result = await post(`/api/worktrees/${WT}/tasks`, { contractPath: FIXTURE.contractPath, cliToolId: 'antigravity', instanceId: FIXTURE.instanceOf.antigravity, ...agentOrigin });
    expect({ status: result.status, code: result.payload.code }).toEqual({ status: 409, code: 'TOOL_POLICY_DENIED' });
    expect(summarizeChanges(result.changes)).toEqual([]);
  });

  it('4466 (iii) POST /instances/roles registering antigravity from an agent: 409 TOOL_POLICY_DENIED, nothing left', async () => {
    const result = await post(`/api/worktrees/${WT}/instances/roles`, {
      instance: { id: FIXTURE.adHoc, cliTool: 'antigravity', alias: 'Agy new' }, role: { state: 'role', roleId }, ...agentOrigin,
    });
    expect(result.status).toBe(409);
    expect(result.payload.code).toBe('TOOL_POLICY_DENIED');
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

  it('4466 (iii) control — POST /api/relays between two claude/codex ends: 201, one relay row', async () => {
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

describe('#4466 (iii) today\'s CLI: refused at the first write, nothing left (what #4449 already holds)', () => {
  const refusedAtFirstWrite: Array<[string, Exclude<(typeof ORIGINS)[number], 'legacy'>, string[], 'TOOL_POLICY_DENIED' | 'RELAY_TOOL_POLICY_DENIED']> = [
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
    // C11b of the design (v0.53.0): #4496 already judges `to` by the tool `--agent` names, so a person is refused too.
    ['an ad-hoc --agent antigravity --reply-to (C11b)', 'terminal', ['hello', '--agent', 'antigravity', '--instance', FIXTURE.adHoc, '--reply-to', reviewEnd], 'RELAY_TOOL_POLICY_DENIED'],
    ['an ad-hoc --agent antigravity --register --reply-to (C11b)', 'terminal', ['hello', '--agent', 'antigravity', '--instance', FIXTURE.adHoc, '--register', '--reply-to', reviewEnd], 'RELAY_TOOL_POLICY_DENIED'],
    ['--contract --reply-to an antigravity end', 'terminal', ['--contract', FIXTURE.contractPath, '--instance', FIXTURE.instanceOf.codex, '--reply-to', agyEnd], 'RELAY_TOOL_POLICY_DENIED'],
    ['--auto-yes --reply-to an antigravity end', 'session', ['hello', '--instance', FIXTURE.instanceOf.codex, '--auto-yes', '--reply-to', agyEnd], 'RELAY_TOOL_POLICY_DENIED'],
  ];

  it.each(refusedAtFirstWrite)('4466 (iii) %s from %s: exit 33, the reason first, stdout empty, nothing left', async (_label, origin, args, code) => {
    asOrigin(origin);
    const result = await sendCli(...args);
    expect(cliRefusalBroken(result, code)).toEqual([]);
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

  it.each(allowed)('4466 (iii) control — %s to codex from a terminal: exit 0, written and typed once', async (_label, args, parts) => {
    asOrigin('terminal');
    const result = await sendCli(...args);
    expect({ code: result.code, errors: result.stderr.filter((line) => line.startsWith('Error')) }).toEqual({ code: 0, errors: [] });
    const changed = result.changes.map(({ part }) => part);
    for (const part of parts) expect(changed).toContain(part);
    expect(result.changes.find(({ part }) => part === 'typed')?.added).toHaveLength(1);
  });
});
