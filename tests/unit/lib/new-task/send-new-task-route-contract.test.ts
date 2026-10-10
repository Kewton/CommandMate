/**
 * New task's reading of the send / auto-yes routes, against the routes
 * themselves (Issue #3511).
 *
 * The dialog's failure handling is only as good as its reading of what
 * `POST /api/worktrees/[id]/send` really answers. So the responses here are
 * produced by the real route handlers — only the tmux / agent edges below them
 * are stubbed — and fed straight into `interpretSendResponse` / `sendNewTask`.
 * A route that changed a status or a `code` fails this file, not the UI.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';
import {
  SESSION_STARTING_CODE,
  SessionStartTimeoutError,
} from '@/lib/session/session-start-error';

const codex = vi.hoisted(() => ({ running: false, startSession: vi.fn() }));
const claude = vi.hoisted(() => ({ running: false, startSession: vi.fn() }));

vi.mock('@/lib/cli-tools/codex', () => ({
  CodexTool: class {
    id = 'codex';
    name = 'Codex CLI';
    command = 'codex';
    async isInstalled() { return true; }
    async isRunning() { return codex.running; }
    async startSession(...args: unknown[]) { return codex.startSession(...args); }
    async sendMessage() {}
    async killSession() {}
    getSessionName(id: string, instanceId?: string) {
      return instanceId && instanceId !== 'codex' ? `mcbd-codex-${id}-${instanceId}` : `mcbd-codex-${id}`;
    }
  },
}));

vi.mock('@/lib/cli-tools/claude', () => ({
  ClaudeTool: class {
    id = 'claude';
    name = 'Claude Code';
    command = 'claude';
    async isInstalled() { return true; }
    async isRunning() { return claude.running; }
    async startSession(...args: unknown[]) { return claude.startSession(...args); }
    async sendMessage() {}
    async killSession() {}
    getSessionName(id: string) { return `mcbd-claude-${id}`; }
  },
}));

const ownership = vi.hoisted(() => ({ verdict: 'absent' as 'absent' | 'foreign' }));
vi.mock('@/lib/cli-tools/session-ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/session-ownership')>()),
  checkSessionOwnership: vi.fn(async () =>
    ownership.verdict === 'foreign'
      ? { verdict: 'foreign', sessionPath: '/elsewhere' }
      : { verdict: 'absent' },
  ),
}));

const isPaneBackAtShell = vi.fn(async (..._args: unknown[]): Promise<boolean> => false);
vi.mock('@/app/api/worktrees/[id]/send/pane-shell', () => ({
  isPaneBackAtShell: (...args: unknown[]) => isPaneBackAtShell(...args),
}));

const sendUserMessage = vi.fn();
vi.mock('@/lib/session/send-user-message', () => ({
  sendUserMessage: (...args: unknown[]) => sendUserMessage(...args),
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

// Arming must not start a real 2-second poller against tmux.
vi.mock('@/lib/polling/auto-yes-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/polling/auto-yes-manager')>()),
  startAutoYesPolling: vi.fn(() => ({ started: true })),
}));
vi.mock('@/lib/hooks/pending-decision-recheck', () => ({
  recheckPendingDecisions: vi.fn(async () => ({ examined: 0, delivered: 0, skipped: 0, reason: 'no-pending' })),
}));

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database): void;
}

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database) => {
      mockDb = db;
    },
    closeDbInstance: () => {
      mockDb = null;
    },
  };
});

import { POST as sendRoute } from '@/app/api/worktrees/[id]/send/route';
import { POST as autoYesRoute } from '@/app/api/worktrees/[id]/auto-yes/route';
import { PROMPT_WAITING_CODE } from '@/lib/session/prompt-waiting-guard';
import { INSTANCE_TOOL_CONFLICT } from '@/lib/session/resolve-session-target';
import { getAutoYesState, clearAllAutoYesStates } from '@/lib/polling/auto-yes-manager';
import {
  interpretSendResponse,
  sendNewTask,
  SEND_RESPONSE_CODES,
} from '@/lib/new-task/send-new-task';

const WORKTREE_ID = 'wt-3511-new-task';

/** Hand a request to the real route the URL names, as the browser would. */
const routeRequest = vi.fn(async (url: string, options?: RequestInit): Promise<Response> => {
  const request = new Request(`http://localhost:3000${url}`, {
    method: options?.method ?? 'GET',
    headers: options?.headers,
    body: options?.body,
  }) as unknown as NextRequest;
  const context = { params: Promise.resolve({ id: WORKTREE_ID }) };
  if (url.endsWith('/auto-yes')) return (await autoYesRoute(request, context)) as unknown as Response;
  if (url.endsWith('/send')) return (await sendRoute(request, context)) as unknown as Response;
  throw new Error(`unexpected request ${url}`);
});

