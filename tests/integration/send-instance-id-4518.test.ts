/**
 * Issue #4518 段 1 (design `docs/design/send-instance-id-4518.md` v3): the invariants of
 * `send --instance-id <id>`, written red-first against the real routes.
 *
 * Two kinds of test live here:
 *  - plain `it`: what today's `send --instance` does with the same steps — it types into
 *    another target, or a state machine the design must keep. These are GREEN now and
 *    pin the defect / the current machine (they are not changed by stage 2).
 *  - `it.fails` marked `// #4518 stage2`: what `--instance-id` must do. RED now (the flag
 *    does not exist), un-`fails`ed by the stage 2 implementation.
 *
 * Harness (the #4496 one): the CLI's `fetch` is routed to the real route handlers with an
 * in-memory database. No tmux, no server, no real agy: every tool module is a fake that
 * records what reached its terminal, and a fake `agy` on a private PATH records any call
 * (none is expected). HOME and every data directory are under one os.tmpdir() directory,
 * removed in afterEach.
 *
 * Routes not in {@link routed} throw "Not stubbed" — stage 2 adds the ones it uses.
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
import { upsertWorktree } from '@/lib/db';
import { createRepository } from '@/lib/db/db-repository';
import { resetSessionLaunchFlightsForTest } from '@/lib/session/session-launch-flight';
import { resetLaunchRoleStateForTest, setLaunchRoleDatabaseForTest } from '@/lib/session/role-launch';
import { noteInputStart, resetInstanceInputLocks } from '@/lib/session/instance-input-lock';
import type { Worktree } from '@/types/models';

/** What reached each fake terminal, in order: `clear:` (composer clear), `model:` (copilot /model), `type:` (the body). */
const fakeTool = vi.hoisted(() => ({
  running: new Set<string>(),
  terminal: [] as string[],
  /** Runs inside the send, before anything reaches the terminal (before the composer clear). */
  beforeFirstKey: null as null | (() => void),
  /** Runs inside the session start, before the session is up. */
  onStart: null as null | ((tool: string, instanceId: string | undefined) => void),
}));

vi.mock('@/lib/cli-tools/claude', () => fakeToolModule('ClaudeTool', 'claude', 'Claude Code'));
vi.mock('@/lib/cli-tools/codex', () => fakeToolModule('CodexTool', 'codex', 'Codex CLI'));
vi.mock('@/lib/cli-tools/antigravity', () => fakeToolModule('AntigravityTool', 'antigravity', 'Antigravity'));
vi.mock('@/lib/cli-tools/copilot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/copilot')>()),
  ...fakeToolModule('CopilotTool', 'copilot', 'GitHub Copilot'),
}));

/**
 * A fake tool module. `sendMessage` keeps the real sender's order
 * (`submit-verified-sender.ts`: the composer clear, then `noteInputStart` — where the
 * required `beforeInput` boundary runs — then the body's keys).
 */
function fakeToolModule(className: string, id: string, name: string): Record<string, unknown> {
  const session = (worktreeId: string, instanceId?: string): string => `mcbd-${id}-${worktreeId}-${instanceId ?? id}`;
  class FakeTool {
    id = id;
    name = name;
    command = id === 'antigravity' ? 'agy' : id;
    async isInstalled() { return true; }
    async isRunning(worktreeId: string, instanceId?: string) { return fakeTool.running.has(session(worktreeId, instanceId)); }
    async startSession(worktreeId: string, _worktreePath: string, instanceId?: string) {
      fakeTool.onStart?.(id, instanceId);
      fakeTool.running.add(session(worktreeId, instanceId));
    }
    async sendMessage(worktreeId: string, message: string, instanceId?: string) {
      fakeTool.beforeFirstKey?.();
      fakeTool.terminal.push(`clear:${id}:${instanceId ?? id}`);
      noteInputStart();
      fakeTool.terminal.push(`type:${id}:${instanceId ?? id}:${message}`);
    }
    async sendModelCommand(_worktreeId: string, model: string, instanceId?: string) {
      fakeTool.terminal.push(`model:${id}:${instanceId ?? id}:${model}`);
    }
    async killSession(worktreeId: string, instanceId?: string) { fakeTool.running.delete(session(worktreeId, instanceId)); }
    getSessionName(worktreeId: string, instanceId?: string) { return session(worktreeId, instanceId); }
  }
  return { [className]: FakeTool };
}

const ownership = vi.hoisted(() => ({ verdict: 'absent' as 'absent' | 'foreign' }));
vi.mock('@/lib/cli-tools/session-ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/session-ownership')>()),
  checkSessionOwnership: vi.fn(async () =>
    ownership.verdict === 'foreign' ? { verdict: 'foreign', sessionPath: '/elsewhere' } : { verdict: 'absent' }),
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
import * as relaysRoute from '@/app/api/relays/route';
import * as relayRoute from '@/app/api/relays/[relayId]/route';
import * as relayCancelRoute from '@/app/api/relays/[relayId]/cancel/route';
import * as capabilitiesRoute from '@/app/api/capabilities/route';
import { validateSendRequest } from '@/app/api/worktrees/[id]/send/send-request';
import { createSendCommand } from '@/cli/commands/send';
import { getAgentInstance, setAgentInstances } from '@/lib/db/agent-instances-db';
import type { AgentInstance } from '@/lib/cli-tools/types';
import { recordWorktreeAlias } from '@/lib/db/worktree-alias-db';
import { decideRelay } from '@/lib/mem/condition-evaluators';
import { getRelayById } from '@/lib/db/relay-db';
import { resetRelayDeliveryState } from '@/lib/relay/relay-delivery';

