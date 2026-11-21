/**
 * Issue #4496: rule 0 of the relay (#4437 — no relay with antigravity at either end)
 * judged an ad-hoc `--instance` (not on the roster, not a tool name) by the worktree's
 * default tool, because `POST /api/relays` was never told the tool `--agent` asked for.
 * So `send --agent antigravity --instance <ad-hoc> --reply-to …` opened its relay, and
 * from a terminal (where the send's own fence lets a person through) typed into agy.
 *
 * Driven as a person (terminal) and as an agent session run the CLI, against the real
 * routes and an in-memory database (the `cli-tool-policy-4437` harness). No tmux, no
 * server, no real agy: the tool module is a fake, and a fake `agy` on a private PATH
 * records any call (none is expected). HOME is a private directory under os.tmpdir().
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
vi.mock('@/lib/hooks/pending-decision-recheck', () => ({
  recheckPendingDecisions: vi.fn(async () => ({ reason: 'test', examined: 0, delivered: 0, skipped: 0 })),
}));
/** Issue #4496 (fix1): a roster read that throws for one instance id (fault injection). */
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
vi.mock('@/lib/cli-tools/claude', () => ({
  ClaudeTool: class {
    id = 'claude';
    name = 'Claude Code';
    command = 'claude';
    async isInstalled() { return true; }
    async isRunning() { return fakeTool.claudeRunning(); }
    async startSession() {}
    async sendMessage(_id: string, message: string) {
      noteInputStart();
      fakeTool.typed.push(`claude:${message}`);
    }
    async killSession() {}
    getSessionName(id: string, instanceId?: string) { return `mcbd-claude-${id}-${instanceId ?? 'claude'}`; }
  },
}));

import * as sendRoute from '@/app/api/worktrees/[id]/send/route';
import * as resolveTargetRoute from '@/app/api/worktrees/[id]/resolve-target/route';
import * as relaysRoute from '@/app/api/relays/route';
import * as relayCancelRoute from '@/app/api/relays/[relayId]/cancel/route';
import * as tasksRoute from '@/app/api/worktrees/[id]/tasks/route';
import { listTasks } from '@/lib/db/tasks-db';
import { RELAY_TOOL_POLICY_WITHDRAWN_MESSAGE } from '@/lib/relay/relay-policy';
import { pumpRelayDeliveries, resetRelayDeliveryState } from '@/lib/relay/relay-delivery';
import { createSendCommand } from '@/cli/commands/send';
import { addAgentInstance } from '@/lib/db/agent-instances-db';
import { notifyRelayTurnCompleted } from '@/lib/relay/relay-delivery';
import { createMessage } from '@/lib/db/chat-db';
import { generationStartedAt } from '@/lib/session/agent-event-turn';
import { buildCompositeKey } from '@/lib/auto-yes-state';

const WT = 'wt-4496';
const AD_HOC = 'agy-adhoc';
const CONTRACT = 'version: 1\ntitle: t\ngoal: |\n  Do the work.\nscope:\n  allow: ["src/**"]\n';

let dir: string;
let worktreePath: string;
let agyCalls: string;
let db: Database.Database;
let requests: string[];
let answered: string[];
let stdinTTY: PropertyDescriptor | undefined;

type RouteHandler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

