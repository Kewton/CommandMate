/**
 * Issue #4031: a plan review answer whose input was taken part-way is answered
 * through the same error table as every other answer (`promptAnswerErrorResponse`).
 *
 * Before this, `answerPlanReviewIfShown`'s catch turned `PlanReviewInputLostError`
 * into a bare 500 with neither `reason` nor `keysSent`, so `respond --plan-review`
 * never printed the InputLost warning.
 *
 * - positive: stopped after a step was sent → 500, `answer_input_lost`, `keysSent: true`
 * - negative: stopped before the first step → `answer_not_delivered`, `keysSent: false`
 * - negative: any other transport error keeps the plain 500
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// Issue #2865: these cases are not about `#{session_path}` ownership, so the
// check decides by session name as before (see the helper's docblock).
vi.mock('@/lib/tmux/session-ownership', async (importOriginal) =>
  (await import('@tests/unit/tmux/name-only-session-ownership')).nameOnlySessionOwnership(importOriginal)
);
import { POST as promptResponse } from '@/app/api/worktrees/[id]/prompt-response/route';
import type { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';

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
    closeDbInstance: () => {
      if (mockDb) { mockDb.close(); mockDb = null; }
    },
  };
});

// The tmux transport, and the ONLY thing between the route and the terminal:
// every key the route decides to send lands in one of these two spies.
vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(''),
}));

vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn().mockResolvedValue(''),
  captureSessionOutputFresh: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/hooks/structured-decision-response', () => ({
  answerStructuredDecision: vi.fn().mockResolvedValue({
    kind: 'not-applicable',
    reason: 'no-pending-decision',
  }),
}));
vi.mock('@/lib/session/agent-event-state', () => ({ getAskUserQuestion: vi.fn(() => null) }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: vi.fn(() => ({
      getTool: () => ({
        name: 'Command Code',
        isRunning: vi.fn().mockResolvedValue(true),
        getSessionName: (id: string, instanceId?: string) =>
          `cm-${id}-${instanceId ?? 'command-code'}`,
      }),
    })),
  },
}));

import {
  invalidateInstanceInput,
  resetInstanceInputLocks,
} from '@/lib/session/instance-input-lock';
import { PlanReviewInputLostError } from '@/lib/cli-tools/command-code-plan-review';
import { planReviewAnswerError } from '@/app/api/worktrees/[id]/prompt-response/plan-review';
import {
  promptAnswerErrorResponse,
  PromptAnswerInputLostError,
  PromptAnswerNotDeliveredError,
} from '@/lib/prompt-answer-errors';

const INITIAL = readFileSync(
  path.resolve(__dirname, '../../fixtures/command-code-plan-review-3125/plan-review-1-74-0-initial.txt'),
  'utf8',
);

const WT = 'wt-4031-plan-review';
const SESSION = `cm-${WT}-command-code`;

function createRequest(body: Record<string, unknown>): NextRequest {
  return new Request(`http://localhost:3000/api/worktrees/${WT}/prompt-response`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cliTool: 'command-code', ...body }),
  }) as unknown as NextRequest;
}

async function respond(raw: string, body: Record<string, unknown>) {
  const { captureSessionOutputFresh } = await import('@/lib/session/cli-session');
  vi.mocked(captureSessionOutputFresh).mockResolvedValue(raw);
  const response = await promptResponse(createRequest(body), {
    params: Promise.resolve({ id: WT }),
  });
  return { status: response.status, data: await response.json() };
}

beforeEach(async () => {
  resetInstanceInputLocks();
  const db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  const worktree: Worktree = {
    id: WT,
    name: 'Test Worktree',
    path: '/path/to/test',
    repositoryPath: '/path/to/repo',
    repositoryName: 'TestRepo',
    cliToolId: 'command-code',
  };
  upsertWorktree(db, worktree);
  vi.clearAllMocks();
});

afterEach(() => {
  resetInstanceInputLocks();
});

describe('[#4031] /prompt-response: a plan review stopped part-way', () => {
  it('positive: the session is replaced after the first step — 500, answer_input_lost, keysSent: true', async () => {
    const { sendKeys, sendSpecialKeys } = await import('@/lib/tmux/tmux');
    // The first step (Enter that opens the comment box) goes out, then — from
    // outside the answer, during the wait before the next step — the session
    // is replaced: the ticket the answer holds is no longer current.
    let firstStepSent!: () => void;
    const firstStep = new Promise<void>((resolve) => (firstStepSent = resolve));
    vi.mocked(sendSpecialKeys).mockImplementationOnce(async () => {
      firstStepSent();
    });
    const answering = respond(INITIAL, { answer: 'please split this step' });
    await firstStep;
    invalidateInstanceInput(SESSION);
    const { status, data } = await answering;

    expect(status).toBe(500);
    expect(data).toMatchObject({ reason: 'answer_input_lost', keysSent: true });
    expect(String(data.error)).toContain('answer_input_lost');
    expect(vi.mocked(sendSpecialKeys)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendKeys)).not.toHaveBeenCalled();
  });

  it('negative: the ticket stays current — every step is sent and the answer succeeds', async () => {
    const { status, data } = await respond(INITIAL, { answer: 'please split this step' });
    expect(status).toBe(200);
    expect(data.success).toBe(true);
  });

  it('negative: any other transport error keeps the plain 500, with no reason', async () => {
    const { sendSpecialKeys } = await import('@/lib/tmux/tmux');
    vi.mocked(sendSpecialKeys).mockRejectedValueOnce(new Error('no server running'));
    const { status, data } = await respond(INITIAL, { answer: 'please split this step' });
    expect(status).toBe(500);
    expect(data.error).toBe('Failed to send answer to tmux: no server running');
    expect(data.reason).toBeUndefined();
    expect(data.keysSent).toBeUndefined();
  });
});

describe('[#4031] planReviewAnswerError', () => {
  it('positive: stepsSent >= 1 becomes PromptAnswerInputLostError (500, keysSent: true), cause kept', () => {
    const original = new PlanReviewInputLostError(SESSION, 2);
    const wrapped = planReviewAnswerError(original, SESSION);
    expect(wrapped).toBeInstanceOf(PromptAnswerInputLostError);
    expect((wrapped as Error).cause).toBe(original);
    expect(promptAnswerErrorResponse(wrapped, 'prompt-response')).toMatchObject({
      status: 500,
      body: { reason: 'answer_input_lost', keysSent: true },
    });
  });

  it('negative: stepsSent === 0 is not delivered (keysSent: false), not InputLost', () => {
    const wrapped = planReviewAnswerError(new PlanReviewInputLostError(SESSION, 0), SESSION);
    expect(wrapped).toBeInstanceOf(PromptAnswerNotDeliveredError);
    expect(wrapped).not.toBeInstanceOf(PromptAnswerInputLostError);
    const mapped = promptAnswerErrorResponse(wrapped, 'prompt-response');
    expect(mapped).toMatchObject({
      status: 200,
      body: { success: false, reason: 'answer_not_delivered', keysSent: false },
    });
    expect(String(mapped?.body.message)).not.toContain('answer_input_lost');
  });

  it('negative: an error that is not the plan review one is returned as it is', () => {
    const other = new Error('no server running');
    expect(planReviewAnswerError(other, SESSION)).toBe(other);
  });
});
