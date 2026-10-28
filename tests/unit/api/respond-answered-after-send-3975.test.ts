/**
 * Issue #3975 (item 3): `/respond`'s stored-message branch records the row as
 * answered only after `sendPromptAnswer` went through, as `/prompt-response`
 * does. Before #3975 the row was marked answered before the send, so a send
 * refused (409 `answer_not_delivered`) or failed (500) left it answered and
 * the chat could not offer the prompt again.
 *
 * Positive controls: 409 and 500 leave the row pending, and it can be answered
 * again. Negative control: a send that went through records it as before.
 * Plus: a second request for the same row while the first is typing is refused
 * (the `answered` check no longer covers the send itself).
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/tmux/session-ownership', async (importOriginal) =>
  (await import('@tests/unit/tmux/name-only-session-ownership')).nameOnlySessionOwnership(importOriginal)
);
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/prompt-answer-sender', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/prompt-answer-sender')>()),
  sendPromptAnswer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: vi.fn(() => ({
      getTool: () => ({
        name: 'Claude',
        isRunning: vi.fn().mockResolvedValue(true),
        getSessionName: (id: string, instanceId?: string) => `cm-${id}-${instanceId ?? 'claude'}`,
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
import { PromptAnswerNotDeliveredError, sendPromptAnswer } from '@/lib/prompt-answer-sender';
import type { ChatMessage, PromptData, Worktree } from '@/types/models';

const WT = 'wt-3975-respond';

let db: Database.Database;

function post(body: Record<string, unknown>): Promise<Response> {
  const request = new Request(`http://localhost:3000/api/worktrees/${WT}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return respond(request, { params: Promise.resolve({ id: WT }) }) as unknown as Promise<Response>;
}

const PROCEED: PromptData = {
  type: 'yes_no',
  question: 'Do you want to proceed?',
  options: ['yes', 'no'],
  status: 'pending',
};

function promptRow(): ChatMessage {
  return createMessage(db, {
    worktreeId: WT,
    cliToolId: 'claude',
    role: 'assistant',
    content: PROCEED.question,
    messageType: 'prompt',
    promptData: PROCEED,
    timestamp: new Date(),
  } as unknown as ChatMessage);
}

function statusOf(messageId: string): string | undefined {
  return getMessageById(db, messageId)?.promptData?.status;
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(sendPromptAnswer).mockResolvedValue(undefined);
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  const worktree: Worktree = {
    id: WT,
    name: 'respond 3975',
    path: '/path/to/test',
    repositoryPath: '/path/to/repo',
    repositoryName: 'TestRepo',
    cliToolId: 'claude',
  };
  upsertWorktree(db, worktree);
});

describe('[#3975] /respond { messageId } marks the row answered only after the send', () => {
  it('positive: a send refused before any key (409 answer_not_delivered) leaves the row pending', async () => {
    const message = promptRow();
    vi.mocked(sendPromptAnswer).mockRejectedValueOnce(new PromptAnswerNotDeliveredError('target-changed', 'cm-s'));

    const response = await post({ messageId: message.id, answer: 'yes' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'answer_not_delivered' });
    expect(statusOf(message.id)).toBe('pending');

    // ...and so the prompt can be answered again.
    const retry = await post({ messageId: message.id, answer: 'yes' });
    expect(retry.status).toBe(200);
    expect(statusOf(message.id)).toBe('answered');
  });

  it('positive: a send that failed (500) leaves the row pending', async () => {
    const message = promptRow();
    vi.mocked(sendPromptAnswer).mockRejectedValueOnce(new Error('tmux went away'));

    const response = await post({ messageId: message.id, answer: 'yes' });
    expect(response.status).toBe(500);
    expect(statusOf(message.id)).toBe('pending');
  });

  it('positive: the send sees the row still pending (recorded after it, not before)', async () => {
    const message = promptRow();
    let statusDuringSend: string | undefined;
    vi.mocked(sendPromptAnswer).mockImplementationOnce(async () => {
      statusDuringSend = statusOf(message.id);
    });

    expect((await post({ messageId: message.id, answer: 'yes' })).status).toBe(200);
    expect(statusDuringSend).toBe('pending');
  });

  it('negative: a send that went through records the row answered, as before', async () => {
    const message = promptRow();
    const response = await post({ messageId: message.id, answer: 'yes' });
    expect(response.status).toBe(200);
    expect(getMessageById(db, message.id)?.promptData).toMatchObject({
      status: 'answered',
      answer: 'yes',
      answeredBy: 'human',
    });
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
  });

  it('a second request for the same row while the first is typing is refused (409), and nothing is sent twice', async () => {
    const message = promptRow();
    let finish!: () => void;
    vi.mocked(sendPromptAnswer).mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve))
    );

    const first = post({ messageId: message.id, answer: 'yes' });
    for (let i = 0; i < 50 && vi.mocked(sendPromptAnswer).mock.calls.length === 0; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);

    const second = await post({ messageId: message.id, answer: 'no' });
    expect(second.status).toBe(409);
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);

    finish();
    expect((await first).status).toBe(200);
    expect(getMessageById(db, message.id)?.promptData).toMatchObject({ status: 'answered', answer: 'yes' });

    // The claim is released: the answered row is refused as already answered.
    const third = await post({ messageId: message.id, answer: 'no' });
    expect(third.status).toBe(400);
  });
});