const WT = 'wt-4518';
const OLD_WT = 'wt-4518-old';
const BODY = 'review the parser';

let dir: string;
let worktreePath: string;
let agyCalls: string;
let db: Database.Database;
/** Every request the CLI made, `METHOD /path`. */
let requests: string[];
/** Every answer a real route gave, `METHOD /path status`. */
let answered: string[];
let stdinTTY: PropertyDescriptor | undefined;

/** Fault and timing hooks of the routed `fetch`. */
const net: {
  /** Runs before a POST reaches its route (the roster changes between the CLI's read and its write). */
  beforePost: null | ((pathname: string) => void);
  /** The route ran, and the answer is lost on the way back: a non-JSON 200 (N2). */
  corruptAnswerOf: RegExp | null;
  /** `GET /api/relays/:id` cannot be answered either (the bound outcome stays unknown). */
  relayReadFails: boolean;
  /** Answer as a server at 192f9dca1 (before #4518) would; `swap` turns it on after the capability read. */
  pre4518: 'off' | 'on' | 'swap';
} = { beforePost: null, corruptAnswerOf: null, relayReadFails: false, pre4518: 'off' };

type RouteHandler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

function routed(pathname: string): { handlers: Record<string, unknown>; params: Record<string, string> } | null {
  if (pathname === '/api/relays') return { handlers: relaysRoute, params: {} };
  const cancel = pathname.match(/^\/api\/relays\/([^/]+)\/cancel$/);
  if (cancel) return { handlers: relayCancelRoute, params: { relayId: cancel[1] } };
  const one = pathname.match(/^\/api\/relays\/([^/]+)$/);
  if (one) return { handlers: relayRoute, params: { relayId: one[1] } };
  const routes: Array<[RegExp, Record<string, unknown>]> = [
    [/^\/api\/worktrees\/([^/]+)\/send$/, sendRoute],
    [/^\/api\/worktrees\/([^/]+)\/resolve-target$/, resolveTargetRoute],
  ];
  for (const [pattern, handlers] of routes) {
    const match = pathname.match(pattern);
    if (match) return { handlers, params: { id: match[1] } };
  }
  return null;
}

/**
 * The routes and body keys of a server at 192f9dca1, the base of #4518 (Q2's "older
 * server"). A path outside it is that server's 404; a key outside it is ignored there,
 * so it is dropped before the current handler sees it; a non-string instance id is the
 * 400 the green "pre-#4518 premise" tests below pin on the real handlers.
 */
const PRE_4518_ROUTES = [
  /^\/api\/relays$/, /^\/api\/relays\/[^/]+(?:\/cancel)?$/,
  /^\/api\/worktrees(?:\/[^/]+)?$/, /^\/api\/worktrees\/[^/]+\/(?:send|resolve-target|tasks|instances|current-output|opencode\/session)$/,
];
const PRE_4518_SEND_KEYS = new Set([
  'content', 'cliToolId', 'instanceId', 'imagePath', 'model', 'ignoreStructuredPromptGuard', 'relayId', 'brief',
  'briefDetail', 'briefBoundary', 'ask', 'origin', 'originEvidence', 'taskId', 'role', 'expectedRole', 'newConversation',
]);
const PRE_4518_RELAY_KEYS = new Set(['from', 'to', 'allowRelayChain', 'ttlMs', 'bind']);
const PRE_4518_ENDPOINT_KEYS = new Set(['worktreeId', 'instanceId', 'cliToolId']);
const PRE_4518_SEND_BAD_INSTANCE = 'Invalid instanceId. Must be an alphanumeric/underscore/hyphen identifier.';
const pre4518RelayBadInstance = (label: string): string => `${label}.instanceId must be an alphanumeric/underscore/hyphen identifier`;

function pick(record: unknown, keys: Set<string>): Record<string, unknown> {
  if (record === null || typeof record !== 'object') return {};
  return Object.fromEntries(Object.entries(record as Record<string, unknown>).filter(([key]) => keys.has(key)));
}