function routed(pathname: string): { handlers: Record<string, unknown>; params: Record<string, string> } | null {
  if (pathname === '/api/relays') return { handlers: relaysRoute, params: {} };
  const cancel = pathname.match(/^\/api\/relays\/([^/]+)\/cancel$/);
  if (cancel) return { handlers: relayCancelRoute, params: { relayId: cancel[1] } };
  const routes: Array<[RegExp, Record<string, unknown>]> = [
    [/^\/api\/worktrees\/([^/]+)\/send$/, sendRoute],
    [/^\/api\/worktrees\/([^/]+)\/resolve-target$/, resolveTargetRoute],
    [/^\/api\/worktrees\/([^/]+)\/tasks$/, tasksRoute],
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
  if (url.pathname === '/api/worktrees') return Response.json({ worktrees: [{ id: WT }] });
  const route = routed(url.pathname);
  if (!route) throw new Error(`Not stubbed: ${method} ${url.pathname}`);
  const handler = route.handlers[method] as RouteHandler | undefined;
  if (!handler) return Response.json({ error: `no ${method}` }, { status: 405 });
  const response = await handler(new NextRequest(url, init as ConstructorParameters<typeof NextRequest>[1]), {
    params: Promise.resolve(route.params),
  });
  answered.push(`${method} ${url.pathname} ${response.status}`);
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

const relayRows = (): number => (db.prepare('SELECT COUNT(*) AS n FROM session_relays').get() as { n: number }).n;
const transcriptRows = (): number => (db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get() as { n: number }).n;
const agyWasCalled = (): boolean => fs.existsSync(agyCalls);

/** Nothing of the refused command is left: exit 33, no relay row (requested included), nothing typed. */
function expectRefusedWithNothingLeft(result: { code: number; stderr: string[] }): void {
  expect(result.code).toBe(33);
  expect(result.stderr[0]).toMatch(/^Error \[RELAY_TOOL_POLICY_DENIED\]: /);
  expect(relayRows()).toBe(0);
  expect(transcriptRows()).toBe(0);
  expect(fakeTool.typed).toEqual([]);
  expect(requests).not.toContain(`POST /api/worktrees/${WT}/send`);
  expect(agyWasCalled()).toBe(false);
}

/** A person typing in a terminal (send-origin step 7): no session env, no TMUX, stdin a TTY. */
function asTerminal(): void {
  for (const name of ['CM_AGENT_TOOL', 'CM_AGENT_WORKTREE_ID', 'CM_AGENT_INSTANCE_ID']) vi.stubEnv(name, '');
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
}

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-relay-adhoc-4496-')));
  worktreePath = path.join(dir, 'wt');
  const root = path.join(dir, 'root');
  const bin = path.join(dir, 'bin');
  agyCalls = path.join(dir, 'agy-calls');
  fs.mkdirSync(path.join(worktreePath, '.commandmate', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(worktreePath, '.commandmate', 'tasks', 'x.yaml'), CONTRACT);
  fs.mkdirSync(root);
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(dir, 'home'));
  // I5: a fake agy that only records that it was run. The real one is never on this PATH.
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
    cliToolId: 'codex',
  } as Worktree);
  db.prepare('UPDATE worktrees SET selected_agents = ? WHERE id = ?').run(JSON.stringify(['codex', 'antigravity']), WT);
  createRepository(db, { name: 'repo', path: root, cloneSource: 'local' });
  setLaunchRoleDatabaseForTest(db);
  resetSessionLaunchFlightsForTest();
  resetInstanceInputLocks();
  fakeTool.running = false;
  fakeTool.typed = [];
  fakeTool.beforeFirstKey = null;
  fakeTool.onStart = null;
  ownership.hook = null;
  requests = [];
  answered = [];
  stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
  vi.stubEnv('HOME', path.join(dir, 'home'));
  // I5: the CLI's usage-notice record (`antigravity-notice.json`) only under this run's directory.
  vi.stubEnv('CM_ANTIGRAVITY_NOTICE_DIR', path.join(dir, 'notice'));
  rosterFault.instanceId = null;
  resetRelayDeliveryState();
  vi.stubEnv('CM_AGENT_HOOKS_INJECT', '0');
  vi.stubEnv('CM_AGENT_ROLE_ARTIFACTS_DIR', path.join(dir, 'data'));
  vi.stubEnv('CM_AGENT_ROLE_ANTIGRAVITY_AGENTS_DIR', path.join(dir, 'agy-agents'));
  vi.stubEnv('CODEX_HOME', path.join(dir, 'codex'));
  vi.stubEnv('CM_PORT', '4496');
  for (const name of ['TMUX', 'CLAUDECODE', 'CM_RUN_ORIGIN', 'CM_WORKTREE_ID', 'CM_INSTANCE_ID', 'CM_CLI_TOOL']) {
    vi.stubEnv(name, '');
  }
  // The default caller is an agent session (codex, the worktree's primary): `--reply-to self` names it.
  vi.stubEnv('CM_AGENT_TOOL', 'codex');
  vi.stubEnv('CM_AGENT_WORKTREE_ID', WT);
  vi.stubEnv('CM_AGENT_INSTANCE_ID', 'codex');
  vi.stubEnv('CM_ANTIGRAVITY_USAGE', '');
  fs.mkdirSync(path.join(dir, 'codex'));
  vi.stubGlobal('fetch', dispatch);
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

