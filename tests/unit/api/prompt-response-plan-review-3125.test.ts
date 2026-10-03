/**
 * `POST /prompt-response` answers Command Code's plan review overlay (Issue #3125).
 *
 * Before #3125 the route found no dialog on the REVIEW screen and answered
 * `prompt_no_longer_active` while `wait` reported `command_code_plan_review`.
 * Real captures (1.74.0 rows from #3059 on a 1.58.0 body, and the 1.58.0 live
 * frames of #2763); only the tmux transport is stubbed.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
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

const DIR_3125 = path.resolve(__dirname, '../../fixtures/command-code-plan-review-3125');
const DIR_2763 = path.resolve(__dirname, '../../fixtures/command-code-plan-review-2763');
const LIVE_DIR = path.resolve(__dirname, '../../fixtures/command-code-live-2250');

const INITIAL = readFileSync(path.join(DIR_3125, 'plan-review-1-74-0-initial.txt'), 'utf8');
const ONE_COMMENT = readFileSync(path.join(DIR_3125, 'plan-review-1-74-0-one-comment.txt'), 'utf8');
const ACTION_FOCUS = readFileSync(path.join(DIR_2763, 'plan-review-action-focus-approve.txt'), 'utf8');
const APPROVE_CHOICE = readFileSync(path.join(DIR_2763, 'plan-review-approve-choice.txt'), 'utf8');
const COMMENT_BOX = readFileSync(path.join(DIR_2763, 'plan-review-comment-typing.txt'), 'utf8');
const IDLE = readFileSync(path.join(LIVE_DIR, 'turn-done-1490.txt'), 'utf8');

const WT = 'wt-3125-plan-review';
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

/** Every key sent, in order, as one list. */
async function wire(): Promise<string[]> {
  const { sendKeys, sendSpecialKeys } = await import('@/lib/tmux/tmux');
  const calls: Array<{ order: number; key: string }> = [];
  vi.mocked(sendKeys).mock.calls.forEach((call, i) => {
    const literal = (call[3] as { literal?: boolean } | undefined)?.literal === true;
    calls.push({ order: vi.mocked(sendKeys).mock.invocationCallOrder[i], key: literal ? `text:${call[1]}` : `key:${call[1]}` });
  });
  vi.mocked(sendSpecialKeys).mock.calls.forEach((call, i) => {
    calls.push({ order: vi.mocked(sendSpecialKeys).mock.invocationCallOrder[i], key: `key:${(call[1] as string[]).join('+')}` });
  });
  return calls.sort((a, b) => a.order - b.order).map((c) => c.key);
}

async function sessionsHit(): Promise<string[]> {
  const { sendKeys, sendSpecialKeys } = await import('@/lib/tmux/tmux');
  return [...vi.mocked(sendKeys).mock.calls, ...vi.mocked(sendSpecialKeys).mock.calls].map((c) => c[0] as string);
}

