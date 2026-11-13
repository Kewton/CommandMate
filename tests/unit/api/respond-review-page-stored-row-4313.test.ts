/**
 * `POST /respond { messageId }` on Command Code's Review page (Issue #4313
 * 再指示 2).
 *
 * The stored row is the question BEFORE the page — its own three options, still
 * pending — while the screen read right before the send (`screenAtSend`) is the
 * Review page (`❯ 1. Submit` / `2. Cancel`). The route validates the number
 * against the stored row, so `3` passed it, and the sender's Review refusal
 * looked at the payload only: the `3` was typed at the page and the row was
 * recorded answered (`prompt_answered_human`).
 *
 * The rule: when the screen at the send is the Review page, anything but `1` /
 * `2` sends no key and records nothing, whatever the payload. 陰性対照:
 * `1` / `2` reach the page once (the cursor and one Enter, as on
 * `/prompt-response`) and are recorded as before.
 *
 * Nothing in the detection layer or the sender is stubbed; only tmux, the
 * capture and the database are. Built on the 1.54.1 live capture; 1.88.2 is
 * not captured (UAT).
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/tmux/session-ownership', async (importOriginal) =>
  (await import('@tests/unit/tmux/name-only-session-ownership')).nameOnlySessionOwnership(importOriginal)
);
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/tmux/tmux', () => ({
  // Issue #4303 (merged from develop): the agent holds the pane.
  readPaneForeground: async () => 'other' as const,
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn().mockResolvedValue(''),
  captureSessionOutputFresh: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/tasks/task-transition-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tasks/task-transition-service')>();
  return { ...actual, applyEventToActiveTask: vi.fn(actual.applyEventToActiveTask) };
});
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: vi.fn(() => ({
      getTool: () => ({
        name: 'Command Code',
        isRunning: vi.fn().mockResolvedValue(true),
        getSessionName: (id: string, instanceId?: string) => `cm-${id}-${instanceId ?? 'command-code'}`,
      }),
    })),
  },
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
    setMockDb: (database: Database.Database) => { mockDb = database; },
    closeDbInstance: () => { mockDb = null; },
  };
});

import { POST as respond } from '@/app/api/worktrees/[id]/respond/route';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree, createMessage, getMessageById } from '@/lib/db';
import { captureSessionOutputFresh } from '@/lib/session/cli-session';
import { capturePane, sendKeys, sendSpecialKeys } from '@/lib/tmux/tmux';
import { applyEventToActiveTask } from '@/lib/tasks/task-transition-service';
import type { ChatMessage, PromptData, Worktree } from '@/types/models';

const WT = 'wt-4313-respond-review';
const DIR = path.resolve(__dirname, '../../fixtures/command-code-askuserquestion-2754');
const REVIEW = readFileSync(path.join(DIR, 'review-page-submit-cancel.txt'), 'utf8');

/** The single-select question the page follows: three rows, saved before the page. */
const QUESTION: PromptData = {
  type: 'multiple_choice',
  question: 'Which option?',
  options: [
    { number: 1, label: 'Alpha', isDefault: true },
    { number: 2, label: 'Beta', isDefault: false },
    { number: 3, label: 'Gamma', isDefault: false },
  ],
  status: 'pending',
  isAskUserQuestion: true,
} as PromptData;

let db: Database.Database;

