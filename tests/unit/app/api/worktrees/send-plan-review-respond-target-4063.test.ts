/**
 * Issue #4063 (part B-1), at the send route: Command Code's plan review
 * refusal names the session that is waiting.
 *
 * Before #4063 the sentence came from the tool layer, which does not know the
 * request: a `send --agent command-code` (no instance) on a claude worktree got
 * a bare `commandmate respond <id> "<text>"`, which the CLI resolves to the
 * worktree default — claude, not the Command Code showing the review.
 *
 * Positive: that request's 500 names `--agent command-code`, and the flags
 * resolve (`resolveSessionTarget`) to the Command Code primary. Negative: on a
 * Command Code worktree the primary keeps the bare sentence; `command-code-2`
 * keeps `--instance command-code-2`; other failures keep their text; the
 * status stays 500 (decision: send is unchanged).
 *
 * tmux and the send service are stood in for; the DB is in memory.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// Issue #2865: these cases are not about `#{session_path}` ownership, so the
// check decides by session name as before (see the helper's docblock).
vi.mock('@/lib/tmux/session-ownership', async (importOriginal) =>
  (await import('@tests/unit/tmux/name-only-session-ownership')).nameOnlySessionOwnership(importOriginal)
);
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';
import type { NextRequest } from 'next/server';

const hasSession = vi.fn(async (_sessionName: string) => false);
const createSession = vi.fn(async () => {});
const sendKeys = vi.fn(async () => {});
const capturePane = vi.fn(async () => '');
const killSession = vi.fn(async () => true);

vi.mock('@/lib/tmux/tmux', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tmux/tmux')>();
  return {
    ...actual,
    hasSession: (...args: [string]) => hasSession(...args),
    createSession: (...args: unknown[]) => createSession(...(args as [])),
    sendKeys: (...args: unknown[]) => sendKeys(...(args as [])),
    capturePane: (...args: unknown[]) => capturePane(...(args as [])),
    killSession: (...args: unknown[]) => killSession(...(args as [])),
    listSessions: vi.fn(async () => []),
    reconcileSessionGeometry: vi.fn(async () => false),
  };
});

/**
 * The send itself is not this file's subject and it is the one step that would
 * otherwise pull the detection graph in. Stubbing it also makes "did the route
 * decide to send at all?" a single assertion.
 */
const sendUserMessage = vi.fn();
vi.mock('@/lib/session/send-user-message', () => ({
  sendUserMessage: (...args: unknown[]) => sendUserMessage(...args),
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
import { commandCodePlanReviewSendMessage } from '@/lib/cli-tools/command-code';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import { resolveSessionTarget } from '@/lib/session/resolve-session-target';
import type { CLIToolType } from '@/lib/cli-tools/types';

const CLAUDE_WT = 'wt-4063-claude';
const CC_WT = 'wt-4063-cc';

function post(worktreeId: string, body: unknown) {
  const request = new Request(`http://localhost:3000/api/worktrees/${worktreeId}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return sendMessage(request as unknown as NextRequest, {
    params: Promise.resolve({ id: worktreeId }),
  });
}

/** The service as it answers a plan review refusal: the tool's wrapped throw, `not-sent (plan-review)`. */
function refuseWithPlanReview(): void {
  sendUserMessage.mockImplementation(
    async (
      _db: unknown,
      params: {
        worktreeId: string;
        instanceId?: string;
        onAttempt?: (attempt: { state: string; reason: string }) => void;
      },
    ) => {
      params.onAttempt?.({ state: 'not-sent', reason: 'plan-review' });
      return {
        ok: false,
        stage: 'send',
        error: `Failed to send message to Command Code: ${commandCodePlanReviewSendMessage(params.worktreeId, params.instanceId)}`,
      };
    },
  );
}

/** The flags of the `commandmate respond … "<text>"` the sentence names. */
function respondFlags(text: string): { instanceId?: string; requestedCliTool?: CLIToolType } {
  const match = /`commandmate respond \S+ "<text>"((?: --(?:instance|agent) \S+)?)`/.exec(text);
  expect(match).not.toBeNull();
  const instance = / --instance (\S+)/.exec(match![1])?.[1];
  const agent = / --agent (\S+)/.exec(match![1])?.[1] as CLIToolType | undefined;
  return { ...(instance ? { instanceId: instance } : {}), ...(agent ? { requestedCliTool: agent } : {}) };
}

describe('[#4063] POST /send: the plan review refusal names the waiting session', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    vi.clearAllMocks();
    hasSession.mockResolvedValue(true);
    capturePane.mockResolvedValue('');
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
    refuseWithPlanReview();
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    db.close();
  });

  async function refusalOf(worktreeId: string, body: Record<string, unknown>): Promise<string> {
    const response = await post(worktreeId, { content: 'hello', ...body });
    expect(response.status).toBe(500);
    const json = (await response.json()) as { error: string };
    expect(json.error).toContain('Command Code is showing a plan review (REVIEW)');
    return json.error;
  }

  it('positive: `--agent command-code` on a claude worktree names `--agent command-code`', async () => {
    const error = await refusalOf(CLAUDE_WT, { cliToolId: 'command-code' });
    expect(error).toContain(`\`commandmate respond ${CLAUDE_WT} "<text>" --agent command-code\``);
    expect(resolveSessionTarget(db, CLAUDE_WT, respondFlags(error))).toMatchObject({
      cliToolId: 'command-code',
      instanceId: 'command-code',
    });
    // The bare sentence before #4063 reached the worktree default instead.
    expect(resolveSessionTarget(db, CLAUDE_WT, {})).toMatchObject({ cliToolId: 'claude' });
  });

  it('positive: the primary named by its own id (#868) on a claude worktree names the tool too', async () => {
    const error = await refusalOf(CLAUDE_WT, { cliToolId: 'command-code', instanceId: 'command-code' });
    expect(resolveSessionTarget(db, CLAUDE_WT, respondFlags(error))).toMatchObject({
      cliToolId: 'command-code',
      instanceId: 'command-code',
    });
  });

  it('negative: the primary on a Command Code worktree keeps the bare sentence', async () => {
    const error = await refusalOf(CC_WT, { cliToolId: 'command-code' });
    expect(error).toContain(`\`commandmate respond ${CC_WT} "<text>"\`, then`);
    expect(error).not.toContain('--agent');
    expect(error).not.toContain('--instance');
  });

  it('negative: `command-code-2` keeps `--instance command-code-2`', async () => {
    const error = await refusalOf(CC_WT, { cliToolId: 'command-code', instanceId: 'command-code-2' });
    expect(error).toContain(`\`commandmate respond ${CC_WT} "<text>" --instance command-code-2\``);
    expect(error).not.toContain('--agent');
  });

  it('negative: a failure that is not the plan review keeps its text', async () => {
    sendUserMessage.mockImplementation(
      async (_db: unknown, params: { onAttempt?: (attempt: { state: string; reason: string }) => void }) => {
        params.onAttempt?.({ state: 'indeterminate', reason: 'send-error' });
        return { ok: false, stage: 'send', error: 'Failed to send message to Command Code: boom' };
      },
    );
    const response = await post(CLAUDE_WT, { content: 'hello', cliToolId: 'command-code' });
    expect(response.status).toBe(500);
    const json = (await response.json()) as { error: string };
    expect(json.error).toContain('Failed to send message to Command Code: boom');
    expect(json.error).not.toContain('--agent');
  });
});
