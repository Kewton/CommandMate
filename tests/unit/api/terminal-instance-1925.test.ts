/**
 * terminal route: instance targeting (Issue #1925, design §4 D5 決定 3).
 * @vitest-environment node
 *
 * This route took a `cliToolId` and nothing else, so it derived the session name
 * from `getSessionName(id)` — always the primary instance. Every non-primary
 * session was unreachable from it (#1906): a worktree running `codex` and
 * `codex-2` could only ever be typed into on `codex`.
 *
 * Sending is a side effect, so the contradiction rule here is the strict one:
 * a caller naming an agent the roster disagrees with is refused rather than
 * resolved to a guess. Text typed into the wrong session cannot be taken back.
 *
 * Issue #1906 moved the send off `sendMessageWithSubmitVerification` (which the
 * route called with a session name it derived itself) and onto
 * `ICLITool.sendMessage`, which takes the worktree id and the instance id. The
 * assertions follow: "addressed the right session" is now "the right tool's
 * `sendMessage` was called with the right instance id".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import type { Worktree } from '@/types/models';

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(true),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));

vi.mock('@/lib/cli-tools/submit-verified-sender', () => ({
  sendMessageWithSubmitVerification: vi.fn().mockResolvedValue(undefined),
}));

// Issue #1906: the route sends through the tool. Real `CLIToolManager`
// instances would drive tmux for real, so the send/liveness pair is stubbed
// while everything the test is actually about — roster resolution — stays real.
const sendMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (id: string) => ({
        id,
        getSessionName: (worktreeId: string, instanceId?: string) =>
          instanceId && instanceId !== id ? `mcbd-${id}-${worktreeId}-${instanceId.split('-').pop()}` : `mcbd-${id}-${worktreeId}`,
        isRunning: async () => true,
        sendMessage: (...args: unknown[]) => sendMessage(id, ...args),
      }),
    }),
  },
}));

// Issue #1906: the prompt guard runs before the send; it would otherwise
// capture a pane that does not exist.
vi.mock('@/lib/session/prompt-waiting-guard', () => ({
  isPromptWaiting: vi.fn().mockResolvedValue({ waiting: false }),
  promptWaitingMessage: vi.fn(() => 'waiting'),
  PROMPT_WAITING_CODE: 'PROMPT_WAITING',
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
    setMockDb: (db: Database.Database) => { mockDb = db; },
    closeDbInstance: () => { mockDb?.close(); mockDb = null; },
  };
});

import { POST } from '@/app/api/worktrees/[id]/terminal/route';

const WORKTREE_ID = 'wt-terminal';

function call(body: Record<string, unknown>) {
  const request = new NextRequest(
    `http://localhost:3000/api/worktrees/${WORKTREE_ID}/terminal`,
    { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
  );
  return POST(request, { params: Promise.resolve({ id: WORKTREE_ID }) });
}

describe('POST /api/worktrees/:id/terminal — instance targeting', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    const worktree: Worktree = {
      id: WORKTREE_ID,
      name: 'Terminal',
      path: '/path/to/wt',
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId: 'claude',
    };
    upsertWorktree(db, worktree);
    setAgentInstances(db, WORKTREE_ID, [
      { id: 'codex-2', cliTool: 'codex', alias: 'Codex 2', order: 0 },
    ]);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
  });

  it('addresses the named instance instead of the primary one', async () => {
    const response = await call({ cliToolId: 'codex', command: 'hello', instanceId: 'codex-2' });

    expect(response.status).toBe(200);
    // The roster says `codex-2` is a codex instance, so the codex tool is the
    // one driven and the instance id is carried through to it — #868 turns that
    // pair into the non-primary session name.
    expect(sendMessage).toHaveBeenCalledWith('codex', WORKTREE_ID, 'hello', 'codex-2');
  });

  /** The pre-#1925 shape stays exactly as it was: no instance means primary. */
  it('addresses the primary instance when no instance is named', async () => {
    const response = await call({ cliToolId: 'claude', command: 'hello' });

    expect(response.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledWith('claude', WORKTREE_ID, 'hello', undefined);
  });

  it('refuses a cliToolId that contradicts the roster, without typing anything', async () => {
    const response = await call({ cliToolId: 'claude', command: 'hello', instanceId: 'codex-2' });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'instance_tool_conflict',
      instanceId: 'codex-2',
      rosterCliTool: 'codex',
      requestedCliTool: 'claude',
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  /** The id lands in a tmux session name, so it gets the same check as everywhere else. */
  it('rejects a malformed instanceId', async () => {
    const response = await call({ cliToolId: 'claude', command: 'hello', instanceId: 'bad id!' });
    expect(response.status).toBe(400);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('rejects a non-string instanceId', async () => {
    const response = await call({ cliToolId: 'claude', command: 'hello', instanceId: 42 });
    expect(response.status).toBe(400);
  });
});