function postSend(body: Record<string, unknown>): Promise<Response> {
  return routeRequest(`/api/worktrees/${WORKTREE_ID}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const CREATED = {
  ok: true,
  message: { id: 'm1', worktreeId: WORKTREE_ID, role: 'user', content: 'hi', timestamp: new Date().toISOString() },
};

describe('[#3511] New task reads the real send / auto-yes routes', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);
    vi.clearAllMocks();
    clearAllAutoYesStates();
    codex.running = false;
    claude.running = false;
    ownership.verdict = 'absent';
    codex.startSession.mockResolvedValue(undefined);
    claude.startSession.mockResolvedValue(undefined);
    isPaneBackAtShell.mockResolvedValue(false);
    sendUserMessage.mockResolvedValue(CREATED);
    upsertWorktree(db, {
      id: WORKTREE_ID,
      name: 'feature/new-task',
      path: `/path/to/${WORKTREE_ID}`,
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId: 'codex',
    } as Worktree);
  });

  afterEach(async () => {
    clearAllAutoYesStates();
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    db.close();
  });

  it('spells the route codes exactly as the server does', () => {
    expect(SEND_RESPONSE_CODES.promptWaiting).toBe(PROMPT_WAITING_CODE);
    expect(SEND_RESPONSE_CODES.sessionStarting).toBe(SESSION_STARTING_CODE);
    expect(SEND_RESPONSE_CODES.instanceToolConflict).toBe(INSTANCE_TOOL_CONFLICT);
  });

  it('reads 201 as sent, and a stopped agent is started by the same request', async () => {
    const response = await postSend({ content: 'hi', cliToolId: 'codex', instanceId: 'codex' });

    expect(response.status).toBe(201);
    expect(codex.startSession).toHaveBeenCalledTimes(1);
    expect(await interpretSendResponse(response, { modelRequested: false })).toEqual({ ok: true });
  });

  it('reads 409 PROMPT_WAITING as prompt_waiting, with the server sentence', async () => {
    codex.running = true;
    sendUserMessage.mockResolvedValue({ ok: false, stage: 'prompt_waiting', error: 'Answer it with respond first' });

    const response = await postSend({ content: 'hi', cliToolId: 'codex', instanceId: 'codex' });
    expect(response.status).toBe(409);
    expect(await interpretSendResponse(response, { modelRequested: false })).toEqual({
      ok: false,
      kind: 'prompt_waiting',
      status: 409,
      detail: 'Answer it with respond first',
    });
  });

  it('reads 400 for a model on a running claude as model_rejected', async () => {
    claude.running = true;
    const response = await postSend({ content: 'hi', cliToolId: 'claude', instanceId: 'claude', model: 'sonnet' });

    expect(response.status).toBe(400);
    const result = await interpretSendResponse(response, { modelRequested: true });
    expect(result).toMatchObject({ ok: false, kind: 'model_rejected', status: 400 });
    expect(result.ok === false && result.detail).toContain('only be set when starting a new session');
  });

  it('reads 400 for a model on a tool that takes none as model_rejected', async () => {
    const response = await postSend({ content: 'hi', cliToolId: 'codex', instanceId: 'codex', model: 'gpt-5' });

    expect(response.status).toBe(400);
    expect(await interpretSendResponse(response, { modelRequested: true })).toMatchObject({
      ok: false,
      kind: 'model_rejected',
    });
  });

  it('does not blame the model for an instance/tool contradiction (400 instance_tool_conflict)', async () => {
    const response = await postSend({ content: 'hi', cliToolId: 'claude', instanceId: 'codex', model: 'sonnet' });

    expect(response.status).toBe(400);
    expect(await interpretSendResponse(response, { modelRequested: true })).toMatchObject({
      ok: false,
      kind: 'invalid',
    });
  });

  it('reads 503 SESSION_STARTING as starting, and an agent back at the shell as start_failed', async () => {
    codex.startSession.mockRejectedValue(new SessionStartTimeoutError('Codex CLI', `mcbd-codex-${WORKTREE_ID}`, 60000));

    const slow = await postSend({ content: 'hi', cliToolId: 'codex', instanceId: 'codex' });
    expect(slow.status).toBe(503);
    expect(await interpretSendResponse(slow, { modelRequested: false })).toMatchObject({ ok: false, kind: 'starting' });

    isPaneBackAtShell.mockResolvedValue(true);
    const exited = await postSend({ content: 'hi', cliToolId: 'codex', instanceId: 'codex' });
    expect(exited.status).toBe(503);
    expect(await interpretSendResponse(exited, { modelRequested: false })).toMatchObject({ ok: false, kind: 'start_failed' });
  });

  it('reads a 500 send failure as failed, with the server sentence', async () => {
    codex.running = true;
    sendUserMessage.mockResolvedValue({ ok: false, stage: 'send', error: 'tmux went away' });

    const response = await postSend({ content: 'hi', cliToolId: 'codex', instanceId: 'codex' });
    expect(response.status).toBe(500);
    const result = await interpretSendResponse(response, { modelRequested: false });
    expect(result).toMatchObject({ ok: false, kind: 'failed', status: 500 });
    expect(result.ok === false && result.detail).toContain('tmux went away');
  });

  describe('sendNewTask', () => {
    it('sends without touching Auto-Yes when none was picked (negative control)', async () => {
      const result = await sendNewTask(
        { target: { worktreeId: WORKTREE_ID, instanceId: 'codex' }, cliToolId: 'codex', content: 'go', autoYesDuration: null },
        routeRequest,
      );

      expect(result).toEqual({ ok: true });
      expect(routeRequest.mock.calls.map(([url]) => url)).toEqual([`/api/worktrees/${WORKTREE_ID}/send`]);
      expect(getAutoYesState(WORKTREE_ID, 'codex', 'codex')?.enabled ?? false).toBe(false);
      expect(sendUserMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ content: 'go', cliToolId: 'codex', instanceId: 'codex' }),
      );
    });

    it('arms the instance Auto-Yes for the picked duration first, then sends', async () => {
      const result = await sendNewTask(
        { target: { worktreeId: WORKTREE_ID, instanceId: 'codex' }, cliToolId: 'codex', content: 'go', autoYesDuration: 3600000 },
        routeRequest,
      );

      expect(routeRequest.mock.calls.map(([url]) => url)).toEqual([
        `/api/worktrees/${WORKTREE_ID}/auto-yes`,
        `/api/worktrees/${WORKTREE_ID}/send`,
      ]);
      const state = getAutoYesState(WORKTREE_ID, 'codex', 'codex');
      expect(state?.enabled).toBe(true);
      expect((state?.expiresAt ?? 0) - Date.now()).toBeGreaterThan(3500000);
      // The armed state comes back exactly as the route answered it.
      expect(result).toEqual({ ok: true, armedAutoYes: { enabled: true, expiresAt: state?.expiresAt } });
    });

    it('reports the armed Auto-Yes even when the send after it fails', async () => {
      codex.running = true;
      sendUserMessage.mockResolvedValue({ ok: false, stage: 'prompt_waiting', error: 'prompt up' });
      const result = await sendNewTask(
        { target: { worktreeId: WORKTREE_ID, instanceId: 'codex' }, cliToolId: 'codex', content: 'go', autoYesDuration: 3600000 },
        routeRequest,
      );

      const state = getAutoYesState(WORKTREE_ID, 'codex', 'codex');
      expect(state?.enabled).toBe(true);
      expect(result).toMatchObject({
        ok: false,
        kind: 'prompt_waiting',
        armedAutoYes: { enabled: true, expiresAt: state?.expiresAt },
      });
    });

    it('sends nothing when arming Auto-Yes is refused', async () => {
      ownership.verdict = 'foreign';
      const result = await sendNewTask(
        { target: { worktreeId: WORKTREE_ID, instanceId: 'codex' }, cliToolId: 'codex', content: 'go', autoYesDuration: 3600000 },
        routeRequest,
      );

      expect(result).toMatchObject({ ok: false, kind: 'auto_yes_failed', status: 409 });
      expect(sendUserMessage).not.toHaveBeenCalled();
    });

    it('passes a model only when one was written', async () => {
      await sendNewTask(
        { target: { worktreeId: WORKTREE_ID, instanceId: 'claude' }, cliToolId: 'claude', content: 'go', model: '  ', autoYesDuration: null },
        routeRequest,
      );
      const body = JSON.parse(String(routeRequest.mock.calls[0][1]?.body));
      expect(body).not.toHaveProperty('model');

      await sendNewTask(
        { target: { worktreeId: WORKTREE_ID, instanceId: 'claude' }, cliToolId: 'claude', content: 'go', model: 'sonnet', autoYesDuration: null },
        routeRequest,
      );
      expect(claude.startSession).toHaveBeenLastCalledWith(WORKTREE_ID, `/path/to/${WORKTREE_ID}`, 'claude', 'sonnet');
    });

    it('turns a request that got no reply into failed', async () => {
      const result = await sendNewTask(
        { target: { worktreeId: WORKTREE_ID, instanceId: 'codex' }, cliToolId: 'codex', content: 'go', autoYesDuration: null },
        async () => {
          throw new Error('Request timed out after 1000ms');
        },
      );
      expect(result).toEqual({ ok: false, kind: 'failed', status: 0, detail: 'Request timed out after 1000ms' });
    });
  });
});
