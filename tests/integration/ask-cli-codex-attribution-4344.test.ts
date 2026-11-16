/**
 * `commandmate ask` → the real ask routes → codex's real rollout reader
 * (Issue #4344, design `docs/design/ask-attribution-4344.md` §0.5・§6 PR3).
 *
 * `scripts/orchestrate/consistency-review.mjs` (5-2b) reads `reply` of
 * `ask --json` and stops with `no-reply` when it is empty. PR3 turns the CLI
 * onto the ledger, so this pins — without a real codex and without a server
 * process — that an `ask` to codex comes back `matched` with the whole reply.
 *
 * Real: the CLI command (`createAskCommand`), `GET /api/asks/capabilities`,
 * `POST /api/worktrees/:id/send` (the reservation, the envelope id handed to the
 * send service, the outcome), `GET /api/asks/:askId` (which runs codex's reader
 * over the rollout once, §3.5), the migrated DB and the ledger.
 * Faked: `fetch` (dispatched to the route handlers in-process), the send
 * service (it writes what codex would: a rollout whose `UserMessage` carries the
 * envelope, a 305-line reply and `task_complete`), tmux ownership, the poll
 * frame, and the installed-version probe (codex 0.167.2, copilot unreadable).
 *
 * The rollout lives under an `os.tmpdir()` CODEX_HOME removed after each test.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (value: Database.Database | null) => {
      mockDb = value;
    },
  };
});

vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

const SESSION = '01a1d600-0000-7000-8000-00000000a5c1';

vi.mock('@/lib/session/agent-event-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session/agent-event-state')>()),
  getLastAgentEvent: () => ({ sessionId: SESSION }),
}));

function fakeTool(id: string) {
  return {
    id,
    name: id,
    command: id,
    async isInstalled() { return true; },
    async isRunning() { return true; },
    async startSession() {},
    async sendMessage() {},
    async killSession() {},
    getSessionName(worktreeId: string) { return `mcbd-${id}-${worktreeId}`; },
  };
}
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: { getInstance: () => ({ getTool: (id: string) => fakeTool(id) }) },
}));

vi.mock('@/lib/cli-tools/session-ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/session-ownership')>()),
  checkSessionOwnership: vi.fn(async () => ({ verdict: 'absent' })),
}));

interface SendParams {
  worktreeId: string;
  content: string;
  cliToolId: string;
  instanceId?: string;
  askEnvelopeId?: string;
  onInputStart?: () => void;
  onAttempt?: (a: { state: string; reason: string }) => void;
}
const sendUserMessage = vi.fn<(db: Database.Database, params: SendParams) => Promise<unknown>>();
vi.mock('@/lib/session/send-user-message', () => ({
  sendUserMessage: (...args: [Database.Database, SendParams]) => sendUserMessage(...args),
}));

import { runMigrations } from '@/lib/db/db-migrations';
import { createMessage, upsertWorktree } from '@/lib/db';
import { formatAskEnvelope } from '@/lib/ask/envelope';
import { setAskVersionProbeForTest } from '@/lib/ask/ask-correlation';
import { resetCodexTranscriptSessions, codexSessionsRoot } from '@/lib/hooks/sources/codex/history';
import { getAskCorrelation } from '@/lib/db/ask-correlation-db';
import { GET as getAskCapabilities } from '@/app/api/asks/capabilities/route';
import { GET as getAsk } from '@/app/api/asks/[askId]/route';
import { POST as postSend } from '@/app/api/worktrees/[id]/send/route';
import type { Worktree } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { createAskCommand } from '../../src/cli/commands/ask';

const WT = 'wt-4344-cli';
const T0 = Date.parse('2026-11-14T06:00:00.000Z');
const REPLY = Array.from({ length: 305 }, (_, i) => `line ${i + 1}: finding`).join('\n');

let db: Database.Database;
let codexHome: string;

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const iso = (offset: number): string => new Date(T0 + offset).toISOString();

/** What codex 0.167.2 writes for one enveloped input answered in one turn (cf. the PR2 fixture). */
async function writeRollout(typedText: string, reply: string): Promise<void> {
  const dir = join(codexSessionsRoot(codexHome), '2026', '11', '14');
  await mkdir(dir, { recursive: true });
  const turn = 'turn-4344-cli';
  const records = [
    { timestamp: iso(-10_000), type: 'session_meta', payload: { session_id: SESSION, id: SESSION, cli_version: '0.167.2' } },
    { timestamp: iso(0), type: 'event_msg', payload: { type: 'task_started', turn_id: turn } },
    {
      timestamp: iso(10), type: 'event_msg',
      payload: { type: 'item_completed', thread_id: SESSION, turn_id: turn, item: { type: 'UserMessage', id: 'u-1', content: [{ type: 'text', text: typedText }] } },
    },
    {
      timestamp: iso(1_000), type: 'event_msg',
      payload: { type: 'item_completed', thread_id: SESSION, turn_id: turn, item: { type: 'AgentMessage', id: 'msg-1', content: [{ type: 'Text', text: reply }], phase: 'final_answer' } },
    },
    { timestamp: iso(2_000), type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, last_agent_message: null } },
  ];
  await writeFile(join(dir, `rollout-2026-11-14T15-00-00-${SESSION}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

const frame = (cliToolId: string) => ({
  isRunning: true,
  isPromptWaiting: false,
  content: 'done',
  fullOutput: 'done',
  realtimeSnippet: '',
  lineCount: 1,
  lastCapturedLine: 1,
  promptData: null,
  autoYes: { enabled: false, expiresAt: null },
  thinking: false,
  cliToolId,
  isSelectionListActive: false,
  lastServerResponseTimestamp: null,
  serverPollerActive: false,
  sessionStatus: 'ready',
  sessionStatusReason: 'input_prompt',
});

const requested: string[] = [];

/** `fetch` for the CLI: the ask and send routes are the real handlers. */
function serve(tool: string): void {
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    requested.push(`${method} ${url.pathname}`);
    if (url.pathname === '/api/capabilities') {
      return json({ serverVersion: '0.0.0-test', capabilities: ['resolve-session-target'] });
    }
    if (url.pathname.endsWith('/resolve-target')) {
      return json({ cliToolId: tool, instanceId: tool, resolvedBy: 'roster', conflict: null });
    }
    if (url.pathname === '/api/asks/capabilities') return getAskCapabilities();
    const ask = /^\/api\/asks\/([^/]+)$/.exec(url.pathname);
    if (ask) {
      const request = new Request(url.toString()) as unknown as NextRequest;
      return getAsk(request, { params: Promise.resolve({ askId: ask[1] }) });
    }
    if (url.pathname === `/api/worktrees/${WT}/send` && method === 'POST') {
      const request = new Request(url.toString(), { method: 'POST', headers: init?.headers, body: init?.body }) as unknown as NextRequest;
      return postSend(request, { params: Promise.resolve({ id: WT }) });
    }
    if (url.pathname.endsWith('/current-output')) return json(frame(tool));
    if (url.pathname.endsWith('/messages')) return json([]);
    if (url.pathname.endsWith('/capture')) return json({ output: 'the pane, never the reply' });
    return json({ error: `unexpected ${url.pathname}` }, 404);
  }) as unknown as typeof fetch;
}

async function runAsk(args: string[]): Promise<void> {
  const pending = createAskCommand().parseAsync(['node', 'ask', ...args]);
  await vi.advanceTimersByTimeAsync(60_000);
  await pending;
}

/** The `--json` line `ask` printed (the routes run in-process may log lines of their own). */
const payload = (): Record<string, unknown> => {
  const line = mockConsoleLog.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('{\n  "worktreeId"'));
  if (line === undefined) throw new Error(`no --json payload; stdout: ${mockConsoleLog.mock.calls.map((c) => String(c[0]).slice(0, 120)).join(' | ')}; stderr: ${mockConsoleError.mock.calls.map((c) => String(c[0]).slice(0, 200)).join(' | ')}`);
  return JSON.parse(line);
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(T0 - 5_000);
  vi.stubEnv('CM_PORT', '3999');
  requested.length = 0;
  codexHome = await mkdtemp(join(tmpdir(), 'cmate-4344-cli-'));
  vi.stubEnv('CODEX_HOME', codexHome);
  resetCodexTranscriptSessions();
  db = new Database(':memory:');
  runMigrations(db);
  const module = (await import('@/lib/db/db-instance')) as unknown as { setMockDb: (v: Database.Database | null) => void };
  module.setMockDb(db);
  upsertWorktree(db, {
    id: WT, name: 'wt', path: join(codexHome, 'wt'), repositoryPath: '/repos', repositoryName: 'CommandMate', cliToolId: 'codex',
  } as Worktree);
  setAskVersionProbeForTest(async (tool) => (tool === 'codex' ? '0.167.2' : tool === 'claude' ? '2.1.293' : null));
  // The send service: what codex would leave behind for the text actually typed.
  sendUserMessage.mockReset();
  sendUserMessage.mockImplementation(async (database, params) => {
    params.onInputStart?.();
    const typed = params.askEnvelopeId ? `${formatAskEnvelope(params.askEnvelopeId)}\n${params.content}` : params.content;
    const message = createMessage(database, {
      worktreeId: params.worktreeId, role: 'user', content: params.content, messageType: 'normal',
      timestamp: new Date(T0), cliToolId: params.cliToolId as CLIToolType, instanceId: params.instanceId ?? params.cliToolId,
    });
    if (params.cliToolId === 'codex') await writeRollout(typed, REPLY);
    params.onAttempt?.({ state: 'sent', reason: 'submitted' });
    return { ok: true, message };
  });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
  setAskVersionProbeForTest(null);
  resetCodexTranscriptSessions();
  const module = (await import('@/lib/db/db-instance')) as unknown as { setMockDb: (v: Database.Database | null) => void };
  module.setMockDb(null);
  db.close();
  await rm(codexHome, { recursive: true, force: true });
});

describe('ask → send route → codex rollout → GET /api/asks/:askId (Issue #4344 PR3)', () => {
  it('a codex ask comes back matched with the whole 305-line reply, read by its own id (consistency-review.mjs reads this `reply`)', async () => {
    serve('codex');

    await runAsk([WT, 'Review the brief', '--instance', 'codex', '--json']);

    expect(mockExit.mock.calls[0]?.[0]).toBe(0);
    const out = payload();
    expect(out).toMatchObject({
      worktreeId: WT,
      instanceId: 'codex',
      cliToolId: 'codex',
      source: 'history',
      reply: REPLY,
      attribution: { state: 'matched', reason: null, notified: false },
    });
    // The id the CLI named is the one the server reserved, typed and settled.
    const askId = String(out.askId);
    expect(sendUserMessage.mock.calls[0][1].askEnvelopeId).toBe(askId);
    expect(getAskCorrelation(db, askId)).toMatchObject({ attributionState: 'matched', sendState: 'sent', nativeInputId: 'u-1' });
    expect(requested).toContain(`GET /api/asks/${askId}`);
    expect(requested.some((r) => r.endsWith('/capture'))).toBe(false);
  });

  it('negative: copilot (no attribution) is sent without an id, nothing is reserved, and no reply is read', async () => {
    serve('copilot');

    await runAsk([WT, 'hi', '--instance', 'copilot', '--json']);

    expect(mockExit.mock.calls[0]?.[0]).toBe(0);
    expect(payload()).toMatchObject({
      source: 'none',
      reply: null,
      askId: null,
      attribution: { state: 'unavailable', reason: 'tool_unsupported' },
    });
    expect(sendUserMessage.mock.calls[0][1].askEnvelopeId).toBeUndefined();
    expect((db.prepare('SELECT COUNT(*) AS n FROM ask_correlations').get() as { n: number }).n).toBe(0);
    expect(requested.some((r) => /^GET \/api\/asks\/(?!capabilities)/.test(r) || r.endsWith('/capture'))).toBe(false);
  });
});
