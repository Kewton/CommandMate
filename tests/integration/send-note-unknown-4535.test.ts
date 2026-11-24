/**
 * Issue #4535 (design `docs/design/send-outcome-4535.md` §5.2 T10): `send --note
 * --reply-to` whose message went in, behind a front that lost the route's answer.
 *
 * The real send, relay and mem routes on an in-memory database (the
 * `cli-relay-adhoc-tool-4496` harness), with a front in between: it hands `/send`
 * to the route, throws the route's 201 away, and answers `408 text/html` the way a
 * proxy that timed out does. Before #4535 the CLI read any 4xx as "nothing was
 * sent" and withdrew the relay and closed the waiting note of a message that was
 * in. No tmux, no server, no real agent: the tool module is a fake. HOME is a
 * private directory under os.tmpdir().
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
// mem reads the worktree's branch from git: answered here, as the mem route tests do.
vi.mock('@/lib/git/git-common-dir', () => ({
  probeGitCommonDir: async () => ({ kind: 'repository', commonDir: '/c/.git' }),
  resolveGitCommonDir: async () => '/c/.git',
}));
vi.mock('@/lib/mem/git-observe', () => ({
  observeWorktreeHead: async () => ({ branch: 'main', detached: false, head: null, commonDir: '/c/.git', known: true }),
  readOriginUrl: async () => null,
  readRefTip: async () => null,
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
import * as memItemsRoute from '@/app/api/worktrees/[id]/mem/items/route';
import * as memCloseRoute from '@/app/api/worktrees/[id]/mem/items/[itemId]/close/route';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import { getMemSettings, saveMemSettings } from '@/lib/db/mem-db';
import { createSendCommand } from '@/cli/commands/send';

const WT = 'wt-4535';
const NOTE = 'waiting for the parser review';

let dir: string;
let db: Database.Database;
let requests: string[];
/** What the front does with the route's answer to `/send`. */
let front: 'lose-the-answer-as-408' | 'drop-the-connection';

type RouteHandler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