describe('Issue #4496: rule 0 judges an ad-hoc end by the tool --agent asked for', () => {
  it('4496 terminal origin: ad-hoc --agent antigravity --reply-to is refused — exit 33, no relay row, nothing typed', async () => {
    asTerminal();
    const result = await send('hello', '--agent', 'antigravity', '--instance', AD_HOC, '--reply-to', `${WT}@codex`);
    expectRefusedWithNothingLeft(result);
    expect(answered).toContain('POST /api/relays 409');
    // I5: the usage notice's record went to this run's directory, and nowhere under HOME.
    expect(fs.existsSync(path.join(dir, 'notice', 'antigravity-notice.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'home', '.commandmate'))).toBe(false);
  });

  it('4496 agent-session origin: ad-hoc --agent antigravity --reply-to self is refused at the relay — exit 33, no row', async () => {
    const result = await send('hello', '--agent', 'antigravity', '--instance', AD_HOC, '--reply-to', 'self');
    expectRefusedWithNothingLeft(result);
    expect(answered).toContain('POST /api/relays 409');
  });

  it('4496 control — ad-hoc --agent claude --reply-to self still opens its relay and is sent', async () => {
    const result = await send('hello', '--agent', 'claude', '--instance', 'claude-adhoc', '--reply-to', 'self');
    expect(result.code).toBe(0);
    expect(answered).toContain('POST /api/relays 201');
    expect(answered).toContain(`POST /api/worktrees/${WT}/send 201`);
    expect(relayRows()).toBe(1);
    expect(agyWasCalled()).toBe(false);
  });

  it('4496 control — a roster instance is judged by its roster tool, as before', async () => {
    addAgentInstance(db, WT, { id: 'codex-2', cliTool: 'codex', alias: '', order: 0 });
    fakeTool.onStart = async () => {};
    const result = await send('hello', '--instance', 'codex-2', '--reply-to', 'self');
    expect(result.code).toBe(0);
    expect(answered).toContain('POST /api/relays 201');
    expect(fakeTool.typed).toHaveLength(1);
    expect(relayRows()).toBe(1);
  });

  it('4496 an older CLI (no tool on POST /api/relays): the send that binds the relay to antigravity is refused, the relay withdrawn', async () => {
    // A relay opened the way a CLI before #4496 opens it: the ad-hoc end judged by the default (codex).
    const opened = await relaysRoute.POST(new NextRequest('http://localhost/api/relays', {
      method: 'POST',
      body: JSON.stringify({ from: { worktreeId: WT, instanceId: 'codex' }, to: { worktreeId: WT, instanceId: AD_HOC }, bind: true }),
    }));
    expect(opened.status).toBe(201);
    const { relay } = (await opened.json()) as { relay: { id: string } };
    // From a terminal (`origin: terminal`, which the send's own fence lets through).
    const sent = await sendRoute.POST(new NextRequest(`http://localhost/api/worktrees/${WT}/send`, {
      method: 'POST',
      body: JSON.stringify({ content: 'hello', cliToolId: 'antigravity', instanceId: AD_HOC, relayId: relay.id, origin: 'terminal' }),
    }), { params: Promise.resolve({ id: WT }) });
    expect(sent.status).toBe(409);
    const refusal = (await sent.json()) as { code: string; error: string };
    expect(refusal.code).toBe('RELAY_TOOL_POLICY_DENIED');
    // Not the "no relay was opened" of a refusal at creation: this one was opened, and withdrawn.
    expect(refusal.error).toBe(RELAY_TOOL_POLICY_WITHDRAWN_MESSAGE);
    expect(refusal.error).not.toContain('No relay was opened');
    expect(fakeTool.typed).toEqual([]);
    expect(agyWasCalled()).toBe(false);
    const row = db.prepare('SELECT state FROM session_relays WHERE id = ?').get(relay.id) as { state: string };
    expect(row.state).toBe('cancelled');
  });

  it('4496 fix1: a worktree whose default is antigravity + ad-hoc --agent claude --reply-to — exit 33, no relay row, nothing typed', async () => {
    // The delivery and the pump's sweep resolve an ad-hoc end by the default (they name no
    // tool), so a relay opened on `claude` alone would be withdrawn silently later.
    db.prepare('UPDATE worktrees SET cli_tool_id = ? WHERE id = ?').run('antigravity', WT);
    const result = await send('hello', '--agent', 'claude', '--instance', 'claude-adhoc', '--reply-to', 'self');
    expectRefusedWithNothingLeft(result);
    expect(answered).toContain('POST /api/relays 409');
  });

  it('4496 fix1 control — default codex + ad-hoc --agent claude: opened, typed, and the pump does not cancel it', async () => {
    const result = await send('hello', '--agent', 'claude', '--instance', 'claude-adhoc', '--reply-to', 'self');
    expect(result.code).toBe(0);
    expect(fakeTool.typed).toEqual(['claude:hello']);
    const [{ id }] = db.prepare('SELECT id FROM session_relays').all() as Array<{ id: string }>;
    await pumpRelayDeliveries();
    const row = db.prepare('SELECT state FROM session_relays WHERE id = ?').get(id) as { state: string };
    expect(row.state).not.toBe('cancelled');
  });

  it('4498 A3 — default codex + ad-hoc --agent claude --reply-to: the reply is taken from claude and typed back into codex', async () => {
    // The claude session typed into has a generation of this process; the codex key the
    // ad-hoc end resolves to (no tool named) has none. Observed as codex, the bound relay
    // was held `generation_changed` and invalidated, and the reply never came back.
    const claudeKey = buildCompositeKey(WT, 'claude', 'claude-adhoc');
    generationStartedAt.set(claudeKey, Date.now() - 1_000);
    try {
      const result = await send('hello', '--agent', 'claude', '--instance', 'claude-adhoc', '--reply-to', 'self');
      expect(result.code).toBe(0);
      expect(fakeTool.typed).toEqual(['claude:hello']);
      const [{ id }] = db.prepare('SELECT id FROM session_relays').all() as Array<{ id: string }>;
      const sent = db.prepare('SELECT hold_reason, obs_state FROM session_relays WHERE id = ?').get(id) as { hold_reason: string | null; obs_state: string | null };
      expect(sent.hold_reason).toBeNull();
      expect(sent.obs_state).not.toBe('invalid');

      // Claude finishes its turn (a transcript row), and the requester (codex) is up.
      createMessage(db, {
        worktreeId: WT,
        role: 'assistant',
        content: 'the answer from claude',
        timestamp: new Date(Date.now() + 1_000),
        requestId: 'claude-turn:4498',
        messageType: 'normal',
        cliToolId: 'claude',
        instanceId: 'claude-adhoc',
      });
      fakeTool.running = true;
      await notifyRelayTurnCompleted({ worktreeId: WT, cliToolId: 'claude', instanceId: 'claude-adhoc' }, { settled: true });
      await vi.waitFor(async () => {
        await pumpRelayDeliveries();
        expect(fakeTool.typed).toHaveLength(2);
      });
      // Back into codex (the requester), once, carrying claude's answer — never into claude.
      expect(fakeTool.typed[1]).not.toMatch(/^claude:/);
      expect(fakeTool.typed[1]).toContain('the answer from claude');
      const row = db.prepare('SELECT state FROM session_relays WHERE id = ?').get(id) as { state: string };
      expect(row.state).toBe('delivered');
      await pumpRelayDeliveries();
      expect(fakeTool.typed).toHaveLength(2);
      expect(agyWasCalled()).toBe(false);
    } finally {
      generationStartedAt.delete(claudeKey);
    }
  });

  it('4496 fix1 (I4): the requester\'s roster cannot be read — --contract writes no task, exit 33, nothing typed', async () => {
    rosterFault.instanceId = 'codex';
    const result = await send('--contract', '.commandmate/tasks/x.yaml', '--agent', 'claude', '--instance', 'claude-adhoc', '--reply-to', 'self');
    expect(result.code).toBe(33);
    expect(result.stderr[0]).toMatch(/^Error \[RELAY_TOOL_POLICY_DENIED\]: /);
    expect(listTasks(db, WT)).toEqual([]);
    expect(relayRows()).toBe(0);
    expect(fakeTool.typed).toEqual([]);
    expect(answered).toContain(`POST /api/worktrees/${WT}/tasks 409`);
  });
});