/** A pre-#4518 answer, or the body to forward (null: forward as is). */
function asPre4518(method: string, pathname: string, body: unknown): Response | { body: unknown } | null {
  if (!PRE_4518_ROUTES.some((pattern) => pattern.test(pathname))) {
    return new Response('<!DOCTYPE html><html><body>404: This page could not be found.</body></html>', {
      status: 404,
      headers: { 'content-type': 'text/html' },
    });
  }
  if (method !== 'POST') return null;
  if (/\/send$/.test(pathname)) {
    const kept = pick(body, PRE_4518_SEND_KEYS);
    if (kept.instanceId !== undefined && typeof kept.instanceId !== 'string') {
      return Response.json({ error: PRE_4518_SEND_BAD_INSTANCE }, { status: 400 });
    }
    return { body: kept };
  }
  if (pathname === '/api/relays') {
    const kept = pick(body, PRE_4518_RELAY_KEYS);
    for (const label of ['from', 'to'] as const) {
      const end = pick(kept[label], PRE_4518_ENDPOINT_KEYS);
      if (end.instanceId !== undefined && typeof end.instanceId !== 'string') {
        return Response.json({ error: pre4518RelayBadInstance(label) }, { status: 400 });
      }
      if (kept[label] !== undefined) kept[label] = end;
    }
    return { body: kept };
  }
  return null;
}

let postsSeen = 0;

async function dispatch(input: unknown, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  requests.push(`${method} ${url.pathname}`);
  if (url.pathname === '/api/capabilities') {
    const answer = await capabilitiesRoute.GET();
    if (net.pre4518 === 'swap') net.pre4518 = 'on';
    return answer;
  }
  if (url.pathname === `/api/worktrees/${WT}/current-output`) return Response.json({ isRunning: false });
  if (url.pathname === `/api/worktrees/${WT}/opencode/session`) return Response.json({ instances: [] });
  if (url.pathname === '/api/worktrees') return Response.json({ worktrees: [{ id: WT }] });
  if (method === 'GET' && net.relayReadFails && /^\/api\/relays\/[^/]+$/.test(url.pathname)) {
    throw new TypeError('fetch failed');
  }
  let requestInit = init;
  if (net.pre4518 === 'on') {
    const parsed = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    const old = asPre4518(method, url.pathname, parsed);
    if (old instanceof Response) {
      answered.push(`${method} ${url.pathname} ${old.status} (pre-4518)`);
      return old;
    }
    if (old) requestInit = { ...init, body: JSON.stringify(old.body) };
  }
  const route = routed(url.pathname);
  if (!route) throw new Error(`Not stubbed: ${method} ${url.pathname}`);
  const handler = route.handlers[method] as RouteHandler | undefined;
  if (!handler) return Response.json({ error: `no ${method}` }, { status: 405 });
  if (method === 'POST') {
    postsSeen += 1;
    net.beforePost?.(url.pathname);
  }
  const response = await handler(new NextRequest(url, requestInit as ConstructorParameters<typeof NextRequest>[1]), {
    params: Promise.resolve(route.params),
  });
  answered.push(`${method} ${url.pathname} ${response.status}`);
  if (net.corruptAnswerOf?.test(url.pathname)) {
    return new Response('<html><body>502 Bad Gateway</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  }
  return response;
}

class ExitSignal extends Error {}

async function send(worktreeId: string, ...args: string[]): Promise<{ code: number; stderr: string[] }> {
  const err: string[] = [];
  const exits: number[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation((line: unknown) => void err.push(String(line)));
  const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  }) as never);
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code ?? 0);
    throw new ExitSignal(String(code));
  }) as never);
  try {
    await createSendCommand().parseAsync(['node', 'cli', worktreeId, ...args]);
  } catch (signal) {
    if (!(signal instanceof ExitSignal)) throw signal;
  } finally {
    log.mockRestore();
    error.mockRestore();
    stderrWrite.mockRestore();
    exit.mockRestore();
  }
  return { code: exits[0] ?? 0, stderr: err };
}

const relayRows = (): Array<{ id: string; state: string; send_state: string | null }> =>
  db.prepare('SELECT id, state, send_state FROM session_relays').all() as Array<{ id: string; state: string; send_state: string | null }>;
const transcriptRows = (): number => (db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get() as { n: number }).n;
const typed = (): string[] => fakeTool.terminal.filter((line) => line.startsWith('type:'));
const agyWasCalled = (): boolean => fs.existsSync(agyCalls);

const CLAUDE3: AgentInstance = { id: 'claude-3', cliTool: 'claude', alias: 'Reviewer', order: 1 };
const CODEX2: AgentInstance = { id: 'codex-2', cliTool: 'codex', alias: 'Codex 2', order: 2 };
const AGY1: AgentInstance = { id: 'agy-1', cliTool: 'antigravity', alias: '', order: 3 };
const COPILOT2: AgentInstance = { id: 'copilot-2', cliTool: 'copilot', alias: '', order: 4 };

function roster(...instances: AgentInstance[]): void {
  setAgentInstances(db, WT, instances.map((instance, order) => ({ ...instance, order })));
}

/** S8 P2-1: claude-3's row is gone and another row took its name as an alias. */
function realiasClaude3ToCodex2(): void {
  roster({ ...CODEX2, alias: 'claude-3' });
}

/** A person typing in a terminal (send-origin step 7): no session env, no TMUX, stdin a TTY. */
function asTerminal(): void {
  for (const name of ['CM_AGENT_TOOL', 'CM_AGENT_WORKTREE_ID', 'CM_AGENT_INSTANCE_ID']) vi.stubEnv(name, '');
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
}