function routed(pathname: string): { handlers: Record<string, unknown>; params: Record<string, string> } | null {
  if (pathname === '/api/relays') return { handlers: relaysRoute, params: {} };
  const cancel = pathname.match(/^\/api\/relays\/([^/]+)\/cancel$/);
  if (cancel) return { handlers: relayCancelRoute, params: { relayId: cancel[1] } };
  const relay = pathname.match(/^\/api\/relays\/([^/]+)$/);
  if (relay) return { handlers: relayRoute, params: { relayId: relay[1] } };
  const close = pathname.match(/^\/api\/worktrees\/([^/]+)\/mem\/items\/([^/]+)\/close$/);
  if (close) return { handlers: memCloseRoute, params: { id: close[1], itemId: close[2] } };
  const routes: Array<[RegExp, Record<string, unknown>]> = [
    [/^\/api\/worktrees\/([^/]+)\/send$/, sendRoute],
    [/^\/api\/worktrees\/([^/]+)\/resolve-target$/, resolveTargetRoute],
    [/^\/api\/worktrees\/([^/]+)\/mem\/items$/, memItemsRoute],
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
  if (url.pathname === `/api/worktrees/${WT}/current-output`) return Response.json({ isRunning: fakeTool.running });
  const route = routed(url.pathname);
  if (!route) throw new Error(`Not stubbed: ${method} ${url.pathname}`);
  const handler = route.handlers[method] as RouteHandler | undefined;
  if (!handler) return Response.json({ error: `no ${method}` }, { status: 405 });
  const response = await handler(new NextRequest(url, init as ConstructorParameters<typeof NextRequest>[1]), {
    params: Promise.resolve(route.params),
  });
  if (url.pathname === `/api/worktrees/${WT}/send`) {
    // The front: the route answered (201, the message is in), and that answer is lost.
    expect(response.status).toBe(201);
    if (front === 'drop-the-connection') {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
    }
    return new Response('<html><body><h1>408 Request Timeout</h1></body></html>', {
      status: 408,
      headers: { 'content-type': 'text/html' },
    });
  }
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

const relayStates = (): string[] =>
  (db.prepare('SELECT state FROM session_relays').all() as Array<{ state: string }>).map((row) => row.state);
const memItems = (): Array<Record<string, unknown>> => db.prepare('SELECT * FROM mem_items').all() as Array<Record<string, unknown>>;

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-send-note-unknown-4535-')));
  const worktreePath = path.join(dir, 'wt');
  const root = path.join(dir, 'root');
  fs.mkdirSync(worktreePath);
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(dir, 'home'));
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
  setAgentInstances(db, WT, [
    { id: 'codex', cliTool: 'codex', alias: '', order: 0 },
    { id: 'codex-2', cliTool: 'codex', alias: '', order: 1 },
  ]);
  const repo = createRepository(db, { name: 'repo', path: root, cloneSource: 'local' }).id;
  const settings = getMemSettings(db, repo);
  saveMemSettings(db, repo, { version: settings.version, features: settings.features, rules: [{ match: 'glob', pattern: '**', mode: 'on' }] });
  setLaunchRoleDatabaseForTest(db);
  resetSessionLaunchFlightsForTest();
  resetInstanceInputLocks();
  fakeTool.running = true;
  fakeTool.typed = [];
  requests = [];
  front = 'lose-the-answer-as-408';
  vi.stubEnv('HOME', path.join(dir, 'home'));
  vi.stubEnv('CM_AGENT_HOOKS_INJECT', '0');
  vi.stubEnv('CM_AGENT_ROLE_ARTIFACTS_DIR', path.join(dir, 'data'));
  vi.stubEnv('CODEX_HOME', path.join(dir, 'codex'));
  vi.stubEnv('CM_PORT', '4535');
  for (const name of ['TMUX', 'CLAUDECODE', 'CM_RUN_ORIGIN', 'CM_WORKTREE_ID', 'CM_INSTANCE_ID', 'CM_CLI_TOOL']) {
    vi.stubEnv(name, '');
  }
  // The sender is the worktree's codex session (the note's author, and `--reply-to self`); the message goes to codex-2.
  vi.stubEnv('CM_AGENT_TOOL', 'codex');
  vi.stubEnv('CM_AGENT_WORKTREE_ID', WT);
  vi.stubEnv('CM_AGENT_INSTANCE_ID', 'codex');
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

describe('Issue #4535 T10: a lost answer to a message that went in leaves its waiting note and relay', () => {
  it('the message lands, a 408 page comes back — the waiting note stays open', async () => {
    const result = await send('hello', '--instance', 'codex-2', '--reply-to', 'self', '--note', NOTE);
    expect(fakeTool.typed).toEqual(['hello']);
    expect(requests.filter((line) => line === `POST /api/worktrees/${WT}/send`)).toHaveLength(1);
    // Nothing of a message that is in is undone: no close, no withdrawal.
    expect(requests.some((line) => line.endsWith('/close'))).toBe(false);
    expect(requests.some((line) => line.endsWith('/cancel'))).toBe(false);
    expect(memItems()).toHaveLength(1);
    expect(memItems()[0]).toMatchObject({ kind: 'waiting', state: 'open' });
    expect(relayStates()).toEqual([expect.not.stringMatching(/^cancelled$/)]);
    // The page said nothing; the relay's own record says the message went in.
    expect(requests).toContain(`GET /api/relays/${relayIdOf()}`);
    expect(result.code).toBe(0);
  });

  it('(negative control) the connection drops after the route answered — the note stays open, as before', async () => {
    front = 'drop-the-connection';
    const result = await send('hello', '--instance', 'codex-2', '--reply-to', 'self', '--note', NOTE);
    expect(fakeTool.typed).toEqual(['hello']);
    expect(requests.some((line) => line.endsWith('/close'))).toBe(false);
    expect(requests.some((line) => line.endsWith('/cancel'))).toBe(false);
    expect(memItems()[0]).toMatchObject({ state: 'open' });
    expect(result.code).toBe(0);
  });
});

function relayIdOf(): string {
  return (db.prepare('SELECT id FROM session_relays').get() as { id: string }).id;
}
