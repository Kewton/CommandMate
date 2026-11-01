/**
 * Issue #4063 (part B-2), at the terminal route: Command Code's plan review
 * refusal is answered, not thrown away.
 *
 * Before #4063 the route mapped only PROMPT_WAITING; the plan review refusal
 * (`not-sent (plan-review)`, #3772) fell through to the fixed 500
 * `Failed to send command to terminal`, so the one way out of the review —
 * `respond … "<text>"`, then `--plan-review …` — never reached the caller.
 *
 * Decision B-2: 409 (a state of the session, like PROMPT_WAITING) with
 * `code: PLAN_REVIEW_SEND_REFUSED` and the sentence, whose `respond` is aimed
 * by `respondTargetFlags`' rule (B-1). Positive: a claude worktree's Command
 * Code primary gets `--agent command-code`, which resolves to that primary.
 * Negative: a Command Code worktree's primary is bare, `command-code-2` names
 * its instance, and any other failure stays the fixed 500.
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
import { commandCodePlanReviewSendMessage } from '@/lib/cli-tools/command-code';
import { resolveSessionTarget } from '@/lib/session/resolve-session-target';
import type { CLIToolType } from '@/lib/cli-tools/types';

const CLAUDE_WT = 'wt-terminal-4063-claude';
const CC_WT = 'wt-terminal-4063-cc';

function call(worktreeId: string, body: Record<string, unknown>) {
  const request = new NextRequest(
    `http://localhost:3000/api/worktrees/${worktreeId}/terminal`,
    { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
  );
  return POST(request, { params: Promise.resolve({ id: worktreeId }) });
}

/** What `CommandCodeTool.sendMessage` throws at the review: its sentence (no request known), wrapped, with the code. */
function planReviewThrow(worktreeId: string, instanceId?: string): Error {
  return Object.assign(
    new Error(`Failed to send message to Command Code: ${commandCodePlanReviewSendMessage(worktreeId, instanceId)}`),
    { code: 'PLAN_REVIEW_SEND_REFUSED' },
  );
}

function respondFlags(text: string): { instanceId?: string; requestedCliTool?: CLIToolType } {
  const match = /`commandmate respond \S+ "<text>"((?: --(?:instance|agent) \S+)?)`/.exec(text);
  expect(match).not.toBeNull();
  const instance = / --instance (\S+)/.exec(match![1])?.[1];
  const agent = / --agent (\S+)/.exec(match![1])?.[1] as CLIToolType | undefined;
  return { ...(instance ? { instanceId: instance } : {}), ...(agent ? { requestedCliTool: agent } : {}) };
}

describe('[#4063] POST /terminal: the plan review refusal', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);
    for (const [id, cliToolId] of [
      [CLAUDE_WT, 'claude'],
      [CC_WT, 'command-code'],
    ] as const) {
      const worktree: Worktree = {
        id,
        name: id,
        path: `/path/to/${id}`,
        repositoryPath: '/path/to/repo',
        repositoryName: 'repo',
        cliToolId,
      };
      upsertWorktree(db, worktree);
    }
    setAgentInstances(db, CC_WT, [{ id: 'command-code-2', cliTool: 'command-code', alias: 'CC 2', order: 0 }]);
    vi.clearAllMocks();
    isPromptWaiting.mockResolvedValue({ waiting: false });
    sendMessage.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
  });

  it('positive: a claude worktree\'s Command Code primary — 409, the code, and `--agent command-code`', async () => {
    sendMessage.mockRejectedValueOnce(planReviewThrow(CLAUDE_WT));
    const response = await call(CLAUDE_WT, { cliToolId: 'command-code', command: 'hello' });
    expect(response.status).toBe(409);
    const json = await response.json();
    expect(json.code).toBe('PLAN_REVIEW_SEND_REFUSED');
    expect(json.error).not.toBe('Failed to send command to terminal');
    expect(json.error).toContain(`\`commandmate respond ${CLAUDE_WT} "<text>" --agent command-code\``);
    expect(json.error).toContain('`--plan-review submit`');
    expect(resolveSessionTarget(db, CLAUDE_WT, respondFlags(json.error))).toMatchObject({
      cliToolId: 'command-code',
      instanceId: 'command-code',
    });
  });

  it('negative: a Command Code worktree\'s primary — the bare sentence', async () => {
    sendMessage.mockRejectedValueOnce(planReviewThrow(CC_WT));
    const response = await call(CC_WT, { cliToolId: 'command-code', command: 'hello' });
    expect(response.status).toBe(409);
    const json = await response.json();
    expect(json.error).toBe(commandCodePlanReviewSendMessage(CC_WT));
  });

  it('negative: `command-code-2` names its instance', async () => {
    sendMessage.mockRejectedValueOnce(planReviewThrow(CC_WT, 'command-code-2'));
    const response = await call(CC_WT, { cliToolId: 'command-code', command: 'hello', instanceId: 'command-code-2' });
    expect(response.status).toBe(409);
    const json = await response.json();
    expect(json.error).toContain(`\`commandmate respond ${CC_WT} "<text>" --instance command-code-2\``);
    expect(json.error).not.toContain('--agent');
  });

  it('negative: any other failure stays the fixed 500', async () => {
    sendMessage.mockRejectedValueOnce(new Error('Failed to send message to Command Code: tmux exploded'));
    const response = await call(CLAUDE_WT, { cliToolId: 'command-code', command: 'hello' });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to send command to terminal' });
  });
});