/** Nothing reached any terminal, the real agy was not run, and no relay is left open. */
function expectNothingReachedATerminal(): void {
  expect(fakeTool.terminal).toEqual([]);
  expect(agyWasCalled()).toBe(false);
  expect(relayRows().filter((row) => row.state === 'pending')).toEqual([]);
}

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-send-instance-id-4518-')));
  worktreePath = path.join(dir, 'wt');
  const root = path.join(dir, 'root');
  const bin = path.join(dir, 'bin');
  agyCalls = path.join(dir, 'agy-calls');
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.mkdirSync(root);
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(dir, 'home'));
  fs.mkdirSync(path.join(dir, 'codex'));
  // A fake agy that only records that it was run. The real one is never on this PATH.
  fs.writeFileSync(path.join(bin, 'agy'), `#!/bin/sh\necho "$@" >> '${agyCalls}'\n`, { mode: 0o755 });
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
  db.prepare('UPDATE worktrees SET selected_agents = ? WHERE id = ?')
    .run(JSON.stringify(['claude', 'codex', 'antigravity', 'copilot']), WT);
  createRepository(db, { name: 'repo', path: root, cloneSource: 'local' });
  setLaunchRoleDatabaseForTest(db);
  resetSessionLaunchFlightsForTest();
  resetInstanceInputLocks();
  resetRelayDeliveryState();
  fakeTool.running = new Set();
  fakeTool.terminal = [];
  fakeTool.beforeFirstKey = null;
  fakeTool.onStart = null;
  ownership.verdict = 'absent';
  net.beforePost = null;
  net.corruptAnswerOf = null;
  net.relayReadFails = false;
  net.pre4518 = 'off';
  postsSeen = 0;
  requests = [];
  answered = [];
  stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
  vi.stubEnv('HOME', path.join(dir, 'home'));
  vi.stubEnv('CM_ANTIGRAVITY_NOTICE_DIR', path.join(dir, 'notice'));
  vi.stubEnv('CM_AGENT_HOOKS_INJECT', '0');
  vi.stubEnv('CM_AGENT_ROLE_ARTIFACTS_DIR', path.join(dir, 'data'));
  vi.stubEnv('CM_AGENT_ROLE_ANTIGRAVITY_AGENTS_DIR', path.join(dir, 'agy-agents'));
  vi.stubEnv('CODEX_HOME', path.join(dir, 'codex'));
  vi.stubEnv('CM_PORT', '4518');
  for (const name of ['TMUX', 'CLAUDECODE', 'CM_RUN_ORIGIN', 'CM_WORKTREE_ID', 'CM_INSTANCE_ID', 'CM_CLI_TOOL']) {
    vi.stubEnv(name, '');
  }
  // The caller is an agent session: the worktree's primary claude (the PM's seat in #4418).
  vi.stubEnv('CM_AGENT_TOOL', 'claude');
  vi.stubEnv('CM_AGENT_WORKTREE_ID', WT);
  vi.stubEnv('CM_AGENT_INSTANCE_ID', 'claude');
  vi.stubEnv('CM_ANTIGRAVITY_USAGE', '');
  vi.stubGlobal('fetch', dispatch);
  roster(CLAUDE3, CODEX2, AGY1, COPILOT2);
});

