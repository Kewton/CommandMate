/**
 * The send route says whether the instance was mid-turn when the message went
 * in (Issue #3957): `turnOpenAtSend: true | false` on the 201 body, read from
 * the instance's turn record at the moment the body started going into the
 * composer (the send service's `onInputStart`, called inside the sender's
 * `noteInputStart`), and no key when that is not known.
 *
 * True: a turn open at the input — however the record changes after it (A's
 * `stop`, this message's own new turn, a re-open). False: no turn open at the
 * input — one that closed while the send queued, a re-open that stopped before
 * it, none at all, another instance's. Not known (no key): a relaunch during
 * the send, a sender that reports no input start, a tool whose hooks do not
 * report turns.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';
import type { NextRequest } from 'next/server';

const startSession = vi.fn();
const isRunning = vi.fn(async () => false);

vi.mock('@/lib/cli-tools/codex', () => ({
  CodexTool: class {
    id = 'codex';
    name = 'Codex CLI';
    command = 'codex';
    async isInstalled() { return true; }
    async isRunning() { return isRunning(); }
    async startSession(...args: unknown[]) { return startSession(...args); }
    async sendMessage() {}
    async killSession() {}
    getSessionName(id: string) { return `mcbd-codex-${id}`; }
  },
}));

vi.mock('@/lib/cli-tools/session-ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/session-ownership')>()),
  checkSessionOwnership: vi.fn(async () => ({ verdict: 'absent' })),
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

import { POST as sendMessage } from '@/app/api/worktrees/[id]/send/route';
import { beginAgentEventGeneration, clearAgentStopEvents, recordAgentEvent } from '@/lib/session/agent-event-state';
import type { AgentEventRecord } from '@/lib/session/agent-event-record';
import { registerAgentEventSource, unregisterAgentEventSource } from '@/lib/hooks/sources/registry';
import { codexAgentEventSource } from '@/lib/hooks/sources/codex/source';

const WORKTREE_ID = 'wt-3957-send';

function post(extra: Record<string, unknown> = {}): Promise<Response> {
  const request = new Request(`http://localhost:3000/api/worktrees/${WORKTREE_ID}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'hello', cliToolId: 'codex', ...extra }),
  });
  return sendMessage(request as unknown as NextRequest, {
    params: Promise.resolve({ id: WORKTREE_ID }),
  }) as unknown as Promise<Response>;
}

function event(name: AgentEventRecord['event'], at: number): AgentEventRecord {
  return { event: name, at, detail: null, sessionId: 's-3957' };
}

interface SendParams {
  content: string;
  onInputStart?: (at: Date) => void;
}

const OPENED = () => Date.now() - 2_000;

/**
 * A send service that runs `beforeInput` (what happens while the send queues
 * for the lock, waits out a mark or relaunches), reports the input start the
 * way the real one does (inside `noteInputStart`), runs `afterInput` (what
 * happens once the body is in) and succeeds.
 */
function sends(beforeInput: () => void, afterInput: () => void = () => {}, reportsInputStart = true): void {
  sendUserMessage.mockImplementation(async (_db: unknown, params: SendParams) => {
    beforeInput();
    if (reportsInputStart) params.onInputStart?.(new Date());
    afterInput();
    return {
      ok: true,
      message: { id: 'm-1', worktreeId: WORKTREE_ID, role: 'user', content: params.content, cliToolId: 'codex', instanceId: 'codex' },
    };
  });
}
const sendsAfter = (beforeInput: () => void, reportsInputStart = true): void =>
  sends(beforeInput, () => {}, reportsInputStart);

const codex = (name: AgentEventRecord['event'], at: number, instanceId?: string): void => {
  recordAgentEvent(WORKTREE_ID, 'codex', instanceId, event(name, at));
};

async function body(extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const response = await post(extra);
  expect(response.status).toBe(201);
  return (await response.json()) as Record<string, unknown>;
}

