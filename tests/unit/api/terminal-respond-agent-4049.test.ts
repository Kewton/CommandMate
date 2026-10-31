/**
 * Issue #4049 (item 1), at the terminal route: both PROMPT_WAITING refusals
 * (the guard, and the re-check under the input lock) name ` --agent <tool>`
 * when the request's tool is not the worktree default and no instance was
 * named, so the `respond` they show reaches the waiting session. A request for
 * the default tool keeps the sentence exactly; an instance still names the
 * instance.
 *
 * The DB is in memory and the tools are stubbed; nothing touches tmux or disk.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// Issue #2865: these cases are not about `#{session_path}` ownership, so the
// check decides by session name as before (see the helper's docblock).
vi.mock('@/lib/tmux/session-ownership', async (importOriginal) =>
  (await import('@tests/unit/tmux/name-only-session-ownership')).nameOnlySessionOwnership(importOriginal)
);
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

// The real `promptWaitingMessage`: the sentence is what this file is about.
const isPromptWaiting = vi.fn();
vi.mock('@/lib/session/prompt-waiting-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session/prompt-waiting-guard')>()),
  isPromptWaiting: (...args: unknown[]) => isPromptWaiting(...args),
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

const WORKTREE_ID = 'wt-terminal-4049';

function call(body: Record<string, unknown>) {
  const request = new NextRequest(
    `http://localhost:3000/api/worktrees/${WORKTREE_ID}/terminal`,
    { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
  );
  return POST(request, { params: Promise.resolve({ id: WORKTREE_ID }) });
}

const UNDER_LOCK = new Error(
  'Failed to send message to Codex: Session x is waiting on a prompt (re-checked under the input lock); nothing was typed',
);

/** The two refusals: the guard before the send, and the one found under the lock. */
const REFUSALS = [
  ['the prompt guard', () => isPromptWaiting.mockResolvedValue({ waiting: true, blockedBy: 'scraper', reason: 'prompt_detected' })],
  ['the re-check under the input lock', () => sendMessage.mockRejectedValueOnce(UNDER_LOCK)],
] as const;

describe('[#4049] POST /terminal: the PROMPT_WAITING refusal names the requested tool', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);
    const worktree: Worktree = {
      id: WORKTREE_ID,
      name: 'Terminal 4049',
      path: '/path/to/wt',
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId: 'claude',
    };
    upsertWorktree(db, worktree);
    setAgentInstances(db, WORKTREE_ID, [{ id: 'codex-2', cliTool: 'codex', alias: 'Codex 2', order: 0 }]);
    vi.clearAllMocks();
    isPromptWaiting.mockResolvedValue({ waiting: false });
    sendMessage.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
  });

  it.each(REFUSALS)('positive: %s — a codex request on a claude worktree gets `--agent codex`', async (_name, refuse) => {
    refuse();
    const response = await call({ cliToolId: 'codex', command: 'hello' });
    expect(response.status).toBe(409);
    const json = await response.json();
    expect(json.code).toBe('PROMPT_WAITING');
    expect(json.error).toContain(`\`commandmate respond ${WORKTREE_ID} <answer> --agent codex\``);
  });

  it.each(REFUSALS)('negative: %s — the default tool keeps the sentence as before', async (_name, refuse) => {
    refuse();
    const response = await call({ cliToolId: 'claude', command: 'hello' });
    expect(response.status).toBe(409);
    const json = await response.json();
    expect(json.error).toContain(`Answer the prompt first: \`commandmate respond ${WORKTREE_ID} <answer>\`.`);
    expect(json.error).not.toContain('--agent');
  });

  it.each(REFUSALS)('negative: %s — an instance names the instance only', async (_name, refuse) => {
    refuse();
    const response = await call({ cliToolId: 'codex', command: 'hello', instanceId: 'codex-2' });
    expect(response.status).toBe(409);
    const json = await response.json();
    expect(json.error).toContain(`\`commandmate respond ${WORKTREE_ID} <answer> --instance codex-2\``);
    expect(json.error).not.toContain('--agent');
  });
});