function post(body: Record<string, unknown>): Promise<Response> {
  const request = new Request(`http://localhost:3000/api/worktrees/${WT}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return respond(request, { params: Promise.resolve({ id: WT }) }) as unknown as Promise<Response>;
}

function storedQuestion(): ChatMessage {
  return createMessage(db, {
    worktreeId: WT,
    cliToolId: 'command-code',
    role: 'assistant',
    content: QUESTION.question,
    messageType: 'prompt',
    promptData: QUESTION,
    timestamp: new Date(),
  } as unknown as ChatMessage);
}

function humanAnswerEvents(): number {
  return vi.mocked(applyEventToActiveTask).mock.calls.filter((call) => call[4] === 'prompt_answered_human').length;
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(captureSessionOutputFresh).mockResolvedValue(REVIEW);
  vi.mocked(capturePane).mockResolvedValue(REVIEW);
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  const worktree: Worktree = {
    id: WT,
    name: 'respond 4313',
    path: '/path/to/test',
    repositoryPath: '/path/to/repo',
    repositoryName: 'TestRepo',
    cliToolId: 'command-code',
  };
  upsertWorktree(db, worktree);
});

describe('[#4313 再指示 2] /respond { messageId } with the Review page on screen', () => {
  it('陽性対照: 3 (a row of the stored question, not of the page) sends no key and records nothing', async () => {
    const message = storedQuestion();

    const response = await post({ messageId: message.id, answer: '3' });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(vi.mocked(sendKeys)).not.toHaveBeenCalled();
    expect(vi.mocked(sendSpecialKeys)).not.toHaveBeenCalled();
    expect(getMessageById(db, message.id)?.promptData?.status).toBe('pending');
    expect(humanAnswerEvents()).toBe(0);
  });

  it('陰性対照: 1 reaches the page once — one Enter on `❯ 1. Submit`, no digit — and is recorded', async () => {
    const message = storedQuestion();

    const response = await post({ messageId: message.id, answer: '1' });

    expect(response.status).toBe(200);
    expect(vi.mocked(sendKeys)).not.toHaveBeenCalled();
    expect(vi.mocked(sendSpecialKeys).mock.calls.map((call) => call[1])).toEqual([['Enter']]);
    expect(getMessageById(db, message.id)?.promptData).toMatchObject({ status: 'answered', answer: '1' });
    expect(humanAnswerEvents()).toBe(1);
  });

  it('陰性対照: 2 reaches the page once — down to Cancel and one Enter — and is recorded', async () => {
    const message = storedQuestion();

    const response = await post({ messageId: message.id, answer: '2' });

    expect(response.status).toBe(200);
    expect(vi.mocked(sendKeys)).not.toHaveBeenCalled();
    expect(vi.mocked(sendSpecialKeys)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendSpecialKeys).mock.calls[0][1]).toEqual(['Down', 'Enter']);
    expect(getMessageById(db, message.id)?.promptData).toMatchObject({ status: 'answered', answer: '2' });
    expect(humanAnswerEvents()).toBe(1);
  });
});

/** The stored row of an old checkbox question (`multiSelect: true`), still pending. */
const CHECKBOX_QUESTION: PromptData = {
  type: 'multiple_choice',
  question: 'Which files should I update?',
  multiSelect: true,
  options: [
    { number: 1, label: '[ ] calc.js', isDefault: true, checked: false },
    { number: 2, label: '[ ] README.md', isDefault: false, checked: false },
    { number: 3, label: '[ ] docs', isDefault: false, checked: false },
  ],
  status: 'pending',
} as PromptData;

function stored(promptData: PromptData): ChatMessage {
  return createMessage(db, {
    worktreeId: WT,
    cliToolId: 'command-code',
    role: 'assistant',
    content: promptData.question,
    messageType: 'prompt',
    promptData,
    timestamp: new Date(),
  } as unknown as ChatMessage);
}

/** The live capture with the `❯` taken off `1. Submit`: the page, its cursor unreadable. */
function withoutCursor(raw: string): string {
  return raw.replace(/❯ 1\. Submit/, '  1. Submit');
}

const REVIEW_UNANSWERED = readFileSync(path.join(DIR, 'review-page-unanswered-warning.txt'), 'utf8');

describe('[#4313 B-1] /respond { messageId }: the combinations refused at the page leave the row pending and record nothing', () => {
  async function expectRefusedAndUnrecorded(message: ChatMessage, answer: string): Promise<void> {
    const response = await post({ messageId: message.id, answer });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(vi.mocked(sendKeys)).not.toHaveBeenCalled();
    expect(vi.mocked(sendSpecialKeys)).not.toHaveBeenCalled();
    expect(getMessageById(db, message.id)?.promptData?.status).toBe('pending');
    expect(humanAnswerEvents()).toBe(0);
  }

  it('an old checkbox row (`multiSelect`) and 1 on the page: no toggle, no Enter', async () => {
    const message = stored(CHECKBOX_QUESTION);
    await expectRefusedAndUnrecorded(message, '1');
    const body = await (await post({ messageId: message.id, answer: '1' })).json();
    expect(JSON.stringify(body)).toContain('/prompt-response');
  });

  it('the page with the unanswered warning and 1', async () => {
    vi.mocked(captureSessionOutputFresh).mockResolvedValue(REVIEW_UNANSWERED);
    vi.mocked(capturePane).mockResolvedValue(REVIEW_UNANSWERED);
    await expectRefusedAndUnrecorded(storedQuestion(), '1');
  });

  it('the page with no readable cursor and 2', async () => {
    vi.mocked(captureSessionOutputFresh).mockResolvedValue(withoutCursor(REVIEW));
    vi.mocked(capturePane).mockResolvedValue(withoutCursor(REVIEW));
    await expectRefusedAndUnrecorded(storedQuestion(), '2');
  });

  it('the route could not read the screen and only the sender’s own read saw the page', async () => {
    vi.mocked(captureSessionOutputFresh).mockRejectedValue(new Error('capture failed'));
    vi.mocked(capturePane).mockResolvedValue(REVIEW);
    await expectRefusedAndUnrecorded(storedQuestion(), '1');
  });
});

describe('[#4313 B-1 再指示 1] /respond { messageId }: a checkbox row when the route could not read the screen', () => {
  it('multiSelect row, answer 1, the capture before the send failed: no key, row pending, nothing recorded', async () => {
    vi.mocked(captureSessionOutputFresh).mockRejectedValue(new Error('capture failed'));
    vi.mocked(capturePane).mockResolvedValue(REVIEW);
    const message = stored(CHECKBOX_QUESTION);

    const response = await post({ messageId: message.id, answer: '1' });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(vi.mocked(sendKeys)).not.toHaveBeenCalled();
    expect(vi.mocked(sendSpecialKeys)).not.toHaveBeenCalled();
    expect(getMessageById(db, message.id)?.promptData?.status).toBe('pending');
    expect(humanAnswerEvents()).toBe(0);
  });
});
