/**
 * `POST /prompt-response` confirms Command Code's `AskUserQuestion` Review page
 * for a human (Issue #4313 (b), B-1).
 *
 * In the #4228 UAT the Review page (`❯ 1. Submit` / `2. Cancel`) stayed up for
 * eight minutes after Auto-Yes answered the question: the route refused it with
 * `unsupported_dialog_layout` and `respond` could not finish the question.
 *
 *  1. `answer: "1"` on the page with the `❯` on Submit sends exactly ONE key,
 *     `Enter` — the keystroke measured to send the answers (1.54.1,
 *     `docs/design/command-code-1541-askuserquestion.md` §4). No digit, and no
 *     second Enter that would land on whatever the tool draws next;
 *  2. `answer: "2"` moves the cursor to Cancel and presses Enter (the `↓` on
 *     this page is not measured on 1.54.1 nor 1.88.2; UAT);
 *  3. 陰性対照: the page reached with answers missing is still refused, with no
 *     key sent.
 *
 * Nothing in the detection layer is stubbed; only tmux and the database are.
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
  // Issue #4303 (merged from develop): the agent holds the pane.
  readPaneForeground: async () => 'other' as const,
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
// The two records an answer leaves (`prompt_answered_human` and the audit row,
// `answer-delivery.ts`), spied so a refusal can be shown to leave neither.
vi.mock('@/lib/tasks/task-transition-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tasks/task-transition-service')>();
  return { ...actual, applyEventToActiveTask: vi.fn(actual.applyEventToActiveTask) };
});
vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return { ...actual, recordAnsweredPrompt: vi.fn(actual.recordAnsweredPrompt) };
});
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

const DIR = path.resolve(__dirname, '../../fixtures/command-code-askuserquestion-2754');
const REVIEW = readFileSync(path.join(DIR, 'review-page-submit-cancel.txt'), 'utf8');
const REVIEW_UNANSWERED = readFileSync(path.join(DIR, 'review-page-unanswered-warning.txt'), 'utf8');

const WT = 'wt-4313-review';
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

async function keystrokes() {
  const { sendKeys, sendSpecialKeys } = await import('@/lib/tmux/tmux');
  return {
    text: vi.mocked(sendKeys).mock.calls,
    special: vi.mocked(sendSpecialKeys).mock.calls.map((call) => [call[0], call[1]]),
  };
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

describe('[#4313] respond on the Review page', () => {
  it('answer 1 (Submit, under the cursor) sends exactly one Enter', async () => {
    const { status, data } = await respond(REVIEW, { answer: '1' });

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    const keys = await keystrokes();
    expect(keys.text).toEqual([]);
    expect(keys.special).toEqual([[SESSION, ['Enter']]]);
  });

  it('--default resolves to Submit, the option under the cursor', async () => {
    const { data } = await respond(REVIEW, { useDefault: true });

    expect(data.success).toBe(true);
    expect(data.resolved).toMatchObject({ via: 'default', optionNumber: 1 });
    expect((await keystrokes()).special).toEqual([[SESSION, ['Enter']]]);
  });

  it('answer 2 (Cancel) moves the cursor down and presses Enter once', async () => {
    const { data } = await respond(REVIEW, { answer: '2' });

    expect(data.success).toBe(true);
    const keys = await keystrokes();
    expect(keys.text).toEqual([]);
    expect(keys.special).toEqual([[SESSION, ['Down', 'Enter']]]);
  });
});

describe('[#4313] 陰性対照', () => {
  it('the page reached with answers missing is refused and gets no key', async () => {
    const { status, data } = await respond(REVIEW_UNANSWERED, { answer: '1' });

    expect(status).toBe(200);
    expect(data.success).toBe(false);
    expect(data.reason).toBe('unsupported_dialog_layout');
    expect(await keystrokes()).toEqual({ text: [], special: [] });
  });

  it('free text aimed at the page is refused and gets no key', async () => {
    const { data } = await respond(REVIEW, { answer: 'looks good' });

    expect(data.success).toBe(false);
    expect(await keystrokes()).toEqual({ text: [], special: [] });
  });
});

/** How many times an answer was recorded: `prompt_answered_human` and the audit row. */
async function records() {
  const { applyEventToActiveTask } = await import('@/lib/tasks/task-transition-service');
  const { recordAnsweredPrompt } = await import('@/lib/db');
  return {
    answeredHuman: vi.mocked(applyEventToActiveTask).mock.calls
      .filter((call) => call[4] === 'prompt_answered_human').length,
    audit: vi.mocked(recordAnsweredPrompt).mock.calls.length,
  };
}

describe('[#4313 再指示 1] on the Review page the answer is 1 or 2, nothing else', () => {
  it('陽性対照: answer 1 is recorded once (what the refusals below must not leave)', async () => {
    const { data } = await respond(REVIEW, { answer: '1' });
    expect(data.success).toBe(true);
    expect(await records()).toEqual({ answeredHuman: 1, audit: 1 });
  });

  it.each(['3', '0', '12'])('answer %s is refused before any key, and nothing is recorded', async (answer) => {
    const { status, data } = await respond(REVIEW, { answer });

    expect(status).toBe(200);
    expect(data.success).toBe(false);
    expect(data.reason).toBe('unresolvable_answer');
    expect(await keystrokes()).toEqual({ text: [], special: [] });
    expect(await records()).toEqual({ answeredHuman: 0, audit: 0 });
  });

  it('answer 3 with `submitMode: answer_only` is refused the same way', async () => {
    const { data } = await respond(REVIEW, { answer: '3', submitMode: 'answer_only' });

    expect(data.success).toBe(false);
    expect(await keystrokes()).toEqual({ text: [], special: [] });
    expect(await records()).toEqual({ answeredHuman: 0, audit: 0 });
  });
});

describe('[#4313 B-1] /prompt-response: the page seen only by the sender’s own read is refused and recorded nowhere', () => {
  it('the first capture failed, the sender’s read is the page, answer 1: no key, no task event, no audit row', async () => {
    const { captureSessionOutputFresh } = await import('@/lib/session/cli-session');
    const { capturePane } = await import('@/lib/tmux/tmux');
    vi.mocked(captureSessionOutputFresh).mockRejectedValue(new Error('capture failed'));
    vi.mocked(capturePane).mockResolvedValue(REVIEW);

    const response = await promptResponse(createRequest({ answer: '1' }), { params: Promise.resolve({ id: WT }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(false);
    expect(await keystrokes()).toEqual({ text: [], special: [] });
    expect(await records()).toEqual({ answeredHuman: 0, audit: 0 });
  });

  it('the page with no readable cursor, answer 1: refused before the sender, nothing recorded', async () => {
    const { data } = await respond(REVIEW.replace(/❯ 1\. Submit/, '  1. Submit'), { answer: '1' });

    expect(data.success).toBe(false);
    expect(data.reason).toBe('unsupported_dialog_layout');
    expect(await keystrokes()).toEqual({ text: [], special: [] });
    expect(await records()).toEqual({ answeredHuman: 0, audit: 0 });
  });
});