afterEach(async () => {
  if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
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

// ---------------------------------------------------------------------------
// GREEN: today's `send --instance` with the same steps (the defect, pinned)
// ---------------------------------------------------------------------------

describe('#4518 today: `send --instance` re-resolves, so the judged target and the typed one differ (green, pinned)', () => {
  it('I1 control: with the roster as judged, --instance claude-3 types into claude-3 once', async () => {
    const result = await send(WT, BODY, '--instance', 'claude-3');
    expect(result.code).toBe(0);
    expect(typed()).toEqual([`type:claude:claude-3:${BODY}`]);
  });

  it('I3 / Sprint 6: an old worktree id is followed to the current worktree and typed into, with no word of it', async () => {
    recordWorktreeAlias(db, OLD_WT, WT);
    const result = await send(OLD_WT, BODY, '--instance', 'claude-3');
    expect(result.code).toBe(0);
    expect(typed()).toEqual([`type:claude:claude-3:${BODY}`]);
  });

  it('I1 / Sprint 6・8 P2-1: claude-3 judged, then its row gone and codex-2 aliased claude-3 — --instance claude-3 types into codex-2', async () => {
    realiasClaude3ToCodex2();
    const result = await send(WT, BODY, '--instance', 'claude-3');
    expect(result.code).toBe(0);
    expect(typed()).toEqual([`type:codex:codex-2:${BODY}`]);
  });

  it('I2 / Sprint 8 r2 P2-1・P2-2: the row goes after the CLI read it — /send falls back to the worktree default and types', async () => {
    net.beforePost = () => roster(CODEX2);
    const result = await send(WT, BODY, '--instance', 'claude-3');
    expect(result.code).toBe(0);
    expect(getAgentInstance(db, WT, 'claude-3')).toBeNull();
    expect(typed()).toEqual([`type:claude:claude-3:${BODY}`]);
  });

  it('I2 / codex repro (S8 r2 P2-2): with no row, resolve-target answers worktree-default and the validator takes the id as explicit', async () => {
    const resolveTarget = async (): Promise<unknown> => {
      const response = await resolveTargetRoute.GET(
        new NextRequest(`http://localhost/api/worktrees/${WT}/resolve-target?instance=claude-3`),
        { params: Promise.resolve({ id: WT }) },
      );
      expect(response.status).toBe(200);
      return response.json();
    };
    const target = { instanceId: 'claude-3', cliToolId: 'claude', conflict: null };
    expect(await resolveTarget()).toEqual({ ...target, resolvedBy: 'roster' });
    roster(CODEX2);
    expect(await resolveTarget()).toEqual({ ...target, resolvedBy: 'worktree-default' });
    expect(validateSendRequest(db, WT, { content: BODY, instanceId: 'claude-3' }))
      .toMatchObject({ ok: true, value: { target: { instanceId: 'claude-3', cliToolId: 'claude', resolvedBy: 'worktree-default' } } });
    // The CLI names the tool it read: the same send is then `explicit`, the missing row unseen.
    expect(validateSendRequest(db, WT, { content: BODY, instanceId: 'claude-3', cliToolId: 'claude' }))
      .toMatchObject({ ok: true, value: { target: { instanceId: 'claude-3', cliToolId: 'claude', resolvedBy: 'explicit' } } });
  });

  it('I4 / T5: claude-3 judged as claude, then re-registered as codex — --instance claude-3 types into codex', async () => {
    roster({ ...CLAUDE3, cliTool: 'codex' });
    const result = await send(WT, BODY, '--instance', 'claude-3');
    expect(result.code).toBe(0);
    expect(typed()).toEqual([`type:codex:claude-3:${BODY}`]);
  });

  it('I5: the row goes while the session starts — nothing re-checks it before the first key, the body is typed', async () => {
    fakeTool.onStart = () => roster(CODEX2);
    const result = await send(WT, BODY, '--instance', 'claude-3');
    expect(result.code).toBe(0);
    expect(typed()).toEqual([`type:claude:claude-3:${BODY}`]);
  });

  it('A2: copilot --model — `/model` goes out before any boundary hook, and the body follows, with the row gone during the start', async () => {
    fakeTool.onStart = () => roster(CLAUDE3);
    const result = await send(WT, BODY, '--instance', 'copilot-2', '--model', 'gpt-5');
    expect(result.code).toBe(0);
    expect(fakeTool.terminal).toEqual([
      'model:copilot:copilot-2:gpt-5',
      'clear:copilot:copilot-2',
      `type:copilot:copilot-2:${BODY}`,
    ]);
  });

  it('A2: a beforeInput refusal (relay reservation lost) comes after the composer clear — the clear reached the terminal, the body did not', async () => {
    fakeTool.beforeFirstKey = () => {
      const [row] = relayRows();
      db.prepare("UPDATE session_relays SET state = 'cancelled' WHERE id = ?").run(row.id);
    };
    const result = await send(WT, BODY, '--instance', 'claude-3', '--reply-to', 'self');
    expect(result.code).not.toBe(0);
    expect(fakeTool.terminal).toEqual(['clear:claude:claude-3']);
    expect(typed()).toEqual([]);
  });

  it('N1 control (unchanged): from an agent session, --instance agy-1 — exit 33, nothing typed, no relay, agy not run', async () => {
    const result = await send(WT, BODY, '--instance', 'agy-1', '--reply-to', 'self');
    expect(result.code).toBe(33);
    expectNothingReachedATerminal();
    expect(relayRows()).toEqual([]);
    expect(requests).not.toContain(`POST /api/worktrees/${WT}/send`);
  });

  it('N1 control (unchanged): from an agent session without a relay, --instance agy-1 — exit 33 from /send, nothing typed', async () => {
    const result = await send(WT, BODY, '--instance', 'agy-1');
    expect(result.code).toBe(33);
    expect(answered).toContain(`POST /api/worktrees/${WT}/send 409`);
    expectNothingReachedATerminal();
  });

  it('N2 control: delivered, then the answer is lost (non-JSON 200) — the relay read says sent, nothing withdrawn, nothing resent', async () => {
    net.corruptAnswerOf = /\/send$/;
    const result = await send(WT, BODY, '--instance', 'claude-3', '--reply-to', 'self');
    expect(result.code).toBe(0);
    expect(typed()).toEqual([`type:claude:claude-3:${BODY}`]);
    expect(relayRows()).toMatchObject([{ state: 'pending', send_state: 'sent' }]);
  });

  it('N2 control: delivered, the answer lost and the relay unreadable — unknown: the relay stays, no "safe to send it again"', async () => {
    net.corruptAnswerOf = /\/send$/;
    net.relayReadFails = true;
    const result = await send(WT, BODY, '--instance', 'claude-3', '--reply-to', 'self');
    expect(result.code).not.toBe(0);
    expect(typed()).toHaveLength(1);
    expect(relayRows()).toMatchObject([{ state: 'pending', send_state: 'sent' }]);
    expect(result.stderr.join('\n')).not.toContain('safe to send it again');
  });
});

describe('#4518 the pre-#4518 server (192f9dca1) refuses a non-string instance id before any side effect (green: Q2 premise)', () => {
  // These pin TODAY's handlers, which are the "older server" of Q2. Stage 2 makes the
  // current handlers new; then these move onto `asPre4518` (the model above), whose 400
  // bodies are the ones pinned here (design §1, choice B).
  it('POST /send with an object instanceId: 400, no attempt recorded, nothing typed, no sendOutcome', async () => {
    const response = await sendRoute.POST(new NextRequest(`http://localhost/api/worktrees/${WT}/send`, {
      method: 'POST',
      body: JSON.stringify({ content: BODY, cliToolId: 'claude', instanceId: { id: 'claude-3', exact: true } }),
    }), { params: Promise.resolve({ id: WT }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: PRE_4518_SEND_BAD_INSTANCE });
    expect(fakeTool.terminal).toEqual([]);
    expect(transcriptRows()).toBe(0);
  });

  it('POST /api/relays with an object to.instanceId: 400, no relay row', async () => {
    const response = await relaysRoute.POST(new NextRequest('http://localhost/api/relays', {
      method: 'POST',
      body: JSON.stringify({ from: { worktreeId: WT, instanceId: 'claude' }, to: { worktreeId: WT, instanceId: { id: 'claude-3', exact: true } }, bind: true }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: pre4518RelayBadInstance('to') });
    expect(relayRows()).toEqual([]);
  });

  it('(control) the same bodies with a string instanceId are accepted: the 400 is the type, not the target', async () => {
    const response = await relaysRoute.POST(new NextRequest('http://localhost/api/relays', {
      method: 'POST',
      body: JSON.stringify({ from: { worktreeId: WT, instanceId: 'claude' }, to: { worktreeId: WT, instanceId: 'claude-3' }, bind: true }),
    }));
    expect(response.status).toBe(201);
  });
});

describe('#4518 A4: where a relay ends and when its waiting closes — the current state machine (green, pinned)', () => {
  async function openRelay(): Promise<string> {
    const opened = await relaysRoute.POST(new NextRequest('http://localhost/api/relays', {
      method: 'POST',
      body: JSON.stringify({ from: { worktreeId: WT, instanceId: 'claude' }, to: { worktreeId: WT, instanceId: 'claude-3' }, bind: true }),
    }));
    expect(opened.status).toBe(201);
    return ((await opened.json()) as { relay: { id: string } }).relay.id;
  }

  async function sendBound(relayId: string, extra: Record<string, unknown> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await sendRoute.POST(new NextRequest(`http://localhost/api/worktrees/${WT}/send`, {
      method: 'POST',
      body: JSON.stringify({ content: BODY, cliToolId: 'claude', instanceId: 'claude-3', relayId, ...extra }),
    }), { params: Promise.resolve({ id: WT }) });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it('refused before creation (relay rule 0, antigravity end): no relay row, no transcript row', async () => {
    const result = await send(WT, BODY, '--instance', 'agy-1', '--reply-to', 'self');
    expect(result.code).toBe(33);
    expect(answered).toContain('POST /api/relays 409');
    expect(relayRows()).toEqual([]);
    expect(transcriptRows()).toBe(0);
  });

  it('refused after the reservation, before any key (foreign session): the server leaves state=pending, send_state=failed — the waiting is not met', async () => {
    const relayId = await openRelay();
    ownership.verdict = 'foreign';
    const sent = await sendBound(relayId);
    expect(sent.status).toBe(409);
    expect(sent.body.sendOutcome).toBe('not_sent');
    expect(relayRows()).toEqual([{ id: relayId, state: 'pending', send_state: 'failed' }]);
    // A CLI that died here leaves it so: `closeWhen: relay:<id>` stays open until expiry.
    expect(decideRelay(getRelayById(db, relayId))).toMatchObject({ result: 'not-met', reason: 'relay-open' });
    expect(fakeTool.terminal).toEqual([]);
  });

  it('the CLI then withdraws it (POST …/cancel): state=cancelled, and the waiting is met with failure', async () => {
    const relayId = await openRelay();
    ownership.verdict = 'foreign';
    await sendBound(relayId);
    const cancelled = await relayCancelRoute.POST(
      new NextRequest(`http://localhost/api/relays/${relayId}/cancel`, { method: 'POST' }),
      { params: Promise.resolve({ relayId }) },
    );
    expect(cancelled.status).toBe(200);
    expect(relayRows()).toEqual([{ id: relayId, state: 'cancelled', send_state: 'failed' }]);
    expect(decideRelay(getRelayById(db, relayId))).toMatchObject({ result: 'met', reason: 'relay-cancelled', outcome: 'failure' });
  });

  it('the CLI path end to end (--instance, foreign session): exit non-zero, the relay withdrawn by the CLI, nothing typed', async () => {
    ownership.verdict = 'foreign';
    const result = await send(WT, BODY, '--instance', 'claude-3', '--reply-to', 'self');
    expect(result.code).not.toBe(0);
    expect(relayRows()).toMatchObject([{ state: 'cancelled', send_state: 'failed' }]);
    expect(fakeTool.terminal).toEqual([]);
  });

  it('withdrawn by the server (tool policy refusal of a bound send): state=cancelled and no withdrawal system line is written', async () => {
    const opened = await relaysRoute.POST(new NextRequest('http://localhost/api/relays', {
      method: 'POST',
      body: JSON.stringify({ from: { worktreeId: WT, instanceId: 'claude' }, to: { worktreeId: WT, instanceId: 'claude-3' }, bind: true }),
    }));
    const { relay } = (await opened.json()) as { relay: { id: string } };
    const rowsBefore = transcriptRows();
    // The roster now says claude-3 is antigravity, and the send comes from an agent session.
    roster({ ...CLAUDE3, cliTool: 'antigravity' });
    const sent = await sendRoute.POST(new NextRequest(`http://localhost/api/worktrees/${WT}/send`, {
      method: 'POST',
      body: JSON.stringify({ content: BODY, instanceId: 'claude-3', relayId: relay.id, origin: 'agent', originEvidence: 'env:CM_AGENT_TOOL' }),
    }), { params: Promise.resolve({ id: WT }) });
    expect(sent.status).toBe(409);
    expect(relayRows()).toEqual([{ id: relay.id, state: 'cancelled', send_state: 'failed' }]);
    expect(transcriptRows()).toBe(rowsBefore);
    expect(fakeTool.terminal).toEqual([]);
    expect(agyWasCalled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RED: what `send --instance-id` must do (stage 2 removes `.fails`)
// ---------------------------------------------------------------------------

describe('#4518 stage 2: `send --instance-id <id>` — exact roster row, no fallback (it.fails until stage 2)', () => {
  // #4518 stage2
  it.fails('I1 positive: the row as judged — exit 0, typed once into claude-3, every write names the exact id', async () => {
    const result = await send(WT, BODY, '--instance-id', 'claude-3', '--reply-to', 'self');
    expect(result.code).toBe(0);
    expect(typed()).toEqual([`type:claude:claude-3:${BODY}`]);
    expect(relayRows()).toMatchObject([{ state: 'pending', send_state: 'sent' }]);
    expect(requests.some((line) => line.endsWith('/resolve-target'))).toBe(false);
  });

  // #4518 stage2
  it.fails('I3 / Sprint 6: an old worktree id — exit 2, nothing typed (the current id is named)', async () => {
    recordWorktreeAlias(db, OLD_WT, WT);
    const result = await send(OLD_WT, BODY, '--instance-id', 'claude-3');
    expect(result.code).toBe(2);
    expect(result.stderr.join('\n')).toContain(WT);
    expectNothingReachedATerminal();
  });

  // #4518 stage2
  it.fails('I1 / Sprint 6・8 P2-1: the row gone, codex-2 aliased claude-3 — exit 2, the alias is not followed, nothing typed', async () => {
    realiasClaude3ToCodex2();
    const result = await send(WT, BODY, '--instance-id', 'claude-3', '--reply-to', 'self');
    expect(result.code).toBe(2);
    expectNothingReachedATerminal();
  });

  // #4518 stage2
  it.fails('I2 / Sprint 8 r2: the row goes after the CLI read it, before its first write — exit 2, nothing typed', async () => {
    net.beforePost = () => roster(CODEX2);
    const result = await send(WT, BODY, '--instance-id', 'claude-3', '--reply-to', 'self');
    expect(result.code).toBe(2);
    expect(postsSeen).toBeGreaterThan(0);
    expectNothingReachedATerminal();
  });

  // #4518 stage2
  it.fails('I2 / A4: the row goes between the relay and the send — exit 2, nothing typed, the relay withdrawn (cancelled, send_state failed or none)', async () => {
    net.beforePost = (pathname) => {
      if (pathname.endsWith('/send')) roster(CODEX2);
    };
    const result = await send(WT, BODY, '--instance-id', 'claude-3', '--reply-to', 'self');
    expect(result.code).toBe(2);
    expect(fakeTool.terminal).toEqual([]);
    const rows = relayRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('cancelled');
    expect([null, 'failed']).toContain(rows[0].send_state);
  });

  // #4518 stage2
  it.fails('I2: no row at all, the worktree default is the same tool — exit 2, nothing typed (no worktree-default fallback)', async () => {
    roster(CODEX2);
    const result = await send(WT, BODY, '--instance-id', 'claude-3');
    expect(result.code).toBe(2);
    expectNothingReachedATerminal();
  });

  // #4518 stage2
  it.fails('I2: a tool-named id with no row (the #868 primary) — exit 2, nothing typed', async () => {
    const result = await send(WT, BODY, '--instance-id', 'claude');
    expect(result.code).toBe(2);
    expectNothingReachedATerminal();
  });

  // #4518 stage2
  it.fails('I4 / T5: judged as claude (--agent claude), re-registered as codex — exit 2, nothing typed', async () => {
    roster({ ...CLAUDE3, cliTool: 'codex' });
    const result = await send(WT, BODY, '--instance-id', 'claude-3', '--agent', 'claude');
    expect(result.code).toBe(2);
    expectNothingReachedATerminal();
  });

  // #4518 stage2
  it.fails('I5: the row goes while the session starts — exit 2, nothing reaches the terminal', async () => {
    fakeTool.onStart = () => roster(CODEX2);
    const result = await send(WT, BODY, '--instance-id', 'claude-3');
    expect(result.code).toBe(2);
    expectNothingReachedATerminal();
  });

  // #4518 stage2
  it.fails('A2: the row goes right before the first terminal change — no composer clear, no body (exit 2)', async () => {
    fakeTool.beforeFirstKey = () => roster(CODEX2);
    const result = await send(WT, BODY, '--instance-id', 'claude-3', '--reply-to', 'self');
    expect(result.code).toBe(2);
    expectNothingReachedATerminal();
  });

  // #4518 stage2
  it.fails('A2: copilot --model, the row re-registered during the start — no `/model`, no clear, no body (exit 2)', async () => {
    fakeTool.onStart = () => roster(CLAUDE3, { ...COPILOT2, cliTool: 'codex' });
    const result = await send(WT, BODY, '--instance-id', 'copilot-2', '--agent', 'copilot', '--model', 'gpt-5');
    expect(result.code).toBe(2);
    expectNothingReachedATerminal();
  });

  // #4518 stage2
  it.fails('I1 (design §2, v2 §3.3 kept): the same (worktree, id, tool) removed and recreated — the same target, sent', async () => {
    net.beforePost = () => {
      roster(CODEX2);
      roster(CODEX2, CLAUDE3);
    };
    const result = await send(WT, BODY, '--instance-id', 'claude-3');
    expect(result.code).toBe(0);
    expect(typed()).toEqual([`type:claude:claude-3:${BODY}`]);
  });

  // #4518 stage2
  it.fails('N1: from an agent session, --instance-id agy-1 (an antigravity row) — exit 33, nothing typed, agy not run', async () => {
    const result = await send(WT, BODY, '--instance-id', 'agy-1');
    expect(result.code).toBe(33);
    expect(result.stderr[0]).toMatch(/^Error \[TOOL_POLICY_DENIED\]: /);
    expectNothingReachedATerminal();
  });

  // #4518 stage2
  it.fails('N1: from an agent session, --instance-id agy-1 --reply-to self — exit 33, no relay row, nothing typed', async () => {
    const result = await send(WT, BODY, '--instance-id', 'agy-1', '--reply-to', 'self');
    expect(result.code).toBe(33);
    expect(result.stderr[0]).toMatch(/^Error \[RELAY_TOOL_POLICY_DENIED\]: /);
    expect(relayRows()).toEqual([]);
    expectNothingReachedATerminal();
  });

  // #4518 stage2
  it.fails('N1: from a terminal, --instance-id agy-1 --reply-to self — the relay rule 0 still refuses (exit 33, no row)', async () => {
    asTerminal();
    const result = await send(WT, BODY, '--instance-id', 'agy-1', '--reply-to', `${WT}@claude`);
    expect(result.code).toBe(33);
    expect(relayRows()).toEqual([]);
    expectNothingReachedATerminal();
  });

  // #4518 stage2
  it.fails('Q2: a pre-#4518 server — exit 2, nothing typed, no relay row, never retried on another route', async () => {
    net.pre4518 = 'on';
    const result = await send(WT, BODY, '--instance-id', 'claude-3', '--reply-to', 'self');
    expect(result.code).toBe(2);
    expectNothingReachedATerminal();
    expect(relayRows()).toEqual([]);
  });

  // #4518 stage2
  it.fails('Q2: from a terminal too, a pre-#4518 server — exit 2, nothing typed', async () => {
    asTerminal();
    net.pre4518 = 'on';
    const result = await send(WT, BODY, '--instance-id', 'claude-3');
    expect(result.code).toBe(2);
    expectNothingReachedATerminal();
  });

  // #4518 stage2
  it.fails('Q2: the capability read answered by the current server, then a pre-#4518 one answers the writes — exit 2, nothing typed', async () => {
    net.pre4518 = 'swap';
    const result = await send(WT, BODY, '--instance-id', 'claude-3', '--reply-to', 'self');
    expect(result.code).toBe(2);
    expectNothingReachedATerminal();
  });

  // #4518 stage2
  it.fails('N2: delivered, the answer lost and the relay unreadable — not exit 2, typed once, the relay not withdrawn, no "nothing was sent"', async () => {
    net.corruptAnswerOf = /\/send$/;
    net.relayReadFails = true;
    const result = await send(WT, BODY, '--instance-id', 'claude-3', '--reply-to', 'self');
    expect(result.code).not.toBe(0);
    expect(result.code).not.toBe(2);
    expect(typed()).toEqual([`type:claude:claude-3:${BODY}`]);
    expect(relayRows()).toMatchObject([{ state: 'pending', send_state: 'sent' }]);
    const stderr = result.stderr.join('\n');
    expect(stderr).not.toMatch(/nothing was sent|not sent|safe to send it again/i);
    expect(requests.filter((line) => line === `POST /api/worktrees/${WT}/send`)).toHaveLength(1);
  });
});