beforeEach(async () => {
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

describe('[#3125] a comment on the REVIEW screen', () => {
  it('text alone is a comment: Enter opens the box, the text goes literally, Enter pins it', async () => {
    const { status, data } = await respond(INITIAL, { answer: 'Also cover a divide(a, b) helper here.' });

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.planReview).toMatchObject({ action: 'comment', comment: 'Also cover a divide(a, b) helper here.', phase: 'body' });
    expect(await wire()).toEqual(['key:Enter', 'text:Also cover a divide(a, b) helper here.', 'key:Enter']);
    expect(new Set(await sessionsHit())).toEqual(new Set([SESSION]));
  });

  it('a comment that begins with a quick-comment key (`x`) is still typed into the box', async () => {
    const { data } = await respond(INITIAL, { answer: 'x is the wrong name here' });
    expect(data.success).toBe(true);
    expect(await wire()).toEqual(['key:Enter', 'text:x is the wrong name here', 'key:Enter']);
  });

  it('a newline does not pin half a comment: the text is sent as one line', async () => {
    const { data } = await respond(INITIAL, { answer: 'first line\nsecond line' });
    expect(data.success).toBe(true);
    expect(await wire()).toEqual(['key:Enter', 'text:first line second line', 'key:Enter']);
  });

  it('a bare number or yes is refused rather than pinned to the plan', async () => {
    for (const answer of ['1', 'yes', 'y', 'no']) {
      vi.clearAllMocks();
      const { data } = await respond(INITIAL, { answer });
      expect(data.success).toBe(false);
      expect(data.reason).toBe('plan_review_ambiguous_answer');
      expect(await wire()).toEqual([]);
    }
  });

  it('...unless the caller says it is a comment', async () => {
    const { data } = await respond(INITIAL, { answer: 'yes', planReviewAction: 'comment' });
    expect(data.success).toBe(true);
    expect(await wire()).toEqual(['key:Enter', 'text:yes', 'key:Enter']);
  });
});

describe('[#3125] submit / approve / cancel', () => {
  it('submit with text pins the comment and then sends ctrl+r', async () => {
    const { data } = await respond(INITIAL, { answer: 'Split the test file.', planReviewAction: 'submit' });
    expect(data.success).toBe(true);
    expect(await wire()).toEqual(['key:Enter', 'text:Split the test file.', 'key:Enter', 'key:C-r']);
  });

  it('submit alone sends ctrl+r when a comment is pending', async () => {
    const { data } = await respond(ONE_COMMENT, { planReviewAction: 'submit' });
    expect(data.success).toBe(true);
    expect(data.planReview).toMatchObject({ action: 'submit', pendingCommentsBefore: 1 });
    expect(await wire()).toEqual(['key:C-r']);
  });

  it('submit alone with nothing pending sends nothing', async () => {
    const { data } = await respond(INITIAL, { planReviewAction: 'submit' });
    expect(data.success).toBe(false);
    expect(data.reason).toBe('plan_review_nothing_to_submit');
    expect(await wire()).toEqual([]);
  });

  it('approve is ctrl+a and cancel is esc', async () => {
    expect((await respond(INITIAL, { planReviewAction: 'approve' })).data.success).toBe(true);
    expect(await wire()).toEqual(['key:C-a']);
    vi.clearAllMocks();
    expect((await respond(ONE_COMMENT, { planReviewAction: 'cancel' })).data.success).toBe(true);
    expect(await wire()).toEqual(['key:Escape']);
  });

  it('approve on the approve-with-comments radio confirms it with Enter', async () => {
    const { data } = await respond(APPROVE_CHOICE, { planReviewAction: 'approve' });
    expect(data.success).toBe(true);
    expect(data.planReview).toMatchObject({ phase: 'approve-choice', approveChoice: 'with-comments' });
    expect(await wire()).toEqual(['key:Enter']);
  });

  it('approve / cancel with text is a bad request and sends nothing', async () => {
    const { data } = await respond(INITIAL, { answer: 'looks good', planReviewAction: 'approve' });
    expect(data.success).toBe(false);
    expect(data.reason).toBe('plan_review_invalid_request');
    expect(await wire()).toEqual([]);
  });

  it('an unknown action is a 400', async () => {
    const { status } = await respond(INITIAL, { planReviewAction: 'merge' });
    expect(status).toBe(400);
    expect(await wire()).toEqual([]);
  });
});

describe('[#3125] refusals that send nothing', () => {
  it('with the focus on the action list (Enter would RUN the focused action)', async () => {
    const { data } = await respond(ACTION_FOCUS, { answer: 'please add tests' });
    expect(data.success).toBe(false);
    expect(data.reason).toBe('plan_review_busy');
    expect(await wire()).toEqual([]);
  });

  it('while someone is typing a comment in the pane', async () => {
    const { data } = await respond(COMMENT_BOX, { planReviewAction: 'cancel' });
    expect(data.success).toBe(false);
    expect(data.reason).toBe('plan_review_busy');
    expect(await wire()).toEqual([]);
  });

  it('--default has no meaning on the review', async () => {
    const { data } = await respond(INITIAL, { useDefault: true });
    expect(data.success).toBe(false);
    expect(data.reason).toBe('plan_review_invalid_request');
    expect(await wire()).toEqual([]);
  });

  it('a plan review action at a pane with no review on it', async () => {
    const { data } = await respond(IDLE, { planReviewAction: 'approve' });
    expect(data.success).toBe(false);
    expect(data.reason).toBe('plan_review_not_active');
    expect(await wire()).toEqual([]);
  });

  it('a plan review action when the pane could not be re-read', async () => {
    const { captureSessionOutputFresh } = await import('@/lib/session/cli-session');
    vi.mocked(captureSessionOutputFresh).mockRejectedValueOnce(new Error('tmux gone'));
    const response = await promptResponse(createRequest({ planReviewAction: 'approve' }), {
      params: Promise.resolve({ id: WT }),
    });
    const data = await response.json();
    expect(data.success).toBe(false);
    expect(data.reason).toBe('plan_review_not_active');
    expect(await wire()).toEqual([]);
  });

  it('a plan review action for another tool is a 400', async () => {
    const response = await promptResponse(
      createRequest({ cliTool: 'claude', planReviewAction: 'approve' }),
      { params: Promise.resolve({ id: WT }) },
    );
    expect(response.status).toBe(400);
  });

  it('text at an idle pane is still prompt_no_longer_active (the pre-#3125 path)', async () => {
    const { data } = await respond(IDLE, { answer: 'hello' });
    expect(data.success).toBe(false);
    expect(data.reason).toBe('prompt_no_longer_active');
    expect(await wire()).toEqual([]);
  });
});