describe('POST /send: turnOpenAtSend (Issue #3957)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);
    vi.clearAllMocks();
    clearAgentStopEvents();
    isRunning.mockResolvedValue(true);
    sendsAfter(() => {});
    upsertWorktree(db, {
      id: WORKTREE_ID,
      name: 'Turn',
      path: `/path/to/${WORKTREE_ID}`,
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId: 'codex',
    } as Worktree);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    db.close();
    clearAgentStopEvents();
  });

  it('positive: a turn opened and not closed before the send → turnOpenAtSend: true', async () => {
    codex('user_prompt_submit', OPENED());
    expect(await body()).toMatchObject({ id: 'm-1', content: 'hello', turnOpenAtSend: true });
  });

  it('a turn that closed before the send → turnOpenAtSend: false', async () => {
    codex('user_prompt_submit', OPENED());
    codex('stop', Date.now() - 1_000);
    expect(await body()).toMatchObject({ id: 'm-1', content: 'hello', turnOpenAtSend: false });
  });

  it('no turn record on a tool whose hooks report turns → turnOpenAtSend: false', async () => {
    expect(await body()).toMatchObject({ turnOpenAtSend: false });
  });

  it('another instance being mid-turn does not mark this send (false)', async () => {
    codex('user_prompt_submit', OPENED(), 'codex-2');
    expect(await body({ instanceId: 'codex' })).toMatchObject({ turnOpenAtSend: false });
  });

  it('(a) open when the route was entered, but closed before the input started → false', async () => {
    codex('user_prompt_submit', OPENED());
    // The previous turn ends while this send waits for the input lock.
    sendsAfter(() => codex('stop', Date.now() - 1));
    expect(await body()).toMatchObject({ turnOpenAtSend: false });
  });

  it('(b) still open at the input start, closing after it → true', async () => {
    codex('user_prompt_submit', OPENED());
    sends(() => {}, () => codex('stop', Date.now() + 5));
    expect(await body()).toMatchObject({ turnOpenAtSend: true });
  });

  it('input → A stops → this message opens its own turn → true (read at the input, not after)', async () => {
    codex('user_prompt_submit', OPENED());
    sends(() => {}, () => {
      codex('stop', Date.now() + 5);
      codex('user_prompt_submit', Date.now() + 10);
    });
    expect(await body()).toMatchObject({ turnOpenAtSend: true });
  });

  it('the open turn replaced after the input start by the prompt of this message (a fold) → turnOpenAtSend: true', async () => {
    codex('user_prompt_submit', OPENED());
    // Issue #3330's re-open: an unmarked prompt of the same session replaces the running turn.
    sends(() => {}, () => codex('user_prompt_submit', Date.now() + 5));
    expect(await body()).toMatchObject({ turnOpenAtSend: true });
  });

  it('A re-opens → stops → input → false', async () => {
    codex('user_prompt_submit', OPENED());
    sendsAfter(() => {
      codex('user_prompt_submit', Date.now() - 500);
      codex('stop', Date.now() - 100);
    });
    expect(await body()).toMatchObject({ turnOpenAtSend: false });
  });

  it('(c) the send relaunched the session (a new generation) → no key', async () => {
    codex('user_prompt_submit', OPENED());
    sendsAfter(() => beginAgentEventGeneration(WORKTREE_ID, 'codex', undefined, Date.now()));
    expect(await body()).not.toHaveProperty('turnOpenAtSend');
  });

  it('a relaunch after the input start (a retyped body) is not known either → no key', async () => {
    codex('user_prompt_submit', OPENED());
    sends(() => {}, () => beginAgentEventGeneration(WORKTREE_ID, 'codex', undefined, Date.now() + 5));
    expect(await body()).not.toHaveProperty('turnOpenAtSend');
  });

  it('a sender that reports no input start leaves it unknown → no key', async () => {
    codex('user_prompt_submit', OPENED());
    sendsAfter(() => {}, false);
    expect(await body()).not.toHaveProperty('turnOpenAtSend');
  });

  it('a tool whose hooks do not report turns is not known → no key', async () => {
    codex('user_prompt_submit', OPENED());
    unregisterAgentEventSource('codex');
    try {
      expect(await body()).not.toHaveProperty('turnOpenAtSend');
    } finally {
      registerAgentEventSource(codexAgentEventSource);
    }
  });
});
